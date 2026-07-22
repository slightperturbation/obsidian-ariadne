import { describe, expect, it } from "vitest";
import { sparkValues } from "../src/index/spark";

const NOW = 1_750_000_000_000;
const DAY = 86_400_000;

describe("sparkValues", () => {
  it("recency: 1 when fresh, ~0.5 at the 30-day half-life, decaying after", () => {
    const fresh = sparkValues({ linkCount: 0, mtime: NOW, chunkCount: 1 }, NOW);
    expect(fresh.recency).toBeCloseTo(1, 5);
    const month = sparkValues({ linkCount: 0, mtime: NOW - 30 * DAY, chunkCount: 1 }, NOW);
    expect(month.recency).toBeCloseTo(0.5, 5);
    const year = sparkValues({ linkCount: 0, mtime: NOW - 365 * DAY, chunkCount: 1 }, NOW);
    expect(year.recency).toBeLessThan(0.01);
  });

  it("linked: 0 with no links, saturating at ~16", () => {
    expect(sparkValues({ linkCount: 0, mtime: NOW, chunkCount: 1 }, NOW).linked).toBe(0);
    const some = sparkValues({ linkCount: 3, mtime: NOW, chunkCount: 1 }, NOW).linked;
    expect(some).toBeGreaterThan(0.3);
    expect(some).toBeLessThan(0.8);
    expect(sparkValues({ linkCount: 20, mtime: NOW, chunkCount: 1 }, NOW).linked).toBe(1);
  });

  it("atomicity: full for short notes, fading as they sprawl", () => {
    expect(sparkValues({ linkCount: 0, mtime: NOW, chunkCount: 1 }, NOW).atomicity).toBe(1);
    expect(sparkValues({ linkCount: 0, mtime: NOW, chunkCount: 3 }, NOW).atomicity).toBe(1);
    expect(sparkValues({ linkCount: 0, mtime: NOW, chunkCount: 12 }, NOW).atomicity).toBe(0.25);
  });

  it("clamps hostile inputs into 0..1", () => {
    const v = sparkValues({ linkCount: -5, mtime: NOW + DAY, chunkCount: 0 }, NOW);
    expect(v.linked).toBe(0);
    expect(v.recency).toBeLessThanOrEqual(1);
    expect(v.atomicity).toBeLessThanOrEqual(1);
  });
});
