import type { IndexEntry, VectorIndex, VectorHit } from "./vector-index";

export type { VectorHit } from "./vector-index";

const INITIAL_SLOTS = 256;

/**
 * Brute-force cosine vector store. Vectors are normalized on insert, so a query
 * reduces to a dot-product scan.
 *
 * Storage is one contiguous Float32Array rather than a Map of small arrays:
 * at ~50k chunks that is the difference between 50k separately-allocated
 * typed arrays (poor cache locality, heavy object overhead) and a single
 * sequential scan. Search selects the top-k against a running threshold
 * instead of materializing and sorting a hit object per vector.
 *
 * No ANN index: exact search keeps the failure surface small (notably on iOS),
 * and with the scan off the main thread the cost is affordable at this scale.
 */
export class VectorStore implements VectorIndex {
  private data: Float32Array;
  /** slot → id, or null for a freed slot. */
  private slotIds: Array<string | null> = [];
  private slotOf = new Map<string, number>();
  private pathSlots = new Map<string, Set<number>>();
  private freeSlots: number[] = [];
  /** High-water mark of used slots (including freed holes below it). */
  private used = 0;

  constructor(public readonly dim: number) {
    this.data = new Float32Array(INITIAL_SLOTS * dim);
  }

  private ensureCapacity(slot: number): void {
    const needed = (slot + 1) * this.dim;
    if (needed <= this.data.length) return;
    let capacity = Math.max(this.data.length * 2, needed);
    // Grow in whole slots.
    capacity = Math.ceil(capacity / this.dim) * this.dim;
    const grown = new Float32Array(capacity);
    grown.set(this.data);
    this.data = grown;
  }

  /** Write `vec` normalized into `slot`. */
  private writeNormalized(slot: number, vec: ArrayLike<number>): void {
    const base = slot * this.dim;
    let norm = 0;
    for (let i = 0; i < this.dim; i++) {
      const x = vec[i] ?? 0;
      this.data[base + i] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) this.data[base + i] /= norm;
    }
  }

  upsert(id: string, path: string, vec: ArrayLike<number>): void {
    if (vec.length !== this.dim) {
      throw new Error(`vector dim ${vec.length} != store dim ${this.dim}`);
    }
    let slot = this.slotOf.get(id);
    if (slot === undefined) {
      slot = this.freeSlots.pop();
      if (slot === undefined) {
        slot = this.used;
        this.used += 1;
      }
      this.ensureCapacity(slot);
      this.slotOf.set(id, slot);
      this.slotIds[slot] = id;
    }
    this.writeNormalized(slot, vec);

    let slots = this.pathSlots.get(path);
    if (!slots) {
      slots = new Set<number>();
      this.pathSlots.set(path, slots);
    }
    slots.add(slot);
  }

  removePath(path: string): void {
    const slots = this.pathSlots.get(path);
    if (!slots) return;
    for (const slot of slots) {
      const id = this.slotIds[slot];
      if (id !== null && id !== undefined) this.slotOf.delete(id);
      this.slotIds[slot] = null;
      this.freeSlots.push(slot);
    }
    this.pathSlots.delete(path);
  }

  async search(query: ArrayLike<number>, limit = 50, floor = -1): Promise<VectorHit[]> {
    return this.searchSync(query, limit, floor);
  }

  /**
   * The stored (already normalized) vectors for one note's chunks.
   *
   * This is what lets a device with no embedding model still ask a semantic
   * question: the note you're reading was embedded by whichever device owns
   * the index, so "what else is like this note" needs no new inference — only
   * the vectors already on disk.
   */
  vectorsOfPathSync(path: string): Float32Array[] {
    const slots = this.pathSlots.get(path);
    if (!slots) return [];
    const out: Float32Array[] = [];
    for (const slot of slots) {
      if (this.slotIds[slot] == null) continue;
      const base = slot * this.dim;
      out.push(this.data.slice(base, base + this.dim));
    }
    return out;
  }

  async vectorsOfPath(path: string): Promise<Float32Array[]> {
    return this.vectorsOfPathSync(path);
  }

  /** The scan itself. Synchronous so the worker can call it directly. */
  searchSync(query: ArrayLike<number>, limit = 50, floor = -1): VectorHit[] {
    // Normalize the query once into a scratch buffer.
    const q = new Float32Array(this.dim);
    let qnorm = 0;
    for (let i = 0; i < this.dim; i++) {
      const x = query[i] ?? 0;
      q[i] = x;
      qnorm += x * x;
    }
    qnorm = Math.sqrt(qnorm);
    if (qnorm > 0) for (let i = 0; i < this.dim; i++) q[i] /= qnorm;

    // Top-k against a rising threshold: no per-vector allocation, no full sort.
    const topScores: number[] = [];
    const topSlots: number[] = [];
    let threshold = floor;

    for (let slot = 0; slot < this.used; slot++) {
      if (this.slotIds[slot] == null) continue;
      const base = slot * this.dim;
      let dot = 0;
      for (let i = 0; i < this.dim; i++) dot += q[i] * this.data[base + i];
      if (dot < threshold) continue;

      // Insertion into a k-sized descending list.
      let pos = topScores.length;
      while (pos > 0 && topScores[pos - 1] < dot) pos -= 1;
      topScores.splice(pos, 0, dot);
      topSlots.splice(pos, 0, slot);
      if (topScores.length > limit) {
        topScores.pop();
        topSlots.pop();
      }
      if (topScores.length === limit) {
        threshold = Math.max(floor, topScores[topScores.length - 1]);
      }
    }

    const hits: VectorHit[] = [];
    for (let i = 0; i < topSlots.length; i++) {
      const id = this.slotIds[topSlots[i]];
      if (id != null) hits.push({ id, score: topScores[i] });
    }
    return hits;
  }

  async entries(): Promise<Array<[string, Float32Array]>> {
    return this.entriesSync();
  }

  entriesSync(): Array<[string, Float32Array]> {
    const out: Array<[string, Float32Array]> = [];
    for (let slot = 0; slot < this.used; slot++) {
      const id = this.slotIds[slot];
      if (id == null) continue;
      const base = slot * this.dim;
      out.push([id, this.data.slice(base, base + this.dim)]);
    }
    return out;
  }

  has(id: string): boolean {
    return this.slotOf.has(id);
  }

  get size(): number {
    return this.slotOf.size;
  }

  /** Replace one note's vectors wholesale (the worker's atomic index step). */
  replacePath(path: string, entries: Array<IndexEntry & { vec: ArrayLike<number> }>): void {
    this.removePath(path);
    for (const e of entries) this.upsert(e.id, path, e.vec);
  }
}
