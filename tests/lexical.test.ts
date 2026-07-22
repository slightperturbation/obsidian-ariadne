import { describe, it, expect } from "vitest";
import { LexicalIndex } from "../src/index/lexical";
import { chunkNote } from "../src/index/chunker";

describe("LexicalIndex", () => {
  const build = () => {
    const idx = new LexicalIndex();
    idx.add(chunkNote("Open-endedness.md", "# Open-endedness\n\nExploratory search opens new doorways and dimensions."));
    idx.add(chunkNote("Agents.md", "# Agents\n\nPlanning, memory, and tools define an agent."));
    return idx;
  };

  it("finds the relevant note by content", () => {
    const idx = build();
    const hits = idx.search("doorways");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe("Open-endedness.md");
  });

  it("matches on the title/filename", () => {
    const idx = build();
    const hits = idx.search("agents");
    expect(hits[0].path).toBe("Agents.md");
  });

  it("returns ranked ids for fusion and removes by path", () => {
    const idx = build();
    expect(idx.rankedIds("planning").length).toBeGreaterThan(0);
    idx.removePath("Agents.md");
    expect(idx.search("planning")).toHaveLength(0);
  });

  it("returns nothing for an empty query", () => {
    expect(build().search("   ")).toEqual([]);
  });
});
