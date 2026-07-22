import { describe, it, expect } from "vitest";
import { fuse, reciprocalRankFusion } from "../src/index/fusion";

describe("reciprocalRankFusion", () => {
  it("rewards items ranked highly across lists", () => {
    const lexical = ["a", "b", "c"];
    const vector = ["b", "a", "d"];
    const scores = reciprocalRankFusion([lexical, vector]);
    // b is rank1+rank0, a is rank0+rank1 -> both high; b slightly higher.
    expect(scores.get("b")!).toBeGreaterThan(scores.get("c")!);
    expect(scores.get("a")!).toBeGreaterThan(scores.get("d")!);
  });

  it("k dampens deep ranks", () => {
    const small = reciprocalRankFusion([["x", "y"]], 1);
    const large = reciprocalRankFusion([["x", "y"]], 1000);
    const gapSmall = small.get("x")! - small.get("y")!;
    const gapLarge = large.get("x")! - large.get("y")!;
    expect(gapSmall).toBeGreaterThan(gapLarge);
  });
});

describe("fuse", () => {
  it("returns results sorted by descending fused score", () => {
    const out = fuse([["a", "b", "c"], ["a", "c", "b"]]);
    expect(out[0].id).toBe("a");
    for (let i = 1; i < out.length; i++) {
      expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    }
  });

  it("union-covers ids from every list", () => {
    const out = fuse([["a"], ["b"], ["c"]]);
    expect(out.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });
});
