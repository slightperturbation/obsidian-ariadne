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
export function paragraphKey(path: string, text: string): string {
  const words = [...new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])].sort();
  return `${path}::${words.join(",")}`;
}
