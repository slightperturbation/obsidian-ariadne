import { describe, it, expect } from "vitest";
import { VectorStore } from "../src/index/vectorstore";

describe("VectorStore", () => {
  it("ranks the most similar vector first (cosine)", () => {
    const store = new VectorStore(3);
    store.upsert("a", "a.md", [1, 0, 0]);
    store.upsert("b", "b.md", [0, 1, 0]);
    store.upsert("c", "c.md", [0.9, 0.1, 0]);
    const hits = store.search([1, 0, 0]);
    expect(hits[0].id).toBe("a");
    expect(hits[1].id).toBe("c");
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("is scale-invariant (normalizes on insert and query)", () => {
    const store = new VectorStore(2);
    store.upsert("x", "x.md", [2, 0]);
    const hits = store.search([10, 0]);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("removes all vectors for a path", () => {
    const store = new VectorStore(2);
    store.upsert("p#0", "p.md", [1, 0]);
    store.upsert("p#1", "p.md", [0, 1]);
    store.upsert("q#0", "q.md", [1, 1]);
    store.removePath("p.md");
    expect(store.size).toBe(1);
    expect(store.search([1, 0]).every((h) => h.id.startsWith("q"))).toBe(true);
  });

  it("rejects vectors of the wrong dimension", () => {
    const store = new VectorStore(3);
    expect(() => store.upsert("a", "a.md", [1, 0])).toThrow();
  });
});
