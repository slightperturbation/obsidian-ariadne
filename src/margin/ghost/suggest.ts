import type { ScoredResult } from "../../core/types";

export interface GhostDecisionInput {
  /** Related results for the current paragraph, current note excluded. */
  results: ScoredResult[];
  /** Full note text — a note already linked is never re-suggested. */
  noteText: string;
  /** Paragraph the cursor is in — suggestions should be about it. */
  paragraphText: string;
  /** Character immediately before the cursor ("" at line start). */
  charBefore: string;
  /** Character immediately after the cursor ("" at line end). */
  charAfter: string;
  /** The cursor's line up to the cursor. */
  lineBefore: string;
  /** Note paths the writer dismissed (scoped per paragraph by the caller). */
  dismissed: ReadonlySet<string>;
  /** Minimum raw cosine (bge-small: ~0.3–0.5 unrelated, ~0.7+ related). */
  minCosine: number;
}

export interface GhostDecision {
  targetPath: string;
  title: string;
  /** Exactly what accepting inserts, spacing included. */
  insertText: string;
}

/**
 * Decide whether to offer a ghost [[link]], and to where. Deliberately
 * conservative — the PRD's bar is marginalia, not autocomplete nagging:
 * only at the end of a word (never mid-word, never inside an unclosed
 * wikilink), only for a semantically close note (raw cosine, not
 * rank-flattered confidence), never for a note already linked, and never
 * re-nagging something dismissed.
 */
export function decideGhost(input: GhostDecisionInput): GhostDecision | null {
  if (!input.paragraphText.trim()) return null;
  // Mid-word: a word character immediately follows the cursor.
  if (/[\w]/.test(input.charAfter)) return null;
  // Inside an unclosed wikilink the writer is typing themselves.
  if (/\[\[[^\]]*$/.test(input.lineBefore)) return null;

  // Offer the semantically *closest* eligible note, not merely the first one
  // past the bar — `results` is ordered by fused rank, which blends lexical
  // overlap and can put a weaker-but-wordier match first.
  let best: ScoredResult | undefined;
  for (const r of input.results) {
    if (r.cosine === undefined || r.cosine < input.minCosine) continue;
    if (input.dismissed.has(r.path)) continue;
    // Already linked anywhere in the note (by title or by path basename)?
    const basename = (r.path.split("/").pop() ?? r.path).replace(/\.md$/i, "");
    const linked =
      input.noteText.includes(`[[${r.title}`) || input.noteText.includes(`[[${basename}`);
    if (linked) continue;
    if (!best || r.cosine > best.cosine!) best = r;
  }
  if (!best) return null;

  const needsSpace = input.charBefore !== "" && !/\s/.test(input.charBefore);
  return {
    targetPath: best.path,
    title: best.title,
    insertText: `${needsSpace ? " " : ""}[[${best.title}]]`,
  };
}
