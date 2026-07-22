import type { EmbeddingProvider } from "./provider";
import type { OrtWasmPaths } from "./transformers-provider";
import { modelDim, resolveModelId } from "./transformers-provider";
import type { WorkerRequest, WorkerResponse } from "./embed-worker";

interface Pending {
  resolve: (buf: { dim: number; buffer: ArrayBuffer }) => void;
  reject: (err: Error) => void;
}

/**
 * Main-thread face of the worker-hosted embedder: implements the standard
 * EmbeddingProvider interface, but every model load and every batch of
 * embedding compute happens in the Web Worker — the UI thread only passes
 * messages, so indexing can never stall a keystroke. Its id matches what an
 * in-process TransformersEmbedder of the same model would report, keeping
 * persisted snapshots compatible across the two hosts.
 */
export class WorkerEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;

  private worker?: Worker;
  private loading?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private model: string,
    /** blob: URL of the bundled embed-worker.js. */
    private workerUrl: string,
    private wasmPaths?: OrtWasmPaths,
  ) {
    this.id = `transformers:${resolveModelId(model)}`;
    this.dim = modelDim(model);
  }

  ready(): Promise<void> {
    this.loading ??= new Promise<void>((resolve, reject) => {
      try {
        this.worker = new Worker(this.workerUrl, { name: "ariadne-embed" });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as WorkerResponse);
      this.worker.onerror = (ev: ErrorEvent) => {
        const err = new Error(ev.message || "embed worker crashed");
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        reject(err);
      };
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: () => resolve(),
        reject,
      });
      this.post({ type: "init", id, model: this.model, wasmPaths: this.wasmPaths });
    }).catch((err) => {
      // Allow a retry instead of caching the failure forever.
      this.loading = undefined;
      this.dispose();
      throw err;
    });
    return this.loading;
  }

  private post(msg: WorkerRequest): void {
    this.worker?.postMessage(msg);
  }

  private onMessage(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.message));
    else if (msg.type === "ready") p.resolve({ dim: this.dim, buffer: new ArrayBuffer(0) });
    else p.resolve({ dim: msg.dim, buffer: msg.buffer });
  }

  private request(msg: WorkerRequest): Promise<{ dim: number; buffer: ArrayBuffer }> {
    return new Promise((resolve, reject) => {
      this.pending.set(msg.id, { resolve, reject });
      this.post(msg);
    });
  }

  private unpack(dim: number, buffer: ArrayBuffer): Float32Array[] {
    const flat = new Float32Array(buffer);
    const out: Float32Array[] = [];
    for (let i = 0; i * dim < flat.length; i++) {
      out.push(flat.slice(i * dim, (i + 1) * dim));
    }
    return out;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.ready();
    const { dim, buffer } = await this.request({ type: "embed", id: this.nextId++, texts });
    return this.unpack(dim, buffer);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    await this.ready();
    const { dim, buffer } = await this.request({ type: "embedQuery", id: this.nextId++, text });
    return this.unpack(dim, buffer)[0];
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    const err = new Error("embedder disposed");
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
