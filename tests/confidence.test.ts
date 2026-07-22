import { describe, it, expect } from "vitest";
import { confidence, prominence } from "../src/index/confidence";

describe("confidence", () => {
  it("is 1 for the top rank and lower for deeper ranks", () => {
    const top = confidence({ fusedRank: 0, total: 10 });
    const deep = confidence({ fusedRank: 9, total: 10 });
    expect(top).toBeGreaterThan(deep);
    expect(top).toBeCloseTo(1, 5);
  });

  it("renormalizes when optional signals are absent", () => {
    // With only rank present, a rank-1-of-1 must be full confidence.
    expect(confidence({ fusedRank: 0, total: 1 })).toBeCloseTo(1, 5);
  });

  it("blends in cosine and graph proximity when provided", () => {
    const withoutSemantic = confidence({ fusedRank: 5, total: 10 });
    const withSemantic = confidence({ fusedRank: 5, total: 10, cosine: 1, graphProximity: 1 });
    expect(withSemantic).toBeGreaterThan(withoutSemantic);
  });

  it("clamps values into 0..1", () => {
    const c = confidence({ fusedRank: 0, total: 10, cosine: 2, graphProximity: -1 });
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe("prominence", () => {
  it("buckets confidence into faint/quiet/prominent", () => {
    expect(prominence(0.1)).toBe("faint");
    expect(prominence(0.5)).toBe("quiet");
    expect(prominence(0.9)).toBe("prominent");
  });
});
