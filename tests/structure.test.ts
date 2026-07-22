import { describe, expect, it } from "vitest";
import {
  paragraphize,
  buildStructureProposal,
  stripProposedSplitCallout,
} from "../src/actions/split";
import { parseAnalysis } from "../src/model/refactor-tasks";

const UNSTRUCTURED = `---
type: note
---

# My messy note

An intro sentence framing everything.

Idea one, first paragraph about cats.

Idea one continued, more about cats.

Idea two, a paragraph about taxes.

A closing throwaway line.`;

describe("paragraphize", () => {
  it("keeps frontmatter and a leading H1 in the intro, numbers the rest", () => {
    const { intro, paragraphs } = paragraphize(UNSTRUCTURED);
    expect(intro).toContain("type: note");
    expect(intro).toContain("# My messy note");
    expect(paragraphs).toHaveLength(5);
    expect(paragraphs[0].text).toContain("intro sentence");
    expect(paragraphs[3].text).toContain("about taxes");
  });
});

describe("buildStructureProposal", () => {
  it("groups paragraphs into ## sections and preserves every paragraph", () => {
    const proposal = buildStructureProposal({
      path: "note.md",
      content: UNSTRUCTURED,
      parentTitle: "My messy note",
      clusters: [
        { title: "On cats", description: "the cat idea", paragraphIndices: [1, 2] },
        { title: "On taxes", description: "", paragraphIndices: [3] },
      ],
    });
    expect(proposal.changes).toHaveLength(1);
    const after = proposal.changes[0].after!;

    // Sections created with titles + description.
    expect(after).toContain("## On cats");
    expect(after).toContain("*the cat idea*");
    expect(after).toContain("## On taxes");
    // The proposal framing callout is present.
    expect(after).toContain("[!note] Proposed split");
    // Content preserved: unclustered framing (index 0, 4) stays in the note.
    expect(after).toContain("An intro sentence framing everything.");
    expect(after).toContain("A closing throwaway line.");
    // Clustered paragraphs are under their sections, all present.
    expect(after).toContain("first paragraph about cats");
    expect(after).toContain("Idea one continued");
    expect(after).toContain("a paragraph about taxes");
    // Original frontmatter + title retained.
    expect(after).toContain("type: note");
    expect(after).toContain("# My messy note");
  });

  it("de-dupes a paragraph claimed by two clusters (first wins)", () => {
    const proposal = buildStructureProposal({
      path: "n.md",
      content: UNSTRUCTURED,
      parentTitle: "t",
      clusters: [
        { title: "A", description: "", paragraphIndices: [1] },
        { title: "B", description: "", paragraphIndices: [1, 3] },
      ],
    });
    const after = proposal.changes[0].after!;
    const catCount = (after.match(/first paragraph about cats/g) ?? []).length;
    expect(catCount).toBe(1);
  });
});

describe("stripProposedSplitCallout", () => {
  it("removes the callout line and collapses blank runs", () => {
    const withCallout =
      '# Note\n\n> [!note] Proposed split — edit these sections, then run ...\n\n## A\n\nbody';
    const out = stripProposedSplitCallout(withCallout);
    expect(out).not.toContain("Proposed split");
    expect(out).toContain("## A");
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe("parseAnalysis", () => {
  it("reads an atomic verdict", () => {
    const r = parseAnalysis(JSON.stringify({ atomic: true, reason: "one idea", clusters: [] }));
    expect(r?.atomic).toBe(true);
    expect(r?.reason).toBe("one idea");
    expect(r?.clusters).toEqual([]);
  });

  it("reads clusters and drops malformed ones", () => {
    const r = parseAnalysis(
      JSON.stringify({
        atomic: false,
        reason: "",
        clusters: [
          { title: "Cats", description: "d", paragraphIndices: [1, 2] },
          { title: "", description: "x", paragraphIndices: [3] },
          { title: "Taxes", description: "", paragraphIndices: [] },
        ],
      }),
    );
    expect(r?.atomic).toBe(false);
    expect(r?.clusters.map((c) => c.title)).toEqual(["Cats"]);
  });

  it("returns null on non-JSON", () => {
    expect(parseAnalysis("nope")).toBeNull();
  });
});
