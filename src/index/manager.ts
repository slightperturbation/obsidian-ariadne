import { chunkNote } from "./chunker";
import { LexicalIndex } from "./lexical";
import { VectorStore } from "./vectorstore";
import type { VectorIndex, VectorHit } from "./vector-index";
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
  /**
   * Drop results below this raw cosine. The Margin is ambient marginalia, so a
   * wrong card costs more than an empty section — unlike an explicit search,
   * which should always show its best guess.
   */
  minCosine?: number;
  /** Note titles already linked from the draft — no point re-surfacing them. */
  excludeTitles?: ReadonlySet<string>;
  /** Paths in the draft's link neighbourhood; raises their confidence. */
  neighbors?: ReadonlySet<string>;
  /**
   * Sink (never drop) matching notes to the bottom of the ranking — e.g.
   * dated journal entries, which would otherwise crowd out the permanent
   * notes a topic surface exists to show. A stable partition, so relative
   * order within each group is preserved.
   */
  deprioritize?: (path: string) => boolean;
}

export interface NoteMeta {
  path: string;
  title: string;
  mtime: number;
  folder: string;
  type?: string;
  /** Frontmatter `date` (ISO) — the time anchor of dated entries. */
  date?: string;
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
/** How long an embed+scan result may be reused (one pause's fan-out). */
const SEMANTIC_MEMO_MS = 10_000;
const SEMANTIC_MEMO_MAX = 8;

/** Frontmatter values worth searching (aliases, tags) flattened to text. */
function searchableMeta(frontmatter?: Record<string, unknown>): string {
  if (!frontmatter) return "";
  const out: string[] = [];
  for (const key of ["aliases", "alias", "tags", "tag", "title"]) {
    const value = frontmatter[key];
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === "string"));
  }
  return out.join(" ");
}

const hasFilters = (f: ReturnType<typeof parseQuery>["filters"]): boolean =>
  !!(f.folder || f.type || f.since);

