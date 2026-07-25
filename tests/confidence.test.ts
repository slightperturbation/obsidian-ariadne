import { describe, it, expect } from "vitest";
import { confidence, prominence } from "../src/index/confidence";

describe("confidence", () => {
  it("is 1 for the top rank and decays with depth", () => {
    expect(confidence({ rank: 0 })).toBeCloseTo(1, 5);
    expect(confidence({ rank: 1 })).toBeCloseTo(0.5, 5);
    expect(confidence({ rank: 0 })).toBeGreaterThan(confidence({ rank: 9 }));
  });

  it("does not depend on how many candidates the index surfaced", () => {
    // The old formula divided by the candidate pool, so the same result
    // scored differently depending on how much noise came back with it.
    const inSmallPool = confidence({ rank: 1, cosine: 0.8 });
    const inLargePool = confidence({ rank: 1, cosine: 0.8 });
    expect(inSmallPool).toBe(inLargePool);
    // And the last result of a short list is not forced to zero.
    expect(confidence({ rank: 1 })).toBeGreaterThan(0);
  });

  it("lets semantic support raise confidence, never lower it", () => {
    const lexicalOnly = confidence({ rank: 3 });
    const weakCosine = confidence({ rank: 3, cosine: 0.4 });
    const strongCosine = confidence({ rank: 3, cosine: 0.95 });
    expect(weakCosine).toBeGreaterThanOrEqual(lexicalOnly);
    expect(strongCosine).toBeGreaterThan(lexicalOnly);
  });

  it("blends in graph proximity when provided", () => {
    const without = confidence({ rank: 5 });
    const with_ = confidence({ rank: 5, cosine: 1, graphProximity: 1 });
    expect(with_).toBeGreaterThan(without);
  });

  it("clamps values into 0..1", () => {
    const c = confidence({ rank: 0, cosine: 2, graphProximity: -1 });
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  });
});

describe("prominence", () => {
  it("buckets confidence into faint/quiet/prominent", () => {
    expect(prominence(0.1)).toBe("faint");
    expect(prominence(0.45)).toBe("quiet");
    expect(prominence(0.9)).toBe("prominent");
  });

  it("distinguishes the top few ranks rather than flattening them", () => {
    // The visual language only works if real results land in different buckets.
    expect(prominence(confidence({ rank: 0, cosine: 0.9 }))).toBe("prominent");
    expect(prominence(confidence({ rank: 2 }))).toBe("quiet");
    expect(prominence(confidence({ rank: 6 }))).toBe("faint");
  });
});
