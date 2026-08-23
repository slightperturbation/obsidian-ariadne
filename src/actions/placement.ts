/**
 * Placement — where a new note belongs, derived from the graph.
 *
 * The vault's folder tree and link graph already ARE the map of its domains;
 * a hand-maintained one would duplicate them and go stale. So placement is a
 * deterministic vote, not a model choice (the model used to free-pick from
 * the folder list and filed a gaming-world topic under "References and
 * Sources" — plausible-sounding, wrong, and unexplainable):
 *
 *   1. Referrers — the notes that LINK to a wanted topic vote with their
 *      folders. The notes that demanded the note know where it lives.
 *   2. Semantic neighbors — cosine-weighted folder vote, the same idiom as
 *      tag suggestion and journal affinity.
 *   3. The Inbox — when the vault doesn't say, don't guess. Ambiguity is
 *      what the Inbox is for; triage proposes homes later.
 *
 * The vote is hierarchical: exact parent folders first; no majority →
 * every voter generalizes one level up and votes again. Lifecycle folders
 * (inbox, archive, attachments, journals) never win — they answer "where in
 * its life", not "what is it about" — and the vault root never wins (root
 * placement is what the Inbox fallback is for).
 */

export interface PlacementVoter {
  /** The voter's folder ("" = vault root). */
  folder: string;
  weight?: number;
}

const underAny = (folder: string, prefixes: string[]): boolean =>
  prefixes.some((p) => p.length > 0 && (folder === p || folder.startsWith(`${p}/`)));

const parentOf = (folder: string): string => {
  const i = folder.lastIndexOf("/");
  return i === -1 ? "" : folder.slice(0, i);
};

/** Majority winner needs more than this share of the total vote weight. */
const MAJORITY = 0.5;
/** Fewer voters than this is a coincidence, not a neighborhood. */
const MIN_VOTERS = 2;

export function placementVote(
  voters: PlacementVoter[],
  excludedFolders: string[] = [],
): string | null {
  let live = voters
    .filter((v) => !underAny(v.folder, excludedFolders))
    .map((v) => ({ folder: v.folder, weight: v.weight ?? 1 }));
  if (live.length < MIN_VOTERS) return null;
  const total = live.reduce((sum, v) => sum + v.weight, 0);
  if (total <= 0) return null;

  for (;;) {
    const tally = new Map<string, number>();
    for (const v of live) tally.set(v.folder, (tally.get(v.folder) ?? 0) + v.weight);
    let best: { folder: string; weight: number } | null = null;
    for (const [folder, weight] of tally) {
      if (!best || weight > best.weight) best = { folder, weight };
    }
    if (best && best.folder !== "" && best.weight / total > MAJORITY) return best.folder;
    if (live.every((v) => v.folder === "")) return null;
    live = live.map((v) => ({ ...v, folder: parentOf(v.folder) }));
  }
}
