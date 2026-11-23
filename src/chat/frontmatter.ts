import { parse as parseYaml } from "yaml";

/**
 * A note's properties block, found the way Obsidian's own reader finds it:
 * the file begins with exactly `---` and a line break (no space after it),
 * and the block ends at the NEXT line that begins with `---`. (A pattern match that let the block run on to a later `---` rule
 * once took body text for properties.) One splitter, used everywhere that
 * reads or rewrites properties, so they all agree on where the body begins.
 */
export interface Front {
  /** The opening line, with its line ending. */
  open: string;
  /** The lines between the fences, without line endings. */
  lines: string[];
  /** The closing line, with its line ending (none at the end of the file). */
  close: string;
  body: string;
  /** The note's line ending. */
  nl: string;
}

export function splitFront(text: string): Front | null {
  // Exactly "---" then the line break: Obsidian reads "--- " (a space after) as no properties at all.
  const first = /^---(\r?\n)/.exec(text);
  if (!first) return null;
  const nl = first[1]!;
  const lines: string[] = [];
  let i = first[0].length;
  for (;;) {
    const j = text.indexOf("\n", i);
    const end = j < 0 ? text.length : j;
    const line = text.slice(i, end).replace(/\r$/, "");
    // Obsidian closes the block at the first line that begins with "---" ("----" and "--- " too).
    if (line.startsWith("---")) {
      const after = j < 0 ? text.length : j + 1;
      return { open: first[0], lines, close: text.slice(i, after), body: text.slice(after), nl };
    }
    lines.push(line);
    if (j < 0) return null;
    i = j + 1;
  }
}

/** The note without its properties block. */
export function bodyOf(text: string): string {
  return splitFront(text)?.body ?? text;
}

/** A properties block put back together with new lines; no block at all when there are none. */
export function joinFront(front: Front, lines: string[]): string {
  if (lines.every((l) => l.trim() === "")) return front.body;
  return `${front.open}${lines.join(front.nl)}${front.nl}${front.close}${front.body}`;
}

/**
 * A top-level property's lines: the `key:` line and every line after it that
 * belongs to it (indented, or a `- item` of a list written flush left).
 */
export function propertySpan(lines: string[], at: number): number {
  let end = at + 1;
  while (end < lines.length && /^(\s+\S|-(\s|$))/.test(lines[end]!)) end++;
  return end;
}

/** Each top-level property's name (as written) and its raw text, value lines included — for comparing two versions. */
export function rawProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const front = splitFront(text);
  if (!front) return out;
  const { lines } = front;
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\s:#][^:]*?)[ \t]*:(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const end = propertySpan(lines, i);
    out.set(m[1]!.trim().toLowerCase(), [m[2]!.trim(), ...lines.slice(i + 1, end).map((l) => l.trim())].join("\n"));
    i = end - 1;
  }
  return out;
}

/**
 * A note's properties as YAML reads them — the way Obsidian does — keyed by
 * name without regard to case, each value as JSON for comparing. Not ok when
 * the block does not parse, or holds the same name twice: then Obsidian would
 * not read it either (and a privacy property in it would silently stop
 * counting).
 */
export function parsedProperties(text: string): { ok: true; props: Map<string, string> } | { ok: false } {
  const front = splitFront(text);
  const props = new Map<string, string>();
  if (!front) return { ok: true, props };
  let data: unknown;
  try {
    data = parseYaml(front.lines.join("\n"), { uniqueKeys: true });
  } catch {
    return { ok: false };
  }
  if (data === null || data === undefined) return { ok: true, props };
  if (typeof data !== "object" || Array.isArray(data)) return { ok: false };
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const key = k.trim().toLowerCase();
    if (props.has(key)) return { ok: false };
    props.set(key, JSON.stringify(v ?? null));
  }
  return { ok: true, props };
}
