import { describe, expect, it } from "vitest";
import { buildMocProposal } from "../src/actions/moc";
import { buildMergeProposal, mergeFrontmatter, repointLinks } from "../src/actions/merge";

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
    // The duplicate's frontmatter is carried over, not discarded.
    expect(modify.after).toContain("type: note");
    // Its title heading is structure, not content, so it isn't appended.
    expect(modify.after).not.toContain("# Dupe");
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

describe("mergeFrontmatter", () => {
  it("keeps the kept note's scalar values and adds the duplicate's new keys", () => {
    const out = mergeFrontmatter("type: note\nrating: 5", "type: reference\nauthor: Herbert");
    expect(out).toContain("type: note"); // kept wins
    expect(out).not.toContain("type: reference");
    expect(out).toContain("author: Herbert"); // new key carried over
    expect(out).toContain("rating: 5");
  });

  it("unions list-valued keys like tags and aliases", () => {
    const out = mergeFrontmatter("tags: [a, b]", "tags: [b, c]\naliases: [the loop]");
    expect(out).toMatch(/tags: \[a, b, c\]/);
    expect(out).toContain("aliases: [the loop]");
  });

  it("is a no-op when the duplicate has no frontmatter", () => {
    expect(mergeFrontmatter("type: note", "")).toBe("type: note");
  });
});

describe("repointLinks", () => {
  it("repoints plain, aliased, and heading links", () => {
    const before = "See [[Dupe]], [[Dupe|the dupe]] and [[Dupe#Section]].";
    const after = repointLinks(before, "Dupe", "Keep");
    expect(after).toBe("See [[Keep]], [[Keep|the dupe]] and [[Keep#Section]].");
  });

  it("leaves similarly-named links alone", () => {
    expect(repointLinks("[[Duplicate]] [[Dupe]]", "Dupe", "Keep")).toBe("[[Duplicate]] [[Keep]]");
  });
});

describe("buildMergeProposal — frontmatter and inbound links", () => {
  it("preserves the duplicate's frontmatter instead of dropping it", () => {
    const proposal = buildMergeProposal({
      keepPath: "keep.md",
      keepContent: "---\ntags: [a]\n---\n\nKept body.",
      keepTitle: "Keep",
      otherPath: "dupe.md",
      otherContent: "---\ntags: [b]\naliases: [alt name]\n---\n\nExtra.",
      otherTitle: "Dupe",
    });
    const modify = proposal.changes.find((c) => c.path === "keep.md")!;
    expect(modify.after).toMatch(/tags: \[a, b\]/);
    expect(modify.after).toContain("aliases: [alt name]");
    expect(modify.after).toContain("Extra.");
  });

  it("repoints notes that linked to the duplicate, in the same action", () => {
    const proposal = buildMergeProposal({
      keepPath: "keep.md",
      keepContent: "Kept body.",
      keepTitle: "Keep",
      otherPath: "dupe.md",
      otherContent: "Extra.",
      otherTitle: "Dupe",
      inbound: [
        { path: "ref.md", content: "As shown in [[Dupe]] and [[Dupe|elsewhere]]." },
        { path: "unrelated.md", content: "No links here." },
      ],
    });
    const ref = proposal.changes.find((c) => c.path === "ref.md")!;
    expect(ref.type).toBe("modify");
    expect(ref.after).toBe("As shown in [[Keep]] and [[Keep|elsewhere]].");
    // A note with nothing to change isn't touched at all.
    expect(proposal.changes.some((c) => c.path === "unrelated.md")).toBe(false);
    // And the delete still lands last.
    expect(proposal.changes[proposal.changes.length - 1].type).toBe("delete");
  });

  it("still trashes a fully-contained duplicate, repointing its links first", () => {
    const proposal = buildMergeProposal({
      keepPath: "keep.md",
      keepContent: "Alpha.\n\nBeta.",
      keepTitle: "Keep",
      otherPath: "dupe.md",
      otherContent: "Beta.\n\nAlpha.",
      otherTitle: "Dupe",
      inbound: [{ path: "ref.md", content: "[[Dupe]]" }],
    });
    // No body edit to keep.md, but the inbound repoint + delete are there.
    expect(proposal.changes.some((c) => c.path === "keep.md")).toBe(false);
    expect(proposal.changes.find((c) => c.path === "ref.md")!.after).toBe("[[Keep]]");
    expect(proposal.changes.some((c) => c.type === "delete")).toBe(true);
  });
});
