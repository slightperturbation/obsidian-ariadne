import { chunkNote } from "./chunker";
import { LexicalIndex } from "./lexical";
import { VectorStore } from "./vectorstore";
import { fuse } from "./fusion";
import { confidence } from "./confidence";
import { sparkValues } from "./spark";
import { parseQuery } from "../search/query";
import type { EmbeddingProvider } from "./embeddings/provider";
import type { Chunk, NoteSource, ScoredResult, SourceNote } from "../core/types";

export interface QueryOptions {
  limit?: number;
  /** Include the semantic (vector) list in fusion. Defaults to true when an embedder is present. */
  semantic?: boolean;
}

export interface RelatedOptions {
  /** The note being written — never suggest a note to itself. */
  excludePath?: string;
  limit?: number;
}

export interface NoteMeta {
  path: string;
  title: string;
  mtime: number;
  folder: string;
  type?: string;
  linkCount: number;
  chunkCount: number;
}

/** Everything needed to reconstruct the index without re-reading the vault. */
export interface IndexSnapshot {
  embedderId?: string;
  dim?: number;
  notes: NoteMeta[];
  chunks: Chunk[];
  vectors: Array<{ id: string; vec: Float32Array }>;
}

const SNIPPET_MAX = 160;

/**
 * Fallback floor for providers that don't declare one. Without a floor the
 * top-k scan returns k chunks no matter how unrelated, and RRF then ranks that
 * noise above real lexical hits — which made the "Related" layer mostly noise.
 * Each provider declares its own floor, since embedders occupy different
 * similarity ranges (see EmbeddingProvider.floor).
 */
const VECTOR_FLOOR = 0.6;
/** How many chunks to pull from each ranked list before fusing. */
const CANDIDATES = 100;

function makeSnippet(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= SNIPPET_MAX ? oneLine : oneLine.slice(0, SNIPPET_MAX - 1).trimEnd() + "…";
}

/**
 * Ties the retrieval core together: chunk → lexical + vector index → fused,
 * confidence-scored, note-level results. Deliberately free of any Obsidian
 * import — it consumes SourceNote/NoteSource, which the runtime adapter builds
 * from the Vault. That keeps the whole engine unit-testable end to end.
 */
export class IndexManager {
  private lexical = new LexicalIndex();
  private vectors?: VectorStore;
  private chunks = new Map<string, Chunk>();
  /** chunk ids per note path — keeps removeNote O(chunks in that note). */
  private pathChunks = new Map<string, Set<string>>();
  private meta = new Map<string, NoteMeta>();
  /** Paths indexed while no embedder was attached — re-index these on attach. */
  private unembedded = new Set<string>();
  /** Which provider produced the stored vectors (survives restore()). */
  private embedderId?: string;
  /** Bumped on every mutation, so persistence can skip no-op saves. */
  revision = 0;

  constructor(private embedder?: EmbeddingProvider) {
    if (embedder) {
      this.vectors = new VectorStore(embedder.dim);
      this.embedderId = embedder.id;
    }
  }

  /**
   * Attach (or swap) the embedding provider after construction — the model
   * loads in the background while lexical search is already live. Returns the
   * paths whose chunks lack vectors from this provider; the caller re-indexes
   * them to backfill. Swapping providers invalidates all stored vectors.
   */
  setEmbedder(embedder: EmbeddingProvider): string[] {
    this.embedder = embedder;
    if (this.embedderId !== embedder.id || !this.vectors || this.vectors.dim !== embedder.dim) {
      this.vectors = new VectorStore(embedder.dim);
      this.embedderId = embedder.id;
      this.unembedded = new Set(
        [...this.meta.values()].filter((m) => m.chunkCount > 0).map((m) => m.path),
      );
    }
    return [...this.unembedded];
  }

  /**
   * Index or re-index a single note (idempotent).
   *
   * Embedding happens BEFORE the old entry is removed: an earlier version
   * removed first, so a throw from the embedder left the note deleted from
   * the index entirely. Now a failure leaves the previous state untouched.
   */
  async indexNote(note: SourceNote): Promise<void> {
    const chunks = chunkNote(note.path, note.content);

    let vecs: Float32Array[] | undefined;
    if (chunks.length > 0 && this.embedder && this.vectors) {
      // Capture the store: setEmbedder() can swap it during this await, and
      // writing vectors from the old model into the new store would mix
      // embedding spaces (or throw on a dim mismatch).
      const store = this.vectors;
      const generation = this.embedderId;
      vecs = await this.embedder.embed(chunks.map((c) => c.text));
      if (this.vectors !== store || this.embedderId !== generation) {
        // Superseded mid-flight; the backfill for the new provider re-indexes.
        return;
      }
    }

    this.removeNote(note.path);
    this.revision++;
    if (chunks.length === 0) {
      // Still record metadata so the note is known, even if it has no body.
      this.recordMeta(note, 0);
      return;
    }
    this.lexical.add(chunks);
    for (const c of chunks) this.addChunk(c);
    if (vecs) {
      chunks.forEach((c, i) => this.vectors!.upsert(c.id, c.path, vecs![i]));
    } else {
      this.unembedded.add(note.path);
    }
    this.recordMeta(note, chunks.length);
  }

