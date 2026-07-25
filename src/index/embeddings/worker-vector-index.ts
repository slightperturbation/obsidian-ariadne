import type { IndexEntry, VectorIndex, VectorHit } from "../vector-index";
import type { WorkerClient } from "./worker-client";

/**
 * Main-thread face of the worker-hosted vector store.
 *
 * The scan itself (~150 ms at 30k vectors) runs in the worker, so retrieval
 * can no longer freeze typing. Mutations are posted without awaiting — message
 * order guarantees they land before any later search — and the combined
 * indexTexts/embedAndSearch paths keep vectors from ever crossing the thread
 * boundary on the hot paths.
 */
export class WorkerVectorIndex implements VectorIndex {
  constructor(
    readonly dim: number,
    private client: WorkerClient,
  ) {}

  upsert(id: string, path: string, vec: ArrayLike<number>): void {
    const flat = new Float32Array(this.dim);
    flat.set(vec as ArrayLike<number> & Iterable<number>);
    this.client.post(
      (msgId) => ({
        type: "vec:upsert",
        id: msgId,
        path,
        ids: [id],
        buffer: flat.buffer,
      }),
      [flat.buffer],
    );
  }

  /** Bulk variant used by the warm start — one message per note, not per chunk. */
  upsertMany(path: string, entries: Array<{ id: string; vec: Float32Array }>): void {
    if (entries.length === 0) return;
    const flat = new Float32Array(entries.length * this.dim);
    entries.forEach((e, i) => flat.set(e.vec, i * this.dim));
    this.client.post(
      (msgId) => ({
        type: "vec:upsert",
        id: msgId,
        path,
        ids: entries.map((e) => e.id),
        buffer: flat.buffer,
      }),
      [flat.buffer],
    );
  }

  removePath(path: string): void {
    this.client.post((id) => ({ type: "vec:remove", id, path }));
  }

  async indexTexts(path: string, entries: IndexEntry[]): Promise<void> {
    if (entries.length === 0) {
      this.removePath(path);
      return;
    }
    const msg = await this.client.request((id) => ({ type: "vec:index", id, path, entries }));
    if (msg.type !== "ok") throw new Error("unexpected worker reply");
  }

  async search(query: ArrayLike<number>, limit: number, floor: number): Promise<VectorHit[]> {
    const flat = new Float32Array(this.dim);
    flat.set(query as ArrayLike<number> & Iterable<number>);
    const msg = await this.client.request(
      (id) => ({ type: "vec:search", id, buffer: flat.buffer, limit, floor }),
      [flat.buffer],
    );
    return msg.type === "hits" ? msg.hits : [];
  }

  async embedAndSearch(
    text: string,
    opts: { asQuery: boolean; limit: number; floor: number },
  ): Promise<VectorHit[]> {
    const msg = await this.client.request((id) => ({
      type: "vec:embedSearch",
      id,
      text,
      asQuery: opts.asQuery,
      limit: opts.limit,
      floor: opts.floor,
    }));
    return msg.type === "hits" ? msg.hits : [];
  }

  async entries(): Promise<Array<[string, Float32Array]>> {
    const msg = await this.client.request((id) => ({ type: "vec:entries", id }));
    if (msg.type !== "entries") return [];
    const flat = new Float32Array(msg.buffer);
    return msg.ids.map((id, i) => [
      id,
      flat.slice(i * msg.dim, (i + 1) * msg.dim),
    ]);
  }

  dispose(): void {
    this.client.dispose();
  }
}
