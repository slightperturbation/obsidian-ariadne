/**
 * Adding and removing tags in a note's properties — and nothing else.
 *
 * Only the `tags` (or `tag`) property is rewritten; every other line of the
 * note stays byte for byte as it was, so the preview is a diff of that one
 * property. The property keeps the form it was written in: `tags: [a, b]`
 * stays inline, a dash list stays a dash list with its own indent. A tag that
 * is written in the text as #tag is never touched — the body is the owner's
 * words — and is reported instead, so they can change it themselves.
 *
 * Pure: no Obsidian, so it is tested on its own.
 */

/** A tag as Obsidian takes it, given with or without "#"; null when it is not one. */
export function normalTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, "");
  if (!t || t.length > 100) return null;
  if (!/^[\p{L}\p{N}_\-/]+$/u.test(t)) return null;
  // Obsidian needs at least one character that is not a digit.
  if (/^[\d/]+$/.test(t)) return null;
  if (t.startsWith("/") || t.endsWith("/") || t.startsWith("-") || t.includes("//")) return null;
  return t;
}

export interface TagEdit {
  /** The note as it would be. Equal to the input when nothing changes. */
  text: string;
  added: string[];
  removed: string[];
  /** Asked to remove, but written in the text as #tag: left for the owner. */
  inline: string[];
  /** Asked to remove, but the note does not have it. */
  missing: string[];
}

const FRONTMATTER = /^(---[ \t]*\r?\n)(?:([\s\S]*?)\r?\n)?(---[ \t]*(?:\r?\n|$))/;
const KEY = /^(tags|tag)[ \t]*:(.*)$/;
const ITEM = /^(\s*)-[ \t]*(.*)$/;

const unquote = (s: string): string => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/** A value YAML would read as something other than text is written in quotes. */
function yamlValue(tag: string): string {
  return /^(true|false|yes|no|on|off|null|~)$/i.test(tag) || /^[-+.\d]/.test(tag) ? JSON.stringify(tag) : tag;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Is #tag written in the text itself (not just in the properties)? */
function inBody(body: string, tag: string): boolean {
  return new RegExp(`(^|[\\s(\\[,;])#${escapeRe(tag)}(?![\\p{L}\\p{N}_\\-/])`, "iu").test(body);
}

export function editTags(note: string, addRaw: string[], removeRaw: string[]): TagEdit | { error: string } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const raw of addRaw) {
    const t = normalTag(raw);
    if (!t) return { error: `"${raw.slice(0, 60)}" is not a tag (letters, digits, _ - and / only, not only digits)` };
    add.push(t);
  }
  for (const raw of removeRaw) {
    const t = normalTag(raw);
    if (!t) return { error: `"${raw.slice(0, 60)}" is not a tag` };
    remove.push(t);
  }
  const lower = (t: string) => t.toLowerCase();
  if (add.some((a) => remove.some((r) => lower(r) === lower(a)))) return { error: "the same tag is both added and removed" };

  const nl = note.includes("\r\n") ? "\r\n" : "\n";
  const fm = FRONTMATTER.exec(note);
  const lines = fm ? (fm[2] ?? "").split(/\r?\n/) : [];
  if (fm && fm[2] === undefined) lines.length = 0;
  const body = fm ? note.slice(fm[0].length) : note;

  // Where the tags property is, what it holds, and how it is written.
  const at = lines.map((l, i) => (KEY.test(l) ? i : -1)).filter((i) => i >= 0);
  if (at.length > 1) return { error: "the note has its tags property more than once; change it by hand" };
  let current: string[] = [];
  let key = "tags";
  let style: "flow" | "block" = "block";
  let indent = "  ";
  let start = -1;
  let end = -1;
  if (at.length === 1) {
    start = at[0]!;
    const m = KEY.exec(lines[start]!)!;
    key = m[1]!;
    const rest = m[2]!.trim();
    end = start + 1;
    if (rest === "") {
      while (end < lines.length && ITEM.test(lines[end]!)) {
        const item = ITEM.exec(lines[end]!)!;
        if (end === start + 1) indent = item[1]!;
        current.push(unquote(item[2]!));
        end++;
      }
    } else if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) return { error: "the tags property is written over several lines in a form I do not change; change it by hand" };
      style = "flow";
      current = rest.slice(1, -1).split(",").map(unquote);
    } else if (/^[|>{&*!]/.test(rest)) {
      return { error: "the tags property is written in a form I do not change; change it by hand" };
    } else {
      current = unquote(rest).split(/[,\s]+/);
    }
    current = current.map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
  }

  const kept = [...current];
  const removed: string[] = [];
  const inline: string[] = [];
  const missing: string[] = [];
  for (const r of remove) {
    const i = kept.findIndex((t) => lower(t) === lower(r));
    if (i >= 0) {
      removed.push(kept[i]!);
      kept.splice(i, 1);
    } else if (inBody(body, r)) inline.push(r);
    else missing.push(r);
  }
  const added: string[] = [];
  for (const a of add) {
    if (kept.some((t) => lower(t) === lower(a))) continue;
    kept.push(a);
    added.push(a);
  }
  if (added.length === 0 && removed.length === 0) return { text: note, added, removed, inline, missing };

  const property =
    kept.length === 0
      ? []
      : style === "flow"
        ? [`${key}: [${kept.map(yamlValue).join(", ")}]`]
        : [`${key}:`, ...kept.map((t) => `${indent}- ${yamlValue(t)}`)];
  let next: string[];
  if (start >= 0) next = [...lines.slice(0, start), ...property, ...lines.slice(end)];
  else next = [...lines, ...property];

  let text: string;
  if (!fm) {
    // Only reached when adding: a note with no properties gets them, with tags alone.
    text = `---${nl}${property.join(nl)}${nl}---${nl}${note}`;
  } else if (next.every((l) => l.trim() === "")) {
    // Nothing is left in the properties but the tags just taken out: no empty block is left behind.
    text = body;
  } else {
    text = `${fm[1]}${next.join(nl)}${nl}${fm[3]}${body}`;
  }
  return { text, added, removed, inline, missing };
}
