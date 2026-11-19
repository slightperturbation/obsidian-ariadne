import MiniSearch from "minisearch";
import { splitNote } from "./frontmatter";
import type { GatewayIO } from "./io";
import { hashText } from "./io";
import { levelOf, underFolder, type LevelPolicy, type PrivacyLevel } from "./levels";
import { cleanDate, cleanString, dayOf, isKind, publicRecord, SPECS, type AgentRecord } from "./records";
import { resolveAgainst, type ResolveQuery, type ResolveResult } from "./resolve";
import { RecordStore, REVIEW_DIR } from "./store";
import { Submissions, type Ledger, type SubmitResult } from "./submit";

/**
 * The agent gateway, transport-free. Every tool takes the calling client
 * first; what a client may read depends on where its model runs.
 */
export interface Client {
  name: string;
  /** "local": a model on the user's own machines. "external": anyone else's. */
  class: "local" | "external";
  /** May submit observations. */
  write?: boolean;
  /** Speaks for the user (a trusted channel to them): may decide reviews. */
  owner?: boolean;
}

export class GatewayError extends Error {
  constructor(
    readonly code: "bad-request" | "forbidden" | "not-found",
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface AuditEntry {
  ts: string;
  client: string;
  tool: string;
  ok: boolean;
  ms: number;
  /** Which privacy levels were consulted to answer. */
  levels?: PrivacyLevel[];
  /** How many items went out. */
  n?: number;
  /** Paths that went out (never content). */
  paths?: string[];
  error?: string;
}

interface IndexedNote {
  id: string;
  title: string;
  text: string;
}

interface NoteMeta {
  mtime: number;
  level: PrivacyLevel;
  origin: "you" | "agent";
  title: string;
  hash: string;
}

const RESCAN_MS = 20_000;
const MAX_NOTE_CHARS = 60_000;

export class Gateway {
  readonly store: RecordStore;
  readonly submissions: Submissions;
  private engine = new MiniSearch<IndexedNote>({
    fields: ["title", "text"],
    storeFields: ["title"],
    searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.15, combineWith: "AND" },
  });
  private meta = new Map<string, NoteMeta>();
  private lastScan = 0;
  private scanning: Promise<void> | null = null;

  constructor(
    private deps: {
      io: GatewayIO;
      policy: LevelPolicy;
      ledger: Ledger;
      /** Folder names (any depth) whose notes are trip itineraries. */
      itineraryFolderNames?: readonly string[];
      now?: () => Date;
      audit?: (entry: AuditEntry) => void;
    },
  ) {
    const now = deps.now ?? (() => new Date());
    this.store = new RecordStore(deps.io, deps.policy.agentFolder);
    this.submissions = new Submissions(
      { io: deps.io, store: this.store, agentFolder: deps.policy.agentFolder, now },
      deps.ledger,
    );
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** May this client see content at this level? Sealed: no agent, ever. */
  private allowed(client: Client, level: PrivacyLevel): boolean {
    if (level === "sealed") return false;
    if (level === "local") return client.class === "local";
    return true;
  }

  private skip(path: string): boolean {
    return (
      path.startsWith(".") ||
      path.includes("/.") ||
      underFolder(path, `${this.deps.policy.agentFolder}/${REVIEW_DIR}`)
    );
  }

  /** Bring the note index up to date with the vault (cheap: mtime-gated). */
  private async scan(force = false): Promise<void> {
    if (!force && Date.now() - this.lastScan < RESCAN_MS) return;
    this.scanning ??= (async () => {
      try {
        const paths = (await this.deps.io.list("")).filter((p) => !this.skip(p));
        const live = new Set(paths);
        for (const path of [...this.meta.keys()]) {
          if (!live.has(path)) {
            this.meta.delete(path);
            if (this.engine.has(path)) this.engine.discard(path);
          }
        }
        for (const path of paths) {
          const mtime = (await this.deps.io.mtime(path)) ?? 0;
          const known = this.meta.get(path);
          if (known && known.mtime === mtime) continue;
          let text: string;
          try {
            text = await this.deps.io.read(path);
          } catch {
            continue;
          }
          const { data, body } = splitNote(text);
          const level = levelOf(path, this.deps.policy, data["agent-access"]);
          const title = path.split("/").pop()!.replace(/\.md$/i, "");
          const agent =
            underFolder(path, this.deps.policy.agentFolder) ||
            data.authorship === "agent" ||
            data.authorship === "ai-generated";
          this.meta.set(path, { mtime, level, origin: agent ? "agent" : "you", title, hash: hashText(text) });
          if (this.engine.has(path)) this.engine.discard(path);
          // Sealed text is never indexed: what is not held cannot leak.
          if (level !== "sealed") {
            this.engine.add({ id: path, title, text: body.slice(0, MAX_NOTE_CHARS) });
          }
        }
        this.lastScan = Date.now();
      } finally {
        this.scanning = null;
      }
    })();
    await this.scanning;
  }

  private async audited<T>(
    client: Client,
    tool: string,
    run: () => Promise<{ result: T; levels?: PrivacyLevel[]; n?: number; paths?: string[] }>,
  ): Promise<T> {
    const started = Date.now();
    try {
      const { result, levels, n, paths } = await run();
      this.deps.audit?.({ ts: this.now().toISOString(), client: client.name, tool, ok: true, ms: Date.now() - started, levels, n, paths: paths?.slice(0, 50) });
      return result;
    } catch (err) {
      this.deps.audit?.({ ts: this.now().toISOString(), client: client.name, tool, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  private requireLocal(client: Client, what: string): void {
    if (client.class !== "local") {
      throw new GatewayError("forbidden", `${what} is not available to this client`);
    }
  }

  private levelsFor(client: Client): PrivacyLevel[] {
    return client.class === "local" ? ["shareable", "local"] : ["shareable"];
  }

  // ── Read tools ───────────────────────────────────────────────────────────

  async search(client: Client, args: { query?: unknown; limit?: unknown }) {
    return this.audited(client, "search", async () => {
      const query = cleanString(args.query, 300);
      if (!query) throw new GatewayError("bad-request", "query is required");
      const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 25);
      await this.scan();
      const hits = [];
      for (const hit of this.engine.search(query)) {
        const meta = this.meta.get(hit.id as string);
        if (!meta || !this.allowed(client, meta.level)) continue;
        let snippet = "";
        try {
          snippet = snippetOf(splitNote(await this.deps.io.read(hit.id as string)).body, query);
        } catch {
          /* vanished between scan and read */
        }
        hits.push({ path: hit.id as string, title: meta.title, snippet, level: meta.level, origin: meta.origin });
        if (hits.length >= limit) break;
      }
      return { result: { hits }, levels: this.levelsFor(client), n: hits.length, paths: hits.map((h) => h.path) };
    });
  }

  async read(client: Client, args: { path?: unknown }) {
    return this.audited(client, "read", async () => {
      const path = cleanString(args.path, 400);
      if (!path || path.includes("..") || this.skip(path)) throw new GatewayError("not-found", "no such note");
      await this.scan();
      let meta = this.meta.get(path);
      if (!meta) {
        await this.scan(true);
        meta = this.meta.get(path);
      }
      // An unreadable note and a nonexistent one look the same to the client.
      if (!meta || !this.allowed(client, meta.level)) throw new GatewayError("not-found", "no such note");
      const text = await this.deps.io.read(path);
      return {
        result: { path, title: meta.title, level: meta.level, origin: meta.origin, hash: meta.hash, text: text.slice(0, MAX_NOTE_CHARS) },
        levels: [meta.level],
        n: 1,
        paths: [path],
      };
    });
  }

  /** List notes (no text) — by folder, or the itinerary folders. */
  async notes(client: Client, args: { folder?: unknown; itineraries?: unknown }) {
    return this.audited(client, "notes", async () => {
      await this.scan();
      const folder = cleanString(args.folder, 300).replace(/^\/+|\/+$/g, "");
      const names = (this.deps.itineraryFolderNames ?? []).map((n) => n.toLowerCase());
      const wantItineraries = args.itineraries === true;
      if (!folder && !wantItineraries) throw new GatewayError("bad-request", "folder or itineraries is required");
      const out = [];
      for (const [path, meta] of this.meta) {
        if (!this.allowed(client, meta.level)) continue;
        if (wantItineraries) {
          const segments = path.toLowerCase().split("/").slice(0, -1);
          if (!segments.some((s) => names.includes(s))) continue;
          if (underFolder(path, this.deps.policy.agentFolder)) continue;
        } else if (!underFolder(path, folder)) continue;
        out.push({ path, title: meta.title, level: meta.level, origin: meta.origin, hash: meta.hash, mtime: meta.mtime });
      }
      out.sort((a, b) => a.path.localeCompare(b.path));
      return { result: { notes: out.slice(0, 500) }, levels: this.levelsFor(client), n: out.length };
    });
  }

  /** Typed query over records: "open bills due this month", "appointments next week". */
  async get(
    client: Client,
    args: { kind?: unknown; state?: unknown; from?: unknown; to?: unknown; open?: unknown; id?: unknown; where?: unknown },
  ) {
    return this.audited(client, "get", async () => {
      this.requireLocal(client, "records");
      const all = await this.store.all();
      const id = cleanString(args.id, 80);
      if (id) {
        const one = all.find((r) => r.id === id);
        if (!one) throw new GatewayError("not-found", "no such record");
        return { result: { records: [publicRecord(one)] }, levels: ["local"] as PrivacyLevel[], n: 1, paths: [one.path] };
      }
      if (args.kind !== undefined && !isKind(args.kind)) throw new GatewayError("bad-request", "unknown kind");
      const state = cleanString(args.state, 40).toLowerCase();
      const from = dayOf(cleanDate(args.from));
      const to = dayOf(cleanDate(args.to));
      // Property filters: { payment: "cash" }, { conference: "BMVC 2026" }, { paid: false }.
      const where =
        args.where && typeof args.where === "object" && !Array.isArray(args.where)
          ? Object.entries(args.where as Record<string, unknown>).slice(0, 8)
          : [];
      const holds = (r: AgentRecord, key: string, want: unknown): boolean => {
        const have = key === "place" ? r.place : key === "title" ? r.title : r.fields[key];
        if (typeof want === "boolean") return (have === true) === want;
        if (typeof want === "number") return have === want;
        return cleanString(have).toLowerCase() === cleanString(want).toLowerCase();
      };
      const records = all.filter((r) => {
        if (where.some(([key, want]) => !holds(r, key, want))) return false;
        if (args.kind && r.kind !== args.kind) return false;
        if (state && r.state !== state) return false;
        if (args.open === true && SPECS[r.kind].terminal.includes(r.state)) return false;
        if (from || to) {
          const anchor = dayOf(r.start ?? (typeof r.fields.due === "string" ? r.fields.due : undefined));
          if (!anchor) return false;
          const last = dayOf(r.end) ?? anchor;
          if (from && last < from) return false;
          if (to && anchor > to) return false;
        }
        return true;
      });
      records.sort((a, b) => (a.start ?? String(a.fields.due ?? "")).localeCompare(b.start ?? String(b.fields.due ?? "")));
      const out = records.slice(0, 200);
      return { result: { records: out.map(publicRecord) }, levels: ["local"] as PrivacyLevel[], n: out.length, paths: out.map((r) => r.path) };
    });
  }

  async resolve(client: Client, args: unknown): Promise<ResolveResult> {
    return this.audited(client, "resolve", async () => {
      this.requireLocal(client, "matching");
      const q = args as Partial<ResolveQuery> | null;
      if (!q || !isKind(q.kind)) throw new GatewayError("bad-request", "kind is required");
      const result = resolveAgainst(await this.store.all(), q as ResolveQuery);
      return { result, levels: ["local"] as PrivacyLevel[], n: result.candidates?.length ?? (result.id ? 1 : 0) };
    });
  }

  // ── Write tools ──────────────────────────────────────────────────────────

  async submit(client: Client, args: { observations?: unknown }): Promise<{ results: SubmitResult[] }> {
    return this.audited(client, "submit", async () => {
      this.requireLocal(client, "submitting");
      if (!client.write) throw new GatewayError("forbidden", "this client may not submit");
      const list = Array.isArray(args.observations) ? args.observations.slice(0, 50) : null;
      if (!list) throw new GatewayError("bad-request", "observations must be a list");
      const results: SubmitResult[] = [];
      for (const obs of list) {
        // Only the owner's own channel may say that a change is the owner's.
        const clean = !client.owner && obs && typeof obs === "object" && "pin" in obs ? { ...(obs as object), pin: undefined } : obs;
        results.push(await this.submissions.submit(clean, client.name));
      }
      return { result: { results }, n: results.length, paths: results.flatMap((r) => (r.path ? [r.path] : [])) };
    });
  }

  async status(client: Client, args: { keys?: unknown }) {
    return this.audited(client, "status", async () => {
      this.requireLocal(client, "status");
      const keys = Array.isArray(args.keys) ? args.keys.map((k) => cleanString(k, 200)).filter(Boolean) : [];
      const entries = await this.submissions.status(keys);
      const pending = await this.submissions.pending();
      return {
        result: {
          entries,
          pending: pending.map((p) => ({ key: p.key, summary: p.summary, reason: p.reason, submitted: p.submitted })),
        },
        n: keys.length,
      };
    });
  }

  async decide(client: Client, args: { key?: unknown; decision?: unknown }): Promise<SubmitResult> {
    return this.audited(client, "decide", async () => {
      this.requireLocal(client, "deciding");
      if (!client.owner) throw new GatewayError("forbidden", "only the owner's channel may decide reviews");
      const key = cleanString(args.key, 200);
      if (args.decision !== "approve" && args.decision !== "dismiss") {
        throw new GatewayError("bad-request", "decision must be approve or dismiss");
      }
      const result = await this.submissions.decide(key, args.decision);
      return { result, n: 1, paths: result.path ? [result.path] : [] };
    });
  }

  /** The latest changes to records, for the owner to look over. */
  async recent(client: Client, args: { limit?: unknown }) {
    return this.audited(client, "recent", async () => {
      this.requireLocal(client, "recent changes");
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : 15;
      const changes = await this.submissions.recent(limit);
      return { result: { changes }, n: changes.length };
    });
  }

  /** Take one change back (the owner, through a trusted channel). */
  async undo(client: Client, args: { key?: unknown }): Promise<SubmitResult> {
    return this.audited(client, "undo", async () => {
      this.requireLocal(client, "taking a change back");
      if (!client.owner) throw new GatewayError("forbidden", "only the owner's channel may take a change back");
      const result = await this.submissions.undo(cleanString(args.key, 200));
      return { result, n: 1, paths: result.path ? [result.path] : [] };
    });
  }

  async health(): Promise<Record<string, unknown>> {
    await this.scan();
    const records = await this.store.all();
    const byLevel: Record<string, number> = { shareable: 0, local: 0, sealed: 0 };
    for (const m of this.meta.values()) byLevel[m.level]!++;
    return {
      ok: true,
      notes: this.meta.size,
      byLevel,
      records: records.length,
      pendingReviews: (await this.submissions.pending()).length,
    };
  }
}

function snippetOf(body: string, query: string): string {
  const flat = body.replace(/\s+/g, " ");
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const lower = flat.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t);
    if (at >= 0) break;
  }
  const start = Math.max(0, at - 100);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 260).trim()}${flat.length > start + 260 ? "…" : ""}`;
}