/** Stable partition: kept entries first, sunk entries after, order preserved. */
function sink<T extends { path: string }>(
  entries: T[],
  shouldSink?: (path: string) => boolean,
): T[] {
  if (!shouldSink) return entries;
  const kept: T[] = [];
  const sunk: T[] = [];
  for (const e of entries) (shouldSink(e.path) ? sunk : kept).push(e);
  return kept.concat(sunk);
}

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
  private vectors?: VectorIndex;
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
  /** Notes touched since the last successful save — drives delta writes. */
  private dirtySincePersist = new Set<string>();
  /** Short-lived memo of embed+scan results (see semanticHits). */
  private semanticCache = new Map<string, { at: number; revision: number; hits: VectorHit[] }>();

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
  setEmbedder(embedder: EmbeddingProvider, vectors?: VectorIndex): string[] {
    this.embedder = embedder;
    const changed =
      this.embedderId !== embedder.id || !this.vectors || this.vectors.dim !== embedder.dim;
    if (changed || vectors) {
      this.vectors = vectors ?? new VectorStore(embedder.dim);
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
    // Capture the store: setEmbedder() can swap it during an await below, and
    // writing vectors from the old model into the new store would mix
    // embedding spaces (or throw on a dim mismatch).
    const store = this.vectors;
    const generation = this.embedderId;
    const superseded = () => this.vectors !== store || this.embedderId !== generation;

    let vecs: Float32Array[] | undefined;
    let storedByIndex = false;
    if (chunks.length > 0 && store) {
      if (store.indexTexts) {
        // The worker embeds and stores in one step, so the vectors never cross
        // the thread boundary — and the replace is atomic on its side.
        await store.indexTexts(
          note.path,
          chunks.map((c) => ({ id: c.id, text: c.text })),
        );
        if (superseded()) return;
        storedByIndex = true;
      } else if (this.embedder) {
        vecs = await this.embedder.embed(chunks.map((c) => c.text));
        if (superseded()) return;
      }
    }

    this.removeNote(note.path, { keepVectors: storedByIndex });
    this.revision++;
    this.dirtySincePersist.add(note.path);
    if (chunks.length === 0) {
      // Still record metadata so the note is known, even if it has no body.
      this.recordMeta(note, 0);
      return;
    }
    this.lexical.setMeta(note.path, searchableMeta(note.frontmatter));
    this.lexical.add(chunks);
    for (const c of chunks) this.addChunk(c);
    if (vecs) {
      chunks.forEach((c, i) => store!.upsert(c.id, c.path, vecs![i]));
    } else if (!storedByIndex) {
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

  /** Paths whose parts must be rewritten on the next save. */
  dirtyPaths(): ReadonlySet<string> {
    return this.dirtySincePersist;
  }

  /** Called after a save lands; unsaved changes stay dirty if it failed. */
  markPersisted(paths: ReadonlySet<string>): void {
    for (const p of paths) this.dirtySincePersist.delete(p);
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

  removeNote(path: string, opts: { keepVectors?: boolean } = {}): void {
    if (this.meta.has(path)) {
      this.revision++;
      this.dirtySincePersist.add(path);
    }
    this.lexical.removePath(path);
    // indexTexts already replaced this path's vectors atomically; removing
    // them here would delete what was just stored.
    if (!opts.keepVectors) this.vectors?.removePath(path);
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

  /**
   * Index an entire source. Prefers the streaming path — `all()` materializes
   * every note's text at once, which on a phone is a straightforward way to
   * get the app killed on a large vault.
   *
   * Production uses the incremental scheduler instead; this is for rebuilds
   * and tests.
   */
  async buildAll(source: NoteSource): Promise<void> {
    if (source.paths && source.loadPath) {
      for (const path of source.paths()) {
        const note = await source.loadPath(path);
        if (note) await this.indexNote(note);
      }
      return;
    }
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

    const scoped = hasFilters(filters) ? (p: string) => this.passesFilters(p, filters) : undefined;
    const lexicalIds = this.lexical.rankedIds(queryText, CANDIDATES, "and", scoped);
    // Layer membership is note-level: a note is "semantic only" when no chunk
    // of it matched lexically at all.
    const lexicalPaths = new Set(
      lexicalIds.map((id) => this.chunks.get(id)?.path).filter((p): p is string => !!p),
    );
    const lists: string[][] = [lexicalIds];

    const useSemantic = (opts.semantic ?? true) && !!this.embedder && !!this.vectors;
    const cosineById = new Map<string, number>();
    if (useSemantic) {
      const vhits = await this.semanticHits(queryText, true);
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
    const semanticActive = !!(this.embedder && this.vectors);
    if (semanticActive) {
      const vhits = await this.semanticHits(clean, false);
      lists.push(vhits.map((h) => h.id));
      for (const h of vhits) cosineById.set(h.id, h.score);
    }

    // Gate before the limit is applied, so a filtered-out card doesn't cost a
    // slot that a good one could have filled. The cosine floor only applies
    // when this retrieval could produce cosines — on a lexical-only device it
    // would drop every candidate and leave the Margin permanently, silently
    // empty.
    const ranked = this.collapseToNotes(lists, (path) => {
      if (path === opts.excludePath) return false;
      if (opts.excludeTitles?.has(this.meta.get(path)?.title ?? "")) return false;
      return true;
    }).filter(
      (entry) =>
        !semanticActive ||
        opts.minCosine === undefined ||
        (cosineById.get(entry.chunkId) ?? 0) >= opts.minCosine,
    );
    return this.buildResults(sink(ranked, opts.deprioritize), limit, cosineById, undefined, opts.neighbors);
  }

  /**
   * Notes related to an already-indexed note, using that note's **stored**
   * vectors as the query.
   *
   * No embedder required — which is the whole point. A phone reading a synced
   * index has every note's vectors but no model to embed anything new with, so
   * this is the one semantic question it can still answer, and happens to be
   * the one the Margin asks. On a device that does have a model it's also
   * simply cheaper than re-embedding text the owner already embedded.
   *
   * Each chunk votes independently and a note keeps its best score: a long
   * source note is a bag of several ideas, and averaging its chunks into one
   * centroid would blur them all into a vector that matches nothing well.
   */
  async relatedToPath(path: string, opts: RelatedOptions = {}): Promise<ScoredResult[]> {
    const limit = opts.limit ?? 8;
    const store = this.vectors;
    if (!store?.vectorsOfPath) return [];
    const queries = await store.vectorsOfPath(path);
    if (queries.length === 0) return [];

    const floor = this.embedder?.floor ?? VECTOR_FLOOR;
    const bestById = new Map<string, number>();
    for (const q of queries) {
      for (const hit of await store.search(q, CANDIDATES, floor)) {
        const prior = bestById.get(hit.id);
        if (prior === undefined || hit.score > prior) bestById.set(hit.id, hit.score);
      }
    }
    const ordered = [...bestById.entries()].sort((a, b) => b[1] - a[1]);

    // Lexical still contributes: the note's own title and headings catch
    // notes that share vocabulary the embedder happened to place elsewhere.
    const meta = this.meta.get(path);
    const lists: string[][] = [ordered.map(([id]) => id)];
    if (meta) lists.push(this.lexical.rankedIds(meta.title, CANDIDATES, "or"));

    const cosineById = new Map(ordered);
    const ranked = this.collapseToNotes(lists, (candidate) => {
      if (candidate === path || candidate === opts.excludePath) return false;
      if (opts.excludeTitles?.has(this.meta.get(candidate)?.title ?? "")) return false;
      return true;
    }).filter(
      (entry) =>
        opts.minCosine === undefined || (cosineById.get(entry.chunkId) ?? 0) >= opts.minCosine,
    );
    return this.buildResults(sink(ranked, opts.deprioritize), limit, cosineById, undefined, opts.neighbors);
  }

  /** Notes indexed without vectors — a consumer's "awaiting desktop" count. */
  get unembeddedCount(): number {
    return this.unembedded.size;
  }

  /** Read-only note metadata, for surfaces that rank notes without text. */
  noteMetas(): NoteMeta[] {
    return [...this.meta.values()].map((m) => ({ ...m }));
  }

  /** Whether relatedToPath() can answer at all (vectors on hand). */
  hasStoredVectors(): boolean {
    return !!this.vectors?.vectorsOfPath;
  }

  /**
   * Whether arbitrary text can be embedded — false on a device that reads a
   * synced index without a local model. Retrieval still works there; it just
   * has to be asked in terms of an indexed note rather than free text.
   */
  canEmbedText(): boolean {
    return !!this.embedder && !!this.vectors;
  }

  /**
   * Embed `text` and return its vector hits above the provider's floor.
   *
   * The floor is applied inside the search rather than after it: an unrelated
   * chunk at vector rank 1 would otherwise out-rank a strong lexical hit under
   * RRF. Where the store can embed and search in one step (the worker), that's
   * a single round trip; otherwise it falls back to embed-then-search.
   */
  private async semanticHits(text: string, asQuery: boolean): Promise<VectorHit[]> {
    // One typing pause fans out to three consumers (Margin, tension, ghost)
    // that all ask about the same paragraph — this memo makes that one
    // embedding + one scan instead of three. Keyed on the revision so an
    // index update invalidates it; TTL-bounded so it can never serve stale
    // results across pauses.
    const key = `${asQuery ? "q" : "d"}:${text}`;
    const cached = this.semanticCache.get(key);
    if (cached && cached.revision === this.revision && Date.now() - cached.at < SEMANTIC_MEMO_MS) {
      return cached.hits;
    }

    const store = this.vectors!;
    const floor = this.embedder!.floor ?? VECTOR_FLOOR;
    let hits: VectorHit[];
    if (store.embedAndSearch) {
      hits = await store.embedAndSearch(text, { asQuery, limit: CANDIDATES, floor });
    } else {
      const vec =
        asQuery && this.embedder!.embedQuery
          ? await this.embedder!.embedQuery(text)
          : (await this.embedder!.embed([text]))[0];
      hits = await store.search(vec, CANDIDATES, floor);
    }
    this.semanticCache.set(key, { at: Date.now(), revision: this.revision, hits });
    if (this.semanticCache.size > SEMANTIC_MEMO_MAX) {
      const oldest = this.semanticCache.keys().next().value;
      if (oldest !== undefined) this.semanticCache.delete(oldest);
    }
    return hits;
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
    /** Notes linked from the note being written — a strong relevance signal. */
    neighbors?: ReadonlySet<string>,
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
        confidence: confidence({
          rank,
          cosine,
          // A note the draft already links to (or that links back) is
          // demonstrably part of this thought, not just lexically nearby.
          ...(neighbors ? { graphProximity: neighbors.has(entry.path) ? 1 : 0 } : {}),
        }),
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
      if (!Number.isNaN(since)) {
        // A dated entry's `date` property is its time anchor; mtime is when
        // the FILE was last touched — nearly the inverse question for a
        // journal (an archival re-save would teleport a 2019 entry into
        // `since:2026`). Fall back to mtime for notes without an anchor.
        const anchor = meta.date ? Date.parse(meta.date) : NaN;
        const when = Number.isNaN(anchor) ? meta.mtime : anchor;
        if (when < since) return false;
      }
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

  async snapshot(): Promise<IndexSnapshot> {
    const vectors: IndexSnapshot["vectors"] = [];
    if (this.vectors) {
      for (const [id, vec] of await this.vectors.entries()) vectors.push({ id, vec });
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
   *
   * `into` lets the caller supply the (worker-hosted) store to load into;
   * without it a plain in-process store is built.
   */
  restore(snap: IndexSnapshot, into?: VectorIndex): void {
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

    const withVectors = new Set<string>();
    if (snap.dim && snap.vectors.length > 0) {
      const store = into ?? new VectorStore(snap.dim);
      this.vectors = store;
      for (const { id, vec } of snap.vectors) {
        const path = this.chunks.get(id)?.path;
        // Skip rather than throw on a wrong-length vector: a truncated part
        // must degrade to "re-embed that note", never take down the restore
        // (and with it the whole session's index).
        if (!path || vec.length !== store.dim) continue;
        store.upsert(id, path, vec);
        withVectors.add(id);
      }
    }
    // Derived from the snapshot rather than by asking the store, so this works
    // the same whether the store is in-process or across a worker boundary.
    for (const c of snap.chunks) {
      if (!withVectors.has(c.id)) this.unembedded.add(c.path);
    }

    // Drift check: if a note's restored chunks don't match what the manifest
    // claims, the parts and the manifest came from different saves. Drop the
    // note's metadata so the startup mtime diff re-indexes it — otherwise its
    // recorded mtime still matches disk and it stays permanently invisible.
    for (const m of snap.notes) {
      const actual = this.pathChunks.get(m.path)?.size ?? 0;
      if (actual !== m.chunkCount) {
        this.meta.delete(m.path);
        this.unembedded.delete(m.path);
      }
    }
  }
}
