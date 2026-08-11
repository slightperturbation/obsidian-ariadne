/**
 * Recognizing daily/weekly/monthly notes by name.
 *
 * Why this matters for the Margin: while journaling, the semantically nearest
 * neighbors of today's entry are *other dated entries* — last Tuesday also
 * mentioned motivation. If those fill the Margin, the permanent note on
 * motivation (the thing the Zettelkasten method says the writer should be
 * elaborating) is buried under a mirror of their own journal. File by
 * lifecycle, connect by topic: a dated entry is lifecycle, so topic surfaces
 * should prefer permanent notes and only then dated ones.
 *
 * Demotion, never exclusion — "you wrote about this on June 28" is real
 * information; it just shouldn't outrank the idea's actual note.
 *
 * Name-based heuristics rather than a folder setting: daily notes travel
 * (root, Daily/, Journal/…) but their names are rigidly conventional.
 */

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december";

const PERIODIC_PATTERNS: RegExp[] = [
  // 2026-07-25, 2026-07-25 Friday, 2026-07-25 anything
  /^\d{4}-\d{2}-\d{2}(\b|_)/,
  // 25-07-2026 / 07-25-2026 style
  /^\d{2}[-.]\d{2}[-.]\d{4}$/,
  // June 28, 2026  (the convention in this vault)
  new RegExp(`^(${MONTHS}) \\d{1,2}, \\d{4}$`, "i"),
  // 28 June 2026
  new RegExp(`^\\d{1,2} (${MONTHS}) \\d{4}$`, "i"),
  // 2026-W31 weekly, 2026-07 monthly, 2026-Q3 quarterly, 2026 yearly
  /^\d{4}-W\d{1,2}$/i,
  /^\d{4}-\d{2}$/,
  /^\d{4}-Q[1-4]$/i,
  /^\d{4}$/,
];

/** Whether a note path names a periodic (daily/weekly/…) note. */
export function looksPeriodic(path: string): boolean {
  const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "").trim();
  return PERIODIC_PATTERNS.some((p) => p.test(base));
}
