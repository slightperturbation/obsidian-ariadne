export interface ConfidenceInputs {
  /** 0-based position in the fused ranking. */
  fusedRank: number;
  /** Total number of candidates in the ranking. */
  total: number;
  /** Cosine similarity to the query, 0..1, if a semantic score exists. */
  cosine?: number;
  /** Link-graph proximity, 0..1 (e.g. 1 = directly linked), if known. */
  graphProximity?: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Collapse the available signals into a single 0..1 confidence used to drive UI
 * prominence (faint → quiet → prominent). Weights are deliberately simple and
 * will be tuned against real usage; the contract is only that more-relevant,
 * better-connected results score higher. Missing signals are dropped and the
 * remaining weights renormalized so confidence never depends on absent data.
 */
export function confidence(input: ConfidenceInputs): number {
  const rankScore =
    input.total > 1 ? 1 - input.fusedRank / (input.total - 1) : 1;

  const parts: Array<{ weight: number; value: number }> = [
    { weight: 0.5, value: clamp01(rankScore) },
  ];
  if (typeof input.cosine === "number") {
    parts.push({ weight: 0.35, value: clamp01(input.cosine) });
  }
  if (typeof input.graphProximity === "number") {
    parts.push({ weight: 0.15, value: clamp01(input.graphProximity) });
  }

  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const blended = parts.reduce((s, p) => s + p.weight * p.value, 0) / totalWeight;
  return clamp01(blended);
}

export type Prominence = "faint" | "quiet" | "prominent";

/** Map a confidence value to a prominence bucket for rendering. */
export function prominence(confidenceValue: number): Prominence {
  if (confidenceValue >= 0.66) return "prominent";
  if (confidenceValue >= 0.33) return "quiet";
  return "faint";
}
