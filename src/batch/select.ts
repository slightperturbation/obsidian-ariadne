/**
 * Which notes a batch job works on — chosen by code, never by a model, so
 * the list is exact and the same each time it is asked for.
 */
export interface Selector {
  /** A folder; "" for the whole vault. */
  folder?: string;
  /** Include notes in the folder's subfolders (default yes). */
  subfolders?: boolean;
  /** A tag, with or without #; its subtags count too (project → project/ariadne). */
  tag?: string;
  /** Words that must all appear in the note's name. */
  name?: string;
  /** YYYY-MM-DD: the date in the note's name is on or after / on or before this. */
  from?: string;
  to?: string;
  /** YYYY-MM-DD: changed on or after this day. */
  changedSince?: string;
  /** "key" (has it) or "key=value". */
  property?: string;
}

export interface NoteInfo {
  path: string;
  mtime: number;
  tags: string[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The date a note's name carries (2026-11-22, 2026-11-22 Sunday, Journal 2026-11-22), if any. */
export function dateInName(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  return /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
}

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The selector in words, for the job card: "in Periodic/Daily, tagged #idea, dated from 2024-01-01". */
export function describeSelector(sel: Selector): string {
  const parts: string[] = [];
  const folder = (sel.folder ?? "").replace(/^\/+|\/+$/g, "");
  parts.push(folder ? `in ${folder}${sel.subfolders === false ? " (not its subfolders)" : ""}` : "in the whole vault");
  if (sel.tag) parts.push(`tagged #${sel.tag.replace(/^#/, "")}`);
  if (sel.name) parts.push(`named with "${sel.name}"`);
  if (sel.from && sel.to) parts.push(`dated ${sel.from} to ${sel.to}`);
  else if (sel.from) parts.push(`dated from ${sel.from}`);
  else if (sel.to) parts.push(`dated up to ${sel.to}`);
  if (sel.changedSince) parts.push(`changed since ${sel.changedSince}`);
  if (sel.property) parts.push(`with property ${sel.property}`);
  return parts.join(", ");
}

/** Is the selector usable? An error in words, or undefined. */
export function selectorError(sel: Selector): string | undefined {
  for (const [k, v] of [["from", sel.from], ["to", sel.to], ["changed_since", sel.changedSince]] as const) {
    if (v !== undefined && v !== "" && !DAY.test(v)) return `${k} must be a day, as YYYY-MM-DD`;
  }
  if (sel.property !== undefined && sel.property !== "" && !/^[A-Za-z][\w -]*(=.*)?$/.test(sel.property)) return "property must be key or key=value";
  const folder = sel.folder ?? "";
  if (folder.split("/").some((seg) => seg === ".." || seg.startsWith("."))) return "that is not a usable folder";
  return undefined;
}

/**
 * The notes a selector picks, in a steady order (by path). `property` reads a
 * note's properties when the selector asks about one.
 */
export function selectNotes(notes: NoteInfo[], sel: Selector, property?: (path: string) => Record<string, unknown> | undefined): string[] {
  const folder = (sel.folder ?? "").replace(/^\/+|\/+$/g, "");
  const words = (sel.name ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const tag = (sel.tag ?? "").replace(/^#/, "").toLowerCase();
  const [propKey, ...rest] = (sel.property ?? "").split("=");
  const propValue = rest.length ? rest.join("=").trim().toLowerCase() : undefined;
  const changed = sel.changedSince ?? "";
  return notes
    .filter((n) => {
      if (folder) {
        if (!n.path.startsWith(`${folder}/`)) return false;
        if (sel.subfolders === false && n.path.slice(folder.length + 1).includes("/")) return false;
      }
      if (tag && !n.tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(`${tag}/`))) return false;
      if (words.length) {
        const name = (n.path.split("/").pop() ?? "").toLowerCase();
        if (!words.every((w) => name.includes(w))) return false;
      }
      if (sel.from || sel.to) {
        const d = dateInName(n.path);
        if (!d) return false;
        if (sel.from && d < sel.from) return false;
        if (sel.to && d > sel.to) return false;
      }
      if (changed && localDay(n.mtime) < changed) return false;
      if (propKey && propKey.trim()) {
        const props = property?.(n.path);
        const key = propKey.trim();
        if (!props || !(key in props)) return false;
        if (propValue !== undefined) {
          const v = props[key];
          const values = (Array.isArray(v) ? v : [v]).map((x) => String(x).trim().toLowerCase());
          if (!values.includes(propValue)) return false;
        }
      }
      return true;
    })
    .map((n) => n.path)
    .sort((a, b) => a.localeCompare(b));
}
