import type { EmbeddingProvider } from "./provider";

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function hashToken(token: string): number {
  let h = FNV_OFFSET >>> 0;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

/**
 * A deterministic, dependency-free "hashing bag-of-words" embedder. It is NOT
 * semantic — it captures lexical overlap only — but it lets the whole retrieval
 * pipeline (index → vector store → fusion) run and be unit-tested offline, and
 * serves as a last-resort fallback when no real embedding model can load
 * (notably a failure mode on iOS). The real semantic provider implements the
 * same interface and swaps in transparently.
 */
export class HashEmbedder implements EmbeddingProvider {
  readonly id: string;

  constructor(public readonly dim = 256) {
    this.id = `hash-${dim}`;
  }

  async ready(): Promise<void> {
    /* nothing to load */
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  }

  embedOne(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const token of this.tokenize(text)) {
      v[hashToken(token) % this.dim] += 1;
    }
    return v;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }
}
