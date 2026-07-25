export interface ConfidenceInputs {
  /** 0-based position in the fused ranking. */
  rank: number;
  /** Raw cosine similarity to the query (-1..1); absent when no vector matched. */
  cosine?: number;
  /** Link-graph proximity, 0..1 (e.g. 1 = directly linked), if known. */
  graphProximity?: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Collapse the available signals into a single 0..1 confidence used to drive UI
 * prominence (faint → quiet → prominent).
 *
 * Rank decays absolutely (1, 1/2, 1/3 …) rather than relative to the candidate
 * pool: an earlier version divided by the total number of candidates, which
 * meant confidence measured how *many* results there were rather than how good
 * they were — with a big pool everything looked prominent, and with a tiny one
 * the last result was always faint.
 *
 * Semantic support can only *raise* confidence, never lower it. Cosine is the
 * raw value: below `COSINE_NEUTRAL` it contributes nothing, above it scales up
 * to a full bonus, so a lexical-only hit is never penalized for lacking a
 * vector match.
 */
const COSINE_NEUTRAL = 0.55;
const COSINE_STRONG = 0.85;
const COSINE_WEIGHT = 0.35;
const GRAPH_WEIGHT = 0.15;

export function confidence(input: ConfidenceInputs): number {
  const rankScore = 1 / (1 + Math.max(0, input.rank));

  let score = rankScore;
  let headroom = 1 - score;

  if (typeof input.cosine === "number") {
    const strength = clamp01(
      (input.cosine - COSINE_NEUTRAL) / (COSINE_STRONG - COSINE_NEUTRAL),
    );
    score += headroom * COSINE_WEIGHT * strength;
    headroom = 1 - score;
  }
  if (typeof input.graphProximity === "number") {
    score += headroom * GRAPH_WEIGHT * clamp01(input.graphProximity);
  }
  return clamp01(score);
}

export type Prominence = "faint" | "quiet" | "prominent";

/** Map a confidence value to a prominence bucket for rendering. */
export function prominence(confidenceValue: number): Prominence {
  if (confidenceValue >= 0.6) return "prominent";
  if (confidenceValue >= 0.3) return "quiet";
  return "faint";
}
