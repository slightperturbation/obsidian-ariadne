import { looksPeriodic } from "../core/periodic";

/**
 * Topics wanting notes — dangling [[links]] ranked by demand.
 *
 * A bare [[Morphogenesis]] with no note behind it is a topic the writer has
 * reached for repeatedly and never given a home; a hand-maintained dashboard
 * full of them is the loop that never closes. Obsidian already knows every
 * unresolved link; the work here is judging which ones constitute *demand*:
 *
 * - ranked by how many DISTINCT notes reach for the topic, then by total
 *   references — five notes each wanting [[X]] once is a stronger signal
 *   than one note repeating [[Y]] five times;
 * - links to future daily notes are excluded (a dangling [[2026-08-12]] is a
 *   calendar artifact, not a missing idea);
 * - single-reference topics are excluded: one dangling link is a typo or a
 *   passing thought, not yet a topic.
 */

export interface WantedTopic {
  title: string;
  /** How many distinct notes link to it. */
  sources: number;
  /** Total reference count across the vault. */
  refs: number;
  /** Paths of the referring notes (capped) — they vote on where the
   * created note belongs: the notes that demanded it know its home. */
  referrers: string[];
}

/** Obsidian's metadataCache.unresolvedLinks shape. */
export type UnresolvedLinks = Record<string, Record<string, number>>;

const MIN_SOURCES = 2;

export function wantedTopics(unresolved: UnresolvedLinks, limit = 3): WantedTopic[] {
  const byTopic = new Map<string, { sources: number; refs: number; referrers: string[] }>();
  for (const [source, links] of Object.entries(unresolved)) {
    // [[X]] and [[X#section]] in one note are two link KEYS but one source —
    // counting keys would let a single note fake the corroboration bar.
    const titlesInSource = new Map<string, number>();
    for (const [target, count] of Object.entries(links)) {
      const title = target.split(/[#|]/)[0].trim();
      if (!title || looksPeriodic(title)) continue;
      titlesInSource.set(title, (titlesInSource.get(title) ?? 0) + count);
    }
    for (const [title, count] of titlesInSource) {
      const entry = byTopic.get(title) ?? { sources: 0, refs: 0, referrers: [] };
      entry.sources += 1;
      entry.refs += count;
      if (entry.referrers.length < 12) entry.referrers.push(source);
      byTopic.set(title, entry);
    }
  }
  return [...byTopic.entries()]
    .filter(([, v]) => v.sources >= MIN_SOURCES)
    .map(([title, v]) => ({ title, sources: v.sources, refs: v.refs, referrers: v.referrers }))
    .sort((a, b) => b.sources - a.sources || b.refs - a.refs || a.title.localeCompare(b.title))
    .slice(0, limit);
}
