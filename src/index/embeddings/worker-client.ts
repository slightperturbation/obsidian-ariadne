import type { OrtWasmPaths } from "./model-ids";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

interface Pending {
  resolve: (msg: WorkerResponse) => void;
  reject: (err: Error) => void;
}

/**
 * Owns the single index worker and multiplexes requests over it, so the
 * embedder and the vector index share one thread and one model instance
 * rather than each spinning up their own.
 *
 * postMessage preserves order, which is what lets mutations be fire-and-forget:
 * an upsert posted before a search is guaranteed to be applied first.
 */
export class WorkerClient {
  private worker?: Worker;
  private loading?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private opts: { workerUrl: string; model: string; wasmPaths?: OrtWasmPaths },
  ) {}

  ready(): Promise<void> {
    this.loading ??= new Promise<void>((resolve, reject) => {
      try {
        this.worker = new Worker(this.opts.workerUrl, { name: "ariadne-index" });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as WorkerResponse);
      this.worker.onerror = (ev: ErrorEvent) => {
        const err = new Error(ev.message || "index worker crashed");
        this.failAll(err);
        reject(err);
      };
      const id = this.nextId++;
      this.pending.set(id, { resolve: () => resolve(), reject });
      this.worker.postMessage({
        type: "init",
        id,
        model: this.opts.model,
        wasmPaths: this.opts.wasmPaths,
      } satisfies WorkerRequest);
    }).catch((err) => {
      // Allow a retry instead of caching the failure forever.
      this.loading = undefined;
      this.dispose();
      throw err;
    });
    return this.loading;
  }

  private onMessage(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /** Send a request and await its reply. */
  async request(
    build: (id: number) => WorkerRequest,
    transfer?: Transferable[],
  ): Promise<WorkerResponse> {
    await this.ready();
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage(build(id), transfer ?? []);
    });
  }

  /**
   * Send without awaiting a reply — for mutations, whose ordering the
   * transport already guarantees. Errors surface on the next read.
   */
  post(build: (id: number) => WorkerRequest, transfer?: Transferable[]): void {
    void this.ready().then(
      () => {
        const id = this.nextId++;
        // Swallow the reply; failures show up as an empty/stale search later,
        // and the scheduler re-indexes on the next change.
        this.pending.set(id, { resolve: () => {}, reject: () => {} });
        this.worker?.postMessage(build(id), transfer ?? []);
      },
      () => {
        /* worker unavailable; the caller already degrades to lexical */
      },
    );
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.failAll(new Error("index worker disposed"));
  }
}
