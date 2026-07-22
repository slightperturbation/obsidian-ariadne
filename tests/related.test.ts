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
  it("ranks contextually similar notes first and carries cosine", async () => {
    const manager = await build();
    const results = await manager.related("My pet mammals sleep all day", {});
    expect(results.length).toBeGreaterThan(0);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("cats.md");
    expect(paths.indexOf("cats.md")).toBeLessThan(paths.indexOf("taxes.md"));
    expect(results[0].cosine).toBeTypeOf("number");
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
