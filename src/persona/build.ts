/**
 * Building a persona note: everything gathered is read in batches by the
 * chosen model, each batch's notes checked (their own words found word for
 * word, facts dated by a source), then summed up into who they are and how
 * they write. A note about someone the owner wrote with, or about the owner
 * themself (see self.ts), differ only in what the model is asked.
 */
import type { Era } from "./eras";
import type { Person } from "./people";
import {
  EXTRACT_SYSTEM,
  REDUCE_SYSTEM,
  batches,
  extractPrompt,
  mergeExtracts,
  parseExtract,
  parseReduce,
  pickExamples,
  pickPhrases,
  profileMarkdown,
  reducePrompt,
  spreadBatches,
  type Extract,
  type Profile,
  type Unit,
} from "./profile";

export type Ask = (system: string, prompt: string) => Promise<string>;

/** What the model is asked, and how the note is written: for a person, or for the owner. */
export interface NotePrompts {
  /** Their name, for messages. */
  name: string;
  extract(batch: Unit[]): { system: string; prompt: string };
  reduce(notes: Extract, units: Unit[]): { system: string; prompt: string };
  markdown(meta: { model: string; built: string; read: number; of: number; last: string }, profile: Profile): string;
}

export interface BuildInput {
  /** Whom the note is of — not needed when `prompts` are given. */
  person?: Person;
  era?: Era;
  units: Unit[];
  ask: Ask;
  model: string;
  today: string;
  /** Characters of source per batch, and at most this many batches. */
  batchChars: number;
  maxBatches: number;
  onProgress?: (done: number, of: number) => void;
  /** Asked between batches: true stops the build. */
  cancelled?: () => boolean;
  /** Instead of the questions about a person: the owner's own (self.ts). */
  prompts?: NotePrompts;
}

/** How many batches a build would read, and how many conversations they hold. */
export function plan(units: Unit[], batchChars: number, maxBatches: number): { batches: number; read: number; of: number } {
  const all = batches(units, batchChars);
  const chosen = spreadBatches(all, maxBatches);
  const count = (bs: Unit[][]) => bs.reduce((a, b) => a + b.filter((u) => u.kind === "conversation").length, 0);
  return { batches: chosen.length, read: count(chosen), of: count(all) };
}

/** The questions about someone the owner wrote with. */
export function personPrompts(p: Person, era?: Era): NotePrompts {
  return {
    name: p.name,
    extract: (batch) => ({ system: EXTRACT_SYSTEM, prompt: extractPrompt(p, batch) }),
    reduce: (notes, units) => ({ system: REDUCE_SYSTEM, prompt: reducePrompt(p, notes, era, units.find((u) => u.kind === "person note")?.text) }),
    markdown: (meta, profile) => profileMarkdown({ person: p, era, ...meta }, profile),
  };
}

export async function buildProfile(input: BuildInput): Promise<string> {
  const prompts = input.prompts ?? personPrompts(input.person!, input.era);
  const name = prompts.name;
  const all = batches(input.units, input.batchChars);
  const chosen = spreadBatches(all, input.maxBatches);
  if (chosen.length === 0) throw new Error(`there is nothing in your notes to make ${name} from`);
  const notes: Extract[] = [];
  let failed = 0;
  let firstError = "";
  for (let i = 0; i < chosen.length; i++) {
    if (input.cancelled?.()) throw new Error("stopped");
    input.onProgress?.(i, chosen.length + 1);
    try {
      const q = prompts.extract(chosen[i]!);
      notes.push(parseExtract(await input.ask(q.system, q.prompt), chosen[i]!));
    } catch (err) {
      failed++;
      firstError ||= err instanceof Error ? err.message : String(err);
    }
  }
  // Too much unread is not a persona: better to say so than to make one up from a little.
  if (failed > chosen.length / 3) throw new Error(`the model could not read ${failed} of ${chosen.length} parts of the notes${firstError ? ` (${firstError})` : ""}`);
  const merged = mergeExtracts(notes);
  if (merged.phrases.length === 0) throw new Error(`no words of ${name}'s own could be found — the persona would not sound like them`);
  input.onProgress?.(chosen.length, chosen.length + 1);
  const r = prompts.reduce(merged, input.units);
  const summed = parseReduce(await input.ask(r.system, r.prompt));
  if (!summed) throw new Error("the model's summary could not be read");
  const conversations = (bs: Unit[][]) => bs.flat().filter((u) => u.kind === "conversation");
  const last = [...all.flat()].map((u) => u.date ?? "").sort().pop() ?? "";
  const lastConv = conversations(all).map((u) => u.date ?? "").sort().pop() ?? "";
  return prompts.markdown(
    { model: input.model, built: input.today, read: conversations(chosen).length, of: conversations(all).length, last: input.prompts ? last : lastConv },
    { summary: summed.summary, voice: summed.voice, phrases: pickPhrases(merged.phrases), facts: merged.facts.slice(0, input.prompts ? 220 : 150), examples: pickExamples(input.units) },
  );
}
