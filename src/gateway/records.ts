import { hashText } from "./io";
import { joinNote, splitNote } from "./frontmatter";

/**
 * Structured records: one note per record, flat properties. Everything here
 * is typed and bounded, because every value may have started life as text in
 * a stranger's email — a record is data, never instructions.
 */
export const KINDS = [
  "appointment",
  "trip",
  "conference",
  "transport",
  "stay",
  "activity",
  "bill",
  "task",
  "project",
  "person",
] as const;
export type RecordKind = (typeof KINDS)[number];

/** The flat kind the itinerary used before it had structure. Migrated at start. */
export const LEGACY_ITINERARY_KIND = "itinerary-item";

export type FieldType = "string" | "number" | "boolean" | "date" | "list";
export type FieldValue = string | number | boolean | string[] | null;

export interface KindSpec {
  folder: string;
  /** Allowed states; null = free-form short text. */
  states: readonly string[] | null;
  initial: string;
  /** States after which a record no longer attracts new matches by default. */
  terminal: readonly string[];
  fields: Readonly<Record<string, FieldType>>;
  /** Tolerance, in days, when testing a date against the record's window. */
  windowDays: number;
}

/** What a thing costs and how it is paid — shared by everything on an itinerary. */
const COST = { price: "number", currency: "string", payment: "string", paid: "boolean" } as const;
/** Where it came from in the user's own notes, which trip it belongs to, and its papers. */
const ITINERARY = { trip: "string", hub: "string", tickets: "list", url: "string", notes: "string" } as const;
const BOOKING_STATES = ["planned", "booked", "changed", "done", "cancelled"] as const;

export const SPECS: Readonly<Record<RecordKind, KindSpec>> = {
  appointment: {
    folder: "Appointments",
    states: ["requested", "confirmed", "rescheduled", "attended", "cancelled"],
    initial: "requested",
    terminal: ["attended", "cancelled"],
    fields: {
      category: "string",
      with: "string",
      phone: "string",
      url: "string",
      address: "string",
      "travel-min": "number",
      ...COST,
    },
    windowDays: 0,
  },
  trip: {
    folder: "Trips",
    states: BOOKING_STATES,
    initial: "planned",
    terminal: ["done", "cancelled"],
    fields: { destination: "string", country: "string", hub: "string" },
    windowDays: 1,
  },
  /** A meeting that spans days. Its talks and events are activities that name it. */
  conference: {
    folder: "Trips/Conferences",
    states: ["planned", "registered", "done", "cancelled"],
    initial: "planned",
    terminal: ["done", "cancelled"],
    fields: { venue: "string", city: "string", country: "string", "schedule-url": "string", ...ITINERARY, ...COST },
    windowDays: 1,
  },
  /**
   * One journey from one place to another: a flight, a train, a transfer.
   * `start` is the departure and `end` the arrival, each in local time there.
   * Several a day are normal, and one booking often covers several legs.
   */
  transport: {
    folder: "Trips/Transport",
    states: BOOKING_STATES,
    initial: "booked",
    terminal: ["done", "cancelled"],
    fields: {
      mode: "string",
      carrier: "string",
      number: "string",
      from: "string",
      to: "string",
      seat: "string",
      "travel-min": "number",
      ...ITINERARY,
      ...COST,
    },
    windowDays: 0,
  },
  /**
   * Where the nights are spent: `start` is the day of arrival, `end` the day
   * of departure, so it covers the nights from start up to (not including)
   * end. One per night — but leaving one and arriving at the next share a day.
   */
  stay: {
    folder: "Trips/Stays",
    states: BOOKING_STATES,
    initial: "booked",
    terminal: ["done", "cancelled"],
    fields: {
      lodging: "string",
      address: "string",
      country: "string",
      "check-in": "string",
      "check-out": "string",
      phone: "string",
      email: "string",
      ...ITINERARY,
      ...COST,
    },
    windowDays: 0,
  },
  /**
   * Something to be at: a meal, a show, an appointment, a tour, a talk.
   * Several a day are normal. `place` is the venue's name.
   */
  activity: {
    folder: "Trips/Activities",
    states: ["planned", "to-confirm", "asked", "confirmed", "done", "cancelled"],
    initial: "planned",
    terminal: ["done", "cancelled"],
    fields: {
      category: "string",
      address: "string",
      provider: "string",
      with: "string",
      contact: "string",
      email: "string",
      "confirm-via": "string",
      "confirm-by": "date",
      "travel-min": "number",
      conference: "string",
      official: "boolean",
      ...ITINERARY,
      ...COST,
    },
    windowDays: 0,
  },
  bill: {
    folder: "Bills",
    states: ["issued", "scheduled", "paid", "overdue"],
    initial: "issued",
    terminal: ["paid"],
    fields: {
      payee: "string",
      amount: "number",
      currency: "string",
      due: "date",
      period: "string",
      autopay: "boolean",
      "paid-on": "date",
    },
    windowDays: 5,
  },
  task: {
    folder: "Tasks",
    states: ["proposed", "open", "waiting", "done", "dropped"],
    initial: "proposed",
    terminal: ["done", "dropped"],
    fields: { due: "date", for: "string", "waiting-on": "string" },
    windowDays: 3,
  },
  project: {
    folder: "Projects",
    states: null,
    initial: "active",
    terminal: [],
    fields: { next: "string" },
    windowDays: 0,
  },
  person: {
    folder: "People",
    states: null,
    initial: "-",
    terminal: [],
    fields: {
      name: "string",
      "last-heard": "date",
      "last-wrote": "date",
      "reply-owed": "boolean",
      channel: "string",
    },
    windowDays: 0,
  },
};

