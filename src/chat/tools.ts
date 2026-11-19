import type { ActionProposal } from "../actions/framework";
import type { AgentRecord } from "../gateway/records";
import { auditRecords } from "./audit";
import type { ChatTool, ToolResult } from "./engine";

/**
 * What the chat can do with the vault. Reading goes through `readable`, the
 * one place that says which notes a local model may be shown; writing does
 * not exist — `propose_edit` builds a before/after for the owner and stops.
 */
export interface VaultAccess {
  /** Search by words and by meaning. */
  search(query: string, limit: number): Promise<Array<{ path: string; title: string; snippet: string }>>;
  /** A note's text, or undefined when there is no such note. */
  read(path: string): Promise<string | undefined>;
  /** May the local model be shown this note? */
  readable(path: string): { ok: true } | { ok: false; why: string };
  /** A name or a path as someone might write it → the note's path. */
  resolve(name: string): string | undefined;
  /** The agent's typed records. */
  records(): Promise<AgentRecord[]>;
  /** YYYY-MM-DD. */
  today(): string;
}

const WINDOW = 2400;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

function recordLine(r: AgentRecord): string {
  const when = r.start ? `${r.start}${r.end && r.end !== r.start ? ` → ${r.end}` : ""}` : "no date";
  const extra = ["trip", "provider", "with", "lodging", "carrier", "number", "from", "to", "price", "currency", "payee", "amount", "due"]
    .map((k) => (r.fields[k] !== undefined && r.fields[k] !== null && r.fields[k] !== "" ? `${k}=${String(r.fields[k])}` : ""))
    .filter(Boolean)
    .join(", ");
  return `${r.kind} | ${r.title} | ${when} | ${r.state}${r.place ? ` | ${r.place}` : ""}${extra ? ` | ${extra}` : ""} | ${r.path}`;
}

