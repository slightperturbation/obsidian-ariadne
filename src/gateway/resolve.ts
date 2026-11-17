import {
  SPECS,
  cleanDate,
  cleanList,
  cleanString,
  dayOf,
  type AgentRecord,
  type RecordKind,
} from "./records";

/**
 * Which record is this about? The harness does not guess: the gateway
 * resolves in stages and stops at the first that is certain.
 *
 *   exact   — a hard key is equal (reference, or a thread already linked)
 *   unique  — the facts leave exactly one record, the rest excluded
 *   several — more than one fits; the answer names what distinguishes them
 *   none    — nothing plausible; a new record may be proposed
 */
export interface ResolveQuery {
  kind: RecordKind;
  refs?: string[];
  thread?: string;
  counterparts?: string[];
  /** A date (or the start of a range) the message is about. */
  date?: string;
  end?: string;
  place?: string;
  /** Bills: who is owed, and how much. */
  payee?: string;
  amount?: number;
  period?: string;
  /** Include records already in a terminal state (done, paid, cancelled…). */
  includeClosed?: boolean;
}

export interface Candidate {
  id: string;
  title: string;
  state: string;
  path: string;
  /** The properties on which the candidates differ. */
  distinguishing: Record<string, string>;
}

export interface ResolveResult {
  class: "exact" | "unique" | "several" | "none";
  id?: string;
  title?: string;
  path?: string;
  state?: string;
  /** For "several": the records that fit, and a ready question for a person. */
  candidates?: Candidate[];
  question?: string;
  /** Why this class — for the audit log and for reviews. */
  why: string;
}

export function normRef(ref: string): string {
  return ref.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function emailOf(s: string): string {
  const m = /<?([^\s<>@]+@[^\s<>@]+)>?/.exec(s.toLowerCase());
  return m ? m[1]! : s.toLowerCase().trim();
}

function domainOf(s: string): string {
  const e = emailOf(s);
  const at = e.lastIndexOf("@");
  const host = at >= 0 ? e.slice(at + 1) : e;
  // Registrable-ish: the last two labels are enough to tell organizations apart.
  return host.split(".").slice(-2).join(".");
}

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);

/** Same address, or same organization's domain (never a free-mail domain). */
export function counterpartsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (emailOf(x) === emailOf(y)) return true;
      const dx = domainOf(x);
      if (dx && dx === domainOf(y) && dx.includes(".") && !FREEMAIL.has(dx)) return true;
    }
  }
  return false;
}

const PLACE_STOP = new Set(["the", "and", "of", "at", "in", "st", "street", "city", "airport"]);

function placeTokens(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !PLACE_STOP.has(t)),
  );
}

export function placesOverlap(a: string, b: string): boolean {
  const ta = placeTokens(a);
  for (const t of placeTokens(b)) if (ta.has(t)) return true;
  return false;
}

/** Organization names: equal once punctuation is dropped, or one contains the other. */
export function namesMatch(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const y = b.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.includes(short);
}

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86_400_000);
}

/** Is a day inside the record's window, widened by the kind's tolerance? */
function dateFits(record: AgentRecord, date: string, end: string | undefined): boolean | undefined {
  const anchor =
    record.start ?? (typeof record.fields.due === "string" ? record.fields.due : undefined);
  if (!anchor) return undefined;
  const tol = SPECS[record.kind].windowDays;
  const lo = dayNumber(anchor) - tol;
  const hi = dayNumber(record.end ?? anchor) + tol;
  const qLo = dayNumber(date);
  const qHi = dayNumber(end ?? date);
  return qLo <= hi && qHi >= lo;
}

type Fit = boolean | undefined;

interface Scored {
  record: AgentRecord;
  positives: string[];
  excluded?: string;
}

function assess(record: AgentRecord, q: ResolveQuery): Scored {
  const positives: string[] = [];
  let excluded: string | undefined;
  const date = cleanDate(q.date);
  const end = cleanDate(q.end);

  if (date) {
    const fit: Fit = dateFits(record, date, end);
    if (fit === true) positives.push("date");
    else if (fit === false) excluded = "date outside the record's window";
  }
  const place = cleanString(q.place);
  const recordPlace = [record.place, record.fields.destination, record.fields.to]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  if (place && recordPlace) {
    if (placesOverlap(place, recordPlace)) positives.push("place");
    else if (record.kind === "trip" || record.kind === "itinerary-item") {
      excluded ??= "different place";
    }
  }
  const counterparts = cleanList(q.counterparts);
  if (counterparts.length > 0 && counterpartsOverlap(counterparts, record.counterparts)) {
    positives.push("counterpart");
  }
  if (record.kind === "bill") {
    const payee = cleanString(q.payee).toLowerCase();
    const recordPayee = typeof record.fields.payee === "string" ? record.fields.payee.toLowerCase() : "";
    if (payee && recordPayee) {
      if (namesMatch(payee, recordPayee)) positives.push("payee");
      else excluded ??= "different payee";
    }
    const period = cleanString(q.period).toLowerCase();
    const recordPeriod =
      typeof record.fields.period === "string" ? record.fields.period.toLowerCase() : "";
    if (period && recordPeriod) {
      if (period === recordPeriod) positives.push("period");
      else excluded ??= "different billing period";
    }
    if (typeof q.amount === "number" && typeof record.fields.amount === "number") {
      if (Math.abs(q.amount - record.fields.amount) < 0.005) positives.push("amount");
    }
  }
  // Where several a day are normal, the day alone identifies nothing.
  if (SPECS[record.kind].severalPerDay && positives.length === 1 && positives[0] === "date") {
    positives.length = 0;
  }
  return { record, positives, excluded };
}

