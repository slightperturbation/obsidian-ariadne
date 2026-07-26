import { describe, expect, it } from "vitest";
import { TransformersEmbedder } from "../src/index/embeddings/transformers-provider";
import { resolveModelId } from "../src/index/embeddings/model-ids";

describe("resolveModelId", () => {
  it("prefixes bare names with Xenova/ and passes repo ids through", () => {
    expect(resolveModelId("bge-small-en-v1.5")).toBe("Xenova/bge-small-en-v1.5");
    expect(resolveModelId("onnx-community/foo")).toBe("onnx-community/foo");
  });
});

/**
 * Real-model integration test: downloads bge-small (~30 MB, cached after the
 * first run) and checks the embeddings are actually semantic. Gated behind an
 * env var so the normal suite stays offline and fast:
 *   ARIADNE_REAL_EMBEDDINGS=1 npx vitest run tests/transformers-provider.integration.test.ts
 */
describe.skipIf(!process.env.ARIADNE_REAL_EMBEDDINGS)("TransformersEmbedder (real model)", () => {
  const cosine = (a: Float32Array, b: Float32Array) => {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot; // vectors come back normalized
  };

  it("embeds semantically: related texts closer than unrelated", { timeout: 300_000 }, async () => {
    const embedder = new TransformersEmbedder();
    await embedder.ready();

    const [cat, kitten, tax] = await embedder.embed([
      "A cat sat on the windowsill watching birds.",
      "The kitten perched by the window, eyeing sparrows.",
      "Quarterly estimated tax payments are due in April.",
    ]);
    expect(cat).toHaveLength(embedder.dim);
    expect(cosine(cat, kitten)).toBeGreaterThan(cosine(cat, tax) + 0.1);

    // Query path (BGE instruction prefix) still lands near the right doc.
    const query = await embedder.embedQuery("pet looking out the window");
    expect(cosine(query, cat)).toBeGreaterThan(cosine(query, tax));
  });
});
