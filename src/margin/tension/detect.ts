import type { ScoredResult } from "../../core/types";

/**
 * Candidate selection for tension/echo surfacing — the free half of the
 * feature.
 *
 * The observation that makes this affordable: an embedding places "X is true"
 * and "X is false" *close together* — semantic similarity measures topic, not
 * agreement. So high-cosine neighbors of the paragraph being written are
 * exactly the notes worth examining, and they divide into:
 *
 *  - **near-verbatim** (cosine ≥ echoFloor): the writer is re-saying an
 *    existing note. That's an echo by construction — no model call needed.
 *    Ahrens: elaborate the original, don't accumulate a duplicate.
 *  - **the ambiguous band** (candidateFloor ≤ cosine < echoFloor): same
 *    territory, unclear stance. Only a reasoning model can tell "contradicts"
 *    from "restates" from "merely nearby" — these become the (few, cached,
 *    budgeted) classification calls.
 *
 * Everything below the band is ordinary relatedness and stays the Margin's
 * business.
 */

export type TensionMode = "off" | "quiet" | "eager";

export interface TensionProfile {
  /** Cosine at which a neighbor enters the ambiguous band. */
  candidateFloor: number;
  /** Cosine at which a neighbor is an echo outright. */
  echoFloor: number;
  /** Most findings shown at once — marginalia, not a report. */
  maxFindings: number;
  /** Most classification calls spawned per paragraph. */
  maxClassify: number;
}

export const TENSION_PROFILES: Record<Exclude<TensionMode, "off">, TensionProfile> = {
  // Quiet is the default: a tension card interrupts a writing session, so it
  // must be almost certainly right before it appears at all.
  quiet: { candidateFloor: 0.84, echoFloor: 0.93, maxFindings: 2, maxClassify: 2 },
  eager: { candidateFloor: 0.78, echoFloor: 0.9, maxFindings: 4, maxClassify: 4 },
};

/** What the model (or the echo shortcut) concluded about one candidate. */
export interface RelationVerdict {
  relation: "contradicts" | "restates" | "neither";
  /** Terse fragment naming the specific disagreement/repetition. */
  explanation?: string;
}

export interface TensionFinding {
  kind: "tension" | "echo";
  path: string;
  title: string;
  /** The model's explanation when there is one, else the chunk snippet. */
  snippet: string;
  cosine: number;
  /** Drives the shared prominence tiers (faint/quiet/prominent). */
  confidence: number;
}

export interface SelectInput {
  results: ScoredResult[];
  /** Titles already [[linked]] from the draft. */
  linkedTitles: ReadonlySet<string>;
  profile: TensionProfile;
}

export interface Selection {
  /** Near-verbatim neighbors — echoes with no model call. */
  echoes: ScoredResult[];
  /** The ambiguous band, best-first — send (some of) these to the model. */
  candidates: ScoredResult[];
}

/**
 * Split retrieval results into certain echoes and classification candidates.
 *
 * Already-linked notes are treated asymmetrically: an echo of a linked note is
 * dropped (the connection is made; re-announcing it is nagging), but a linked
 * note stays a *tension* candidate — contradicting a note you cite is
 * precisely the moment to be told.
 */
export function selectCandidates(input: SelectInput): Selection {
  const { profile } = input;
  const echoes: ScoredResult[] = [];
  const candidates: ScoredResult[] = [];
  for (const r of input.results) {
    if (r.cosine === undefined) continue; // lexical-only: no stance signal
    if (r.cosine >= profile.echoFloor) {
      if (!input.linkedTitles.has(r.title)) echoes.push(r);
    } else if (r.cosine >= profile.candidateFloor) {
      candidates.push(r);
    }
  }
  const byCosine = (a: ScoredResult, b: ScoredResult) => (b.cosine ?? 0) - (a.cosine ?? 0);
  echoes.sort(byCosine);
  candidates.sort(byCosine);
  return { echoes, candidates };
}

/** Echo confidence: map [echoFloor..1] onto [0.5..0.9] — never full certainty. */
export function echoConfidence(cosine: number, echoFloor: number): number {
  const t = Math.min(1, Math.max(0, (cosine - echoFloor) / (1 - echoFloor)));
  return 0.5 + 0.4 * t;
}

/**
 * A confirmed tension is shown prominently regardless of exact cosine: the
 * model has read both texts and said they disagree, which is stronger
 * evidence than the embedding distance that nominated the pair.
 */
export const TENSION_CONFIDENCE = 0.75;

/**
 * Jaccard similarity of two paragraph keys (see paragraphKey: the key's tail
 * is the sorted unique word set). Classification verdicts are reused while
 * the paragraph's word set stays similar — a verdict about "does this
 * paragraph contradict that note" doesn't change because one more sentence
 * was added, and re-asking on every keystroke-pause would burn the ambient
 * budget on duplicates.
 */
export function keySimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const wordsOf = (key: string) => new Set(key.slice(key.indexOf("::") + 2).split(","));
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}
