import type { SparkValues } from "../core/types";

export interface SparkInputs {
  linkCount: number;
  mtime: number;
  chunkCount: number;
}

const DAY_MS = 86_400_000;
const RECENCY_HALF_LIFE_DAYS = 30;

/**
 * Normalize raw note signals into the 0..1 values the sparkline renders.
 * Pure so the curves are unit-testable and easy to retune:
 *  - linked: log-scaled; ~16 outgoing links saturates the bar.
 *  - recency: exponential decay with a 30-day half-life.
 *  - atomicity: 1 for a short atomic note (≤3 chunks), fading as notes sprawl.
 */
export function sparkValues(inputs: SparkInputs, now: number): SparkValues {
  const ageDays = Math.max(0, now - inputs.mtime) / DAY_MS;
  return {
    linked: Math.min(1, Math.log2(1 + Math.max(0, inputs.linkCount)) / 4),
    recency: Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS),
    atomicity: Math.min(1, 3 / Math.max(1, inputs.chunkCount)),
  };
}
