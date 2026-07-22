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

  /** Index or re-index a single note (idempotent). */
  async indexNote(note: SourceNote): Promise<void> {
    this.removeNote(note.path);
    this.revision++;
    const chunks = chunkNote(note.path, note.content);
    if (chunks.length === 0) {
      // Still record metadata so the note is known, even if it has no body.
      this.recordMeta(note, 0);
      return;
    }
    this.lexical.add(chunks);
    for (const c of chunks) this.chunks.set(c.id, c);

    if (this.embedder && this.vectors) {
      const vecs = await this.embedder.embed(chunks.map((c) => c.text));
      chunks.forEach((c, i) => this.vectors!.upsert(c.id, c.path, vecs[i]));
    } else {
      this.unembedded.add(note.path);
    }
    this.recordMeta(note, chunks.length);
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
    for (const id of [...this.chunks.keys()]) {
      if (this.chunks.get(id)?.path === path) this.chunks.delete(id);
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

    const lexicalIds = this.lexical.rankedIds(queryText, 100);
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
      const vhits = this.vectors!.search(queryVec, 100);
      lists.push(vhits.map((h) => h.id));
      // Map cosine [-1,1] -> [0,1] for the confidence blend.
      for (const h of vhits) cosineById.set(h.id, (h.score + 1) / 2);
    }

    // Fuse, then collapse to the best-ranked chunk per note.
    const bestPerNote: Array<{ chunkId: string; path: string }> = [];
    const seen = new Set<string>();
    for (const { id } of fuse(lists)) {
      const chunk = this.chunks.get(id);
      if (!chunk || seen.has(chunk.path)) continue;
      seen.add(chunk.path);
      bestPerNote.push({ chunkId: id, path: chunk.path });
    }

    const filtered = bestPerNote.filter(({ path }) => this.passesFilters(path, filters));
    const total = filtered.length;

    const now = Date.now();
    return filtered.slice(0, limit).map((entry, rank) => {
      const chunk = this.chunks.get(entry.chunkId)!;
      const meta = this.meta.get(entry.path)!;
      return {
        path: entry.path,
        title: meta.title,
        snippet: makeSnippet(chunk.text),
        score: total > 1 ? 1 - rank / (total - 1) : 1,
        confidence: confidence({ fusedRank: rank, total, cosine: cosineById.get(entry.chunkId) }),
        semanticOnly: useSemantic && !lexicalPaths.has(entry.path),
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
    this.meta = new Map();
    this.unembedded = new Set();
    this.vectors = undefined;
    this.embedderId = snap.embedderId;
    this.revision++;

    for (const m of snap.notes) this.meta.set(m.path, { ...m });
    for (const c of snap.chunks) this.chunks.set(c.id, c);
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
