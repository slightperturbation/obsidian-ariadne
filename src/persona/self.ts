/**
 * The owner as their own writing shows them: their side of every conversation
 * in their correspondence (the parts under "ME:"), their journal, and their
 * personal notes — read and compressed, like a persona, into a profile note
 * (Personas/Me.md) that the personas made for the owner talk from. A profile
 * of one period of their life (Personas/Me (2005–2008).md) is made from that
 * period's writing alone, so that their younger self knows nothing later.
 */
import { bodyOf } from "../chat/frontmatter";
import type { NotePrompts } from "./build";
import type { Candidate } from "./context";
import type { Era } from "./eras";
import type { Moment } from "./people";
import { PERSONA_FOLDER, type Extract, type Profile, type Unit } from "./profile";

/** The note format: a profile made by an older format is made again. */
export const SELF_VERSION = 1;

const safe = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();

/** The owner's profile: of all of it, or of one period. */
export function selfPath(era?: Era): string {
  return `${PERSONA_FOLDER}/Me${era ? ` (${safe(era.label)})` : ""}.md`;
}

/** "**[2005-03-04] ME:** text" or "**ME:** text": a speaker's label at the start of a line. */
const LABEL = /^\s*(?:[-*>]\s*)?\*\*([^*]{1,60})\*\*:?\s*/;
const isMe = (label: string) => /(^|\]\s*)ME:?$/.test(label.trim());

