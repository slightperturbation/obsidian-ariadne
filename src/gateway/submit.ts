import type { FileChange } from "../actions/framework";
import { MAX_DIGEST_LINES, MAX_DIGEST_LINKS, MAX_PAPER_BYTES, digestPath, renderDigest, sniff, type DigestLink } from "./digest";
import { joinNote, splitNote } from "./frontmatter";
import { hashText, type GatewayIO } from "./io";
import {
  SPECS,
  appendHistory,
  cleanDate,
  cleanFields,
  cleanList,
  cleanString,
  inertQuote,
  isKind,
  newBody,
  parseRecord,
  safeTitle,
  serializeRecord,
  validState,
  type AgentRecord,
  type FieldValue,
  type RecordKind,
} from "./records";
import { resolveAgainst, type ResolveQuery } from "./resolve";
import { REVIEW_DIR, type RecordStore } from "./store";

/**
 * The write path. A harness never edits the vault: it submits observations
 * — typed data plus the quoted evidence — and the gateway decides, by rule,
 * whether each is applied, held for the user, or refused.
 */
export interface Evidence {
  /** A short quotation from the source message. Stored inert, in a callout. */
  quote?: string;
  /** Where it came from: "gmail", "whatsapp", "imessage", "vault-note"… */
  source: string;
  account?: string;
  from?: string;
  /** When the source was observed (ISO). */
  at: string;
}

export interface Observation {
  /** Idempotency key: the same key is never applied twice. */
  key: string;
  kind: RecordKind | "log" | "digest" | "paper";
  op: "create" | "update" | "log" | "digest" | "paper";
  /** For updates: the record, and how surely the harness matched it. */
  match?: { id: string; class: "exact" | "unique" | "adjudicated" };
  /** The identifying facts the harness resolved with; the gateway re-checks them. */
  query?: ResolveQuery;
  title?: string;
  state?: string;
  fields?: Record<string, FieldValue>;
  start?: string;
  end?: string;
  place?: string;
  refs?: string[];
  thread?: string;
  counterparts?: string[];
  /** One short clause describing the change, for the history line. */
  what?: string;
  /** For op "log": the line to append to the day's agent log. */
  line?: string;
  /**
   * For op "digest": the whole of a note the agent keeps for the user to read
   * (a trip's itinerary as the records have it). Replaced each time; never a record.
   * A line may open with a heading, a list item or a callout (see digest.ts); the rest is plain
   * text, in which ⟦n⟧ stands for the n-th of `links`.
   */
  lines?: string[];
  /** For op "digest": typed links the gateway builds itself — a map, a telephone number, another note. */
  links?: DigestLink[];
  /** For op "digest": a folder under Itineraries to keep it in (a trip's own folder). For "paper": the folder under Papers. */
  folder?: string;
  /**
   * For op "paper": a file to keep — a ticket, a station plan, a picture of a
   * timetable — in base64. Kept as it is: never opened, converted or run.
   */
  data?: string;
  /**
   * The harness is not sure this should happen (an entry has gone from the
   * user's note — cancelled, or only reworded?): hold it for the user.
   */
  ask?: boolean;
  evidence: Evidence;
}

export type Decision = "apply" | "review" | "reject";

export interface Plan {
  decision: Decision;
  reason: string;
  /** One line a person can read: what this would do. */
  summary: string;
  changes: FileChange[];
  id?: string;
  path?: string;
}

export interface LedgerEntry {
  status: "applied" | "review" | "rejected" | "dismissed";
  reason: string;
  summary?: string;
  id?: string;
  path?: string;
  at: string;
  client?: string;
}

export interface Ledger {
  get(key: string): Promise<LedgerEntry | undefined>;
  set(key: string, entry: LedgerEntry): Promise<void>;
}

export class MemoryLedger implements Ledger {
  entries = new Map<string, LedgerEntry>();
  async get(key: string): Promise<LedgerEntry | undefined> {
    return this.entries.get(key);
  }
  async set(key: string, entry: LedgerEntry): Promise<void> {
    this.entries.set(key, entry);
  }
}

export interface SubmitContext {
  io: GatewayIO;
  store: RecordStore;
  agentFolder: string;
  now: () => Date;
}

