/**
 * Fill-out candidates — the Vault zone's "finish what the world can see".
 *
 * A stub in a private corner costs nothing; a stub behind a published URL is
 * a live gap, and an unpublished stub LINKED FROM a published page is a
 * doorway that opens onto nothing. So candidacy is publish-anchored: a note
 * qualifies by being published and incomplete, or by being incomplete and
 * reachable from a published note. Pure scoring over content the caller
 * reads; reasons are stated as facts ("stub — 32 words"), never judgments.
 */

export interface FillOutCandidate {
  path: string;
  title: string;
  published: boolean;
  /** Title of the published note that links here (unpublished candidates). */
  viaPublished?: string;
  content: string;
  unresolvedCount: number;
}

export interface FillOutRow {
  path: string;
  title: string;
  /** Fact-only context line for the row. */
  reason: string;
}

/** Below this, a note is a stub; below SHORT_WORDS, merely thin. */
const STUB_WORDS = 40;
const SHORT_WORDS = 120;

/** A heading with nothing under it before the next heading (or EOF). */
const EMPTY_SECTION = /^#{1,6}[^\n]*\n(?:\s*\n)*(?=#{1,6}[ \t]|\s*$)/m;

export function incompleteness(
  content: string,
  unresolvedCount: number,
): { score: number; reasons: string[] } {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  const reasons: string[] = [];
  let score = 0;
  if (words < STUB_WORDS) {
    score += 3;
    reasons.push(`stub — ${words} words`);
  } else if (words < SHORT_WORDS) {
    score += 1;
    reasons.push(`short — ${words} words`);
  }
  if (/^\s*- \[ \]/m.test(body) || /\bTODO\b/.test(body)) {
    score += 1;
    reasons.push("open tasks");
  }
  if (unresolvedCount > 0) {
    score += 1;
    reasons.push(`${unresolvedCount} unresolved link${unresolvedCount === 1 ? "" : "s"}`);
  }
  if (EMPTY_SECTION.test(body)) {
    score += 1;
    reasons.push("empty sections");
  }
  return { score, reasons };
}

export function rankFillOut(candidates: FillOutCandidate[], limit = 2): FillOutRow[] {
  return candidates
    .map((c) => ({ c, ...incompleteness(c.content, c.unresolvedCount) }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        Number(b.c.published) - Number(a.c.published) ||
        b.score - a.score ||
        a.c.title.localeCompare(b.c.title),
    )
    .slice(0, limit)
    .map((x) => ({
      path: x.c.path,
      title: x.c.title,
      reason: `${x.c.published ? "published" : `via “${x.c.viaPublished ?? "?"}”`} — ${x.reasons.join(", ")}`,
    }));
}
