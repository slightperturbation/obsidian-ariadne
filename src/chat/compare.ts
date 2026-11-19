import type { AgentRecord } from "../gateway/records";

/**
 * A record set beside the lines of the owner's note it was made from, field
 * by field, by plain rules — no model. The note is the owner's word; where
 * the record says something else, that is a place to look.
 *
 * A record made from a note carries the owner's own lines about it (its
 * `notes` field) and a link to the note (`hub`). Those lines are found again
 * in the note as it stands today, and the record's time, day, price and
 * standing are checked against them.
 */
export interface Finding {
  /** What was compared: "start time", "day", "price", "standing", "lines". */
  field: string;
  /** What the record says. */
  record: string;
  /** What the note's lines say. */
  note: string;
}

export interface Comparison {
  /** The owner's lines about this record, as they stand in the note today. */
  passage: string[];
  /** Lines the record was made from that are no longer in the note. */
  gone: string[];
  findings: Finding[];
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Every time of day a line states, as HH:MM: "13:29", "1.29pm", "6pm", "noon". */
export function timesIn(text: string): string[] {
  const out = new Set<string>();
  const put = (h: number, m: number, half?: string) => {
    let hour = h;
    const ap = half?.toLowerCase();
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && m >= 0 && m <= 59) out.add(`${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  };
  for (const m of text.matchAll(/\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/gi)) put(Number(m[1]), Number(m[2]), m[3]);
  for (const m of text.matchAll(/\b(\d{1,2})\s*(am|pm)\b/gi)) put(Number(m[1]), 0, m[2]);
  if (/\bnoon\b|\bmidday\b/i.test(text)) out.add("12:00");
  if (/\bmidnight\b/i.test(text)) out.add("00:00");
  return [...out].sort();
}

/** Sums of money a line states: "£65", "65 GBP", "$840", and "140 + 10" as 150 too. */
export function amountsIn(text: string): number[] {
  const out = new Set<number>();
  const num = (s: string) => Number(s.replace(/,/g, ""));
  for (const m of text.matchAll(/[£$€]\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) out.add(num(m[1]!));
  for (const m of text.matchAll(/\b(\d[\d,]*(?:\.\d{1,2})?)\s?(?:gbp|usd|eur|pounds?|dollars?|euros?)\b/gi)) out.add(num(m[1]!));
  for (const m of text.matchAll(/\b(\d{1,5}(?:\.\d{1,2})?)\s*\+\s*(\d{1,5}(?:\.\d{1,2})?)\b/g)) {
    out.add(num(m[1]!));
    out.add(num(m[2]!));
    out.add(Math.round((num(m[1]!) + num(m[2]!)) * 100) / 100);
  }
  return [...out].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

/** The day a heading or a line names: its day of the month, and the month when it says one. */
export function dayIn(line: string): { day: number; month?: number } | undefined {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(line);
  if (iso) return { day: Number(iso[3]), month: Number(iso[2]) };
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}[a-z]*\\b`, "i").test(line));
  const before = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(line);
  const after = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(line);
  const dayNum = before?.[1] ?? after?.[1];
  if (dayNum) return { day: Number(dayNum), month: month >= 0 ? month + 1 : undefined };
  // "Thu 19", "Thursday 19th": a weekday and a number.
  const weekday = /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*[:.]\d)/i.exec(line);
  return weekday ? { day: Number(weekday[1]) } : undefined;
}

const hhmm = (iso: string | undefined): string => (iso && iso.length > 10 ? iso.slice(11, 16) : "");

export function compareWithNote(record: AgentRecord, noteText: string): Comparison {
  const noteLines = noteText.split(/\r?\n/);
  const squashed = noteLines.map(squash);
  // The owner's lines the record was made from; a remark the agent added in brackets is not one of them.
  const own = String(record.fields.notes ?? "")
    .split(/\r?\n|\s*;\s*(?=\S)/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 3 && !/^\(.*\)$/.test(l));
  const passage: string[] = [];
  const gone: string[] = [];
  let firstAt = -1;
  for (const line of own) {
    const want = squash(line.replace(/^[-*•]\s*/, ""));
    const at = squashed.findIndex((l) => l.includes(want));
    if (at < 0) gone.push(line);
    else {
      passage.push(noteLines[at]!.trim());
      if (firstAt < 0 || at < firstAt) firstAt = at;
    }
  }
  const findings: Finding[] = [];
  if (gone.length > 0) {
    findings.push({ field: "lines", record: `made from ${own.length} of your lines`, note: `${gone.length} of them ${gone.length === 1 ? "is" : "are"} no longer in the note as written: ${gone.map((g) => `"${g.slice(0, 80)}"`).join("; ")}` });
  }
  if (passage.length === 0) return { passage, gone, findings };
  const text = passage.join("\n");

  // Times: what the record gives must be among the times its lines state.
  const stated = timesIn(text);
  const start = hhmm(record.start);
  const end = hhmm(record.end);
  if (stated.length > 0) {
    // A journey known only by its arrival carries that time as both.
    if (start && !stated.includes(start)) findings.push({ field: "start time", record: start, note: stated.join(", ") });
    if (end && end !== start && !stated.includes(end) && stated.length > 1) findings.push({ field: "end time", record: end, note: stated.join(", ") });
  }

  // The day: the nearest line above that names one (a day heading), or the lines themselves.
  let named = dayIn(text);
  for (let i = firstAt; !named && i >= 0 && i >= firstAt - 60; i--) named = dayIn(noteLines[i]!);
  if (named && record.start) {
    const recDay = Number(record.start.slice(8, 10));
    const recMonth = Number(record.start.slice(5, 7));
    if (named.day !== recDay || (named.month !== undefined && named.month !== recMonth)) {
      findings.push({ field: "day", record: record.start.slice(0, 10), note: `${named.day}${named.month ? ` ${MONTHS[named.month - 1]}` : ""}` });
    }
  }

  // Price.
  const price = typeof record.fields.price === "number" ? record.fields.price : typeof record.fields.amount === "number" ? record.fields.amount : undefined;
  const sums = amountsIn(text);
  if (price !== undefined && sums.length > 0 && !sums.includes(price)) findings.push({ field: "price", record: String(price), note: sums.join(", ") });

  // Standing: the note's own words for how settled it is, and for money.
  const soft = /\bsoft[- ]?book|\bto (?:be )?confirm|\btbc\b|\bnot (?:yet )?(?:booked|confirmed)|\bneeds? confirm|\btentative/i.test(text);
  const firm = !soft && /\b(?:booked|confirmed|reserved)\b/i.test(text);
  const agreed = ["confirmed", "booked", "registered", "changed", "rescheduled"].includes(record.state);
  if (soft && agreed) findings.push({ field: "standing", record: record.state, note: "your lines say it is not yet confirmed" });
  if (firm && ["offered", "planned", "to-confirm", "asked", "requested"].includes(record.state)) findings.push({ field: "standing", record: record.state, note: "your lines say it is booked or confirmed" });
  const paidSaid = /\bpaid\b/i.test(text) && !/\b(?:not|un)\s?paid\b|\bto pay\b|\bpay (?:on|at|in)\b/i.test(text);
  if (paidSaid && record.fields.paid === false) findings.push({ field: "paid", record: "not paid", note: "your lines say paid" });
  if (!paidSaid && record.fields.paid === true && /\bcash\b|\bto pay\b|\bnot paid\b|\bunpaid\b/i.test(text)) findings.push({ field: "paid", record: "paid", note: "your lines do not say it is paid" });

  return { passage, gone, findings };
}
