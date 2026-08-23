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

describe("paragraph-context (OR) search posture", () => {
  it("contextTerms drops stopwords, dedupes, and caps the term count", async () => {
    const { contextTerms } = await import("../src/index/lexical");
    const text =
      "The morphology of the evolved robots was shaped by environmental " +
      "complexity and the complexity of the environment they were in";
    const terms = contextTerms(text).split(" ");
    expect(terms).toContain("morphology");
    expect(terms).toContain("environmental");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("were");
    expect(new Set(terms).size).toBe(terms.length);
    const long = Array.from({ length: 60 }, (_, i) => `distinctiveterm${i}`).join(" ");
    expect(contextTerms(long).split(" ").length).toBeLessThanOrEqual(16);
  });

  it("OR mode matches on exact term overlap without fuzzy or prefix", () => {
    const idx = new LexicalIndex();
    idx.add(chunkNote("Doors.md", "# Doors\n\nExploratory search opens doorways."));
    // Exact overlap: found.
    expect(idx.search("many doorways were opened", 50, "or").length).toBeGreaterThan(0);
    // A near-miss term ("doorwais") must NOT fuzzy-match in context mode…
    expect(idx.search("doorwais", 50, "or")).toHaveLength(0);
    // …while interactive AND search keeps its forgiving posture.
    expect(idx.search("doorwais", 50, "and").length).toBeGreaterThan(0);
  });
});
