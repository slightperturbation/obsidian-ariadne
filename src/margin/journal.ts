/**
 * Journaling and daily notes are similar but not the same — not the same
 * activity, not the same artifact.
 *
 * A **daily note** is operational: a dated container for the day's traffic —
 * tasks, meeting lines, links to what passed through. Its value is
 * navigational ("when did I do X?"). A **journal entry** is reflective:
 * prose written to think — sense-making whose value lies in the writing
 * itself and in re-reading over time. The first is a logbook; the second is
 * where recurring themes, tensions with one's past thinking, and promotable
 * ideas are born.
 *
 * The two routinely share a file: people journal in a paragraph of their
 * daily note, two bullets under a task list. So the honest unit for the
 * distinction is not the file but the **paragraph** — and the whole Margin
 * pipeline already works per paragraph. File-level detection (names,
 * folders) answers "is this a dated/journal note at all"; paragraph-level
 * detection answers "is the writer logging or reflecting right now", and the
 * surfaces respond to that:
 *
 * - logging   → quiet: no ghost links on task lines, no tension checks
 *               (a log line has no stance), minimal relatedness;
 * - reflecting → the full journaling apparatus: echo/tension, permanent
 *               notes first, temporal companions, and a visible offer to
 *               promote the thought out of the journal.
 */

/** A line that logs rather than reflects: bullets, tasks, headings. */
const LOG_LINE = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|\[.\]\s|- \[.\])/;

/**
 * Is this paragraph reflective prose (vs. log lines)? Deliberately
 * conservative: reflection is sentences — length, punctuation, and not
 * mostly list structure. A short bullet never qualifies, so the quiet
 * treatment is the default and reflection must earn its surfaces.
 */
export function isReflectiveProse(paragraph: string): boolean {
  const text = paragraph.trim();
  if (text.length < 100) return false;
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const logLines = lines.filter((l) => LOG_LINE.test(l)).length;
  if (logLines > lines.length / 2) return false;
  return /[.!?…。！？]/.test(text);
}

/** Is the line the cursor sits on a log line (list item, task, heading)? */
export function isLogLine(line: string): boolean {
  return LOG_LINE.test(line);
}

/** Is `path` inside any of `folders` (vault-relative, no trailing slash)? */
export function inFolders(path: string, folders: string[]): boolean {
  return folders.some((f) => f.length > 0 && (path === f || path.startsWith(`${f}/`)));
}

/** Parse the comma-separated journal-folders setting. */
export function parseFolderList(setting: string): string[] {
  return setting
    .split(",")
    .map((f) => f.trim().replace(/^\/+|\/+$/g, ""))
    .filter((f) => f.length > 0);
}
