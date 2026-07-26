import { describe, expect, it } from "vitest";
import { IndexManager } from "../src/index/manager";
import { HashEmbedder } from "../src/index/embeddings/hash-embedder";
import type { SourceNote } from "../src/core/types";

function note(path: string, content: string): SourceNote {
  return { path, title: path.replace(/\.md$/, ""), content, mtime: Date.now(), folder: "" };
}

async function build(): Promise<IndexManager> {
  const manager = new IndexManager(new HashEmbedder(64));
  for (const n of [
    note("cats.md", "Cats are small carnivorous mammals often kept as pets."),
    note("dogs.md", "Dogs are loyal domesticated mammals kept as pets."),
    note("taxes.md", "Quarterly estimated tax payments are due in April."),
  ]) {
    await manager.indexNote(n);
  }
  return manager;
}

describe("IndexManager.related", () => {
  it("surfaces contextually similar notes", async () => {
    const manager = await build();
    const results = await manager.related("My pet mammals sleep all day", {});
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.path)).toContain("cats.md");
  });

  it("carries a raw cosine (not a [0,1]-remapped one) when a vector matched", async () => {
    const manager = await build();
    // Near-verbatim context, so the hit clears the embedder's floor.
    const results = await manager.related(
      "Cats are small carnivorous mammals often kept as pets.",
      {},
    );
    const cats = results.find((r) => r.path === "cats.md");
    expect(cats?.cosine).toBeTypeOf("number");
    // A remap of [-1,1]→[0,1] would floor every value at 0.5; raw values run
    // the full range, which is what every suggestion threshold assumes.
    expect(cats!.cosine!).toBeGreaterThan(0.5);
    expect(cats!.cosine!).toBeLessThanOrEqual(1);
  });

  it("drops notes below the embedder's similarity floor instead of ranking them last", async () => {
    const manager = await build();
    const results = await manager.related("My pet mammals sleep all day", {});
    // "Quarterly estimated tax payments…" shares no meaning with the context.
    // Before the floor it still came back (as noise) at the bottom of the list.
    expect(results.map((r) => r.path)).not.toContain("taxes.md");
  });

  it("excludes the note being written", async () => {
    const manager = await build();
    const results = await manager.related("Cats are small carnivorous mammals", {
      excludePath: "cats.md",
    });
    expect(results.map((r) => r.path)).not.toContain("cats.md");
  });

  it("strips wikilink brackets from the context before matching", async () => {
    const manager = await build();
    const withLinks = await manager.related("thinking about [[pets]] and mammals", {});
    expect(withLinks.length).toBeGreaterThan(0);
  });

  it("returns nothing for empty context", async () => {
    const manager = await build();
    expect(await manager.related("   ", {})).toEqual([]);
  });
});

describe("retrieval scoping and gating", () => {
  it("finds a note by a frontmatter alias it never mentions in its body", async () => {
    const manager = new IndexManager(new HashEmbedder(64));
    await manager.indexNote({
      ...note("kb.md", "A running record of what we tried and why."),
      frontmatter: { aliases: ["decision log"], tags: ["process"] },
    });
    expect((await manager.query("decision log")).map((r) => r.path)).toContain("kb.md");
    expect((await manager.query("process")).map((r) => r.path)).toContain("kb.md");
  });

  it("does not return empty for a scoped query whose hits rank below the global top", async () => {
    const manager = new IndexManager(new HashEmbedder(64));
    // Many strong "pets" hits outside Research, one weaker one inside it.
    for (let i = 0; i < 40; i++) {
      await manager.indexNote({
        ...note(`Notes/pets-${i}.md`, "Pets are mammals kept as pets, pets pets."),
        folder: "Notes",
      });
    }
    await manager.indexNote({
      ...note("Research/one.md", "A passing remark about pets."),
      folder: "Research",
    });
    const scoped = await manager.query("in:Research pets");
    expect(scoped.map((r) => r.path)).toEqual(["Research/one.md"]);
  });

  it("Margin gating drops weak hits and notes already linked from the draft", async () => {
    const manager = await build();
    const all = await manager.related("Cats are small carnivorous mammals often kept as pets.", {});
    expect(all.map((r) => r.path)).toContain("cats.md");

    const gated = await manager.related(
      "Cats are small carnivorous mammals often kept as pets.",
      { excludeTitles: new Set(["cats"]) },
    );
    expect(gated.map((r) => r.path)).not.toContain("cats.md");

    // An impossible floor leaves nothing: an empty Margin is a valid outcome.
    const floored = await manager.related("My pet mammals sleep all day", { minCosine: 0.999 });
    expect(floored).toHaveLength(0);
  });

  it("raises confidence for notes in the draft's link neighbourhood", async () => {
    const manager = await build();
    const plain = await manager.related("My pet mammals sleep all day", {});
    const near = await manager.related("My pet mammals sleep all day", {
      neighbors: new Set(plain.map((r) => r.path)),
    });
    for (const r of near) {
      const before = plain.find((p) => p.path === r.path)!;
      expect(r.confidence).toBeGreaterThanOrEqual(before.confidence);
    }
    expect(near.some((r, i) => r.confidence > plain[i].confidence)).toBe(true);
  });
});