const MAX_KEY = 200;

function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sourceLabel(e: Evidence): string {
  return [cleanString(e.source, 40), cleanString(e.account, 60)].filter(Boolean).join("/");
}

/** Shape check. Returns problems; an empty list means the observation is well-formed. */
export function validateObservation(raw: unknown): string[] {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return ["observation must be an object"];
  const o = raw as Partial<Observation>;
  if (typeof o.key !== "string" || !o.key.trim() || o.key.length > MAX_KEY) errors.push("key is required (≤200 chars)");
  if (o.op !== "create" && o.op !== "update" && o.op !== "log" && o.op !== "digest" && o.op !== "paper") errors.push("op must be create, update, log, digest or paper");
  if (o.op === "log") {
    if (o.kind !== "log") errors.push('op "log" needs kind "log"');
    if (!cleanString(o.line)) errors.push("log needs a line");
  } else if (o.op === "paper") {
    if (o.kind !== "paper") errors.push('op "paper" needs kind "paper"');
    if (!cleanString(o.title)) errors.push("paper needs a title");
    if (typeof o.data !== "string" || !o.data || o.data.length > Math.ceil((MAX_PAPER_BYTES * 4) / 3) + 8) errors.push("paper needs its data, up to 10 MB");
  } else if (o.op === "digest") {
    if (o.kind !== "digest") errors.push('op "digest" needs kind "digest"');
    if (!cleanString(o.title)) errors.push("digest needs a title");
    if (!Array.isArray(o.lines) || o.lines.length === 0 || o.lines.length > MAX_DIGEST_LINES || o.lines.some((l) => typeof l !== "string")) {
      errors.push(`digest needs 1–${MAX_DIGEST_LINES} lines of text`);
    }
    if (o.links !== undefined && (!Array.isArray(o.links) || o.links.length > MAX_DIGEST_LINKS)) errors.push(`digest takes at most ${MAX_DIGEST_LINKS} links`);
  } else if (!isKind(o.kind)) {
    errors.push("unknown kind");
  } else {
    errors.push(...cleanFields(o.kind, o.fields).errors);
    if (o.state !== undefined && !validState(o.kind, o.state)) errors.push(`state "${cleanString(o.state, 40)}" is not valid for ${o.kind}`);
    if (o.op === "create" && !cleanString(o.title)) errors.push("create needs a title");
    if (o.op === "update" && !cleanString(o.match?.id, 80)) errors.push("update needs match.id");
    for (const k of ["start", "end"] as const) {
      if (o[k] !== undefined && o[k] !== null && o[k] !== "" && !cleanDate(o[k])) errors.push(`${k} is not an ISO date`);
    }
  }
  const e = o.evidence;
  if (!e || typeof e !== "object" || !cleanString(e.source, 40) || !cleanString(e.at, 40)) {
    errors.push("evidence.source and evidence.at are required");
  }
  return errors;
}

function queryOf(o: Observation): ResolveQuery {
  if (o.query && isKind(o.query.kind)) return { ...o.query, kind: o.kind as RecordKind };
  const f = o.fields ?? {};
  return {
    kind: o.kind as RecordKind,
    refs: o.refs,
    thread: o.thread,
    counterparts: o.counterparts,
    date: o.start ?? (typeof f.due === "string" ? f.due : undefined),
    end: o.end,
    place: o.place ?? (typeof f.destination === "string" ? f.destination : undefined),
    name: typeof f.lodging === "string" ? f.lodging : o.title,
    number: typeof f.number === "string" ? f.number : undefined,
    from: typeof f.from === "string" ? f.from : undefined,
    to: typeof f.to === "string" ? f.to : undefined,
    payee: typeof f.payee === "string" ? f.payee : undefined,
    amount: typeof f.amount === "number" ? f.amount : undefined,
    period: typeof f.period === "string" ? f.period : undefined,
  };
}

function union(a: readonly string[], b: readonly string[], cap = 60): string[] {
  const out = [...a];
  for (const x of b) if (x && !out.includes(x)) out.push(x);
  return out.slice(-cap);
}

