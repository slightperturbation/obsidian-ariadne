/**
 * The people the owner has written with, found in their correspondence: a
 * person note each (Personal/Correspondence/People — name, aka, first and
 * last contact, how many messages) and the conversations with them
 * (Personal/Correspondence/Moments — a person and a date each). Someone with
 * conversations but no person note of their own is found too.
 */

export interface NoteInfo {
  path: string;
  frontmatter?: Record<string, unknown>;
  mtime: number;
  /** Bytes: how much the note holds. */
  size?: number;
}

export interface Moment {
  path: string;
  /** YYYY-MM-DD. */
  date: string;
  title: string;
  messages: number;
  /** Bytes: how much the conversation holds. */
  size: number;
}

export interface Person {
  /** Lower-case name: what identifies them here. */
  key: string;
  name: string;
  /** Other names they go by. */
  aliases: string[];
  /** Their person note, when they have one. */
  note?: string;
  moments: Moment[];
  /** YYYY-MM-DD, or "" when nothing is dated. */
  first: string;
  last: string;
  messages: number;
  /** How much there is to know them by: their note, their conversations, their messages. */
  info: number;
}

const strings = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\s*,\s*/) : []).filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);

/** "[[People/Ann Lee|Ann]]" → "Ann Lee"; a plain name stays as it is. */
export function bareName(v: string): string {
  const link = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(v.trim());
  const name = link ? link[1]!.split("/").pop()! : v.trim();
  return name.replace(/\.md$/i, "").trim();
}

export function isoDate(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
    if (m) return m[1];
  }
  return undefined;
}

const baseName = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");
const isPersonNote = (n: NoteInfo) => /(^|\/)Correspondence\/People\//.test(n.path) || n.frontmatter?.type === "person";
const isMoment = (n: NoteInfo) => n.frontmatter?.type === "correspondence-moment" || /(^|\/)Correspondence\/Moments\//.test(n.path);

/** Everyone the owner has written with, the one there is most to know them by first. */
export function findPeople(notes: NoteInfo[]): Person[] {
  const byKey = new Map<string, Person>();
  const lookup = new Map<string, Person>();
  for (const n of notes) {
    if (!isPersonNote(n)) continue;
    const fm = n.frontmatter ?? {};
    const name = (typeof fm.name === "string" && fm.name.trim()) || baseName(n.path);
    const aliases = [...new Set([...strings(fm.aka), ...strings(fm.aliases), baseName(n.path)].filter((a) => a.toLowerCase() !== name.toLowerCase()))];
    const p: Person = {
      key: name.toLowerCase(),
      name,
      aliases,
      note: n.path,
      moments: [],
      first: isoDate(fm.first_contact) ?? "",
      last: isoDate(fm.last_contact) ?? "",
      messages: typeof fm.messages === "number" ? fm.messages : 0,
      info: n.size ?? 0,
    };
    if (byKey.has(p.key)) continue;
    byKey.set(p.key, p);
    for (const k of [name, ...aliases]) if (!lookup.has(k.toLowerCase())) lookup.set(k.toLowerCase(), p);
  }
  const counted = new Set<Person>();
  for (const n of notes) {
    if (!isMoment(n)) continue;
    const fm = n.frontmatter ?? {};
    const date = isoDate(fm.date) ?? isoDate(baseName(n.path));
    if (!date) continue;
    const title = baseName(n.path).replace(/^\d{4}-\d{2}-\d{2}\s*/, "");
    const messages = typeof fm.messages === "number" ? fm.messages : 1;
    for (const who of strings(fm.person).map(bareName)) {
      let p = lookup.get(who.toLowerCase());
      if (!p) {
        p = { key: who.toLowerCase(), name: who, aliases: [], moments: [], first: "", last: "", messages: 0, info: 0 };
        byKey.set(p.key, p);
        lookup.set(p.key, p);
      }
      p.moments.push({ path: n.path, date, title, messages, size: n.size ?? 0 });
      if (!p.note) counted.add(p);
    }
  }
  for (const p of byKey.values()) {
    p.moments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (p.moments.length) {
      if (!p.first || p.moments[0]!.date < p.first) p.first = p.moments[0]!.date;
      if (!p.last || p.moments[p.moments.length - 1]!.date > p.last) p.last = p.moments[p.moments.length - 1]!.date;
    }
    // A person with no note of their own: their messages are what their conversations hold.
    if (counted.has(p)) p.messages = p.moments.reduce((a, m) => a + m.messages, 0);
    p.info += p.moments.reduce((a, m) => a + m.size, 0) + p.messages * 150;
  }
  // Someone only named once is not one of the people the owner has written with.
  return [...byKey.values()]
    .filter((p) => p.note !== undefined || p.moments.length >= 2)
    .sort((a, b) => b.info - a.info || b.moments.length - a.moments.length || a.name.localeCompare(b.name));
}

/**
 * Does a text mention this person? By full name or another name, or by first
 * name alone when it is at least three letters — whole words, any case.
 */
export function mentionPattern(p: Pick<Person, "name" | "aliases">): RegExp {
  const names = new Set<string>([p.name, ...p.aliases]);
  const first = p.name.split(/\s+/)[0] ?? "";
  if (first.length >= 3) names.add(first);
  const alts = [...names].filter((n) => n.trim().length >= 3).map((n) => n.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join("|") || "\\u0000"})(?![\\p{L}\\p{N}])`, "iu");
}
