import { dateOf } from "../core/periodic";
import { isReflectiveProse } from "./journal";

/**
 * Threads — the anti-blank-page mechanism.
 *
 * The blocker journaling practice keeps finding is not having nothing to
 * say; it is retrieval at the moment of sitting down. Generic prompts go
 * stale because they are nobody's. The vault holds something better: the
 * writer's own unfinished thinking. A thread is a continuation point drawn
 * verbatim from their words — yesterday's last reflective paragraph, an
 * unanswered question from the weekly synthesis — offered when today's
 * entry is still (nearly) blank.
 *
 * The AI-writing boundary holds by construction: everything a thread can
 * insert is a QUOTE of existing vault text (the writer's prose, or a
 * synthesis QUESTION — questions being the one thing the model is allowed
 * to author). Threads never generate an opener in the writer's voice.
 */

export interface ThreadItem {
  /** Where it came from — "yesterday", "weekly synthesis". */
  label: string;
  /** The verbatim line offered as a continuation point. */
  quote: string;
  sourcePath: string;
}

/** An entry with this little body still counts as facing the blank page. */
export const BLANK_PAGE_CHARS = 200;

const stripFrontmatter = (s: string): string =>
  s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

export function isBlankPage(noteText: string): boolean {
  return stripFrontmatter(noteText).trim().length < BLANK_PAGE_CHARS;
}

/** First sentence of a paragraph, clipped at a word boundary. */
function clip(text: string, max = 110): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const sentence = /^(.*?[.!?…。！？])\s/.exec(oneLine + " ")?.[1] ?? oneLine;
  if (sentence.length <= max) return sentence;
  const cut = sentence.lastIndexOf(" ", max - 1);
  return (cut > 30 ? sentence.slice(0, cut) : sentence.slice(0, max - 1)) + "…";
}

/**
 * The gist of an entry's LAST reflective paragraph — where yesterday's
 * thinking stopped is where today's most naturally starts.
 */
export function lastReflectiveGist(content: string): string | null {
  const paragraphs = stripFrontmatter(content)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => isReflectiveProse(p));
  const last = paragraphs[paragraphs.length - 1];
  return last ? clip(last) : null;
}

/** The bullets under "## Questions to elaborate" in a synthesis note. */
export function synthesisQuestions(content: string): string[] {
  const m = /## Questions to elaborate\s*\n([\s\S]*?)(\n## |$)/.exec(content);
  if (!m) return [];
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*-\s*/, "").trim())
    .filter((l) => l.length > 0);
}

/** Deterministic daily pick — the same thread all day, a new one tomorrow. */
export function pickForDay<T>(items: T[], isoDate: string): T | null {
  if (items.length === 0) return null;
  let hash = 0x811c9dc5;
  for (let i = 0; i < isoDate.length; i++) {
    hash ^= isoDate.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return items[(hash >>> 0) % items.length];
}

/** The nearest dated entry strictly before `beforeIso` (the chain's ← link). */
export function previousDated(paths: string[], beforeIso: string): string | null {
  let best: { path: string; date: string } | null = null;
  for (const p of paths) {
    const d = dateOf(p);
    if (!d || d >= beforeIso) continue;
    if (!best || d > best.date) best = { path: p, date: d };
  }
  return best?.path ?? null;
}

/** The quote line a thread inserts — the writer's words, quoted, attributed. */
export function threadQuote(item: ThreadItem): string {
  return `> ${item.label}: “${item.quote}”\n\n`;
}

/**
 * "last wrote Tuesday" — continuity as information, never as a streak. A
 * streak converts a reflective practice into a compliance game; a plain
 * statement of when you last wrote is just true.
 */
export function continuityLabel(prevIso: string, todayIso: string): string {
  const prev = new Date(`${prevIso}T12:00:00`);
  const today = new Date(`${todayIso}T12:00:00`);
  const days = Math.round((today.getTime() - prev.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days <= 6) {
    return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      prev.getDay()
    ];
  }
  return `${days} days ago`;
}
