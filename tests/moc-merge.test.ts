import { describe, expect, it } from "vitest";
import { buildMocProposal } from "../src/actions/moc";
import { buildMergeProposal } from "../src/actions/merge";

describe("buildMocProposal", () => {
  it("creates a themed MoC note linking the members", () => {
    const proposal = buildMocProposal({
      title: "Evolution of complexity",
      path: "Zettel/Evolution of complexity.md",
      isoDate: "2026-07-22",
      sections: [
        {
          theme: "Environment",
          items: [
            { title: "Auerboch 2012", description: "env → morphology" },
            { title: "Auerboch 2014", description: "" },
          ],
        },
        { theme: "", items: [{ title: "Solé and Seoane 2022", description: "brains & computers" }] },
      ],
    });
    expect(proposal.changes).toHaveLength(1);
    const md = proposal.changes[0].after!;
    expect(proposal.changes[0].type).toBe("create");
    expect(md).toContain("type: moc");
    expect(md).toContain("# Evolution of complexity");
    expect(md).toContain("## Environment");
    expect(md).toContain("- [[Auerboch 2012]] — env → morphology");
    expect(md).toContain("- [[Solé and Seoane 2022]] — brains & computers");
  });

  it("skips empty sections", () => {
    const proposal = buildMocProposal({
      title: "M",
      path: "M.md",
      isoDate: "2026-07-22",
      sections: [{ theme: "Empty", items: [] }, { theme: "", items: [{ title: "A", description: "" }] }],
    });
    expect(proposal.changes[0].after).not.toContain("## Empty");
    expect(proposal.changes[0].after).toContain("- [[A]]");
  });
});

describe("buildMergeProposal", () => {
  it("appends only the other's unique blocks under a Merged-from heading, then deletes it", () => {
    const proposal = buildMergeProposal({
      keepPath: "keep.md",
      keepContent: "# Keep\n\nShared paragraph.\n\nKept-only paragraph.",
      keepTitle: "Keep",
      otherPath: "dupe.md",
      // Shares "Shared paragraph." verbatim; adds one new paragraph.
      otherContent: "---\ntype: note\n---\n\n# Dupe\n\nShared paragraph.\n\nExtra content.",
      otherTitle: "Dupe",
    });
    expect(proposal.changes).toHaveLength(2);
    const [modify, del] = proposal.changes;
    expect(modify.type).toBe("modify");
    expect(modify.before).toBe("# Keep\n\nShared paragraph.\n\nKept-only paragraph.");
    expect(modify.after).toContain("## Merged from [[Dupe]]");
    expect(modify.after).toContain("Extra content.");
    // The shared paragraph is NOT duplicated: it appears exactly once total.
    expect((modify.after!.match(/Shared paragraph\./g) ?? []).length).toBe(1);
    // Other note's frontmatter is dropped in the union.
    expect(modify.after).not.toContain("type: note");
    expect(del.type).toBe("delete");
    expect(del.path).toBe("dupe.md");
  });

  it("when the duplicate is fully contained, only trashes it (no edit to keep)", () => {
    const proposal = buildMergeProposal({
      keepPath: "keep.md",
      keepContent: "# Keep\n\nAlpha.\n\nBeta.",
      keepTitle: "Keep",
      otherPath: "dupe.md",
      otherContent: "# Dupe\n\nBeta.\n\nAlpha.", // same blocks, reordered
      otherTitle: "Dupe",
    });
    // No modify — the kept note already has everything; just the delete.
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes[0].type).toBe("delete");
    expect(proposal.changes[0].path).toBe("dupe.md");
  });
});
