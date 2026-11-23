import { joinFront, propertySpan, splitFront } from "./frontmatter";
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

const KEY = /^(tags|tag)[ \t]*:(.*)$/i;
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
  const fm = splitFront(note);
  const lines = fm ? [...fm.lines] : [];
  const body = fm ? fm.body : note;

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
    end = propertySpan(lines, start);
    const following = lines.slice(start + 1, end);
    if (rest === "" || /^(null|~)$/i.test(rest)) {
      // Every line that belongs to the property must be a list item, or nothing here is understood well enough to change.
      if (following.some((l) => !ITEM.test(l))) return { error: "the tags property is written in a form I do not change; change it by hand" };
      for (const l of following) {
        const item = ITEM.exec(l)!;
        if (current.length === 0) indent = item[1]!;
        current.push(unquote(item[2]!));
      }
    } else if (following.length > 0) {
      return { error: "the tags property runs over several lines in a form I do not change; change it by hand" };
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

  // No properties yet (only reached when adding): the note gets them, with tags alone. Nothing left: no empty block.
  const text = fm ? joinFront(fm, next) : `---${nl}${property.join(nl)}${nl}---${nl}${note}`;
  return { text, added, removed, inline, missing };
}

/**
 * Properties a batch may never set: they decide who may read a note, whether
 * it is published, and who wrote it — the owner's to change, by hand.
 */
const GUARDED = new Set(["agent-access", "publish", "authorship", "type", "tags", "tag", "aliases", "alias", "cssclasses"]);

/** A value as YAML reads it back as written: dates, numbers and true/false plain; other text plain or quoted. */
function propertyValue(v: string): string {
  // Written plain only where YAML reads back exactly what was meant: a date, true/false, a plain decimal number.
  if (/^(true|false|-?(0|[1-9]\d*)(\.\d+)?|\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?)$/.test(v)) return v;
  // Text that YAML could read as something else (a number in another form, a boolean, null) is quoted.
  const looksTyped = /^[-+.]?\d/.test(v) || /^(yes|no|on|off|null|~|true|false)$/i.test(v);
  if (!looksTyped && /^[\p{L}][\p{L}\p{N} _.,/()'-]*$/u.test(v)) return v;
  return JSON.stringify(v);
}

/**
 * Set one plain property (`key: value`) in a note's properties, or take it
 * out (`value` null). Every other line stays as it was. Lists and nested
 * values are not changed here — tags have their own editor — and the guarded
 * properties are never set at all.
 */
export function editProperty(note: string, keyRaw: string, value: string | null): { text: string } | { error: string } {
  const key = keyRaw.trim();
  if (!/^[A-Za-z][\w-]*( [\w-]+)*$/.test(key) || key.length > 60) return { error: `"${keyRaw.slice(0, 60)}" is not a property name` };
  if (GUARDED.has(key.toLowerCase())) return { error: `"${key}" is not changed by a batch: ${["tags", "tag"].includes(key.toLowerCase()) ? "use the tag tools" : "the owner sets it by hand"}` };
  const val = value === null ? null : value.replace(/[\r\n]+/g, " ").trim();
  if (val !== null && val.length > 300) return { error: "that value is too long for a property" };

  const nl = note.includes("\r\n") ? "\r\n" : "\n";
  const fm = splitFront(note);
  const lines = fm ? [...fm.lines] : [];
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*:(.*)$`, "i");
  const at = lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0);
  if (at.length > 1) return { error: `the note has "${key}" more than once; change it by hand` };
  if (at.length === 1) {
    const i = at[0]!;
    const rest = re.exec(lines[i]!)![1]!.trim();
    // Any line after it that belongs to it (indented, or a flush-left "- item") makes it more than one plain value.
    if (propertySpan(lines, i) > i + 1) return { error: `"${key}" holds a list or more than one line; change it by hand` };
    if (/^[[{|>&*!]/.test(rest)) return { error: `"${key}" holds a list or more than one line; change it by hand` };
  }
  const line = val === null ? [] : [`${key}: ${propertyValue(val)}`];
  if (at.length === 0 && val === null) return { text: note };
  const nextLines = at.length === 1 ? [...lines.slice(0, at[0]!), ...line, ...lines.slice(at[0]! + 1)] : [...lines, ...line];
  if (!fm) return { text: `---${nl}${line.join(nl)}${nl}---${nl}${note}` };
  return { text: joinFront(fm, nextLines) };
}
