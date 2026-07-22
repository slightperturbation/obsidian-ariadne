import { describe, expect, it } from "vitest";
import { segmentNote, buildSplitProposal, fallbackSplitGroups } from "../src/actions/split";

const NOTE = `---
type: note
---

# Big topic

Intro paragraph.

## Alpha

Alpha body line one.
Alpha body line two.

## Beta

Beta body.

## Gamma

Gamma body.`;

describe("segmentNote", () => {
  it("splits at the shallowest repeated heading level, intro kept separate", () => {
    const { intro, segments } = segmentNote(NOTE);
    expect(intro).toContain("# Big topic");
    expect(intro).toContain("Intro paragraph.");
    expect(segments.map((s) => s.heading)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(segments[0].text).toContain("Alpha body line two.");
  });

  it("returns a single segment for a note with no headings", () => {
    const { segments } = segmentNote("just a paragraph\nand another");
    expect(segments).toHaveLength(1);
  });

  it("returns no segments for an empty/frontmatter-only note", () => {
    expect(segmentNote("---\ntype: note\n---\n").segments).toEqual([]);
  });
});

describe("buildSplitProposal", () => {
  it("creates a child per group and turns the parent into a Contents MoC", () => {
    const proposal = buildSplitProposal({
      originalPath: "Zettel/Big topic.md",
      originalContent: NOTE,
      parentTitle: "Big topic",
      isoDate: "2026-07-22",
      children: [
        { title: "Alpha", description: "the alpha idea", segmentIndices: [0], path: "Zettel/Alpha.md" },
        { title: "Beta and Gamma", description: "", segmentIndices: [1, 2], path: "Zettel/Beta and Gamma.md" },
      ],
    });

    const parent = proposal.changes.find((c) => c.type === "modify")!;
    expect(parent.path).toBe("Zettel/Big topic.md");
    expect(parent.after).toContain("## Contents");
    expect(parent.after).toContain("- [[Alpha]] — the alpha idea");
    expect(parent.after).toContain("- [[Beta and Gamma]]");
    expect(parent.after).toContain("Intro paragraph."); // intro stays

    const children = proposal.changes.filter((c) => c.type === "create");
    expect(children).toHaveLength(2);
    expect(children[0].after).toContain("Part of [[Big topic]].");
    expect(children[0].after).toContain("Alpha body line two.");
    const bg = children[1].after!;
    expect(bg).toContain("Beta body.");
    expect(bg).toContain("Gamma body.");
  });

  it("preserves all content: unassigned segments stay in the parent", () => {
    const proposal = buildSplitProposal({
      originalPath: "n.md",
      originalContent: NOTE,
      parentTitle: "Big topic",
      isoDate: "2026-07-22",
      // Only Alpha is claimed; Beta + Gamma are left unassigned.
      children: [{ title: "Alpha", description: "", segmentIndices: [0], path: "Alpha.md" }],
    });
    const parent = proposal.changes.find((c) => c.type === "modify")!;
    expect(parent.after).toContain("Beta body.");
    expect(parent.after).toContain("Gamma body.");
    // Alpha moved out of the parent into its child.
    const child = proposal.changes.find((c) => c.type === "create")!;
    expect(child.after).toContain("Alpha body line two.");
  });

  it("de-dupes a segment claimed by two children (first wins)", () => {
    const proposal = buildSplitProposal({
      originalPath: "n.md",
      originalContent: NOTE,
      parentTitle: "Big topic",
      isoDate: "2026-07-22",
      children: [
        { title: "A", description: "", segmentIndices: [0], path: "A.md" },
        { title: "B", description: "", segmentIndices: [0, 1], path: "B.md" },
      ],
    });
    const a = proposal.changes.find((c) => c.path === "A.md")!;
    const b = proposal.changes.find((c) => c.path === "B.md")!;
    expect(a.after).toContain("Alpha body line one.");
    expect(b.after).not.toContain("Alpha body line one."); // already claimed
    expect(b.after).toContain("Beta body.");
  });
});

describe("fallbackSplitGroups", () => {
  it("makes one group per headed section", () => {
    const groups = fallbackSplitGroups(segmentNote(NOTE));
    expect(groups.map((g) => g.title)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(groups.every((g) => g.segmentIndices.length === 1)).toBe(true);
  });
});
