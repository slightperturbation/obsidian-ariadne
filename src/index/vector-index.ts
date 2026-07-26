export interface VectorHit {
  id: string;
  /** cosine similarity in [-1, 1]. */
  score: number;
}

/** One chunk to embed and store, for hosts that can do both in one step. */
export interface IndexEntry {
  id: string;
  text: string;
}

/**
 * The vector half of the index, behind an async surface so it can live off the
 * main thread.
 *
 * Mutations are fire-and-forget by design: the worker transport preserves
 * message order, so an upsert posted before a search is guaranteed to be
 * applied before that search runs. Only reads need awaiting.
 */
export interface VectorIndex {
  readonly dim: number;

  upsert(id: string, path: string, vec: ArrayLike<number>): void;
  removePath(path: string): void;

  search(query: ArrayLike<number>, limit: number, floor: number): Promise<VectorHit[]>;

  /** All stored vectors (normalized), for persistence snapshots. */
  entries(): Promise<Array<[string, Float32Array]>>;

  /**
   * The stored vectors for one note's chunks. Lets a host with no embedder ask
   * "what is like this note" using vectors another device already computed.
   */
  vectorsOfPath?(path: string): Promise<Float32Array[]>;

  /**
   * Embed and store a note's chunks in one step, replacing whatever that path
   * had before. Present only where the embedder and the store share a host
   * (the worker), so vectors never cross the thread boundary during indexing.
   */
  indexTexts?(path: string, entries: IndexEntry[]): Promise<void>;

  /**
   * Embed a query and search in one round trip — the hot path for ghost text
   * and the Margin, where two trips would double the latency per keystroke
   * pause.
   */
  embedAndSearch?(
    text: string,
    opts: { asQuery: boolean; limit: number; floor: number },
  ): Promise<VectorHit[]>;

  dispose?(): void;
}
