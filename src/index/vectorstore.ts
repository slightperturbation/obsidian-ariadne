export interface VectorHit {
  id: string;
  /** cosine similarity in [-1, 1]. */
  score: number;
}

/**
 * Brute-force cosine vector store. Vectors are normalized on insert, so a query
 * reduces to a dot-product scan. Correct and fast below ~20k vectors, which is
 * well beyond this vault; avoids the extra WASM/ANN failure surface (especially
 * on iOS). Ids are chunk ids; note-path tracking allows whole-note removal.
 */
export class VectorStore {
  private vectors = new Map<string, Float32Array>();
  private pathIds = new Map<string, Set<string>>();

  constructor(public readonly dim: number) {}

  private normalize(v: ArrayLike<number>): Float32Array {
    const out = new Float32Array(this.dim);
    let norm = 0;
    for (let i = 0; i < this.dim; i++) {
      const x = v[i] ?? 0;
      out[i] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dim; i++) out[i] /= norm;
    return out;
  }

  upsert(id: string, path: string, vec: ArrayLike<number>): void {
    if (vec.length !== this.dim) {
      throw new Error(`vector dim ${vec.length} != store dim ${this.dim}`);
    }
    this.vectors.set(id, this.normalize(vec));
    let ids = this.pathIds.get(path);
    if (!ids) {
      ids = new Set<string>();
      this.pathIds.set(path, ids);
    }
    ids.add(id);
  }

  removePath(path: string): void {
    const ids = this.pathIds.get(path);
    if (!ids) return;
    for (const id of ids) this.vectors.delete(id);
    this.pathIds.delete(path);
  }

  search(query: ArrayLike<number>, limit = 50): VectorHit[] {
    const q = this.normalize(query);
    const hits: VectorHit[] = [];
    for (const [id, vec] of this.vectors) {
      let dot = 0;
      for (let i = 0; i < this.dim; i++) dot += q[i] * vec[i];
      hits.push({ id, score: dot });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, limit);
  }

  rankedIds(query: ArrayLike<number>, limit = 50): string[] {
    return this.search(query, limit).map((h) => h.id);
  }

  /** All stored vectors (normalized), for persistence snapshots. */
  entries(): IterableIterator<[string, Float32Array]> {
    return this.vectors.entries();
  }

  has(id: string): boolean {
    return this.vectors.has(id);
  }

  get size(): number {
    return this.vectors.size;
  }
}
