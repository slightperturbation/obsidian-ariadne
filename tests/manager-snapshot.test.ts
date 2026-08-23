import { describe, expect, it, vi } from "vitest";
import { IndexManager } from "../src/index/manager";
import { VectorStore } from "../src/index/vectorstore";
import { HashEmbedder } from "../src/index/embeddings/hash-embedder";
import type { EmbeddingProvider } from "../src/index/embeddings/provider";
import type { SourceNote } from "../src/core/types";

function note(path: string, content: string, extra: Partial<SourceNote> = {}): SourceNote {
  return {
    path,
    title: path.replace(/\.md$/, ""),
    content,
    mtime: 1000,
    folder: "",
    ...extra,
  };
}

const NOTES = [
  note("cats.md", "Cats are small carnivorous mammals often kept as pets."),
  note("taxes.md", "Quarterly estimated tax payments are due in April."),
  note("empty.md", ""),
];

async function indexAll(manager: IndexManager, notes = NOTES) {
  for (const n of notes) await manager.indexNote(n);
}

/** Strip spark.recency, which depends on Date.now() at query time. */
const stable = (results: Awaited<ReturnType<IndexManager["query"]>>) =>
  results.map(({ spark, ...rest }) => ({ ...rest, linked: spark?.linked, atomicity: spark?.atomicity }));

describe("IndexManager snapshot/restore", () => {
  it("query results survive a snapshot → restore round-trip", async () => {
    const original = new IndexManager(new HashEmbedder(64));
    await indexAll(original);
    const before = await original.query("carnivorous mammals");

    const restored = new IndexManager();
    restored.restore(await original.snapshot());
    // No embedder attached yet → lexical-only compare.
    const afterLexical = await restored.query("carnivorous mammals", { semantic: false });
    const beforeLexical = await original.query("carnivorous mammals", { semantic: false });
    expect(stable(afterLexical)).toEqual(stable(beforeLexical));

    // Attaching the same embedder id keeps the restored vectors: no backfill.
    const backfill = restored.setEmbedder(new HashEmbedder(64));
    expect(backfill).toEqual([]);
    expect(stable(await restored.query("carnivorous mammals"))).toEqual(stable(before));
  });

  it("late embedder attach reports notes needing backfill, which clears after re-index", async () => {
    const manager = new IndexManager(); // lexical-only start
    await indexAll(manager);

    const backfill = manager.setEmbedder(new HashEmbedder(64));
    // empty.md now yields a title-only chunk, so it needs embedding too.
    expect(backfill.sort()).toEqual(["cats.md", "empty.md", "taxes.md"]);

    for (const n of NOTES) await manager.indexNote(n);
    expect(manager.setEmbedder(new HashEmbedder(64))).toEqual([]);
  });

  it("swapping to a different embedder invalidates all vectors", async () => {
    const manager = new IndexManager(new HashEmbedder(64));
    await indexAll(manager);
    const backfill = manager.setEmbedder(new HashEmbedder(128));
    expect(backfill.sort()).toEqual(["cats.md", "empty.md", "taxes.md"]);
  });

  it("prefers embedQuery for the query vector when the provider has one", async () => {
    const embedQuery = vi.fn(async () => new Float32Array(64).fill(0.1));
    const base = new HashEmbedder(64);
    const provider: EmbeddingProvider = {
      id: "spy-64",
      dim: 64,
      floor: 0.6,
      ready: async () => {},
      embed: (texts) => base.embed(texts),
      embedQuery,
    };
    const manager = new IndexManager(provider);
    await indexAll(manager);
    await manager.query("cats");
    expect(embedQuery).toHaveBeenCalledWith("cats");
  });

  it("revision bumps on mutation, not on query", async () => {
    const manager = new IndexManager();
    const r0 = manager.revision;
    await manager.indexNote(NOTES[0]);
    expect(manager.revision).toBeGreaterThan(r0);
    const r1 = manager.revision;
    await manager.query("cats");
    expect(manager.revision).toBe(r1);
    manager.removeNote("cats.md");
    expect(manager.revision).toBeGreaterThan(r1);
    manager.removeNote("never-existed.md");
    expect(manager.revision).toBe(r1 + 1);
  });
});

describe("warm start does not re-embed the vault", () => {
  it("same embedder + worker store arriving → vectors migrate, backfill is empty", async () => {
    const embedder = new HashEmbedder(64);
    const owner = new IndexManager(embedder);
    await owner.indexNote({
      path: "a.md", title: "a", folder: "", mtime: 1,
      content: "Cats are small carnivorous mammals often kept as pets.",
    });
    await owner.indexNote({
      path: "b.md", title: "b", folder: "", mtime: 1,
      content: "Dogs are loyal domesticated mammals kept as pets.",
    });
    const snap = await owner.snapshot();

    // Next session: restore, then the "worker" store arrives for the SAME
    // embedder. The old behavior invalidated everything here — a full
    // re-embed of the vault on every single startup.
    const next = new IndexManager();
    next.restore(snap);
    const target = new VectorStore(64); // stands in for the worker store
    const backfill = next.setEmbedder(new HashEmbedder(64), target);

    expect(backfill).toEqual([]); // nothing to re-embed
    // And the migrated vectors actually answer queries.
    const hits = await next.related("small carnivorous cats kept as pets", {});
    expect(hits.map((h) => h.path)).toContain("a.md");
    expect(hits.find((h) => h.path === "a.md")?.cosine).toBeTypeOf("number");
  });

  it("a DIFFERENT embedder still invalidates everything", async () => {
    const owner = new IndexManager(new HashEmbedder(64));
    await owner.indexNote({
      path: "a.md", title: "a", folder: "", mtime: 1,
      content: "Cats are small carnivorous mammals often kept as pets.",
    });
    const next = new IndexManager();
    next.restore(await owner.snapshot());
    const other = new HashEmbedder(32); // different id + dim
    const backfill = next.setEmbedder(other, new VectorStore(32));
    expect(backfill).toEqual(["a.md"]);
  });

  it("notes edited on a reader (no vectors) stay in the backfill set", async () => {
    const owner = new IndexManager(new HashEmbedder(64));
    await owner.indexNote({
      path: "a.md", title: "a", folder: "", mtime: 1,
      content: "Cats are small carnivorous mammals often kept as pets.",
    });
    const next = new IndexManager();
    next.restore(await owner.snapshot());
    // A lexical-only re-index (reader edit) strips a.md's vectors.
    await next.indexNote({
      path: "a.md", title: "a", folder: "", mtime: 2,
      content: "Cats, revised on a phone with no model.",
    });
    const backfill = next.setEmbedder(new HashEmbedder(64), new VectorStore(64));
    expect(backfill).toEqual(["a.md"]); // only the genuinely-missing note
  });
});
