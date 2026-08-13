/** Pure helpers for extracting the writing context around the cursor. */

export interface ParagraphContext {
  /** The paragraph's text, lines joined with newlines. */
  text: string;
  /** First and last line numbers (0-based, inclusive) of the paragraph. */
  startLine: number;
  endLine: number;
}

const isBlank = (line: string): boolean => line.trim().length === 0;

/**
 * The blank-line-delimited paragraph containing `line`. Headings act as
 * boundaries too, so context under a heading doesn't bleed into it — but a
 * cursor ON a heading takes the heading itself (its words are the context).
 */
export function paragraphAround(lines: string[], line: number): ParagraphContext {
  const at = Math.max(0, Math.min(line, lines.length - 1));
  const isHeading = (l: string) => /^#{1,6}\s/.test(l);

  if (lines.length === 0 || isBlank(lines[at] ?? "")) {
    return { text: "", startLine: at, endLine: at };
  }
  if (isHeading(lines[at])) {
    return { text: lines[at].replace(/^#{1,6}\s+/, ""), startLine: at, endLine: at };
  }

  let start = at;
  while (start > 0 && !isBlank(lines[start - 1]) && !isHeading(lines[start - 1])) start--;
  let end = at;
  while (end < lines.length - 1 && !isBlank(lines[end + 1]) && !isHeading(lines[end + 1])) end++;

  return { text: lines.slice(start, end + 1).join("\n"), startLine: start, endLine: end };
}

/**
 * A stable key for "the same paragraph, materially unchanged" — used to avoid
 * re-suggesting after a dismissal while the writer is still mid-thought.
 * Word-set based, so small edits (typos, punctuation) don't count as change.
 */
const STOP = new Set(["the", "and", "are", "was", "has", "had", "its", "this", "that"]);

export function paragraphKey(path: string, text: string): string {
  // Unicode-aware, and ≥3 chars so negators ("not", "nor") count — a key
  // that can't see negation would keep serving a pre-negation verdict for a
  // paragraph that now says the opposite. The previous [a-z0-9]{4,} matched
  // NOTHING in CJK/Cyrillic/Greek text, collapsing every paragraph of such a
  // note to one identical key: the watcher's dedupe then froze the Margin
  // for the whole note after its first emit.
  // 3-char words are kept because negators live there ("not", "nor") — but
  // stance-free articles/copulas are dropped, or every "the" typed would
  // churn the key and defeat the dedupe it exists for.
  const words = [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []).filter((w) => !STOP.has(w)),
    ),
  ].sort();
  if (words.length === 0 && text.trim().length > 0) {
    // Scriptless/symbolic text still needs a content-derived identity.
    return `${path}::${text.trim().slice(0, 60)}`;
  }
  return `${path}::${words.join(",")}`;
}
