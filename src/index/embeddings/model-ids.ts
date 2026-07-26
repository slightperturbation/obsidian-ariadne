/**
 * Model identity and dimensions — deliberately free of any transformers.js
 * import.
 *
 * The main thread needs to know a model's id and dimension (to name a snapshot
 * and size a vector store) but never runs inference. When these lived beside
 * `TransformersEmbedder`, importing them dragged the whole transformers.js +
 * onnxruntime-web glue into main.js, to be parsed on the UI thread at every
 * plugin load — a few hundred KB of code the main thread never calls, and on a
 * phone that parse is not free.
 */

/** Where ONNX Runtime loads its engine from (blob: URLs, built at runtime). */
export interface OrtWasmPaths {
  mjs: string;
  wasm: string;
}

const DIMS: Record<string, number> = {
  "Xenova/bge-small-en-v1.5": 384,
  "Snowflake/snowflake-arctic-embed-xs": 384,
};

/** Map a bare settings value ("bge-small-en-v1.5") to a hub repo id. */
export function resolveModelId(model: string): string {
  return model.includes("/") ? model : `Xenova/${model}`;
}

export function modelDim(model: string): number {
  return DIMS[resolveModelId(model)] ?? 384;
}

/** The id a provider reports for `model`, whatever host it runs in. */
export function embedderId(model: string): string {
  return `transformers:${resolveModelId(model)}`;
}
