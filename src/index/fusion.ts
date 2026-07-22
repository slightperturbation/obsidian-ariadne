export interface FusedResult {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion. Combines several ranked id-lists into one ranking by
 * summing 1 / (k + rank). Rank-based, so lexical (BM25) and vector (cosine)
 * lists fuse without any score normalization. k dampens the weight of deep
 * ranks; 60 is the conventional default.
 */
export function reciprocalRankFusion(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return scores;
}

/** Fuse ranked id-lists and return results sorted by descending fused score. */
export function fuse(lists: string[][], k = 60): FusedResult[] {
  const scores = reciprocalRankFusion(lists, k);
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
