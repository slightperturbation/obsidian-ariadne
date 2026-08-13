import { isReflectiveProse } from "./journal";

/**
 * Entry classification and tag suggestion.
 *
 * **Classification** continues the journal/daily distinction (see journal.ts)
 * at the whole-entry level: an entry whose paragraphs are mostly log-shaped
 * (lists, todos, meeting lines, loose fragments) is a *daily note*; one
 * dominated by narrative prose is a *journal entry*. The bar is deliberately
 * asymmetric — a to-do list with one thoughtful sentence is still a daily
 * note; narrative must dominate to claim the journal kind.
 *
 * Time-anchored notes get *structure*, not just a label, because the point
 * of the anchoring is future use — timelines, "every journal entry from
 * 2026". A dated tag per entry would mint a new tag every day and can't
 * answer range queries; so the kind is a plain tag (`#daily`/`#journal`)
 * plus a `type` property (the vault's existing convention, already
 * queryable as `type:journal` in the Line), and the standardized ISO date
 * is a real `date` property — sortable, range-filterable, and what a Bases
 * timeline groups on.
 *
 * **Suggestion** mirrors the echo/tension tiering, with one governing rule:
 * Ariadne never invents a tag. Candidates come only from the tags already on
 * semantically-near notes — the writer's own taxonomy propagating through
 * embedding space — so suggestions converge the vocabulary instead of
 * sprawling it. A tag qualifies when at least two neighbors carry it, or one
 * neighbor so close (cosine ≥ 0.85) that it is nearly the same idea.
 */

export type EntryKind = "daily" | "journal";

export function classifyEntry(content: string): EntryKind {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  let reflective = 0;
  let log = 0;
  for (const p of paragraphs) {
    if (isReflectiveProse(p)) reflective++;
    else log++;
  }
  return reflective > log ? "journal" : "daily";
}

/** The managed kind tag for an entry — plain, undated. */
export function entryTag(kind: EntryKind, dailyTag: string, journalTag: string): string {
  return kind === "journal" ? journalTag : dailyTag;
}

/**
 * A dated tag from the short-lived earlier scheme (`kind/YYYY-MM-DD`) —
 * recognized only to clean it up; the date now lives in the `date` property.
 */
export function isLegacyDatedTag(tag: string): boolean {
  return /\/\d{4}-\d{2}-\d{2}$/.test(tag);
}

export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").trim();
}

export interface TaggedNeighbor {
  cosine?: number;
  tags: string[];
}

/** A single neighbor this close is evidence enough on its own. */
const SINGLE_SOURCE_COSINE = 0.85;
const MAX_SUGGESTIONS = 3;

/**
 * Tags worth offering for a note, drawn ONLY from its neighbors' existing
 * tags — weighted by closeness, requiring corroboration (two sources) unless
 * one neighbor is nearly the same idea. The note's own tags and Ariadne's
 * managed entry tags (dated, per-entry, not topical) never qualify.
 */
export function suggestTags(
  neighbors: TaggedNeighbor[],
  ownTags: ReadonlySet<string>,
  max = MAX_SUGGESTIONS,
): string[] {
  const score = new Map<string, { weight: number; sources: number }>();
  for (const n of neighbors) {
    const weight = n.cosine ?? 0.5; // lexical-only neighbors still count, weakly
    for (const tag of new Set(n.tags.map(normalizeTag))) {
      if (!tag || ownTags.has(tag.toLowerCase()) || isLegacyDatedTag(tag)) continue;
      const entry = score.get(tag) ?? { weight: 0, sources: 0 };
      entry.weight += weight;
      entry.sources += 1;
      score.set(tag, entry);
    }
  }
  return [...score.entries()]
    .filter(([, e]) => e.sources >= 2 || e.weight >= SINGLE_SOURCE_COSINE)
    .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]))
    .map(([tag]) => tag)
    .slice(0, max);
}
