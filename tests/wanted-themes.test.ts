import { describe, expect, it } from "vitest";
import { wantedTopics } from "../src/margin/wanted";
import {
  COVERED_COSINE,
  MIN_ENTRIES,
  THEME_COSINE,
  clusterThemes,
  type EntryNeighbors,
} from "../src/actions/themes";

describe("wantedTopics", () => {
  it("ranks by distinct sources, then total references", () => {
    const topics = wantedTopics({
      "Home.md": { Morphogenesis: 1, "Mate selection": 3 },
      "Agents.md": { Morphogenesis: 1 },
      "Open-endedness.md": { Morphogenesis: 1, "Mate selection": 1 },
    });
    // Morphogenesis: 3 sources beats Mate selection: 2 sources (4 refs).
    expect(topics.map((t) => t.title)).toEqual(["Morphogenesis", "Mate selection"]);
    expect(topics[0]).toMatchObject({ sources: 3, refs: 3 });
  });

  it("a single dangling reference is not yet a topic", () => {
    expect(wantedTopics({ "a.md": { Typo: 1 } })).toEqual([]);
  });

  it("ignores dangling links to future daily notes", () => {
    expect(
      wantedTopics({
        "a.md": { "2026-08-12": 1 },
        "b.md": { "2026-08-12": 1 },
      }),
    ).toEqual([]);
  });

  it("folds heading/block subpaths into their note", () => {
    const topics = wantedTopics({
      "a.md": { "Morphogenesis#constraints": 1 },
      "b.md": { Morphogenesis: 1 },
    });
    expect(topics).toHaveLength(1);
    expect(topics[0].sources).toBe(2);
  });
});

describe("clusterThemes", () => {
  const entry = (
    path: string,
    hits: Array<[string, number, boolean]>, // [path, cosine, periodic]
  ): EntryNeighbors => ({
    path,
    hits: hits.map(([p, cosine, periodic]) => ({
      path: p,
      title: p,
      snippet: `snippet of ${p}`,
      cosine,
      periodic,
    })),
  });

  const strong = THEME_COSINE + 0.05;

  it("finds a cluster of mutually-related dated entries with no permanent note", () => {
    const themes = clusterThemes([
      entry("d1.md", [["d2.md", strong, true], ["perm.md", 0.5, false]]),
      entry("d2.md", [["d3.md", strong, true]]),
      entry("d3.md", [["d1.md", strong, true]]),
      entry("unrelated.md", [["perm.md", 0.6, false]]),
    ]);
    expect(themes).toHaveLength(1);
    expect(themes[0].entries.sort()).toEqual(["d1.md", "d2.md", "d3.md"]);
    expect(themes[0].evidence.length).toBeGreaterThan(0);
  });

  it("a nearby permanent note means the theme is covered — link, don't create", () => {
    const themes = clusterThemes([
      entry("d1.md", [["d2.md", strong, true], ["Motivation.md", COVERED_COSINE + 0.01, false]]),
      entry("d2.md", [["d3.md", strong, true]]),
      entry("d3.md", [["d1.md", strong, true]]),
    ]);
    expect(themes).toEqual([]);
  });

  it("two co-occurrences are a coincidence, not a theme", () => {
    const themes = clusterThemes([
      entry("d1.md", [["d2.md", strong, true]]),
      entry("d2.md", [["d1.md", strong, true]]),
    ]);
    expect(themes).toEqual([]);
    expect(MIN_ENTRIES).toBe(3);
  });

  it("weak similarity between dated entries does not form an edge", () => {
    const themes = clusterThemes([
      entry("d1.md", [["d2.md", THEME_COSINE - 0.05, true]]),
      entry("d2.md", [["d3.md", THEME_COSINE - 0.05, true]]),
      entry("d3.md", [["d1.md", THEME_COSINE - 0.05, true]]),
    ]);
    expect(themes).toEqual([]);
  });

  it("orders themes by recurrence and dedups evidence", () => {
    const big = [
      entry("a1.md", [["a2.md", strong, true], ["a3.md", strong, true]]),
      entry("a2.md", [["a3.md", strong, true], ["a4.md", strong, true]]),
      entry("a3.md", [["a4.md", strong, true]]),
      entry("a4.md", [["a1.md", strong, true]]),
    ];
    const small = [
      entry("b1.md", [["b2.md", strong, true]]),
      entry("b2.md", [["b3.md", strong, true]]),
      entry("b3.md", [["b1.md", strong, true]]),
    ];
    const themes = clusterThemes([...small, ...big]);
    expect(themes).toHaveLength(2);
    expect(themes[0].entries.length).toBe(4); // the bigger cluster leads
    // Evidence lists are unique snippets.
    const ev = themes[0].evidence;
    expect(new Set(ev).size).toBe(ev.length);
  });
});