async function freePath(io: GatewayIO, folder: string, title: string): Promise<string> {
  const base = safeTitle(title);
  for (let n = 1; n < 200; n++) {
    const path = `${folder}/${n === 1 ? base : `${base} ${n}`}.md`;
    if (!(await io.exists(path))) return path;
  }
  return `${folder}/${base} ${Date.now()}.md`;
}

async function planLog(ctx: SubmitContext, o: Observation): Promise<Plan> {
  const at = new Date(Date.parse(o.evidence.at) || ctx.now().getTime());
  const stamp = localStamp(at);
  const day = stamp.slice(0, 10);
  const path = `${ctx.agentFolder}/Log/${day}.md`;
  const line = `- ${stamp.slice(11)} · ${inertQuote(o.line, 240)} · ${sourceLabel(o.evidence)}\n`;
  if (await ctx.io.exists(path)) {
    const before = await ctx.io.read(path);
    return {
      decision: "apply",
      reason: "append to the agent's own log",
      summary: `Log · ${day}`,
      changes: [{ type: "modify", path, before, after: `${before.trimEnd()}\n${line}` }],
      path,
    };
  }
  const head = joinNote(
    { type: "agent-log", date: day, authorship: "agent", "agent-access": "local" },
    `> [!robot] Agent log\n> What your agent saw on ${day}. Append-only; text from messages is untrusted.\n\n${line}`,
  );
  return {
    decision: "apply",
    reason: "append to the agent's own log",
    summary: `Log · ${day}`,
    changes: [{ type: "create", path, after: head }],
    path,
  };
}

const DIGEST_TYPE = "agent-digest";

/**
 * A note the agent keeps for the user to read: one per title (and optional
 * folder), under the agent's Itineraries folder, written whole each time.
 * It is not a record — nothing resolves against it — and it only ever
 * replaces a digest of its own. How its text is made safe: see digest.ts.
 */
async function planDigest(ctx: SubmitContext, o: Observation): Promise<Plan> {
  const path = digestPath(ctx.agentFolder, o.title, o.folder);
  const title = path.slice(path.lastIndexOf("/") + 1, -3);
  const summary = `Itinerary · ${title}`;
  const body = renderDigest(o.lines ?? [], Array.isArray(o.links) ? o.links : [], ctx.agentFolder);
  const after = joinNote({ type: DIGEST_TYPE, authorship: "agent", "agent-access": "local", updated: localStamp(ctx.now()) }, body);
  if (!(await ctx.io.exists(path))) {
    return { decision: "apply", reason: "the agent's own digest", summary, changes: [{ type: "create", path, after }], path };
  }
  const before = await ctx.io.read(path);
  if (splitNote(before).data.type !== DIGEST_TYPE) {
    return { decision: "reject", reason: "a note that is not an agent digest is in the way", summary, changes: [] };
  }
  return { decision: "apply", reason: "the agent's own digest", summary, changes: [{ type: "modify", path, before, after }], path };
}

function historyEntry(ctx: SubmitContext, o: Observation, state: string | undefined) {
  return {
    at: localStamp(ctx.now()),
    state,
    what: o.what,
    source: sourceLabel(o.evidence),
    quote: o.evidence.quote,
  };
}

