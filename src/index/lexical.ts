import MiniSearch from "minisearch";
import type { Chunk } from "../core/types";

interface LexicalDoc {
  id: string;
  path: string;
  title: string;
  heading: string;
  text: string;
  /** Frontmatter aliases/tags — a standard Obsidian retrieval affordance. */
  meta: string;
}

export interface LexicalHit {
  id: string;
  path: string;
  score: number;
}

const titleFromPath = (path: string): string =>
  (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/** Function words carry no overlap signal for context matching. */
const CONTEXT_STOP = new Set([
  "the", "and", "are", "was", "were", "has", "had", "have", "its", "this",
  "that", "with", "for", "not", "but", "you", "your", "they", "them", "their",
  "then", "than", "there", "here", "what", "when", "where", "which", "who",
  "how", "why", "can", "could", "would", "should", "will", "just", "about",
  "into", "over", "from", "been", "being", "because", "also", "only", "some",
  "more", "most", "very", "much", "many", "like", "one", "two", "all", "any",
]);

/** How many terms a paragraph-context query may carry. */
const CONTEXT_TERM_CAP = 16;

/**
 * Reduce free text to its most distinctive terms for an OR overlap query.
 * Longer words are the cheap proxy for rarer words — good enough here, since
 * OR scoring only needs the strong terms to be present, not a perfect IDF
 * ordering. Keeps retrieval cost bounded no matter how long the paragraph is.
 */
export function contextTerms(text: string): string {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []) {
    if (!CONTEXT_STOP.has(w)) seen.add(w);
  }
  return [...seen]
    .sort((a, b) => b.length - a.length)
    .slice(0, CONTEXT_TERM_CAP)
    .join(" ");
}

/**
 * BM25 lexical index over note chunks (MiniSearch under the hood). Pure-JS and
 * iOS-safe. Provides the always-available search floor that works with no model
 * loaded; its ranked ids are later fused with the vector index via RRF.
 */
export class LexicalIndex {
  private engine: MiniSearch<LexicalDoc>;
  /** chunk ids belonging to each note path, so a note can be fully removed. */
  private pathIds = new Map<string, Set<string>>();
  /** Per-note searchable frontmatter (aliases, tags). */
  private metaByPath = new Map<string, string>();

  constructor() {
    this.engine = new MiniSearch<LexicalDoc>({
      fields: ["title", "heading", "meta", "text"],
      storeFields: ["path"],
      searchOptions: {
        boost: { title: 2, meta: 2, heading: 1.5 },
        prefix: true,
        fuzzy: 0.2,
        combineWith: "AND",
      },
    });
  }

  private toDoc(chunk: Chunk): LexicalDoc {
    return {
      id: chunk.id,
      path: chunk.path,
      title: titleFromPath(chunk.path),
      heading: chunk.heading ?? "",
      meta: this.metaByPath.get(chunk.path) ?? "",
      text: chunk.text,
    };
  }

  /**
   * Searchable frontmatter for a note (aliases, tags). Set before adding the
   * note's chunks; stored per path since it belongs to the note, not a chunk.
   */
  setMeta(path: string, meta: string): void {
    if (meta) this.metaByPath.set(path, meta);
    else this.metaByPath.delete(path);
  }

  /** Add or replace all chunks for a set (idempotent per chunk id). */
  add(chunks: Chunk[]): void {
    for (const chunk of chunks) {
      if (this.engine.has(chunk.id)) this.engine.replace(this.toDoc(chunk));
      else this.engine.add(this.toDoc(chunk));
      let ids = this.pathIds.get(chunk.path);
      if (!ids) {
        ids = new Set<string>();
        this.pathIds.set(chunk.path, ids);
      }
      ids.add(chunk.id);
    }
  }

  /** Remove every chunk belonging to a note path. */
  removePath(path: string): void {
    this.metaByPath.delete(path);
    const ids = this.pathIds.get(path);
    if (!ids) return;
    for (const id of ids) {
      if (this.engine.has(id)) this.engine.discard(id);
    }
    this.pathIds.delete(path);
  }

  /**
   * Ranked hits for a query (best first). mode "and" (default) is the search
   * behavior — every term must match; mode "or" suits long free-text contexts
   * (a draft paragraph) where any strong term overlap is a signal.
   *
   * `keepPath` filters DURING retrieval rather than after it: a scoped query
   * (`in:Research`) that filtered afterwards could come back empty simply
   * because none of the globally-top hits happened to live in that folder.
   */
  search(
    query: string,
    limit = 50,
    mode: "and" | "or" = "and",
    keepPath?: (path: string) => boolean,
  ): LexicalHit[] {
    // OR mode exists for whole draft paragraphs, and they need the opposite
    // search posture from a typed query: exact terms only, and few of them.
    // The constructor's fuzzy+prefix defaults are right for a 2-word search
    // box but catastrophic for an 80-term paragraph — fuzzy walks the whole
    // vocabulary per term, and this runs on the main thread at every typing
    // pause (the 2-second freeze of the 0.6.4 incident).
    const effective = mode === "or" ? contextTerms(query) : query;
    if (!effective.trim()) return [];
    return this.engine
      .search(effective, {
        ...(mode === "or"
          ? { combineWith: "OR" as const, fuzzy: false, prefix: false }
          : {}),
        ...(keepPath ? { filter: (r) => keepPath(r.path as string) } : {}),
      })
      .slice(0, limit)
      .map((r) => ({ id: r.id as string, path: r.path as string, score: r.score }));
  }

  /** Ranked chunk ids only — the shape RRF consumes. */
  rankedIds(
    query: string,
    limit = 50,
    mode: "and" | "or" = "and",
    keepPath?: (path: string) => boolean,
  ): string[] {
    return this.search(query, limit, mode, keepPath).map((h) => h.id);
  }

  get size(): number {
    return this.engine.documentCount;
  }
}
