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
  it("appends the other's body under a Merged-from heading and deletes it", () => {
    const proposal = buildMergeProposal({
      keepPath: "keep.md",
      keepContent: "# Keep\n\nKept body.",
      keepTitle: "Keep",
      otherPath: "dupe.md",
      otherContent: "---\ntype: note\n---\n\n# Dupe\n\nExtra content.",
      otherTitle: "Dupe",
    });
    expect(proposal.changes).toHaveLength(2);
    const [modify, del] = proposal.changes;
    expect(modify.type).toBe("modify");
    expect(modify.before).toBe("# Keep\n\nKept body.");
    expect(modify.after).toContain("Kept body.");
    expect(modify.after).toContain("## Merged from [[Dupe]]");
    expect(modify.after).toContain("Extra content.");
    // Other note's frontmatter is dropped in the union.
    expect(modify.after).not.toContain("type: note");
    expect(del.type).toBe("delete");
    expect(del.path).toBe("dupe.md");
    expect(del.before).toContain("Extra content.");
  });
});