async function planCreate(ctx: SubmitContext, o: Observation, force: boolean): Promise<Plan> {
  const kind = o.kind as RecordKind;
  const spec = SPECS[kind];
  const title = cleanString(o.title);
  const summary = `New ${kind} · ${title}`;
  const records = await ctx.store.all();
  const near = resolveAgainst(records, queryOf(o));
  const state = validState(kind, o.state) ?? spec.initial;
  const id = `${kind}-${hashText(o.key)}`;
  if (records.some((r) => r.id === id)) {
    return { decision: "reject", reason: "a record with this key already exists", summary, changes: [] };
  }
  const path = await freePath(ctx.io, `${ctx.agentFolder}/${spec.folder}`, title);
  const record: AgentRecord = {
    id,
    kind,
    title,
    state,
    fields: cleanFields(kind, o.fields).fields,
    refs: cleanList(o.refs),
    threads: cleanList(o.thread ? [o.thread] : [], 200),
    notThreads: [],
    counterparts: cleanList(o.counterparts),
    start: cleanDate(o.start),
    end: cleanDate(o.end),
    place: cleanString(o.place) || undefined,
    source: cleanString(o.evidence.source, 40),
    account: cleanString(o.evidence.account, 60) || undefined,
    observed: cleanString(o.evidence.at, 40),
    updated: localStamp(ctx.now()),
    path,
    body: appendHistory(newBody(), historyEntry(ctx, o, state)),
    humanEdited: false,
  };
  const changes: FileChange[] = [{ type: "create", path, after: serializeRecord(record) }];
  if (!force && near.class !== "none") {
    const other = near.title ?? near.candidates?.map((c) => c.title).join(", ") ?? "an existing record";
    return { decision: "review", reason: `looks close to ${other} (${near.why})`, summary, changes, id, path };
  }
  return { decision: "apply", reason: force ? "approved by you" : "nothing similar exists", summary, changes, id, path };
}

/**
 * A day named without a time does not erase the time already known for that
 * day: a reminder that says only "on the 24th" leaves "the 24th at 19:00".
 */
function keepTime(had: string | undefined, next: string | undefined): string | undefined {
  if (!next) return had;
  if (had && next.length === 10 && had.length > 10 && had.startsWith(next)) return had;
  return next;
}

async function planUpdate(ctx: SubmitContext, o: Observation, force: boolean): Promise<Plan> {
  const kind = o.kind as RecordKind;
  const records = await ctx.store.all();
  const record = records.find((r) => r.id === o.match!.id);
  const label = cleanString(o.what, 80) || validState(kind, o.state) || "update";
  if (!record) return { decision: "reject", reason: "no such record", summary: `Update ${kind} · ${label}`, changes: [] };
  const summary = `${record.title} · ${label}`;
  if (record.kind !== kind) return { decision: "reject", reason: "record is of a different kind", summary, changes: [] };

  const before = await ctx.io.read(record.path);
  const fresh = parseRecord(record.path, before) ?? record;
  const state = validState(kind, o.state);
  const next: AgentRecord = {
    ...fresh,
    state: state ?? fresh.state,
    fields: { ...fresh.fields, ...cleanFields(kind, o.fields).fields },
    refs: union(fresh.refs, cleanList(o.refs)),
    threads: union(fresh.threads, cleanList(o.thread ? [o.thread] : [], 200)),
    counterparts: union(fresh.counterparts, cleanList(o.counterparts)),
    start: keepTime(fresh.start, cleanDate(o.start)),
    end: keepTime(fresh.end, cleanDate(o.end)),
    place: cleanString(o.place) || fresh.place,
    updated: localStamp(ctx.now()),
    body: appendHistory(fresh.body, historyEntry(ctx, o, state && state !== fresh.state ? state : undefined)),
  };
  const changes: FileChange[] = [{ type: "modify", path: record.path, before, after: serializeRecord(next) }];
  const out = { summary, changes, id: record.id, path: record.path };
  if (force) return { decision: "apply", reason: "approved by you", ...out };

  if (fresh.humanEdited) return { decision: "review", reason: "you have edited this record, so changes to it ask first", ...out };
  if (o.ask === true) return { decision: "review", reason: "your agent is not sure, and asks you to confirm", ...out };
  if (o.match!.class === "adjudicated") return { decision: "review", reason: "the match was chosen among several candidates", ...out };
  const check = resolveAgainst(records, queryOf(o));
  if ((check.class !== "exact" && check.class !== "unique") || check.id !== record.id) {
    return { decision: "review", reason: `the gateway could not confirm the match itself (${check.why})`, ...out };
  }
  return { decision: "apply", reason: `matched ${check.class}: ${check.why}`, ...out };
}

