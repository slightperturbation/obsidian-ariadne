/**
 * A persona, read and compressed from everything the owner's notes hold about
 * someone — their correspondence above all — and kept as an agent-made note
 * in Personal/Correspondence/Personas, so it is built once and talked with
 * often.
 *
 * Two rules hold it together. Their voice is kept in their own words: every
 * phrase in the note is checked to appear, word for word, in what was read.
 * And nothing is made up: every fact carries the date of the source it came
 * from, and a fact whose date is not one of those sources' is dropped.
 */
import { bodyOf } from "../chat/frontmatter";
import type { Era } from "./eras";
import type { Person } from "./people";

export const PERSONA_FOLDER = "Personal/Correspondence/Personas";
/** The note format: a note built by an older format is built again. */
export const PROFILE_VERSION = 1;

export interface Unit {
  /** Where it is from, for the model: "2011-03-04 — trip", "Journal, 2011-03-05". */
  head: string;
  /** YYYY-MM-DD, when dated. */
  date?: string;
  text: string;
  kind: "conversation" | "journal" | "note" | "person note";
}

export interface Extract {
  facts: Array<{ date: string; fact: string }>;
  phrases: string[];
  voice: string[];
  relationship: string[];
}

export interface Profile {
  summary: string;
  voice: string;
  phrases: string[];
  facts: Array<{ date: string; fact: string }>;
  examples: Array<{ head: string; text: string }>;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** The units, in order, cut into batches of at most `size` characters each (a longer unit is cut to fit). */
export function batches(units: Unit[], size: number): Unit[][] {
  const out: Unit[][] = [];
  let cur: Unit[] = [];
  let used = 0;
  for (const u of units) {
    const text = u.text.length > size - u.head.length - 50 ? `${u.text.slice(0, size - u.head.length - 50)}\n[…cut]` : u.text;
    const len = u.head.length + text.length + 8;
    if (cur.length && used + len > size) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push({ ...u, text });
    used += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** At most `max` batches: when there are more, an even spread across the years — said in the note. */
export function spreadBatches<T>(all: T[], max: number): T[] {
  if (all.length <= max) return all;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(all[Math.floor((i * all.length) / max)]!);
  return out;
}

export const unitText = (batch: Unit[]) => batch.map((u) => `### ${u.head}\n${u.text}`).join("\n\n");

export const EXTRACT_SYSTEM =
  "You read a person's correspondence and the notes about them, and write down only what the text itself says. You never guess, infer or add. Reply with a single JSON object and nothing else.";

export function extractPrompt(p: Pick<Person, "name">, batch: Unit[]): string {
  return [
    `Below are conversations between the owner of a notes vault and ${p.name}, and things the owner wrote about ${p.name}. Each part starts with "###", its date and title.`,
    unitText(batch),
    `Write down, as JSON:`,
    `- "phrases": 5 to 15 things ${p.name} wrote that are most like them — greetings, sign-offs, pet names, jokes, turns of phrase, typical sentences. Copy each EXACTLY as written, character for character, including spelling, punctuation and emoji. Only ${p.name}'s own words, never the owner's. Each under 200 characters.`,
    `- "voice": short observations of HOW ${p.name} writes: length of messages, punctuation, capital letters, emoji, language, tone, how they address the owner.`,
    `- "facts": facts about ${p.name}'s life, and about ${p.name} and the owner, that the text states — each with the date ("YYYY-MM-DD") of the part it is in. Only what is stated. No guesses.`,
    `- "relationship": what the text shows of what ${p.name} and the owner are to each other at these dates.`,
    `{"phrases": ["…"], "voice": ["…"], "facts": [{"date": "YYYY-MM-DD", "fact": "…"}], "relationship": ["…"]}`,
  ].join("\n\n");
}

/** The model's notes on a batch, checked: phrases found word for word in it, facts dated by one of its parts. */
export function parseExtract(text: string, batch: Unit[]): Extract {
  const out: Extract = { facts: [], phrases: [], voice: [], relationship: [] };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    return out;
  }
  const source = clean(batch.map((u) => u.text).join("\n"));
  const dates = new Set(batch.map((u) => u.date).filter(Boolean));
  const undated = batch.some((u) => !u.date);
  // A fact's date is one of the parts' own, or one written in them (a timeline), or "undated" from an undated note.
  const dated = (d: string) => dates.has(d) || (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(d) && source.includes(d)) || (d === "undated" && undated);
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  for (const ph of list(raw.phrases)) {
    if (typeof ph !== "string") continue;
    const p = clean(ph).replace(/^["“]|["”]$/g, "");
    // Their voice in their own words: a phrase not in what was read is not theirs.
    if (p.length >= 3 && p.length <= 200 && source.includes(p)) out.phrases.push(p);
  }
  for (const f of list(raw.facts)) {
    const r = (f ?? {}) as Record<string, unknown>;
    const date = typeof r.date === "string" ? r.date.trim().slice(0, 10).toLowerCase() : "";
    const fact = typeof r.fact === "string" ? clean(r.fact).slice(0, 300) : "";
    // A fact is kept only with the date of a part it could have come from.
    if (fact && dated(date)) out.facts.push({ date, fact });
  }
  for (const v of list(raw.voice)) if (typeof v === "string" && clean(v)) out.voice.push(clean(v).slice(0, 300));
  for (const v of list(raw.relationship)) if (typeof v === "string" && clean(v)) out.relationship.push(clean(v).slice(0, 300));
  return out;
}

export const REDUCE_SYSTEM =
  "You write a short, faithful profile of a person from notes already taken from their correspondence. You use only those notes; you never add facts. Reply with a single JSON object and nothing else.";

export function reducePrompt(p: Pick<Person, "name">, notes: Extract, era?: Era, personNote?: string): string {
  return [
    `Notes taken from the correspondence between the owner of a notes vault and ${p.name}${era ? `, ${era.from} to ${era.to} (${era.label})` : ""}.`,
    personNote ? `The owner's own note about ${p.name}:\n${personNote.slice(0, 4000)}` : "",
    `How ${p.name} writes:\n${notes.voice.slice(0, 80).map((v) => `- ${v}`).join("\n")}`,
    `What they are to each other:\n${notes.relationship.slice(0, 60).map((v) => `- ${v}`).join("\n")}`,
    `Facts, dated:\n${notes.facts.slice(0, 200).map((f) => `- ${f.date}: ${f.fact}`).join("\n")}`,
    `${p.name}'s own words, as written:\n${notes.phrases.slice(0, 60).map((v) => `- ${v}`).join("\n")}`,
    `Write, as JSON:`,
    `- "summary": who ${p.name} is and what they are to the owner${era ? " in this period" : ""}, in 4 to 8 sentences. Only what the notes above say.`,
    `- "voice": how to write exactly like ${p.name}, in 5 to 10 sentences: message length, punctuation and capitals, emoji, greetings and sign-offs, what they call the owner, humour, tone, language, habits. Concrete, from the notes above.`,
    `{"summary": "…", "voice": "…"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseReduce(text: string): { summary: string; voice: string } | undefined {
  try {
    const raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Record<string, unknown>;
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
    const voice = typeof raw.voice === "string" ? raw.voice.trim() : "";
    return summary && voice ? { summary, voice } : undefined;
  } catch {
    return undefined;
  }
}

/** Notes from many batches as one: repeats dropped, facts in date order. */
export function mergeExtracts(all: Extract[]): Extract {
  const uniq = (xs: string[]) => {
    const seen = new Set<string>();
    return xs.filter((x) => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const facts = new Map<string, { date: string; fact: string }>();
  for (const e of all) for (const f of e.facts) facts.set(`${f.date}|${f.fact.toLowerCase()}`, f);
  return {
    phrases: uniq(all.flatMap((e) => e.phrases)),
    voice: uniq(all.flatMap((e) => e.voice)),
    relationship: uniq(all.flatMap((e) => e.relationship)),
    // In date order; the undated ones last.
    facts: [...facts.values()].sort((a, b) => {
      const x = a.date === "undated" ? "9999" : a.date;
      const y = b.date === "undated" ? "9999" : b.date;
      return x < y ? -1 : x > y ? 1 : 0;
    }),
  };
}

/** Short conversations, word for word, spread across the time: how a whole exchange with them reads. */
export function pickExamples(units: Unit[], room = 8000, max = 4): Array<{ head: string; text: string }> {
  const convs = units.filter((u) => u.kind === "conversation" && u.text.length >= 40 && u.text.length <= 2500);
  const out: Array<{ head: string; text: string; i: number }> = [];
  let used = 0;
  for (let k = 0; k < max && convs.length; k++) {
    const i = Math.floor(((k + 0.5) * convs.length) / Math.min(max, convs.length));
    const u = convs[Math.min(i, convs.length - 1)]!;
    if (out.some((o) => o.head === u.head) || used + u.text.length > room) continue;
    out.push({ head: u.head, text: u.text, i });
    used += u.text.length;
  }
  return out.sort((a, b) => a.i - b.i).map(({ head, text }) => ({ head, text }));
}

/** Phrases spread across the time they were written, at most `max`. */
export function pickPhrases(phrases: string[], max = 40): string[] {
  return spreadBatches(phrases, max);
}

/** The persona note's path for a person, and for a period of their life with the owner. */
export function profilePath(p: Pick<Person, "name">, era?: Era): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();
  const period = era ? ` (${safe(era.label.replace(/ · /, ", "))})` : "";
  return `${PERSONA_FOLDER}/${safe(p.name)}${period}.md`;
}

export interface ProfileMeta {
  person: Person;
  era?: Era;
  model: string;
  built: string;
  /** The conversations it was made from, and how many there are in all. */
  read: number;
  of: number;
  last: string;
}

const yamlStr = (s: string) => JSON.stringify(s);

/** The persona note: marked as agent-made and local-only, then the profile, its words and its facts. */
export function profileMarkdown(meta: ProfileMeta, profile: Profile): string {
  const p = meta.person;
  const front = [
    "---",
    "type: persona",
    "authorship: ai-generated",
    `model: ${yamlStr(meta.model)}`,
    // Made of private correspondence: kept from cloud models like the notes it is made of.
    "agent-access: local",
    "publish: false",
    `person: ${yamlStr(p.note ? `[[${p.note.split("/").pop()!.replace(/\.md$/, "")}]]` : p.name)}`,
    ...(meta.era ? [`period: ${yamlStr(meta.era.label)}`, `period_from: ${meta.era.from}`, `period_to: ${meta.era.to}`] : []),
    `built: ${meta.built}`,
    `conversations_read: ${meta.read}`,
    `conversations: ${meta.of}`,
    `last_conversation: ${meta.last || '""'}`,
    `persona_version: ${PROFILE_VERSION}`,
    "---",
  ];
  const body = [
    `# ${p.name}${meta.era ? ` — ${meta.era.label}` : ""}`,
    `> [!note] Made by ${meta.model} for persona chat, from ${meta.read === meta.of ? `all ${meta.of}` : `${meta.read} of ${meta.of}`} conversations and your notes about ${p.name}, on ${meta.built}. Their words below are copied exactly; every fact is dated by the note it came from.`,
    `## Who they are to me\n\n${profile.summary}`,
    `## How they write\n\n${profile.voice}`,
    `## In their own words\n\n${profile.phrases.map((x) => `- "${x.replace(/"/g, '\\"')}"`).join("\n")}`,
    `## What happened, by date\n\n${profile.facts.map((f) => `- ${f.date}: ${f.fact}`).join("\n")}`,
    profile.examples.length ? `## Whole exchanges\n\n${profile.examples.map((e) => `### ${e.head}\n\n${e.text}`).join("\n\n")}` : "",
  ].filter(Boolean);
  return `${front.join("\n")}\n\n${body.join("\n\n")}\n`;
}

/** Is a persona note still good for these conversations? Not when it is of an older format, or more have come since. */
export function isCurrent(frontmatter: Record<string, unknown> | undefined, convs: number, last: string): boolean {
  if (!frontmatter || frontmatter.type !== "persona") return false;
  if (Number(frontmatter.persona_version) !== PROFILE_VERSION) return false;
  if (Number(frontmatter.conversations) !== convs) return false;
  return String(frontmatter.last_conversation ?? "") === last;
}

/** The persona note's text, for the model: its body, without its properties. */
export const profileBody = (text: string): string => bodyOf(text).trim();
