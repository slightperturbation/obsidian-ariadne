/**
 * Publish screening — the pure half of the departure lounge.
 *
 * The vault is a house with the garage door open: Zettels and working notes
 * are public by intent, journals are the bedroom. This module decides which
 * rooms a note is in, and it is built to FAIL SAFE at every tier: the costly
 * mistake here is the inverse of everywhere else in Ariadne. A wrongly-held
 * note costs one click; a wrongly-cleared note is on the public internet.
 *
 * Tier 0 — categorical: journal/daily entries and private folders are never
 *   candidates at all. The bedroom has no door to the departure lounge; the
 *   once-a-year exception is a hand-written `publish: true`, deliberately
 *   outside this flow.
 * Tier 1 — free red-flag nets: high-recall, low-precision lexical signals
 *   (first-person emotion, relationship terms, health/intimacy/finance) plus
 *   the graph check only Ariadne can make: a public note that links into the
 *   bedroom leaks the bedroom (private titles appear as links on the site).
 * Tier 2 — the model (elsewhere): screens what tiers 0–1 didn't decide,
 *   biased to hold, with a malformed answer parsed as HOLD.
 */

export type PublishState = "cleared" | "held" | "polish" | "unreviewed";

export interface PublishVerdict {
  state: PublishState;
  /** Terse reasons, shown on the row. */
  reasons: string[];
}

/** Per-note ledger entry — which revision was screened, and its verdict. */
export interface LedgerEntry {
  /** fnv1a of the content that was screened. */
  hash: number;
  /** File mtime at screening — the cheap staleness probe. */
  mtime: number;
  state: PublishState;
  reasons: string[];
  /** The writer explicitly overrode a hold. Loud, per-note, remembered. */
  overridden?: boolean;
  /**
   * A HUMAN made this call (override, manual clear/hold, or a hand-set
   * publish flag predating Ariadne). Human decisions are precedents: future
   * candidates are screened alongside their nearest ones, so classification
   * improves with use instead of staying frozen in a prompt.
   */
  human?: boolean;
}

export type PublishLedger = Record<string, LedgerEntry>;

export function contentHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/* ── Tier 1: red-flag nets ────────────────────────────────────────────── */

/**
 * High-recall by design: these exist to route a note to the model (or to a
 * hold when no model is available), never to clear one. Precision is the
 * model's job; recall is this list's job.
 */
const PERSONAL_PATTERNS: Array<{ re: RegExp; flag: string }> = [
  {
    re: /\bmy (wife|husband|partner|girlfriend|boyfriend|ex|mom|mother|dad|father|sister|brother|son|daughter|boss|manager|coworker|colleague|therapist|doctor|friend)\b/i,
    flag: "mentions people close to you",
  },
  {
    re: /\bI (feel|felt|cried|hate|love|miss|regret|resent|fear)\b|\bI'?m (afraid|scared|ashamed|angry|anxious|depressed|exhausted|lonely|heartbroken)\b/i,
    flag: "first-person emotional content",
  },
  {
    re: /\b(sex|sexual|intimacy|intimate|libido|affair)\b/i,
    flag: "intimate content",
  },
  {
    re: /\b(therapy|therapist|medication|diagnos\w+|depression|anxiety|panic attack|insomnia|illness)\b/i,
    flag: "health content",
  },
  {
    re: /\b(salary|my debt|net worth|mortgage|my savings)\b/i,
    flag: "personal finances",
  },
  {
    re: /\b(password|api[ _-]?key|secret key|ssn|social security)\b/i,
    flag: "credential-like content",
  },
];

/** Local red flags in a note's body. Empty = no local signal (NOT "safe"). */
export function personalSignals(content: string): string[] {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const flags: string[] = [];
  for (const { re, flag } of PERSONAL_PATTERNS) {
    if (re.test(body) && !flags.includes(flag)) flags.push(flag);
  }
  return flags;
}

/* ── Polish checks (advisory, free) ───────────────────────────────────── */

export interface PolishInput {
  content: string;
  /** Titles this note links to that resolve to NON-candidate notes (the
   * bedroom, holds, or unpublished drafts). */
  privateLinks: string[];
  /** Link targets that resolve to nothing at all. */
  unresolvedLinks: string[];
}

export function polishProblems(input: PolishInput): string[] {
  const problems: string[] = [];
  if (input.privateLinks.length > 0) {
    // The graph leak: a published page shows its link text even when the
    // target isn't published — private note TITLES escape that way.
    problems.push(
      `links into unpublished notes: ${input.privateLinks.slice(0, 3).join(", ")}${
        input.privateLinks.length > 3 ? "…" : ""
      }`,
    );
  }
  if (input.unresolvedLinks.length > 0) {
    problems.push(`${input.unresolvedLinks.length} unresolved link(s)`);
  }
  const body = input.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  if (/^\s*- \[ \]/m.test(body) || /\bTODO\b/.test(body)) {
    problems.push("open tasks / TODO markers");
  }
  if (body.trim().split(/\s+/).length < 40) {
    problems.push("stub — under 40 words");
  }
  return problems;
}

/** Which ledger entries are stale against the current file mtimes. */
export function changedSince(
  ledger: PublishLedger,
  files: Array<{ path: string; mtime: number }>,
): string[] {
  return files
    .filter((f) => {
      const entry = ledger[f.path];
      return !entry || entry.mtime < f.mtime;
    })
    .map((f) => f.path);
}

/* ── The embedding ensemble ───────────────────────────────────────────── */

export interface ScreenNeighbor {
  path: string;
  title: string;
  cosine?: number;
  /** Journal/dated entry? */
  journal: boolean;
}

/**
 * How much a candidate READS like the writer's journal, regardless of
 * vocabulary: cosine-weighted share of its nearest neighbors that are
 * journal entries. This is the signal regex can't provide — writing about
 * people and feelings in the journal's register without journal keywords
 * still lands near journal entries in embedding space.
 */
export function journalAffinity(neighbors: ScreenNeighbor[]): number {
  let journal = 0;
  let total = 0;
  for (const n of neighbors) {
    if (n.cosine === undefined) continue;
    total += n.cosine;
    if (n.journal) journal += n.cosine;
  }
  return total > 0 ? journal / total : 0;
}

/** Affinity at which "reads like your journal" becomes a red flag. */
export const JOURNAL_AFFINITY_FLAG = 0.5;
/** Affinity at which, with NO model available, the note holds outright. */
export const JOURNAL_AFFINITY_HOLD = 0.65;

export interface Precedent {
  title: string;
  decision: "cleared" | "held";
  reason?: string;
}

/**
 * The writer's own nearest prior decisions — dynamic few-shot, retrieved by
 * similarity rather than frozen in the prompt. Only HUMAN decisions qualify:
 * feeding the model its own past verdicts would just amplify its biases.
 */
export function selectPrecedents(
  neighbors: ScreenNeighbor[],
  ledger: PublishLedger,
  max = 3,
): Precedent[] {
  const out: Precedent[] = [];
  for (const n of neighbors) {
    const entry = ledger[n.path];
    if (!entry?.human) continue;
    const published = entry.state === "cleared" || entry.overridden === true;
    out.push({
      title: n.title,
      decision: published ? "cleared" : "held",
      reason: entry.reasons[0],
    });
    if (out.length >= max) break;
  }
  return out;
}