/** Decide what an observation would do. Reads the vault; writes nothing. */
export async function planObservation(
  ctx: SubmitContext,
  raw: unknown,
  opts: { force?: boolean } = {},
): Promise<Plan> {
  const errors = validateObservation(raw);
  if (errors.length > 0) {
    return { decision: "reject", reason: errors.slice(0, 4).join("; "), summary: "Malformed observation", changes: [] };
  }
  const o = raw as Observation;
  if (o.op === "log") return planLog(ctx, o);
  if (o.op === "digest") return planDigest(ctx, o);
  // A paper is kept directly by the submissions service, which holds the bytes; there is nothing to plan.
  if (o.op === "paper") return { decision: "reject", reason: "a paper is kept, not planned", summary: "Paper", changes: [] };
  if (o.op === "create") return planCreate(ctx, o, !!opts.force);
  return planUpdate(ctx, o, !!opts.force);
}

/** Apply planned changes, refusing if the vault moved since the plan was made. */
export async function applyChanges(io: GatewayIO, changes: readonly FileChange[]): Promise<void> {
  for (const c of changes) {
    if (c.type === "create") {
      if (await io.exists(c.path)) throw new Error(`conflict: ${c.path} already exists`);
    } else if ((await io.read(c.path)) !== c.before) {
      throw new Error(`conflict: ${c.path} changed since the plan was made`);
    }
  }
  for (const c of changes) {
    if (c.type === "create") await io.create(c.path, c.after ?? "");
    else if (c.type === "modify") await io.modify(c.path, c.after ?? "");
  }
}

// ── Review queue ───────────────────────────────────────────────────────────

export interface ReviewItem {
  key: string;
  path: string;
  summary: string;
  reason: string;
  submitted: string;
  client: string;
  target?: string;
  decision?: "approved" | "dismissed";
  observation: Observation;
}

export function reviewFolder(agentFolder: string): string {
  return `${agentFolder}/${REVIEW_DIR}`;
}

function reviewPath(agentFolder: string, key: string): string {
  return `${reviewFolder(agentFolder)}/${hashText(key)}.md`;
}

export function serializeReview(item: Omit<ReviewItem, "path">): string {
  const json = JSON.stringify(item.observation, null, 2).replace(/```/g, "'''");
  return joinNote(
    {
      type: "agent-review",
      key: item.key,
      summary: item.summary,
      reason: item.reason,
      submitted: item.submitted,
      client: item.client,
      target: item.target,
      decision: item.decision,
      authorship: "agent",
      "agent-access": "local",
    },
    `> [!robot] Waiting for your review\n> ${inertQuote(item.summary, 200)} — held because ${inertQuote(item.reason, 200)}.\n> Approve or dismiss it from Ariadne's panel.\n\n\`\`\`json\n${json}\n\`\`\`\n`,
  );
}

export function parseReview(path: string, text: string): ReviewItem | null {
  const { data, body } = splitNote(text);
  if (data.type !== "agent-review") return null;
  const m = /```json\n([\s\S]*?)\n```/.exec(body);
  if (!m) return null;
  let observation: Observation;
  try {
    observation = JSON.parse(m[1]!) as Observation;
  } catch {
    return null;
  }
  const decision = data.decision === "approved" || data.decision === "dismissed" ? data.decision : undefined;
  return {
    key: cleanString(data.key, MAX_KEY),
    path,
    summary: cleanString(data.summary),
    reason: cleanString(data.reason),
    submitted: cleanString(data.submitted, 40),
    client: cleanString(data.client, 60),
    target: cleanString(data.target) || undefined,
    decision,
    observation,
  };
}

export async function listReviews(io: GatewayIO, agentFolder: string): Promise<ReviewItem[]> {
  const out: ReviewItem[] = [];
  for (const path of await io.list(reviewFolder(agentFolder))) {
    try {
      const item = parseReview(path, await io.read(path));
      if (item) out.push(item);
    } catch {
      /* unreadable review file: skip */
    }
  }
  return out.sort((a, b) => a.submitted.localeCompare(b.submitted));
}

/** Mark a review decided in place (the plugin does this after applying). */
export async function markDecided(
  io: GatewayIO,
  item: ReviewItem,
  decision: "approved" | "dismissed",
): Promise<void> {
  const { path: _p, ...rest } = item;
  void _p;
  await io.modify(item.path, serializeReview({ ...rest, decision }));
}

/**
 * The user said "not this record": remember the conversation as not
 * belonging to it, so later messages in that thread stop matching.
 */
