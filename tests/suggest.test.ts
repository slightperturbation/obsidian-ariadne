import { describe, expect, it } from "vitest";
import { decideGhost, type GhostDecisionInput } from "../src/margin/ghost/suggest";
import type { ScoredResult } from "../src/core/types";

function result(path: string, title: string, cosine?: number): ScoredResult {
  return { path, title, snippet: "", score: 1, confidence: 0.9, cosine };
}

function input(overrides: Partial<GhostDecisionInput> = {}): GhostDecisionInput {
  return {
    results: [result("zettel/Atomic notes.md", "Atomic notes", 0.85)],
    noteText: "Some draft text about writing methods.",
    paragraphText: "Some draft text about writing methods.",
    charBefore: " ",
    charAfter: "",
    lineBefore: "Some draft text ",
    dismissed: new Set(),
    minCosine: 0.7,
    ...overrides,
  };
}

describe("decideGhost", () => {
  it("suggests the closest note above the cosine threshold", () => {
    const d = decideGhost(input());
    expect(d).toEqual({
      targetPath: "zettel/Atomic notes.md",
      title: "Atomic notes",
      insertText: "[[Atomic notes]]",
    });
  });

  it("thresholds on raw cosine, not rank-flattered confidence", () => {
    expect(decideGhost(input({ results: [result("a.md", "A", 0.6)] }))).toBeNull();
    expect(decideGhost(input({ results: [result("a.md", "A", undefined)] }))).toBeNull();
  });

  it("falls through to the next candidate when the top is filtered out", () => {
    const d = decideGhost(
      input({
        results: [result("a.md", "A", 0.9), result("b.md", "B", 0.8)],
        dismissed: new Set(["a.md"]),
      }),
    );
    expect(d?.targetPath).toBe("b.md");
  });

  it("stays silent mid-word and inside an unclosed wikilink", () => {
    expect(decideGhost(input({ charAfter: "o" }))).toBeNull();
    expect(decideGhost(input({ lineBefore: "linking to [[Ato" }))).toBeNull();
  });

  it("never re-suggests a note already linked (by title or basename)", () => {
    expect(decideGhost(input({ noteText: "see [[Atomic notes]] for more" }))).toBeNull();
    expect(decideGhost(input({ noteText: "see [[Atomic notes|aliased]] too" }))).toBeNull();
  });

  it("prepends a space only when the cursor touches a word", () => {
    expect(decideGhost(input({ charBefore: "d" }))?.insertText).toBe(" [[Atomic notes]]");
    expect(decideGhost(input({ charBefore: " " }))?.insertText).toBe("[[Atomic notes]]");
    expect(decideGhost(input({ charBefore: "" }))?.insertText).toBe("[[Atomic notes]]");
  });

  it("suggests nothing for an empty paragraph", () => {
    expect(decideGhost(input({ paragraphText: "  " }))).toBeNull();
  });
});
