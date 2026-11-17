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
  /** What the thing is called: a lodging, an activity, a conference. */
  name?: string;
  /** Transport: the service number, and where the journey runs from and to. */
  number?: string;
  from?: string;
  to?: string;
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

/** Domains shared by unrelated people: a mail provider, or a messaging service's id space. */
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "yahoo.com",
  "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
  "whatsapp.net", "c.us", "g.us", "lid",
]);

/** The digits of a telephone number, however it is written; "" when it is not one. */
function phoneOf(s: string): string {
  const at = s.indexOf("@");
  const local = at >= 0 ? s.slice(0, at) : s;
  if (/[a-z]/i.test(local)) return "";
  const digits = local.replace(/\D/g, "");
  return digits.length >= 7 ? digits : "";
}

/** The same number, with or without its country code or leading zero. */
function samePhone(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 9 && b.length >= 9 && a.slice(-9) === b.slice(-9);
}

/** Same address or telephone number, or same organization's domain (never a shared one). */
export function counterpartsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (emailOf(x) === emailOf(y)) return true;
      if (samePhone(phoneOf(x), phoneOf(y))) return true;
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
  /** Not the same thing, but the two cannot both stand: the user should look. */
  conflict?: string;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** Words that say what sort of thing a title names, not which one. */
const TITLE_STOP = new Set([
  "the", "and", "with", "for", "from", "your", "our", "you", "reservation", "booking", "booked",
  "confirmation", "confirmed", "appointment", "ticket", "tickets", "visit", "hotel", "hostel", "inn",
  "airbnb", "apartment", "apartments", "guesthouse", "lodge", "suites", "room", "stay", "check",
]);

function titleTokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !TITLE_STOP.has(t)));
}

/**
 * Do two names mean the same thing? True when every telling word of the
 * shorter one is in the longer ("Megaro" and "The Megaro Hotel"); false when
 * they differ; undefined when either has no telling word to compare.
 */
