import { describe, expect, it } from "vitest";
import { insertAt, appendBacklink, buildWeaveProposal } from "../src/actions/link-weave";

describe("insertAt", () => {
  it("inserts a link with word-boundary spacing", () => {
    expect(insertAt("the cat sat", { line: 0, ch: 7 }, "[[X]]")).toBe("the cat [[X]] sat");
  });
  it("adds no extra space at a clean boundary", () => {
    expect(insertAt("the cat ", { line: 0, ch: 8 }, "[[X]]")).toBe("the cat [[X]]");
  });
  it("clamps out-of-range positions", () => {
    expect(insertAt("abc", { line: 9, ch: 99 }, "[[X]]")).toBe("abc [[X]]");
  });
});

describe("appendBacklink", () => {
  it("adds a Related section when absent", () => {
    const out = appendBacklink("# Note\n\nBody.", "- [[Source]]");
    expect(out).toContain("## Related");
    expect(out.trimEnd().endsWith("- [[Source]]")).toBe(true);
  });

  it("appends under an existing Related section, before the next heading", () => {
    const content = "# Note\n\n## Related\n\n- [[Existing]]\n\n## Notes\n\nmore";
    const out = appendBacklink(content, "- [[Source]]");
    const relatedIdx = out.indexOf("## Related");
    const notesIdx = out.indexOf("## Notes");
    const sourceIdx = out.indexOf("- [[Source]]");
    expect(sourceIdx).toBeGreaterThan(relatedIdx);
    expect(sourceIdx).toBeLessThan(notesIdx);
    expect(out).toContain("- [[Existing]]");
  });
});

describe("buildWeaveProposal", () => {
  it("produces two modify changes with correct before-anchors", () => {
    const proposal = buildWeaveProposal({
      sourcePath: "src.md",
      sourceContent: "writing about ideas",
      cursor: { line: 0, ch: 19 },
      targetLinktext: "Target",
      targetPath: "tgt.md",
      targetContent: "# Target\n\nbody",
      targetTitle: "Target",
      sourceLinktext: "Source",
      sourceTitle: "Source",
      phrase: "extends the idea",
    });
    expect(proposal.changes).toHaveLength(2);
    const [src, tgt] = proposal.changes;
    expect(src.type).toBe("modify");
    expect(src.before).toBe("writing about ideas");
    expect(src.after).toContain("[[Target]]");
    expect(tgt.after).toContain("- [[Source]] — extends the idea");
  });

  it("omits the connective dash when no phrase is given", () => {
    const proposal = buildWeaveProposal({
      sourcePath: "src.md",
      sourceContent: "x",
      cursor: { line: 0, ch: 1 },
      targetLinktext: "T",
      targetPath: "tgt.md",
      targetContent: "y",
      targetTitle: "T",
      sourceLinktext: "S",
      sourceTitle: "S",
    });
    expect(proposal.changes[1].after).toContain("- [[S]]");
    expect(proposal.changes[1].after).not.toContain("—");
  });
});