function describe(r: AgentRecord): Record<string, string> {
  const out: Record<string, string> = { title: r.title };
  if (r.start) out.when = r.end && dayOf(r.end) !== dayOf(r.start) ? `${dayOf(r.start)} to ${dayOf(r.end)}` : r.start;
  const place = r.place ?? (typeof r.fields.destination === "string" ? r.fields.destination : "");
  if (place) out.place = place;
  for (const key of ["with", "payee", "period", "due", "amount"]) {
    const v = r.fields[key];
    if (v !== undefined && v !== null) out[key] = String(v);
  }
  out.state = r.state;
  return out;
}

/** Keep only the properties on which the candidates actually differ. */
function distinguishing(records: AgentRecord[]): Candidate[] {
  const all = records.map(describe);
  const keys = new Set(all.flatMap((d) => Object.keys(d)));
  const differing = [...keys].filter((k) => new Set(all.map((d) => d[k] ?? "")).size > 1);
  return records.map((r, i) => {
    const d: Record<string, string> = {};
    for (const k of differing) if (all[i]![k]) d[k] = all[i]![k]!;
    if (Object.keys(d).length === 0) d.title = r.title;
    return { id: r.id, title: r.title, state: r.state, path: r.path, distinguishing: d };
  });
}

function questionFor(kind: RecordKind, candidates: Candidate[]): string {
  const options = candidates
    .map((c, i) => `${i + 1}) ${Object.values(c.distinguishing).join(", ")}`)
    .join("  ");
  return `Which ${kind} is this about?  ${options}  0) none of these`;
}

export function resolveAgainst(records: readonly AgentRecord[], q: ResolveQuery): ResolveResult {
  const pool = records.filter((r) => r.kind === q.kind);
  const thread = cleanString(q.thread, 200);
  const refs = cleanList(q.refs).map(normRef).filter((r) => r.length >= 4);
  const notThis = (r: AgentRecord) => thread !== "" && r.notThreads.includes(thread);

  // Stage 1 — a hard key is equal.
  const exact = pool.filter(
    (r) =>
      !notThis(r) &&
      ((thread !== "" && r.threads.includes(thread)) ||
        (refs.length > 0 && r.refs.map(normRef).some((x) => refs.includes(x)))),
  );
  if (exact.length === 1) {
    const r = exact[0]!;
    return { class: "exact", id: r.id, title: r.title, path: r.path, state: r.state, why: "a reference or linked conversation matches" };
  }
  if (exact.length > 1) {
    const candidates = distinguishing(exact);
    return {
      class: "several",
      candidates,
      question: questionFor(q.kind, candidates),
      why: "the same reference or conversation is linked to more than one record",
    };
  }

  // Stage 2 — the facts leave exactly one record.
  const terminal = SPECS[q.kind].terminal;
  const scored = pool
    .filter((r) => !notThis(r) && (q.includeClosed || !terminal.includes(r.state)))
    .map((r) => assess(r, q));
  const fitting = scored.filter((s) => !s.excluded && s.positives.length > 0);
  // A counterpart alone is not enough: the same sender writes about many things.
  const strong = fitting.filter((s) => s.positives.some((p) => p !== "counterpart"));
  if (strong.length === 1) {
    const s = strong[0]!;
    const r = s.record;
    return {
      class: "unique",
      id: r.id,
      title: r.title,
      path: r.path,
      state: r.state,
      why: `only one open ${q.kind} fits (${s.positives.join(", ")})`,
    };
  }
  const several = strong.length > 1 ? strong : fitting;
  if (several.length > 0) {
    const candidates = distinguishing(several.map((s) => s.record).slice(0, 6));
    return {
      class: "several",
      candidates,
      question: questionFor(q.kind, candidates),
      why:
        strong.length > 1
          ? `${strong.length} open ${q.kind} records fit`
          : "only the sender matches, which is not enough to be sure",
    };
  }
  return { class: "none", why: `no open ${q.kind} fits` };
}
