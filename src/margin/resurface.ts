import { dateOf, dayKeyOf, looksPeriodic } from "../core/periodic";
import type { NoteMeta } from "../index/manager";

/**
 * Resurfacing — the vault reads back.
 *
 * A dormant vault's problem is not capture, it's return: notes that were
 * never linked and never revisited simply stop existing. Two mechanisms,
 * both deliberately quiet:
 *
 * - **On this day**: past dated entries sharing today's month-day. The
 *   classic journaling loop-closer — cheap, delightful, and zero-judgment.
 * - **Still true?**: one old, orphaned note per day, chosen
 *   deterministically so it doesn't churn on every refresh — the same
 *   invitation all day, a different one tomorrow. Ahrens's spaced encounter
 *   with your own thinking, without gamification: no streaks, no queue, no
 *   guilt. One note, take it or leave it.
 */

/** Untouched for this long = eligible for resurfacing. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
/** More links than this and the graph already returns the note to you. */
const MAX_LINKS = 1;

/** Past dated entries sharing the month-day of `currentPath`, newest first. */
export function onThisDay(currentPath: string, allPaths: string[]): string[] {
  const key = dayKeyOf(currentPath);
  if (!key) return [];
  return allPaths
    .filter((p) => p !== currentPath && dayKeyOf(p) === key)
    // By date, newest first — a path sort would order by folder name.
    .sort((a, b) => (dateOf(b) ?? "").localeCompare(dateOf(a) ?? ""));
}

/** FNV-1a — deterministic seed from the date string. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Today's "still true?" note: old, barely linked, not a dated entry — and
 * the SAME pick all day (seeded by the date), so the invitation is stable
 * rather than a slot machine.
 */
export function resurfacePick(
  metas: NoteMeta[],
  isoDate: string,
  now: number,
  isJournal: (path: string) => boolean = looksPeriodic,
): NoteMeta | null {
  const candidates = metas
    .filter(
      (m) =>
        m.chunkCount > 0 &&
        m.linkCount <= MAX_LINKS &&
        now - m.mtime > STALE_MS &&
        !isJournal(m.path),
    )
    .sort((a, b) => a.path.localeCompare(b.path)); // stable across sessions
  if (candidates.length === 0) return null;
  return candidates[fnv1a(isoDate) % candidates.length];
}