export function isKind(v: unknown): v is RecordKind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

export interface AgentRecord {
  id: string;
  kind: RecordKind;
  title: string;
  state: string;
  fields: Record<string, FieldValue>;
  /** Fingerprint — what later messages are matched against. */
  refs: string[];
  threads: string[];
  /** Conversations the user said do NOT belong to this record. */
  notThreads: string[];
  counterparts: string[];
  start?: string;
  end?: string;
  place?: string;
  /** Provenance. */
  source?: string;
  account?: string;
  observed?: string;
  updated?: string;
  path: string;
  body: string;
  /** The note no longer matches what the agent last wrote: the user edited it. */
  humanEdited: boolean;
  /**
   * Properties some other tool put on the note (tags, a publish flag). They
   * are not the agent's, so they are kept as found and are not an edit.
   */
  extra?: Record<string, unknown>;
}

const MAX_STRING = 300;
const MAX_LIST = 30;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/;

/** One line, bounded, no control characters. */
export function cleanString(v: unknown, max = MAX_STRING): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return String(v)
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function cleanList(v: unknown, max = MAX_LIST): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
  const out: string[] = [];
  for (const item of arr) {
    const s = cleanString(item, 200);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** Accepts YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS] (zone suffixes dropped). */
export function cleanDate(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v !== "string") return undefined;
  const s = v.trim().replace(/(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/, "").replace(" ", "T");
  if (!ISO_DATE.test(s)) return undefined;
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : s.slice(0, 16);
}

export function dayOf(iso: string | undefined): string | undefined {
  return iso ? iso.slice(0, 10) : undefined;
}

/** Validate typed fields against a kind; unknown keys and bad values are errors. */
export function cleanFields(
  kind: RecordKind,
  raw: unknown,
): { fields: Record<string, FieldValue>; errors: string[] } {
  const fields: Record<string, FieldValue> = {};
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { fields, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { fields, errors: ["fields must be an object"] };
  const spec = SPECS[kind].fields;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const type = spec[key];
    if (!type) {
      errors.push(`unknown field "${cleanString(key, 40)}" for ${kind}`);
      continue;
    }
    if (value === null || value === undefined || value === "") continue;
    if (type === "string") {
      const s = cleanString(value);
      if (s) fields[key] = s;
    } else if (type === "number") {
      const n = typeof value === "number" ? value : Number(String(value).replace(/[,\s]/g, ""));
      if (Number.isFinite(n)) fields[key] = Math.round(n * 100) / 100;
      else errors.push(`field "${key}" is not a number`);
    } else if (type === "boolean") {
      if (typeof value === "boolean") fields[key] = value;
      else if (value === "true" || value === "false") fields[key] = value === "true";
      else errors.push(`field "${key}" is not true/false`);
    } else if (type === "date") {
      const d = cleanDate(value);
      if (d) fields[key] = d;
      else errors.push(`field "${key}" is not an ISO date`);
    } else {
      fields[key] = cleanList(value);
    }
  }
  return { fields, errors };
}

export function validState(kind: RecordKind, state: unknown): string | undefined {
  const s = cleanString(state, 40).toLowerCase();
  if (!s) return undefined;
  const allowed = SPECS[kind].states;
  if (allowed === null) return s;
  return allowed.includes(s) ? s : undefined;
}

/** A filename-safe title. */
export function safeTitle(title: string): string {
  return (
    cleanString(title, 90)
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "") || "Untitled"
  );
}

/**
 * Untrusted free text, made inert for display: one line, bounded, with the
 * characters that would let it act as a link, embed, tag, HTML or a new
 * block defused. Always rendered inside a quote callout.
 */