export function vaultTools(vault: VaultAccess): ChatTool[] {
  /** The path a tool was given, as a note that may be shown — or why not. */
  const open = (given: unknown): { path: string } | { error: string } => {
    const name = str(given);
    if (!name) return { error: "Give the note's path." };
    const path = vault.resolve(name);
    if (!path) return { error: `There is no note "${name.slice(0, 120)}". Use search to find its path.` };
    const may = vault.readable(path);
    if (!may.ok) return { error: `"${path}" is not shown to this chat: ${may.why}.` };
    return { path };
  };

  const search: ChatTool = {
    name: "search",
    description: "Find notes by words and by meaning. Returns paths with a short excerpt each; read a note before relying on it.",
    args: { query: "what to look for, in a few words" },
    async run(args): Promise<ToolResult> {
      const query = str(args.query);
      if (!query) return { text: "Give a query." };
      const found = await vault.search(query, 12);
      const hits = found.filter((h) => vault.readable(h.path).ok).slice(0, 8);
      // Notes that matched but may not be shown: said as a count and a reason, so the owner is not told "nothing".
      const reasons = new Map<string, number>();
      for (const h of found) {
        const may = vault.readable(h.path);
        if (!may.ok) reasons.set(may.why, (reasons.get(may.why) ?? 0) + 1);
      }
      const withheld = [...reasons].map(([why, n]) => `${n} matching note${n === 1 ? " is" : "s are"} not shown to this chat: ${why}.`).join(" ");
      if (hits.length === 0) return { text: `Nothing ${withheld ? "that may be shown was " : ""}found for "${query}".${withheld ? ` ${withheld} Tell the owner so.` : " Try other words."}` };
      return {
        text: `${hits.map((h) => `${h.path}\n  ${h.snippet.replace(/\s+/g, " ").slice(0, 220)}`).join("\n")}${withheld ? `\n(${withheld})` : ""}`,
        sources: hits.map((h) => h.path),
      };
    },
  };

  const read: ChatTool = {
    name: "read",
    description: "Read a note. Long notes come a part at a time.",
    args: { path: "the note's path", around: "(optional) words in the note to read around", from: "(optional) character position to continue from" },
    async run(args): Promise<ToolResult> {
      const got = open(args.path);
      if ("error" in got) return { text: got.error };
      const text = await vault.read(got.path);
      if (text === undefined) return { text: `There is no note "${got.path}".` };
      let start = Math.max(0, Math.floor(Number(args.from) || 0));
      const around = str(args.around);
      if (around) {
        const at = text.toLowerCase().indexOf(around.toLowerCase());
        if (at < 0) return { text: `"${around.slice(0, 80)}" does not occur in ${got.path}. It has ${text.length} characters; read it from the start.`, sources: [got.path] };
        start = Math.max(0, at - 600);
      }
      const part = text.slice(start, start + WINDOW);
      const more = start + WINDOW < text.length ? `\n[…${text.length - start - WINDOW} more characters: read again with from=${start + WINDOW}]` : "";
      return { text: `${got.path}${start > 0 ? ` (from character ${start})` : ""}:\n${part}${more}`, sources: [got.path] };
    },
  };

  const records: ChatTool = {
    name: "records",
    description: "List the agent's typed records (appointment, trip, conference, transport, stay, activity, bill, task, project, person), one line each with its path.",
    args: { kind: "(optional) one kind", from: "(optional) YYYY-MM-DD", to: "(optional) YYYY-MM-DD", state: "(optional) a state such as offered, confirmed, booked, cancelled", text: "(optional) words in the title or place" },
    async run(args): Promise<ToolResult> {
      const kind = str(args.kind).toLowerCase();
      const from = str(args.from);
      const to = str(args.to);
      const state = str(args.state).toLowerCase();
      const words = str(args.text).toLowerCase().split(/\s+/).filter(Boolean);
      const all = (await vault.records()).filter((r) => vault.readable(r.path).ok);
      const hits = all
        .filter((r) => !kind || r.kind === kind)
        .filter((r) => !state || r.state === state)
        .filter((r) => {
          if (!from && !to) return true;
          const s = (r.start ?? "").slice(0, 10);
          const e = (r.end ?? r.start ?? "").slice(0, 10);
          return !!s && (!to || s <= to) && (!from || e >= from);
        })
        .filter((r) => words.every((w) => `${r.title} ${r.place ?? ""} ${Object.values(r.fields).join(" ")}`.toLowerCase().includes(w)))
        .sort((a, b) => String(a.start ?? "").localeCompare(String(b.start ?? "")));
      if (hits.length === 0) return { text: `No records match (of ${all.length} on record).` };
      const shown = hits.slice(0, 40);
      return {
        text: `${hits.length} record${hits.length === 1 ? "" : "s"}${hits.length > shown.length ? `, the first ${shown.length} shown — narrow it by kind or dates` : ""}:\n${shown.map(recordLine).join("\n")}`,
        sources: shown.map((r) => r.path),
      };
    },
  };

  const check: ChatTool = {
    name: "check_records",
    description: "Check the agent's records by plain rules for things that cannot all be right: an end before a start, the same thing twice, two stays on one night, something still open after its date, a trip that is not on record.",
    args: { kind: "(optional) only this kind" },
    async run(args): Promise<ToolResult> {
      const kind = str(args.kind).toLowerCase();
      const all = (await vault.records()).filter((r) => vault.readable(r.path).ok);
      const issues = auditRecords(all, vault.today()).filter((i) => !kind || all.some((r) => r.kind === kind && i.paths.includes(r.path)));
      if (issues.length === 0) return { text: `The rules found nothing wrong in ${all.length} records. That is not proof that they are right — only that these rules are satisfied.` };
      const shown = issues.slice(0, 30);
      return {
        text: `${issues.length} thing${issues.length === 1 ? "" : "s"} to look at${issues.length > shown.length ? ` (the first ${shown.length})` : ""}:\n${shown.map((i) => `- ${i.rule}: ${i.detail}\n  ${i.paths.join(" ; ")}`).join("\n")}`,
        sources: [...new Set(shown.flatMap((i) => i.paths))],
      };
    },
  };

  const propose: ChatTool = {
    name: "propose_edit",
    description: "Propose a correction to a note, for the owner to apply or not. It changes nothing by itself.",
    args: {
      path: "the note's path",
      find: "the existing text to replace, copied exactly from the note (enough of it to occur only once)",
      replace: "the text to put in its place",
      reason: "one sentence: why, and which note says so",
    },
    async run(args): Promise<ToolResult> {
      const got = open(args.path);
      if ("error" in got) return { text: got.error };
      const find = typeof args.find === "string" ? args.find : "";
      const replace = typeof args.replace === "string" ? args.replace : "";
      if (!find.trim()) return { text: "Give the existing text to replace, copied exactly from the note." };
      if (find === replace) return { text: "The replacement is the same as the existing text." };
      const before = await vault.read(got.path);
      if (before === undefined) return { text: `There is no note "${got.path}".` };
      const count = before.split(find).length - 1;
      if (count === 0) return { text: `That text does not occur in ${got.path} exactly as given. Read the note again and copy the text exactly, including punctuation and spacing.`, sources: [got.path] };
      if (count > 1) return { text: `That text occurs ${count} times in ${got.path}. Give more of the surrounding text so that it occurs once.`, sources: [got.path] };
      const after = before.replace(find, () => replace);
      const reason = str(args.reason).slice(0, 300);
      const proposal: ActionProposal = {
        title: `Edit ${got.path.split("/").pop()?.replace(/\.md$/, "") ?? got.path}`,
        description: reason || undefined,
        changes: [{ type: "modify", path: got.path, before, after }],
      };
      return { text: `Proposed, not applied: the owner will see the before and after of ${got.path} and decide.`, sources: [got.path], proposal };
    },
  };

  return [search, read, records, check, propose];
}
