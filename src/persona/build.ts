/**
 * Building a persona note: everything gathered about someone is read in
 * batches by the chosen model, each batch's notes checked (their own words
 * found word for word, facts dated by a source), then summed up into who they
 * are and how they write.
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
  type Unit,
} from "./profile";

export type Ask = (system: string, prompt: string) => Promise<string>;

export interface BuildInput {
  person: Person;
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
}

/** How many batches a build would read, and how many conversations they hold. */
export function plan(units: Unit[], batchChars: number, maxBatches: number): { batches: number; read: number; of: number } {
  const all = batches(units, batchChars);
  const chosen = spreadBatches(all, maxBatches);
  const count = (bs: Unit[][]) => bs.reduce((a, b) => a + b.filter((u) => u.kind === "conversation").length, 0);
  return { batches: chosen.length, read: count(chosen), of: count(all) };
}

export async function buildProfile(input: BuildInput): Promise<string> {
  const { person: p, era } = input;
  const all = batches(input.units, input.batchChars);
  const chosen = spreadBatches(all, input.maxBatches);
  if (chosen.length === 0) throw new Error(`there is nothing in your notes to make ${p.name} from`);
  const notes: Extract[] = [];
  let failed = 0;
  for (let i = 0; i < chosen.length; i++) {
    if (input.cancelled?.()) throw new Error("stopped");
    input.onProgress?.(i, chosen.length + 1);
    try {
      notes.push(parseExtract(await input.ask(EXTRACT_SYSTEM, extractPrompt(p, chosen[i]!)), chosen[i]!));
    } catch {
      failed++;
    }
  }
  // Too much unread is not a persona: better to say so than to make one up from a little.
  if (failed > chosen.length / 3) throw new Error(`the model could not read ${failed} of ${chosen.length} parts of the notes`);
  const merged = mergeExtracts(notes);
  if (merged.phrases.length === 0) throw new Error(`no words of ${p.name}'s own could be found — the persona would not sound like them`);
  input.onProgress?.(chosen.length, chosen.length + 1);
  const personNote = input.units.find((u) => u.kind === "person note")?.text;
  const summed = parseReduce(await input.ask(REDUCE_SYSTEM, reducePrompt(p, merged, era, personNote)));
  if (!summed) throw new Error("the model's summary could not be read");
  const conversations = (bs: Unit[][]) => bs.flat().filter((u) => u.kind === "conversation");
  const last = conversations(all).map((u) => u.date ?? "").sort().pop() ?? "";
  return profileMarkdown(
    { person: p, era, model: input.model, built: input.today, read: conversations(chosen).length, of: conversations(all).length, last },
    { summary: summed.summary, voice: summed.voice, phrases: pickPhrases(merged.phrases), facts: merged.facts.slice(0, 150), examples: pickExamples(input.units) },
  );
}