async function recordNotThread(ctx: SubmitContext, o: Observation): Promise<void> {
  if (o.op !== "update" || !o.thread || !o.match?.id) return;
  const record = await ctx.store.byId(o.match.id);
  if (!record || record.notThreads.includes(o.thread)) return;
  const before = await ctx.io.read(record.path);
  const fresh = parseRecord(record.path, before);
  if (!fresh) return;
  const edited = fresh.humanEdited;
  const next = { ...fresh, notThreads: union(fresh.notThreads, [o.thread]) };
  // Keep a human-edited record flagged as such: do not re-stamp its hash.
  if (edited) {
    const { data, body } = splitNote(before);
    await ctx.io.modify(record.path, joinNote({ ...data, "not-threads": next.notThreads }, body));
  } else {
    await ctx.io.modify(record.path, serializeRecord(next));
  }
}

export interface SubmitResult extends LedgerEntry {
  key: string;
  duplicate?: boolean;
}

export class Submissions {
  constructor(
    private ctx: SubmitContext,
    private ledger: Ledger,
  ) {}

  async submit(raw: unknown, client: string): Promise<SubmitResult> {
    const key = cleanString((raw as { key?: unknown } | null)?.key, MAX_KEY);
    if (key) {
      const prior = await this.ledger.get(key);
      if (prior) return { key, ...prior, duplicate: true };
    }
    if ((raw as { op?: unknown } | null)?.op === "paper") return this.keepPaper(raw, key, client);
    const plan = await planObservation(this.ctx, raw);
    const at = this.ctx.now().toISOString();
    const base = { reason: plan.reason, summary: plan.summary, id: plan.id, path: plan.path, at, client };
    if (plan.decision === "reject") {
      const entry: LedgerEntry = { status: "rejected", ...base };
      if (key) await this.ledger.set(key, entry);
      return { key, ...entry };
    }
    if (plan.decision === "apply") {
      try {
        await applyChanges(this.ctx.io, plan.changes);
      } catch (err) {
        // A conflict is transient: do not burn the idempotency key on it.
        return { key, status: "rejected", ...base, reason: String(err) };
      }
      const entry: LedgerEntry = { status: "applied", ...base };
      await this.ledger.set(key, entry);
      return { key, ...entry };
    }
    const path = reviewPath(this.ctx.agentFolder, key);
    const text = serializeReview({
      key,
      summary: plan.summary,
      reason: plan.reason,
      submitted: at,
      client,
      target: plan.path,
      observation: raw as Observation,
    });
    if (await this.ctx.io.exists(path)) await this.ctx.io.modify(path, text);
    else await this.ctx.io.create(path, text);
    const entry: LedgerEntry = { status: "review", ...base };
    await this.ledger.set(key, entry);
    return { key, ...entry };
  }

  /**
   * Keep a file under the agent's Papers folder. What kind of file it is, is
   * told from its bytes; its name is made here from the title; nothing is
   * ever overwritten. The bytes are stored as they came and never opened.
   */
  private async keepPaper(raw: unknown, key: string, client: string): Promise<SubmitResult> {
    const at = this.ctx.now().toISOString();
    const o = raw as Observation;
    const refuse = async (reason: string): Promise<SubmitResult> => {
      const entry: LedgerEntry = { status: "rejected", reason, summary: "Paper", at, client };
      if (key) await this.ledger.set(key, entry);
      return { key, ...entry };
    };
    const errors = validateObservation(raw);
    if (errors.length > 0) return refuse(errors.slice(0, 3).join("; "));
    if (!this.ctx.io.createBinary) return refuse("this gateway cannot store files");
    let data: Uint8Array;
    try {
      data = Uint8Array.from(Buffer.from(o.data ?? "", "base64"));
    } catch {
      return refuse("the data is not base64");
    }
    if (data.length === 0 || data.length > MAX_PAPER_BYTES) return refuse("a paper is at most 10 MB");
    const ext = sniff(data);
    if (!ext) return refuse("only PDF, PNG and JPEG files are kept");
    const folder = `${this.ctx.agentFolder}/Papers/${cleanString(o.folder, 120) ? safeTitle(cleanString(o.folder, 120)) : "Other"}`;
    const base = safeTitle(o.title ?? "");
    let path = `${folder}/${base}.${ext}`;
    for (let n = 2; n < 100 && (await this.ctx.io.exists(path)); n++) path = `${folder}/${base} ${n}.${ext}`;
    try {
      await this.ctx.io.createBinary(path, data);
    } catch (err) {
      return { key, status: "rejected", reason: String(err), summary: "Paper", at, client };
    }
    const entry: LedgerEntry = { status: "applied", reason: "a paper kept by the agent", summary: `Paper · ${base}`, path, at, client };
    if (key) await this.ledger.set(key, entry);
    return { key, ...entry };
  }

