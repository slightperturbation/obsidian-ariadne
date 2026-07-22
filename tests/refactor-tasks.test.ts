import { describe, expect, it } from "vitest";
import { parseSplitGroups, parseMoc, fallbackMoc, parseCritique } from "../src/model/refactor-tasks";

describe("parseSplitGroups", () => {
  it("parses valid groups and drops malformed ones", () => {
    const groups = parseSplitGroups(
      JSON.stringify({
        children: [
          { title: "Alpha", description: "a", segmentIndices: [0, 1] },
          { title: "", description: "x", segmentIndices: [2] }, // no title
          { title: "Beta", description: "b", segmentIndices: [] }, // no indices
          { title: "Gamma", description: "g", segmentIndices: [3] },
        ],
      }),
    );
    expect(groups.map((g) => g.title)).toEqual(["Alpha", "Gamma"]);
    expect(groups[0].segmentIndices).toEqual([0, 1]);
  });

  it("returns [] on garbage", () => {
    expect(parseSplitGroups("not json")).toEqual([]);
    expect(parseSplitGroups("{}")).toEqual([]);
  });
});

describe("parseCritique", () => {
  it("parses refined clusters and drops malformed ones", () => {
    const clusters = parseCritique(
      JSON.stringify({
        clusters: [
          { title: "Sharper title", description: "d", paragraphIndices: [0, 1] },
          { title: "", description: "x", paragraphIndices: [2] },
          { title: "Another", description: "", paragraphIndices: [3] },
        ],
      }),
    );
    expect(clusters.map((c) => c.title)).toEqual(["Sharper title", "Another"]);
    expect(clusters[0].paragraphIndices).toEqual([0, 1]);
  });

  it("returns [] on garbage so the caller keeps the first proposal", () => {
    expect(parseCritique("not json")).toEqual([]);
    expect(parseCritique("{}")).toEqual([]);
  });
});

describe("parseMoc", () => {
  const allowed = new Set(["Note A", "Note B"]);

  it("keeps only items whose title is a real neighborhood note", () => {
    const moc = parseMoc(
      JSON.stringify({
        title: "Cluster",
        sections: [
          {
            theme: "Theme",
            items: [
              { title: "Note A", description: "real" },
              { title: "Hallucinated", description: "not in the vault" },
            ],
          },
        ],
      }),
      allowed,
    );
    expect(moc?.title).toBe("Cluster");
    expect(moc?.sections[0].items.map((i) => i.title)).toEqual(["Note A"]);
  });

  it("returns null when nothing survives filtering", () => {
    const moc = parseMoc(
      JSON.stringify({ title: "X", sections: [{ theme: "", items: [{ title: "Ghost", description: "" }] }] }),
      allowed,
    );
    expect(moc).toBeNull();
  });
});

describe("fallbackMoc", () => {
  it("makes a flat single-section map over the titles", () => {
    const moc = fallbackMoc("Seed", ["A", "B"]);
    expect(moc.title).toBe("Seed — Map");
    expect(moc.sections).toHaveLength(1);
    expect(moc.sections[0].items.map((i) => i.title)).toEqual(["A", "B"]);
  });
});
