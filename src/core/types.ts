/** Shared domain types used across the index, search, and UI layers. */

export interface NoteRef {
  path: string;
  title: string;
  mtime: number;
}

/** An atomic unit of a note (roughly a heading section or paragraph group). */
export interface Chunk {
  id: string; // `${path}#${ordinal}`
  path: string;
  ordinal: number;
  heading?: string;
  text: string;
}

/** Per-note signals rendered as the Line's sparkline (each 0..1). */
export interface SparkValues {
  linked: number; // how connected the note is
  recency: number; // how recently it was touched
  atomicity: number; // how close to "one idea per note"
}

/** A ranked result surfaced by the Line or the Margin. */
export interface ScoredResult {
  path: string;
  title: string;
  snippet: string;
  score: number; // fused relevance, 0..1
  confidence: number; // drives UI prominence, 0..1
  /** Surfaced by the vector list but not the lexical one → Layer 2 (Related). */
  semanticOnly?: boolean;
  /** Raw cosine similarity (0..1-mapped) when a vector matched — the purest
   * "how close in meaning" signal, used for suggestion thresholds. */
  cosine?: number;
  spark?: SparkValues;
}

/**
 * A note as seen by the indexer, decoupled from Obsidian. The Obsidian adapter
 * (runtime) produces these from the Vault + MetadataCache; tests produce them
 * directly. This keeps the retrieval core free of any Obsidian dependency.
 */
export interface SourceNote {
  path: string;
  title: string;
  content: string;
  mtime: number;
  folder: string;
  frontmatter?: Record<string, unknown>;
  /** Outgoing wikilinks + embeds, from the metadata cache (0 when unknown). */
  linkCount?: number;
}

export interface NoteSource {
  all(): Promise<SourceNote[]>;
}