export function titlesAgree(a: string, b: string): Fit {
  if (!a.trim() || !b.trim()) return undefined;
  if (namesMatch(a, b)) return true;
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return undefined;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

/** "UA 949", "UA949" and "949" are one service; "UA 949" and "BA 949" are not. */
export function sameService(a: string, b: string): Fit {
  const x = normRef(a);
  const y = normRef(b);
  if (!x || !y) return undefined;
  if (x === y) return true;
  const split = (s: string) => ({ letters: /^[A-Z]*/.exec(s)![0], digits: s.replace(/^[A-Z]*0*/, "") });
  const p = split(x);
  const r = split(y);
  if (!/^\d+$/.test(p.digits) || !/^\d+$/.test(r.digits)) return false;
  if (p.digits !== r.digits) return false;
  return !p.letters || !r.letters || p.letters === r.letters;
}

/** Same journey (true), plainly another leg such as the way back (false), or not told. */
function routeFit(q: ResolveQuery, record: AgentRecord): Fit {
  const from = cleanString(q.from);
  const to = cleanString(q.to);
  const rFrom = text(record.fields.from);
  const rTo = text(record.fields.to);
  if (!from || !to || !rFrom || !rTo) return undefined;
  if (placesOverlap(from, rFrom) && placesOverlap(to, rTo)) return true;
  if (placesOverlap(from, rTo) && placesOverlap(to, rFrom)) return false;
  return undefined;
}

/** Is this the same service on the same route — leaving aside which day? */
function legOf(record: AgentRecord, q: ResolveQuery): "same" | "other" | "unknown" {
  const service = sameService(cleanString(q.number), text(record.fields.number));
  const route = routeFit(q, record);
  if (service === false || route === false) return "other";
  return service || route ? "same" : "unknown";
}

function sameDay(record: AgentRecord, date: string | undefined): Fit {
  if (!date || !record.start) return undefined;
  return dayOf(date) === dayOf(record.start);
}

/**
 * Transport. A journey has no single place, and several a day are normal:
 * what identifies one is the day together with its service number or its
 * route. The day alone identifies nothing.
 */
function assessTransport(record: AgentRecord, q: ResolveQuery): Scored {
  const positives: string[] = [];
  const day = sameDay(record, cleanDate(q.date));
  const service = sameService(cleanString(q.number), text(record.fields.number));
  const route = routeFit(q, record);
  let excluded: string | undefined;
  if (service === false) excluded = "a different service number";
  else if (route === false) excluded = "another leg of the journey";
  else if (day === false) excluded = "a different day";
  if (service) positives.push("number");
  if (route) positives.push("route");
  // "The 10:05" is a journey too: the same day and the same departure time,
  // when neither its number nor its route says otherwise.
  const qMin = minutesOf(cleanDate(q.date));
  const rMin = minutesOf(record.start);
  if (day && positives.length === 0 && qMin !== undefined && rMin !== undefined && Math.abs(qMin - rMin) <= 15) positives.push("time");
  if (day && positives.length > 0) positives.unshift("date");
  return { record, positives, excluded };
}

/**
 * Stays. One overnight place per night, so two stays whose nights overlap
 * are either the same stay or a conflict. Leaving one place and arriving at
 * the next share a day and are not an overlap.
 */
function assessStay(record: AgentRecord, q: ResolveQuery): Scored {
  const positives: string[] = [];
  const date = cleanDate(q.date);
  const end = cleanDate(q.end);
  const named = titlesAgree(cleanString(q.name), `${record.title} ${text(record.fields.lodging)}`);
  const nights = !!date && !!end && dayNumber(end) > dayNumber(date);
  let overlap: Fit;
  if (date && record.start) {
    const lo = dayNumber(record.start);
    const hi = Math.max(dayNumber(record.end ?? record.start), lo);
    const qLo = dayNumber(date);
    // Nights are half-open: the day of departure is free for the next stay.
    overlap = nights ? qLo < Math.max(hi, lo + 1) && dayNumber(end!) > lo : qLo >= lo && qLo <= hi;
  }
  if (overlap === false) return { record, positives, excluded: "different nights" };
  if (named === false) {
    if (overlap && nights) {
      return { record, positives, conflict: "its nights overlap another stay, and there is one overnight place per night" };
    }
    return { record, positives, excluded: "a different lodging" };
  }
  if (named) positives.push("name");
  if (overlap) positives.push(nights ? "nights" : "date");
  // One day alone picks no stay: a departure and an arrival share it.
  if (positives.length === 1 && positives[0] === "date") positives.length = 0;
  return { record, positives };
}

function minutesOf(iso: string | undefined): number | undefined {
  if (!iso || iso.length < 16) return undefined;
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
}

/**
 * Activities. Several a day are normal — two talks in one hall, lunch and
 * dinner with the same person — so neither the day nor the venue identifies
 * one. Its name does (at about the same time), or the same time at the same
 * venue, or a message from the people who run it about that day.
 */
function assessActivity(record: AgentRecord, q: ResolveQuery): Scored {
  const positives: string[] = [];
  const date = cleanDate(q.date);
  const day = sameDay(record, date);
  if (day === false) return { record, positives, excluded: "a different day" };
  const named = titlesAgree(cleanString(q.name), record.title);
  const qMin = minutesOf(date);
  const rMin = minutesOf(record.start);
  const apart = qMin !== undefined && rMin !== undefined ? Math.abs(qMin - rMin) : undefined;
  const place = cleanString(q.place);
  const recordPlace = `${record.place ?? ""} ${text(record.fields.address)} ${text(record.fields.provider)}`;
  const samePlace = !!place && placesOverlap(place, recordPlace);
  const counterparts = cleanList(q.counterparts);
  const known =
    counterparts.length > 0 &&
    counterpartsOverlap(counterparts, [...record.counterparts, text(record.fields.email), text(record.fields.contact)].filter(Boolean));

  if (named && (apart === undefined || apart <= 120)) positives.push("name");
  else if (apart !== undefined && apart <= 30 && samePlace) positives.push("time", "place");
  if (known) positives.push("counterpart");
  // The day supports the others; alone, or with only the venue, it says nothing.
  if (day && positives.length > 0) positives.unshift("date");
  return { record, positives };
}

function assessGeneral(record: AgentRecord, q: ResolveQuery): Scored {
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
  const recordPlace = [record.place, record.fields.destination, record.fields.city, record.fields.venue]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  if (place && recordPlace) {
    if (placesOverlap(place, recordPlace)) positives.push("place");
    else if (record.kind === "trip") excluded ??= "different place";
  }
  if (record.kind === "conference") {
    const named = titlesAgree(cleanString(q.name), record.title);
    if (named) positives.push("name");
    else if (named === false) excluded ??= "a different conference";
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
  return { record, positives, excluded };
}

/** Each kind of thing is identified by its own facts. */
function assess(record: AgentRecord, q: ResolveQuery): Scored {
  if (record.kind === "transport") return assessTransport(record, q);
  if (record.kind === "stay") return assessStay(record, q);
  if (record.kind === "activity") return assessActivity(record, q);
  return assessGeneral(record, q);
}

function describe(r: AgentRecord): Record<string, string> {
  const out: Record<string, string> = { title: r.title };
  if (r.start) out.when = r.end && dayOf(r.end) !== dayOf(r.start) ? `${dayOf(r.start)} to ${dayOf(r.end)}` : r.start;
  const from = text(r.fields.from);
  const to = text(r.fields.to);
  if (from || to) out.route = `${from || "?"} → ${to || "?"}`;
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

/**
 * Which of the journeys on one booking is meant? The reference is shared by
 * the way out, the way back and every connection, so it is narrowed by the
 * service and the day. Null means every one of them is plainly another leg.
 */
function resolveLeg(sharing: AgentRecord[], q: ResolveQuery): ResolveResult | null {
  const hit = (r: AgentRecord, why: string): ResolveResult => ({
    class: "exact", id: r.id, title: r.title, path: r.path, state: r.state, why,
  });
  const ask = (rs: AgentRecord[], why: string): ResolveResult => {
    const candidates = distinguishing(rs.slice(0, 6));
    return { class: "several", candidates, question: questionFor("transport", candidates), why };
  };
  const possible = sharing.filter((r) => legOf(r, q) !== "other");
  if (possible.length === 0) return null;
  const date = cleanDate(q.date);
  if (!date) {
    return possible.length === 1
      ? hit(possible[0]!, "a reference or linked conversation matches")
      : ask(possible, "the booking covers more than one journey");
  }
  const thatDay = possible.filter((r) => sameDay(r, date) !== false);
  if (thatDay.length === 1) return hit(thatDay[0]!, "the booking reference and the day match");
  if (thatDay.length > 1) return ask(thatDay, "the booking covers more than one journey that day");
  // Nothing on that day. The same service on another day is that journey, moved.
  const moved = possible.filter((r) => legOf(r, q) === "same");
  if (moved.length === 1) return hit(moved[0]!, "the booking reference and the service match; the day has changed");
  return ask(possible, "it shares a booking reference but is on another day: a change to that journey, or a separate leg");
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
  if (q.kind === "transport" && exact.length > 0) {
    // One booking covers several journeys, so its reference names a set of legs.
    const leg = resolveLeg(exact, q);
    if (leg) return leg;
  } else if (exact.length === 1) {
    const r = exact[0]!;
    return { class: "exact", id: r.id, title: r.title, path: r.path, state: r.state, why: "a reference or linked conversation matches" };
  } else if (exact.length > 1) {
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
  const conflicts = scored.filter((x) => x.conflict);
  if (strong.length === 0 && conflicts.length > 0) {
    const candidates = distinguishing(conflicts.map((x) => x.record).slice(0, 6));
    return { class: "several", candidates, question: questionFor(q.kind, candidates), why: conflicts[0]!.conflict! };
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