  private addChunk(c: Chunk): void {
    this.chunks.set(c.id, c);
    let ids = this.pathChunks.get(c.path);
    if (!ids) {
      ids = new Set<string>();
      this.pathChunks.set(c.path, ids);
    }
    ids.add(c.id);
  }

  private recordMeta(note: SourceNote, chunkCount: number): void {
    const fmType = note.frontmatter?.type;
    this.meta.set(note.path, {
      path: note.path,
      title: note.title,
      mtime: note.mtime,
      folder: note.folder,
      type: typeof fmType === "string" ? fmType : undefined,
      linkCount: note.linkCount ?? 0,
      chunkCount,
    });
  }

  removeNote(path: string): void {
    if (this.meta.has(path)) this.revision++;
    this.lexical.removePath(path);
    this.vectors?.removePath(path);
    // Indexed by path: scanning every chunk in the vault here (the previous
    // approach) made each note's re-index O(all chunks), so a full rebuild was
    // quadratic — ~8s at 4k notes and far worse beyond.
    const ids = this.pathChunks.get(path);
    if (ids) {
      for (const id of ids) this.chunks.delete(id);
      this.pathChunks.delete(path);
    }
    this.meta.delete(path);
    this.unembedded.delete(path);
  }

  async buildAll(source: NoteSource): Promise<void> {
    for (const note of await source.all()) await this.indexNote(note);
  }

  /**
   * Run a query through the full pipeline: parse grammar → lexical + (optional)
   * vector ranking → RRF → best-chunk-per-note dedup → filters → confidence.
   */
  async query(raw: string, opts: QueryOptions = {}): Promise<ScoredResult[]> {
    const limit = opts.limit ?? 20;
    const { text, phrases, filters } = parseQuery(raw);
    const queryText = [text, ...phrases].join(" ").trim();
    if (!queryText) return [];

    const lexicalIds = this.lexical.rankedIds(queryText, CANDIDATES);
    // Layer membership is note-level: a note is "semantic only" when no chunk
    // of it matched lexically at all.
    const lexicalPaths = new Set(
      lexicalIds.map((id) => this.chunks.get(id)?.path).filter((p): p is string => !!p),
    );
    const lists: string[][] = [lexicalIds];

    const useSemantic = (opts.semantic ?? true) && !!this.embedder && !!this.vectors;
    const cosineById = new Map<string, number>();
    if (useSemantic) {
      const queryVec = this.embedder!.embedQuery
        ? await this.embedder!.embedQuery(queryText)
        : (await this.embedder!.embed([queryText]))[0];
      // Floor first: an unrelated chunk at vector rank 1 would otherwise
      // out-rank a strong lexical hit under RRF.
      const floor = this.embedder!.floor ?? VECTOR_FLOOR;
      const vhits = this.vectors!
        .search(queryVec, CANDIDATES)
        .filter((h) => h.score >= floor);
      lists.push(vhits.map((h) => h.id));
      for (const h of vhits) cosineById.set(h.id, h.score);
    }

    const ranked = this.collapseToNotes(lists, (path) => this.passesFilters(path, filters));
    return this.buildResults(ranked, limit, cosineById, (path) =>
      useSemantic && !lexicalPaths.has(path),
    );
  }

  /**
   * Notes related to a free-text context (a draft paragraph), for the Margin
   * and ghost-text suggestions. Differs from query(): no grammar/filters,
   * OR-combined lexical (any strong term overlap counts), and the context is
   * embedded as a passage (no BGE query instruction — this is doc-to-doc
   * similarity), with the note being written excluded.
   */
  async related(text: string, opts: RelatedOptions = {}): Promise<ScoredResult[]> {
    const limit = opts.limit ?? 8;
    // Strip wikilink brackets so already-made links don't dominate matching.
    const clean = text.replace(/\[\[|\]\]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) return [];

    const lists: string[][] = [this.lexical.rankedIds(clean, CANDIDATES, "or")];
    const cosineById = new Map<string, number>();
    if (this.embedder && this.vectors) {
      const [vec] = await this.embedder.embed([clean]);
      const floor = this.embedder.floor ?? VECTOR_FLOOR;
      const vhits = this.vectors
        .search(vec, CANDIDATES)
        .filter((h) => h.score >= floor);
      lists.push(vhits.map((h) => h.id));
      for (const h of vhits) cosineById.set(h.id, h.score);
    }

    const ranked = this.collapseToNotes(lists, (path) => path !== opts.excludePath);
    return this.buildResults(ranked, limit, cosineById);
  }

