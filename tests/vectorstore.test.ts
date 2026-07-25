import { describe, it, expect } from "vitest";
import { VectorStore } from "../src/index/vectorstore";

describe("VectorStore", () => {
  it("ranks the most similar vector first (cosine)", async () => {
    const store = new VectorStore(3);
    store.upsert("a", "a.md", [1, 0, 0]);
    store.upsert("b", "b.md", [0, 1, 0]);
    store.upsert("c", "c.md", [0.9, 0.1, 0]);
    const hits = await store.search([1, 0, 0], 10, -1);
    expect(hits[0].id).toBe("a");
    expect(hits[1].id).toBe("c");
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("is scale-invariant (normalizes on insert and query)", async () => {
    const store = new VectorStore(2);
    store.upsert("x", "x.md", [2, 0]);
    const hits = await store.search([10, 0], 10, -1);
    expect(hits[0].score).toBeCloseTo(1, 5);
  });

  it("removes all vectors for a path", async () => {
    const store = new VectorStore(2);
    store.upsert("p#0", "p.md", [1, 0]);
    store.upsert("p#1", "p.md", [0, 1]);
    store.upsert("q#0", "q.md", [1, 1]);
    store.removePath("p.md");
    expect(store.size).toBe(1);
    const hits = await store.search([1, 0], 10, -1);
    expect(hits.every((h) => h.id.startsWith("q"))).toBe(true);
  });

  it("rejects vectors of the wrong dimension", () => {
    const store = new VectorStore(3);
    expect(() => store.upsert("a", "a.md", [1, 0])).toThrow();
  });

  it("honours the similarity floor and the limit", async () => {
    const store = new VectorStore(2);
    store.upsert("near", "a.md", [1, 0]);
    store.upsert("mid", "b.md", [0.7, 0.7]);
    store.upsert("far", "c.md", [0, 1]);

    const floored = await store.search([1, 0], 10, 0.6);
    expect(floored.map((h) => h.id)).toEqual(["near", "mid"]);

    const limited = await store.search([1, 0], 1, -1);
    expect(limited).toHaveLength(1);
    expect(limited[0].id).toBe("near");
  });

  it("reuses freed slots without corrupting results", async () => {
    const store = new VectorStore(2);
    store.upsert("a#0", "a.md", [1, 0]);
    store.upsert("b#0", "b.md", [0, 1]);
    store.removePath("a.md");
    // Should land in the slot "a#0" vacated.
    store.upsert("c#0", "c.md", [1, 0]);

    expect(store.size).toBe(2);
    const hits = await store.search([1, 0], 10, -1);
    expect(hits[0].id).toBe("c#0");
    expect(hits.map((h) => h.id)).not.toContain("a#0");
  });

  it("grows past its initial capacity", async () => {
    const store = new VectorStore(2);
    // Spread the vectors around the unit circle so each direction is distinct
    // (normalizing [i, 1] would collapse them all toward [1, 0]).
    const angle = (i: number) => (i / 500) * Math.PI * 2;
    for (let i = 0; i < 500; i++) {
      store.upsert(`v${i}`, `n${i}.md`, [Math.cos(angle(i)), Math.sin(angle(i))]);
    }
    expect(store.size).toBe(500);
    const hits = await store.search([Math.cos(angle(499)), Math.sin(angle(499))], 3, -1);
    expect(hits[0].id).toBe("v499");
  });

  it("round-trips every stored vector through entries()", async () => {
    const store = new VectorStore(2);
    store.upsert("a", "a.md", [3, 4]); // normalizes to [0.6, 0.8]
    store.upsert("b", "b.md", [0, 2]);
    const entries = await store.entries();
    expect(entries.map(([id]) => id).sort()).toEqual(["a", "b"]);
    const a = entries.find(([id]) => id === "a")![1];
    expect(a[0]).toBeCloseTo(0.6, 5);
    expect(a[1]).toBeCloseTo(0.8, 5);
  });

  it("replacePath swaps a note's vectors atomically", async () => {
    const store = new VectorStore(2);
    store.upsert("n#0", "n.md", [1, 0]);
    store.upsert("n#1", "n.md", [1, 0]);
    store.replacePath("n.md", [{ id: "n#0", text: "", vec: [0, 1] }]);
    expect(store.size).toBe(1);
    const hits = await store.search([0, 1], 10, -1);
    expect(hits[0].id).toBe("n#0");
    expect(hits[0].score).toBeCloseTo(1, 5);
  });
});
