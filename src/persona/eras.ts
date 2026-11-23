/**
 * The periods of the owner's life with someone: a friend at school, then out
 * of touch, then back; or dating, then married. Found by a local model from
 * the conversations' dates and titles when it can, and from the gaps between
 * conversations when it cannot.
 */
import type { Moment, Person } from "./people";

export interface Era {
  /** YYYY-MM-DD, inclusive. */
  from: string;
  to: string;
  label: string;
}

const DAY = 86_400_000;
const t = (d: string) => Date.parse(`${d}T00:00:00Z`);
const year = (d: string) => d.slice(0, 4);
const span = (from: string, to: string) => (year(from) === year(to) ? year(from) : `${year(from)}–${year(to)}`);

/** A long silence splits the conversations into periods; a period of one or two is folded into its neighbour. */
export function gapEras(moments: Moment[], gapDays = 540): Era[] {
  const dated = [...moments].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (dated.length === 0) return [];
  const groups: Moment[][] = [[dated[0]!]];
  for (const m of dated.slice(1)) {
    const last = groups[groups.length - 1]!;
    if (t(m.date) - t(last[last.length - 1]!.date) > gapDays * DAY) groups.push([m]);
    else last.push(m);
  }
  // Fold small groups into the nearer neighbour, so each period is worth choosing.
  for (let i = 0; i < groups.length && groups.length > 1; ) {
    if (groups[i]!.length >= 3) {
      i++;
      continue;
    }
    const prev = groups[i - 1];
    const next = groups[i + 1];
    const gPrev = prev ? t(groups[i]![0]!.date) - t(prev[prev.length - 1]!.date) : Infinity;
    const gNext = next ? t(next[0]!.date) - t(groups[i]![groups[i]!.length - 1]!.date) : Infinity;
    if (gPrev <= gNext && prev) prev.push(...groups[i]!);
    else next!.unshift(...groups[i]!);
    groups.splice(i, 1);
    i = 0;
  }
  return groups.map((g) => ({ from: g[0]!.date, to: g[g.length - 1]!.date, label: `${span(g[0]!.date, g[g.length - 1]!.date)} · ${g.length} conversation${g.length === 1 ? "" : "s"}` }));
}

/** What a local model is shown to find the periods: one line per conversation, and the person note's opening. */
export function erasPrompt(p: Person, summary: string): string {
  const lines = p.moments.map((m) => `${m.date} ${m.title.slice(0, 80)}`);
  // At most about 600 lines: an even spread across the years when there are more.
  const step = Math.max(1, Math.ceil(lines.length / 600));
  const shown = lines.filter((_, i) => i % step === 0);
  return [
    `These are the conversations between the owner of a notes vault and ${p.name}, one per line (date, then title).`,
    summary ? `From the owner's note about ${p.name}:\n${summary.slice(0, 2500)}` : "",
    `Conversations:\n${shown.join("\n")}`,
    `Split the time the owner has known ${p.name} into the periods in which their relationship was different — for example "school friends", "dating", "married", "after the divorce", "colleagues at X", "back in touch". Use only what these lines and the note show. If it did not really change, give one period.`,
    'Reply as {"eras": [{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "label": "2 to 6 words"}]}, oldest first, at most 6.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const ERAS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    eras: {
      type: "array",
      items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, label: { type: "string" } }, required: ["from", "to", "label"] },
    },
  },
  required: ["eras"],
};

/** A model's periods, checked: dated, in order, within the time they knew each other, labelled. Undefined when unusable. */
export function parseEras(text: string, p: Pick<Person, "first" | "last">): Era[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return undefined;
  }
  const list = (raw as { eras?: unknown })?.eras;
  if (!Array.isArray(list)) return undefined;
  const day = (v: unknown, end: boolean): string | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(t(s))) return s;
    if (/^\d{4}-\d{2}$/.test(s)) return end ? new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)), 0)).toISOString().slice(0, 10) : `${s}-01`;
    if (/^\d{4}$/.test(s)) return end ? `${s}-12-31` : `${s}-01-01`;
    return undefined;
  };
  const out: Era[] = [];
  for (const e of list.slice(0, 6)) {
    const r = (e ?? {}) as Record<string, unknown>;
    let from = day(r.from, false);
    let to = day(r.to, true);
    const label = typeof r.label === "string" ? r.label.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (!from || !to || !label) return undefined;
    if (p.first && from < p.first) from = p.first;
    if (p.last && to > p.last) to = p.last;
    if (from > to) return undefined;
    if (out.length && from < out[out.length - 1]!.from) return undefined;
    out.push({ from, to, label: `${label} · ${span(from, to)}` });
  }
  return out.length ? out : undefined;
}

/** What a period needs to be offered on its own: enough conversations, and enough of what was written in them. */
export const ENOUGH = { conversations: 8, chars: 12_000 };

/**
 * Periods that each have enough to be a persona of their own. A period with
 * too little is joined to the neighbour with less, until every period has
 * enough — and when fewer than two are left, none is offered: a known change
 * in their life together is not a choice without enough to show it.
 */
export function enoughEras(eras: Era[], moments: Moment[], enough = ENOUGH): Era[] {
  const measure = (e: Era) => {
    const ms = inEra(moments, e);
    return { n: ms.length, chars: ms.reduce((a, m) => a + m.size, 0) };
  };
  const base = (label: string) => label.replace(/ · .*$/, "");
  let list = eras.map((e) => ({ ...e }));
  for (;;) {
    if (list.length < 2) return [];
    const weak = list.findIndex((e) => {
      const m = measure(e);
      return m.n < enough.conversations || m.chars < enough.chars;
    });
    if (weak < 0) return list;
    const prev = list[weak - 1];
    const next = list[weak + 1];
    const into = !prev ? weak + 1 : !next ? weak - 1 : measure(prev).n <= measure(next).n ? weak - 1 : weak + 1;
    const [a, b] = into < weak ? [list[into]!, list[weak]!] : [list[weak]!, list[into]!];
    const labels = [...new Set([base(a.label), base(b.label)])].filter((l) => !/^\d{4}(–\d{4})?$/.test(l));
    const joined: Era = { from: a.from, to: b.to, label: `${labels.join(", then ") || "together"} · ${span(a.from, b.to)}` };
    list = [...list.slice(0, Math.min(into, weak)), joined, ...list.slice(Math.max(into, weak) + 1)];
  }
}

/** The conversations in a period (all of them when there is none). */
export function inEra<T extends { date: string }>(items: T[], era?: Pick<Era, "from" | "to">): T[] {
  return era ? items.filter((m) => m.date >= era.from && m.date <= era.to) : items;
}