  /**
   * Fuse the ranked lists, keep the best-ranked chunk per note, and drop notes
   * the caller filtered out or whose metadata is missing (index drift must
   * degrade to fewer results, never to a crash in the ghost-text hot path).
   */
  private collapseToNotes(
    lists: string[][],
    keep: (path: string) => boolean,
  ): Array<{ chunkId: string; path: string; fused: number }> {
    const out: Array<{ chunkId: string; path: string; fused: number }> = [];
    const seen = new Set<string>();
    for (const { id, score } of fuse(lists)) {
      const chunk = this.chunks.get(id);
      if (!chunk || seen.has(chunk.path)) continue;
      if (!this.meta.has(chunk.path) || !keep(chunk.path)) continue;
      seen.add(chunk.path);
      out.push({ chunkId: id, path: chunk.path, fused: score });
    }
    return out;
  }

  private buildResults(
    ranked: Array<{ chunkId: string; path: string; fused: number }>,
    limit: number,
    cosineById: Map<string, number>,
    semanticOnly?: (path: string) => boolean,
  ): ScoredResult[] {
    const now = Date.now();
    // Relevance is relative to the best hit, not to how many candidates the
    // index happened to surface.
    const best = ranked[0]?.fused ?? 1;
    return ranked.slice(0, limit).map((entry, rank) => {
      const chunk = this.chunks.get(entry.chunkId)!;
      const meta = this.meta.get(entry.path)!;
      const cosine = cosineById.get(entry.chunkId);
      return {
        path: entry.path,
        title: meta.title,
        snippet: makeSnippet(chunk.text),
        score: best > 0 ? entry.fused / best : 0,
        confidence: confidence({ rank, cosine }),
        ...(semanticOnly ? { semanticOnly: semanticOnly(entry.path) } : {}),
        cosine,
        spark: sparkValues(
          { linkCount: meta.linkCount, mtime: meta.mtime, chunkCount: meta.chunkCount },
          now,
        ),
      };
    });
  }

  private passesFilters(path: string, filters: ReturnType<typeof parseQuery>["filters"]): boolean {
    const meta = this.meta.get(path);
    if (!meta) return false;
    if (filters.folder && !meta.folder.toLowerCase().includes(filters.folder.toLowerCase())) {
      return false;
    }
    if (filters.type && meta.type !== filters.type) return false;
    if (filters.since) {
      const since = Date.parse(filters.since);
      if (!Number.isNaN(since) && meta.mtime < since) return false;
    }
    return true;
  }

  get noteCount(): number {
    return this.meta.size;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  /** Indexed mtime for a path — the warm-start stale diff compares this. */
  mtimeOf(path: string): number | undefined {
    return this.meta.get(path)?.mtime;
  }

  indexedPaths(): string[] {
    return [...this.meta.keys()];
  }

  snapshot(): IndexSnapshot {
    const vectors: IndexSnapshot["vectors"] = [];
    if (this.vectors) {
      for (const [id, vec] of this.vectors.entries()) vectors.push({ id, vec });
    }
    return {
      embedderId: this.embedderId,
      dim: this.vectors?.dim,
      notes: [...this.meta.values()],
      chunks: [...this.chunks.values()],
      vectors,
    };
  }

  /**
   * Replace all state from a snapshot (the warm start). The lexical index is
   * rebuilt from the chunks; vectors are restored as-is. Chunks with no stored
   * vector leave their note in the backfill set for when an embedder attaches.
   */
  restore(snap: IndexSnapshot): void {
    this.lexical = new LexicalIndex();
    this.chunks = new Map();
    this.pathChunks = new Map();
    this.meta = new Map();
    this.unembedded = new Set();
    this.vectors = undefined;
    this.embedderId = snap.embedderId;
    this.revision++;

    for (const m of snap.notes) this.meta.set(m.path, { ...m });
    for (const c of snap.chunks) this.addChunk(c);
    this.lexical.add(snap.chunks);

    if (snap.dim && snap.vectors.length > 0) {
      this.vectors = new VectorStore(snap.dim);
      for (const { id, vec } of snap.vectors) {
        const path = this.chunks.get(id)?.path;
        if (path) this.vectors.upsert(id, path, vec);
      }
    }
    for (const c of snap.chunks) {
      if (!this.vectors?.has(c.id)) this.unembedded.add(c.path);
    }
  }
}
