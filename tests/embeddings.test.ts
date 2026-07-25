import { describe, it, expect } from "vitest";
import { HashEmbedder } from "../src/index/embeddings/hash-embedder";
import { VectorStore } from "../src/index/vectorstore";

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

describe("HashEmbedder", () => {
  it("is deterministic and correctly dimensioned", async () => {
    const e = new HashEmbedder(64);
    const [v1] = await e.embed(["open endedness"]);
    const [v2] = await e.embed(["open endedness"]);
    expect(v1.length).toBe(64);
    expect(Array.from(v1)).toEqual(Array.from(v2));
    expect(e.id).toBe("hash-64");
  });

  it("scores overlapping text more similar than disjoint text", async () => {
    const e = new HashEmbedder(512);
    const [base, near, far] = await e.embed([
      "convergent evolution of camera eyes",
      "camera eyes and convergent evolution",
      "quarterly revenue spreadsheet totals",
    ]);
    expect(cosine(base, near)).toBeGreaterThan(cosine(base, far));
  });

  it("feeds the vector store end to end", async () => {
    const e = new HashEmbedder(256);
    const store = new VectorStore(e.dim);
    const [a, b] = await e.embed(["agents plan and use tools", "photography lightroom workflow"]);
    store.upsert("a", "a.md", a);
    store.upsert("b", "b.md", b);
    const [q] = await e.embed(["planning agent tools"]);
    expect((await store.search(q, 10, -1))[0].id).toBe("a");
  });
});
