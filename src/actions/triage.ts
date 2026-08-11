import { sanitizeTitle } from "../model/tasks";

/**
 * Pure helpers for the 4c filing pair: `Untitled` renaming and Inbox triage
 * (PRD §4.5). Everything here is deterministic and model-free; the model is
 * consulted only where these helpers come up empty, and never for a decision
 * a local signal already answers.
 */

/** "Untitled", "Untitled 3", "untitled 12" — Obsidian's default note names. */
export function isUntitledName(basename: string): boolean {
  return /^untitled( \d+)?$/i.test(basename.trim());
}

const MAX_TITLE_CHARS = 60;

/**
 * Derive a title from the note's own text: its first heading, else its first
 * sentence-ish line. Returns null when the content offers nothing usable —
 * only then is a model asked. The writer's own words beat a generated title,
 * and this path is free and instant.
 */
export function titleFromContent(content: string): string | null {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const candidate = heading ? heading[1] : line;
    const cleaned = sanitizeTitle(
      candidate
        // The alias is the writer's chosen display text — prefer it.
        .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[*_`>#]/g, "")
        .trim(),
    );
    // sanitizeTitle answers "Untitled" for junk input — which here would
    // propose renaming Untitled to Untitled. Junk means keep looking.
    if (cleaned.length < 3 || isUntitledName(cleaned)) continue;
    if (cleaned.length <= MAX_TITLE_CHARS) return cleaned;
    // Cut at a word boundary; a trailing fragment reads worse than a short title.
    const cut = cleaned.lastIndexOf(" ", MAX_TITLE_CHARS);
    return cut > 20 ? cleaned.slice(0, cut) : cleaned.slice(0, MAX_TITLE_CHARS);
  }
  return null;
}

/** What triage proposes for one Inbox item. */
export interface TriageProposal {
  disposition: "elaborate" | "merge" | "archive";
  /** Terse justification, shown on the row. */
  reason: string;
  /** For merge: the note it duplicates. */
  mergeTarget?: { path: string; title: string };
}

/** Content with markdown scaffolding stripped — “is anything actually here?” */
const substanceOf = (content: string): string =>
  content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .replace(/[#>*\-_`[\]|]/g, "")
    .trim();

/** Below this many substantive characters, a note is a dead stub. */
const STUB_CHARS = 40;
/** Stored-vector cosine above which an Inbox item duplicates an existing note. */
export const TRIAGE_MERGE_COSINE = 0.9;

/**
 * The local (free) half of the triage decision. Returns null when only a
 * reasoning model can judge — which is precisely the interesting middle:
 * real content that neither duplicates anything nor is obviously dead.
 */
export function decideLocally(
  content: string,
  top: { path: string; title: string; cosine?: number } | undefined,
): TriageProposal | null {
  if (substanceOf(content).length < STUB_CHARS) {
    return { disposition: "archive", reason: "effectively empty — a dead stub" };
  }
  if (top?.cosine !== undefined && top.cosine >= TRIAGE_MERGE_COSINE) {
    return {
      disposition: "merge",
      reason: `near-duplicate of ${top.title}`,
      mergeTarget: { path: top.path, title: top.title },
    };
  }
  return null;
}