  /** Decide a held item (the owner, through a trusted channel). */
  async decide(key: string, decision: "approve" | "dismiss"): Promise<SubmitResult> {
    const items = await listReviews(this.ctx.io, this.ctx.agentFolder);
    const item = items.find((i) => i.key === key && !i.decision);
    const at = this.ctx.now().toISOString();
    if (!item) return { key, status: "rejected", reason: "no such pending review", at };
    if (decision === "dismiss") {
      await recordNotThread(this.ctx, item.observation);
      await this.ctx.io.delete(item.path);
      const entry: LedgerEntry = { status: "dismissed", reason: "dismissed by you", summary: item.summary, at, client: item.client };
      await this.ledger.set(key, entry);
      return { key, ...entry };
    }
    const plan = await planObservation(this.ctx, item.observation, { force: true });
    if (plan.decision !== "apply") return { key, status: "rejected", reason: plan.reason, at };
    await applyChanges(this.ctx.io, plan.changes);
    await this.ctx.io.delete(item.path);
    const entry: LedgerEntry = { status: "applied", reason: "approved by you", summary: plan.summary, id: plan.id, path: plan.path, at, client: item.client };
    await this.ledger.set(key, entry);
    return { key, ...entry };
  }

  /**
   * Look again at what is held, with the rules as they are now. An item that
   * today's rules would apply without asking is applied and leaves the queue;
   * everything else stays held. Run when the gateway starts, which is when the
   * rules can have changed.
   */
  async recheck(): Promise<number> {
    let released = 0;
    for (const item of await this.pending()) {
      const plan = await planObservation(this.ctx, item.observation);
      if (plan.decision !== "apply") continue;
      try {
        await applyChanges(this.ctx.io, plan.changes);
      } catch {
        continue; // a conflict: leave it held
      }
      await this.ctx.io.delete(item.path);
      await this.ledger.set(item.key, {
        status: "applied",
        reason: `${plan.reason} (held earlier; released on re-check)`,
        summary: plan.summary,
        id: plan.id,
        path: plan.path,
        at: this.ctx.now().toISOString(),
        client: item.client,
      });
      released++;
    }
    return released;
  }

  /**
   * Pick up decisions made elsewhere (the plugin on another device marks a
   * review file decided; Sync brings it here).
   */
  async sweep(): Promise<number> {
    let swept = 0;
    for (const item of await listReviews(this.ctx.io, this.ctx.agentFolder)) {
      if (!item.decision) continue;
      const at = this.ctx.now().toISOString();
      if (item.decision === "dismissed") await recordNotThread(this.ctx, item.observation);
      await this.ledger.set(item.key, {
        status: item.decision === "approved" ? "applied" : "dismissed",
        reason: item.decision === "approved" ? "approved by you" : "dismissed by you",
        summary: item.summary,
        path: item.target,
        at,
        client: item.client,
      });
      await this.ctx.io.delete(item.path);
      swept++;
    }
    return swept;
  }

  async pending(): Promise<ReviewItem[]> {
    return (await listReviews(this.ctx.io, this.ctx.agentFolder)).filter((i) => !i.decision);
  }

  async status(keys: readonly string[]): Promise<Record<string, LedgerEntry | null>> {
    await this.sweep();
    const out: Record<string, LedgerEntry | null> = {};
    for (const key of keys.slice(0, 200)) out[key] = (await this.ledger.get(key)) ?? null;
    return out;
  }
}
