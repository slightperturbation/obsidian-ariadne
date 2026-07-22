import { describe, expect, it } from "vitest";
import { paragraphAround, paragraphKey } from "../src/margin/context";

const NOTE = [
  "# Evolution notes", // 0
  "", // 1
  "Auerboch showed environmental complexity", // 2
  "drives morphological complexity in evolved robots.", // 3
  "", // 4
  "## Open questions", // 5
  "Is the relationship causal?", // 6
];

describe("paragraphAround", () => {
  it("captures the blank-line-delimited paragraph around the cursor", () => {
    for (const line of [2, 3]) {
      const p = paragraphAround(NOTE, line);
      expect(p.startLine).toBe(2);
      expect(p.endLine).toBe(3);
      expect(p.text).toContain("Auerboch");
      expect(p.text).toContain("robots");
    }
  });

  it("returns empty on a blank line", () => {
    expect(paragraphAround(NOTE, 4).text).toBe("");
  });

  it("treats headings as boundaries, not paragraph members", () => {
    const p = paragraphAround(NOTE, 6);
    expect(p.startLine).toBe(6);
    expect(p.text).toBe("Is the relationship causal?");
  });

  it("uses the heading's own words when the cursor is on it", () => {
    expect(paragraphAround(NOTE, 5).text).toBe("Open questions");
  });

  it("clamps out-of-range lines and handles empty docs", () => {
    expect(paragraphAround(NOTE, 99).endLine).toBe(6);
    expect(paragraphAround([], 0).text).toBe("");
  });
});

describe("paragraphKey", () => {
  it("is stable under punctuation and small-word edits", () => {
    const a = paragraphKey("a.md", "Environmental complexity drives morphology!");
    const b = paragraphKey("a.md", "environmental complexity, drives the morphology");
    expect(a).toBe(b);
  });

  it("changes when a substantial word is added, and differs across notes", () => {
    const a = paragraphKey("a.md", "environmental complexity drives morphology");
    const b = paragraphKey("a.md", "environmental complexity drives morphology evolution");
    expect(a).not.toBe(b);
    expect(paragraphKey("b.md", "environmental complexity drives morphology")).not.toBe(a);
  });
});
