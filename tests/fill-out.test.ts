import { describe, expect, it } from "vitest";
import { incompleteness, rankFillOut } from "../src/margin/fill-out";
import { wantedTopics } from "../src/margin/wanted";

describe("incompleteness", () => {
  it("scores stubs, TODOs, unresolved links, and empty sections as facts", () => {
    const stub = incompleteness("---\npublish: true\n---\nJust a line.", 2);
    expect(stub.score).toBeGreaterThanOrEqual(4);
    expect(stub.reasons.join()).toMatch(/stub — \d+ words/);
    expect(stub.reasons.join()).toContain("2 unresolved links");

    const sections = incompleteness(
      "## Overview\n\n## Details\n\n" + "substantial words here ".repeat(30),
      0,
    );
    expect(sections.reasons).toContain("empty sections");

    const done = incompleteness("word ".repeat(200), 0);
    expect(done.score).toBe(0);
  });
});

describe("rankFillOut", () => {
  it("published incompleteness outranks unpublished, complete notes drop out", () => {
    const rows = rankFillOut(
      [
        { path: "a.md", title: "A", published: false, viaPublished: "Hub", content: "tiny.", unresolvedCount: 0 },
        { path: "b.md", title: "B", published: true, content: "also tiny. TODO", unresolvedCount: 1 },
        { path: "c.md", title: "C", published: true, content: "word ".repeat(300), unresolvedCount: 0 },
      ],
      5,
    );
    expect(rows.map((r) => r.path)).toEqual(["b.md", "a.md"]);
    expect(rows[0].reason).toMatch(/^published — /);
    expect(rows[1].reason).toContain("via “Hub”");
  });
});

describe("wantedTopics public demand", () => {
  const unresolved = {
    "pub.md": { Morphogenesis: 1 },
    "x.md": { "Old Idea": 2 },
    "y.md": { "Old Idea": 1 },
  };
  const isPublished = (p: string) => p === "pub.md";

  it("a single published referrer waives the 2-source bar and ranks first", () => {
    const topics = wantedTopics(unresolved, 3, isPublished);
    expect(topics[0]).toMatchObject({ title: "Morphogenesis", publicDemand: 1, sources: 1 });
    expect(topics[1].title).toBe("Old Idea");
  });

  it("without the predicate, single-source topics stay filtered as before", () => {
    const topics = wantedTopics(unresolved, 3);
    expect(topics.map((t) => t.title)).toEqual(["Old Idea"]);
  });
});