/** The owner's side of a conversation: what is under their "ME:" labels, the labels taken off. */
export function ownWords(body: string): string {
  const out: string[] = [];
  let mine = false;
  for (const line of body.split("\n")) {
    const m = LABEL.exec(line);
    if (m) mine = isMe(m[1]!);
    else if (/^(#|---)/.test(line)) mine = false;
    if (!mine) continue;
    const text = (m ? line.slice(m[0].length) : line).trimEnd();
    if (text.trim()) out.push(text);
  }
  return out.join("\n").trim();
}

export interface SelfMoment extends Moment {
  /** Who it was with. */
  person: string;
}

export interface SelfInput {
  /** Every conversation in the correspondence, with who it was with. */
  moments: SelfMoment[];
  /** The owner's journal entries (dated). */
  journal: Candidate[];
  /** The owner's other personal notes: read for the whole profile, not a period's — they are not dated. */
  notes: string[];
  era?: Era;
  read: (path: string) => Promise<string | undefined>;
  allowed: (path: string) => boolean;
}

const MAX_UNIT = 8000;
const cut = (t: string) => (t.length > MAX_UNIT ? `${t.slice(0, MAX_UNIT)}\n[…the rest is left out]` : t);
const within = (date: string | undefined, era?: Era) => !era || (!!date && date >= era.from && date <= era.to);

/** Everything the owner wrote, in the period: their messages, their journal, their notes. A note that may not go to a model is counted, not read. */
export async function gatherSelf(s: SelfInput): Promise<{ units: Unit[]; withheld: number }> {
  const units: Unit[] = [];
  let withheld = 0;
  if (!s.era) {
    for (const path of s.notes) {
      if (!s.allowed(path)) {
        withheld++;
        continue;
      }
      const t = bodyOf((await s.read(path)) ?? "").trim();
      if (t.length >= 80) units.push({ head: `My note: ${path.split("/").pop()!.replace(/\.md$/, "")}`, text: cut(t), kind: "note" });
    }
  }
  const dated: Unit[] = [];
  for (const j of s.journal) {
    if (!j.date || !within(j.date, s.era)) continue;
    if (!s.allowed(j.path)) {
      withheld++;
      continue;
    }
    const t = bodyOf((await s.read(j.path)) ?? "").trim();
    if (t.length >= 40) dated.push({ head: `My journal, ${j.date}`, date: j.date, text: cut(t), kind: "journal" });
  }
  for (const m of s.moments) {
    if (!within(m.date, s.era)) continue;
    if (!s.allowed(m.path)) {
      withheld++;
      continue;
    }
    const mine = ownWords(bodyOf((await s.read(m.path)) ?? ""));
    if (mine.length < 40) continue;
    const subject = m.title.replace(/^\d{4}-\d{2}-\d{2}\s*/, "").replace(new RegExp(`^${m.person.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*-\\s*`), "");
    dated.push({ head: `${m.date} — what I wrote to ${m.person}${subject ? `: ${subject}` : ""}`, date: m.date, text: cut(mine), kind: "conversation" });
  }
  dated.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
  return { units: [...units, ...dated], withheld };
}

/** A period of the owner's life is offered only with this much of their own writing. */
export const SELF_ENOUGH = { chars: 30_000, units: 8 };

/**
 * The periods of the owner's life their writing can speak for: consecutive
 * years joined until each holds about a sixth of everything (and at least
 * enough to make a profile of), the last few folded into the one before.
 * Fewer than two, and there is nothing to choose.
 */
export function selfEras(units: Unit[]): Era[] {
  const years = new Map<string, { chars: number; units: number }>();
  for (const u of units) {
    if (!u.date) continue;
    const y = u.date.slice(0, 4);
    const v = years.get(y) ?? { chars: 0, units: 0 };
    v.chars += u.text.length;
    v.units++;
    years.set(y, v);
  }
  const ys = [...years.keys()].sort();
  const total = [...years.values()].reduce((a, v) => a + v.chars, 0);
  const target = Math.max(SELF_ENOUGH.chars * 1.5, total / 6);
  const groups: Array<{ from: string; to: string; chars: number; units: number }> = [];
  let cur: (typeof groups)[number] | undefined;
  for (const y of ys) {
    const v = years.get(y)!;
    if (!cur) cur = { from: y, to: y, chars: 0, units: 0 };
    cur.to = y;
    cur.chars += v.chars;
    cur.units += v.units;
    if (cur.chars >= target) {
      groups.push(cur);
      cur = undefined;
    }
  }
  if (cur) {
    const last = groups[groups.length - 1];
    if (cur.chars >= SELF_ENOUGH.chars && cur.units >= SELF_ENOUGH.units) groups.push(cur);
    else if (last) {
      last.to = cur.to;
      last.chars += cur.chars;
      last.units += cur.units;
    } else groups.push(cur);
  }
  const ok = groups.filter((g) => g.chars >= SELF_ENOUGH.chars && g.units >= SELF_ENOUGH.units);
  return ok.length >= 2 ? ok.map(toEra) : [];
}

const toEra = (g: { from: string; to: string }): Era => ({ from: `${g.from}-01-01`, to: `${g.to}-12-31`, label: g.from === g.to ? g.from : `${g.from}–${g.to}` });

export const SELF_EXTRACT_SYSTEM =
  "You read someone's own writing — their messages, journal and notes — and write down only what the text itself says. You never guess, infer or add. Reply with a single JSON object and nothing else.";

export function selfExtractPrompt(owner: string, batch: Unit[]): string {
  return [
    `Below is writing by ${owner}, the owner of a notes vault, in their own words: messages they sent to people they corresponded with (each headed with its date and who it was to), their journal, and their notes. Each part starts with "###".`,
    batch.map((u) => `### ${u.head}\n${u.text}`).join("\n\n"),
    `Write down, as JSON:`,
    `- "phrases": 5 to 15 things ${owner} wrote that are most like them — greetings, sign-offs, jokes, turns of phrase, typical sentences. Copy each EXACTLY as written, character for character, including spelling, punctuation and emoji. Each under 200 characters.`,
    `- "voice": short observations of HOW ${owner} writes: length, punctuation, capital letters, emoji, tone, humour, how they address people.`,
    `- "facts": facts about ${owner}'s life that the text states — events, places, work, projects, the people in their life and what they are to them, plans. Each with a date: the date of the part it is in, or a date the text itself gives ("YYYY", "YYYY-MM" or "YYYY-MM-DD"), or "undated" for an undated note. Only what is stated. No guesses.`,
    `- "relationship": what ${owner} cares about, worries about, hopes for, and how they see themself — only as the text shows it.`,
    `{"phrases": ["…"], "voice": ["…"], "facts": [{"date": "YYYY-MM-DD", "fact": "…"}], "relationship": ["…"]}`,
  ].join("\n\n");
}

export const SELF_REDUCE_SYSTEM =
  "You write a short, faithful profile of a person from notes already taken from their own writing. You use only those notes; you never add facts. Reply with a single JSON object and nothing else.";

export function selfReducePrompt(owner: string, notes: Extract, era?: Era): string {
  return [
    `Notes taken from ${owner}'s own writing${era ? `, ${era.from} to ${era.to}` : ""}.`,
    `How ${owner} writes:\n${notes.voice.slice(0, 80).map((v) => `- ${v}`).join("\n")}`,
    `What ${owner} cares about, and how they see themself:\n${notes.relationship.slice(0, 60).map((v) => `- ${v}`).join("\n")}`,
    `Facts, dated:\n${notes.facts.slice(0, 220).map((f) => `- ${f.date}: ${f.fact}`).join("\n")}`,
    `${owner}'s own words, as written:\n${notes.phrases.slice(0, 60).map((v) => `- ${v}`).join("\n")}`,
    `Write, as JSON:`,
    `- "summary": who ${owner} is${era ? " in this period" : ""} — their life, work, the people who matter to them, what they care about and are working through — in 6 to 12 sentences. Only what the notes above say.`,
    `- "voice": how to write exactly like ${owner}, in 5 to 10 sentences: length, punctuation and capitals, emoji, greetings and sign-offs, humour, tone, habits. Concrete, from the notes above.`,
    `{"summary": "…", "voice": "…"}`,
  ].join("\n\n");
}

const yamlStr = (s: string) => JSON.stringify(s);

/** The profile note: marked as agent-made and local-only, like a persona. */
export function selfMarkdown(owner: string, era: Era | undefined, meta: { model: string; built: string; read: number; of: number; last: string; sources: number }, profile: Profile): string {
  const front = [
    "---",
    "type: persona",
    "subject: self",
    "authorship: ai-generated",
    `model: ${yamlStr(meta.model)}`,
    "agent-access: local",
    "publish: false",
    `person: ${yamlStr(owner)}`,
    ...(era ? [`period: ${yamlStr(era.label)}`, `period_from: ${era.from}`, `period_to: ${era.to}`] : []),
    `built: ${meta.built}`,
    `sources: ${meta.sources}`,
    `conversations_read: ${meta.read}`,
    `conversations: ${meta.of}`,
    `last_source: ${meta.last || '""'}`,
    `persona_version: ${SELF_VERSION}`,
    "---",
  ];
  const body = [
    `# ${owner}${era ? ` — ${era.label}` : ""}`,
    `> [!note] Made by ${meta.model} for persona chat, from your own writing${era ? ` of ${era.label}` : ""} — ${meta.read === meta.of ? `all ${meta.of}` : `${meta.read} of ${meta.of}`} conversations, and your journal${era ? "" : " and notes"} — on ${meta.built}. The personas made for you talk from it. Your words below are copied exactly; every fact is dated by the note it came from.`,
    `## Who I am\n\n${profile.summary}`,
    `## How I write\n\n${profile.voice}`,
    `## In my own words\n\n${profile.phrases.map((x) => `- "${x.replace(/"/g, '\\"')}"`).join("\n")}`,
    `## What happened, by date\n\n${profile.facts.map((f) => `- ${f.date}: ${f.fact}`).join("\n")}`,
    profile.examples.length ? `## Whole messages\n\n${profile.examples.map((e) => `### ${e.head}\n\n${e.text}`).join("\n\n")}` : "",
  ].filter(Boolean);
  return `${front.join("\n")}\n\n${body.join("\n\n")}\n`;
}

/** The questions about the owner, and how their profile is written. */
export function selfPrompts(owner: string, era: Era | undefined, sources: number): NotePrompts {
  return {
    name: owner,
    extract: (batch) => ({ system: SELF_EXTRACT_SYSTEM, prompt: selfExtractPrompt(owner, batch) }),
    reduce: (notes) => ({ system: SELF_REDUCE_SYSTEM, prompt: selfReducePrompt(owner, notes, era) }),
    markdown: (meta, profile) => selfMarkdown(owner, era, { ...meta, sources }, profile),
  };
}

/** Is a profile still good? Not of an older format, and not when there is a tenth more to read than it was made from. */
export function selfCurrent(frontmatter: Record<string, unknown> | undefined, sources: number): boolean {
  if (!frontmatter || frontmatter.type !== "persona" || frontmatter.subject !== "self") return false;
  if (Number(frontmatter.persona_version) !== SELF_VERSION) return false;
  return sources <= Number(frontmatter.sources ?? 0) * 1.1;
}
