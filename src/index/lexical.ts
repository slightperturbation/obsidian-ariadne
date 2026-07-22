import MiniSearch from "minisearch";
import type { Chunk } from "../core/types";

interface LexicalDoc {
  id: string;
  path: string;
  title: string;
  heading: string;
  text: string;
}

export interface LexicalHit {
  id: string;
  path: string;
  score: number;
}

const titleFromPath = (path: string): string =>
  (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/**
 * BM25 lexical index over note chunks (MiniSearch under the hood). Pure-JS and
 * iOS-safe. Provides the always-available search floor that works with no model
 * loaded; its ranked ids are later fused with the vector index via RRF.
 */
export class LexicalIndex {
  private engine: MiniSearch<LexicalDoc>;
  /** chunk ids belonging to each note path, so a note can be fully removed. */
  private pathIds = new Map<string, Set<string>>();

  constructor() {
    this.engine = new MiniSearch<LexicalDoc>({
      fields: ["title", "heading", "text"],
      storeFields: ["path"],
      searchOptions: {
        boost: { title: 2, heading: 1.5 },
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
      text: chunk.text,
    };
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
    const ids = this.pathIds.get(path);
    if (!ids) return;
    for (const id of ids) {
      if (this.engine.has(id)) this.engine.discard(id);
    }
    this.pathIds.delete(path);
  }

  /** Ranked hits for a query (best first). */
  search(query: string, limit = 50): LexicalHit[] {
    if (!query.trim()) return [];
    return this.engine
      .search(query)
      .slice(0, limit)
      .map((r) => ({ id: r.id as string, path: r.path as string, score: r.score }));
  }

  /** Ranked chunk ids only — the shape RRF consumes. */
  rankedIds(query: string, limit = 50): string[] {
    return this.search(query, limit).map((h) => h.id);
  }

  get size(): number {
    return this.engine.documentCount;
  }
}
