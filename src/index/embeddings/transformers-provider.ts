import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { EmbeddingProvider } from "./provider";
import { embedderId, modelDim, resolveModelId, type OrtWasmPaths } from "./model-ids";



/** BGE retrieval instruction — queries get it, documents must not. */
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export interface TransformersOptions {
  ortWasmPaths?: OrtWasmPaths;
  /**
   * Pin the ONNX execution device. Leave unset to let transformers pick per
   * environment (node → cpu, browser → wasm). Inside Obsidian this class must
   * run in a Web Worker with device "wasm": the renderer exposes `process`, so
   * transformers mis-detects Node and demands native backends we don't ship.
   */
  device?: "wasm" | "cpu";
}

/**
 * Real semantic embeddings via transformers.js (ONNX Runtime). The model
 * (~30 MB, int8) downloads from the HuggingFace hub on first use and is cached
 * by the browser Cache API after that, so only the very first run needs the
 * network. Loading is lazy and single-flight; callers race ready() themselves
 * and fall back to the hash embedder if this provider can't come up.
 */
export class TransformersEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dim: number;
  /** bge-small: unrelated text ~0.3–0.5, genuinely related ~0.7+. */
  readonly floor = 0.6;

  private readonly modelId: string;
  private extractor?: FeatureExtractionPipeline;
  private loading?: Promise<void>;

  constructor(
    model = "bge-small-en-v1.5",
    private opts: TransformersOptions = {},
  ) {
    this.modelId = resolveModelId(model);
    this.id = embedderId(model);
    this.dim = modelDim(model);
  }

  ready(): Promise<void> {
    this.loading ??= (async () => {
      if (this.opts.ortWasmPaths && env.backends.onnx.wasm) {
        env.backends.onnx.wasm.wasmPaths = { ...this.opts.ortWasmPaths };
      }
      this.extractor = await pipeline("feature-extraction", this.modelId, {
        dtype: "q8",
        ...(this.opts.device ? { device: this.opts.device } : {}),
      });
    })().catch((err) => {
      // Allow a later retry instead of caching the failure forever.
      this.loading = undefined;
      throw err;
    });
    return this.loading;
  }

  private isBge(): boolean {
    return this.modelId.toLowerCase().includes("bge");
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    await this.ready();
    const output = await this.extractor!(texts, { pooling: "mean", normalize: true });
    // Tensor [batch, dim] → one Float32Array per input.
    const data = output.data as Float32Array;
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      out.push(new Float32Array(data.subarray(i * this.dim, (i + 1) * this.dim)));
    }
    output.dispose?.();
    return out;
  }

  embed(texts: string[]): Promise<Float32Array[]> {
    return this.run(texts);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const prefixed = this.isBge() ? BGE_QUERY_PREFIX + text : text;
    const [vec] = await this.run([prefixed]);
    return vec;
  }
}
