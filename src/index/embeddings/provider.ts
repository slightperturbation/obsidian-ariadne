/**
 * A source of text embeddings. Implementations: a local on-device model
 * (transformers.js / ONNX Runtime Web) on desktop and, where viable, iOS; a
 * lightweight deterministic fallback (see HashEmbedder); and later a remote
 * option. The index depends only on this interface, so providers are swappable
 * and the retrieval core stays testable without downloading a model.
 */
export interface EmbeddingProvider {
  /** Stable identifier, e.g. "bge-small-en-v1.5" or "hash-256". */
  readonly id: string;
  /** Output dimensionality. */
  readonly dim: number;
  /**
   * Minimum cosine for a hit to be worth fusing, in THIS provider's own
   * distribution. Different embedders occupy different similarity ranges — a
   * true semantic model separates related (~0.7+) from unrelated (~0.3–0.5),
   * while the hashing fallback is bag-of-words overlap and sits lower — so the
   * floor belongs to the provider, not to the index.
   */
  readonly floor: number;
  /** Resolve once the provider is usable (model loaded, etc.). */
  ready(): Promise<void>;
  /** Embed a batch of texts, preserving order. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /**
   * Embed a search query. Retrieval models like BGE want queries prefixed with
   * an instruction that documents don't get; providers that care implement
   * this, everyone else falls back to embed().
   */
  embedQuery?(text: string): Promise<Float32Array>;
}