export function inertQuote(text: unknown, max = 280): string {
  const s = cleanString(text, max * 2)
    .replace(/\[\[/g, "[ [")
    .replace(/\]\]/g, "] ]")
    .replace(/\]\(/g, "] (")
    .replace(/!\[/g, "! [")
    .replace(/[`<>]/g, "'")
    .replace(/(^|\s)#(?=\w)/g, "$1# ")
    .replace(/%%/g, "% %");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const RESERVED = new Set([
  "type",
  "agent-id",
  "title",
  "state",
  "refs",
  "threads",
  "not-threads",
  "counterparts",
  "start",
  "end",
  "place",
  "authorship",
  "source",
  "account",
  "observed",
  "updated",
  "agent-hash",
  "agent-access",
]);

const BANNER =
  "> [!robot] Agent record\n" +
  "> Kept by your agent through Ariadne's gateway. Edit freely — once you do, " +
  "later agent updates to this note ask first.\n";

export function newBody(): string {
  return `${BANNER}\n## History\n`;
}

/** Append one dated history entry (with optional quoted evidence). */
export function appendHistory(
  body: string,
  entry: { at: string; state?: string; what?: string; source?: string; quote?: string },
): string {
  const when = entry.at.slice(0, 16).replace("T", " ");
  const what = entry.what && entry.what !== entry.state ? inertQuote(entry.what, 160) : undefined;
  const parts = [when, entry.state, what, entry.source]
    .filter(Boolean)
    .join(" · ");
  let line = `- ${parts}\n`;
  if (entry.quote) line += `  > [!quote] From the message (untrusted text)\n  > ${inertQuote(entry.quote)}\n`;
  const base = /## History/.test(body) ? body : `${body.trimEnd()}\n\n## History\n`;
  return `${base.trimEnd()}\n${line}`;
}

function frontmatterOf(r: AgentRecord): Record<string, unknown> {
  return {
    type: r.kind,
    "agent-id": r.id,
    title: r.title,
    state: r.state,
    start: r.start,
    end: r.end,
    place: r.place,
    ...r.fields,
    refs: r.refs,
    threads: r.threads,
    "not-threads": r.notThreads,
    counterparts: r.counterparts,
    authorship: "agent",
    source: r.source,
    account: r.account,
    observed: r.observed,
    updated: r.updated,
    "agent-access": "local",
  };
}

/**
 * The note text for a record, stamped with the hash that detects human edits.
 * The stamp covers the agent's own properties and the body; properties other
 * tools added ride along after it, untouched and unstamped.
 */
export function serializeRecord(r: AgentRecord): string {
  const data = frontmatterOf(r);
  const unstamped = joinNote(data, r.body);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r.extra ?? {})) if (!(k in data) && k !== "agent-hash") extra[k] = v;
  return joinNote({ ...data, "agent-hash": hashText(unstamped), ...extra }, r.body);
}

/** Parse a note as a record; null when it is not one. */
export function parseRecord(path: string, text: string): AgentRecord | null {
  const { data, body } = splitNote(text);
  if (!isKind(data.type)) return null;
  const id = cleanString(data["agent-id"], 80);
  if (!id) return null;
  const kind = data.type;
  const fields: Record<string, FieldValue> = {};
  const spec = SPECS[kind].fields;
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED.has(key) || !(key in spec)) continue;
    const one = cleanFields(kind, { [key]: value }).fields[key];
    if (one !== undefined) fields[key] = one;
  }
  const stamped = cleanString(data["agent-hash"], 40);
  // Only what the agent writes is the agent's to compare: a tag or a flag
  // added by another tool is not the user editing the record.
  const own: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "agent-hash") continue;
    if (RESERVED.has(key) || key in spec) own[key] = value;
    else extra[key] = value;
  }
  const humanEdited = stamped !== "" && hashText(joinNote(own, body)) !== stamped;
  return {
    id,
    kind,
    title: cleanString(data.title) || path.split("/").pop()!.replace(/\.md$/, ""),
    state: cleanString(data.state, 40) || SPECS[kind].initial,
    fields,
    refs: cleanList(data.refs),
    threads: cleanList(data.threads, 200),
    notThreads: cleanList(data["not-threads"], 200),
    counterparts: cleanList(data.counterparts),
    start: cleanDate(data.start),
    end: cleanDate(data.end),
    place: cleanString(data.place) || undefined,
    source: cleanString(data.source, 60) || undefined,
    account: cleanString(data.account, 60) || undefined,
    observed: cleanString(data.observed, 40) || undefined,
    updated: cleanString(data.updated, 40) || undefined,
    path,
    body,
    humanEdited,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  };
}

/** What a client sees of a record. */
export function publicRecord(r: AgentRecord): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    state: r.state,
    start: r.start,
    end: r.end,
    place: r.place,
    fields: r.fields,
    refs: r.refs,
    counterparts: r.counterparts,
    source: r.source,
    account: r.account,
    updated: r.updated,
    path: r.path,
    origin: "agent",
    humanEdited: r.humanEdited,
  };
}
