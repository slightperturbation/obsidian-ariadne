import type { EmbeddingProvider } from "./provider";
import { modelDim, resolveModelId } from "./transformers-provider";
import type { WorkerClient } from "./worker-client";

/**
 * Main-thread face of the worker-hosted embedder. Every model load and every
 * batch of embedding compute happens in the worker; the UI thread only passes
 * messages. Its id matches what an in-process TransformersEmbedder of the same
 * model would report, so persisted snapshots stay compatible across hosts.
 *
 * Note that during indexing the manager prefers the vector index's combined
 * embed-and-store path, so these methods are the fallback rather than the hot
 * path — vectors only cross the boundary when something on the main thread
 * genuinely needs them.
 */
export class WorkerEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  /** Same model as TransformersEmbedder, just hosted in the worker. */
  readonly floor = 0.6;

  constructor(
    model: string,
    private client: WorkerClient,
  ) {
    this.id = `transformers:${resolveModelId(model)}`;
    this.dim = modelDim(model);
  }

  ready(): Promise<void> {
    return this.client.ready();
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
    const msg = await this.client.request((id) => ({ type: "embed", id, texts }));
    if (msg.type !== "vectors") throw new Error("unexpected worker reply");
    return this.unpack(msg.dim, msg.buffer);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const msg = await this.client.request((id) => ({ type: "embedQuery", id, text }));
    if (msg.type !== "vectors") throw new Error("unexpected worker reply");
    return this.unpack(msg.dim, msg.buffer)[0];
  }
}
