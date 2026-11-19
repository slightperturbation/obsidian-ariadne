import type { ActionProposal } from "../actions/framework";
import type { AgentRecord } from "../gateway/records";
import { auditRecords } from "./audit";
import { compareWithNote } from "./compare";
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
  /** Every note: where it is, when it was last changed, and its tags (without "#"). */
  notes(): Array<{ path: string; mtime: number; tags: string[] }>;
  /** Show a note to the owner in the editor. Nothing of it is handed back. */
  open(path: string): Promise<void>;
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

  const day = (ms: number): string => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const list: ChatTool = {
    name: "list",
    description: "List notes by where they are, by tag, or by when they were last changed — newest first. With no arguments: the folders of the vault and how many notes each holds.",
    args: { folder: "(optional) a folder path, such as Projects/Ariadne", tag: "(optional) a tag, with or without #", since: "(optional) YYYY-MM-DD: changed on or after this day", name: "(optional) words in the note's name" },
    async run(args): Promise<ToolResult> {
      const folder = str(args.folder).replace(/^\/+|\/+$/g, "");
      const tag = str(args.tag).replace(/^#/, "").toLowerCase();
      const since = str(args.since);
      const words = str(args.name).toLowerCase().split(/\s+/).filter(Boolean);
      const all = vault.notes();
      if (!folder && !tag && !since && words.length === 0) {
        // Where things are: each folder, two levels deep, with the number of notes under it.
        const counts = new Map<string, number>();
        for (const n of all) {
          const parts = n.path.split("/");
          const top = parts.length > 1 ? parts[0]! : "(vault root)";
          counts.set(top, (counts.get(top) ?? 0) + 1);
          if (parts.length > 2) counts.set(`${parts[0]}/${parts[1]}`, (counts.get(`${parts[0]}/${parts[1]}`) ?? 0) + 1);
        }
        const lines = [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([f, n]) => `${f.includes("/") ? "  " : ""}${f} — ${n} note${n === 1 ? "" : "s"}`);
        return { text: `${all.length} notes in all. Folders:\n${lines.slice(0, 80).join("\n")}` };
      }
      const lowerFolder = folder.toLowerCase();
      const matched = all
        .filter((n) => !folder || n.path.toLowerCase().startsWith(`${lowerFolder}/`))
        .filter((n) => !tag || n.tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(`${tag}/`)))
        .filter((n) => !since || day(n.mtime) >= since)
        .filter((n) => words.every((w) => (n.path.split("/").pop() ?? "").toLowerCase().includes(w)));
      if (matched.length === 0) {
        const known = folder && !all.some((n) => n.path.toLowerCase().startsWith(`${lowerFolder}/`));
        return { text: known ? `There is no folder "${folder}" with notes in it. Call list with no arguments to see the folders.` : "No notes match." };
      }
      const shown = matched.filter((n) => vault.readable(n.path).ok).sort((a, b) => b.mtime - a.mtime);
      const withheld = matched.length - shown.length;
      const top = shown.slice(0, 40);
      const note = withheld ? `\n(${withheld} more match but are not shown to this chat.)` : "";
      if (top.length === 0) return { text: `${withheld} note${withheld === 1 ? " matches but is" : "s match but are"} not shown to this chat. Tell the owner so.` };
      return {
        text: `${shown.length} note${shown.length === 1 ? "" : "s"}${shown.length > top.length ? `, the ${top.length} most recently changed shown` : ""} (last changed · path):\n${top.map((n) => `${day(n.mtime)} · ${n.path}`).join("\n")}${note}`,
        sources: top.map((n) => n.path),
      };
    },
  };

  const openNote: ChatTool = {
    name: "open",
    description: "Open a note in the editor for the owner to see. Use it when they ask to open, show or go to a note. It does not read the note to you.",
    args: { path: "the note's path or name" },
    async run(args): Promise<ToolResult> {
      const name = str(args.path);
      if (!name) return { text: "Give the note's path or name." };
      const path = vault.resolve(name);
      if (!path) return { text: `There is no note "${name.slice(0, 120)}". Use search or list to find its path.` };
      await vault.open(path);
      // The owner sees their own note; whether this chat may be shown its text is another matter.
      return vault.readable(path).ok ? { text: `Opened ${path} in the editor.`, sources: [path] } : { text: `Opened ${path} in the editor. Its text is not shown to this chat.` };
    },
  };

  /** A record's source note: the note its `hub` field links, when that note may be shown. */
  const hubOf = (r: AgentRecord): string | undefined => {
    const hub = typeof r.fields.hub === "string" ? r.fields.hub : "";
    const path = hub ? vault.resolve(hub) : undefined;
    return path && vault.readable(path).ok ? path : undefined;
  };

  const compare: ChatTool = {
    name: "compare_with_note",
    description:
      "Set the agent's records beside the lines of your own note they were made from, field by field, by plain rules: time, day, price, whether it is booked or paid, and lines that are no longer in the note. Give a record's path for one in full, or nothing (or a trip's name) for every record that differs.",
    args: { path: "(optional) one record's path", trip: "(optional) only records of this trip" },
    async run(args): Promise<ToolResult> {
      const all = (await vault.records()).filter((r) => vault.readable(r.path).ok);
      const given = str(args.path);
      const trip = str(args.trip).toLowerCase();
      const one = given ? all.find((r) => r.path === (vault.resolve(given) ?? given)) : undefined;
      if (given && !one) return { text: `"${given.slice(0, 120)}" is not one of the agent's records. Use records to find its path.` };
      const chosen = one ? [one] : all.filter((r) => !trip || String(r.fields.trip ?? r.title).toLowerCase().includes(trip));
      const texts = new Map<string, string | undefined>();
      const lines: string[] = [];
      const sources = new Set<string>();
      let compared = 0;
      let differing = 0;
      for (const r of chosen) {
        const hub = hubOf(r);
        if (!hub || !String(r.fields.notes ?? "").trim()) {
          if (one) lines.push(`${r.path} was not made from a note of yours (or the note may not be shown), so there is nothing to set it beside.`);
          continue;
        }
        if (!texts.has(hub)) texts.set(hub, await vault.read(hub));
        const note = texts.get(hub);
        if (note === undefined) continue;
        compared++;
        const c = compareWithNote(r, note);
        if (c.findings.length === 0 && !one) continue;
        if (c.findings.length > 0) differing++;
        if (differing > 25 && !one) continue;
        sources.add(r.path);
        sources.add(hub);
        lines.push(
          [
            `${r.kind} "${r.title}" — ${r.path}`,
            `  record: start ${r.start ?? "—"}${r.end ? `, end ${r.end}` : ""}, state ${r.state}${typeof r.fields.price === "number" ? `, price ${r.fields.price}` : ""}`,
            `  your note (${hub}): ${c.passage.length ? c.passage.map((p) => `"${p.slice(0, 160)}"`).join(" / ") : "its lines were not found"}`,
            ...(c.findings.length ? c.findings.map((f) => `  DIFFERS — ${f.field}: the record says ${f.record}; the note says ${f.note}`) : ["  agrees on time, day, price and standing, as far as these rules can tell"]),
          ].join("\n"),
        );
      }
      if (one) return { text: lines.join("\n") || "Nothing to compare.", sources: [...sources] };
      if (compared === 0) return { text: "None of these records was made from a note of yours, so there is nothing to set them beside." };
      if (differing === 0) return { text: `${compared} record${compared === 1 ? "" : "s"} made from your notes were compared; none differs from its lines on time, day, price or standing. These rules do not read meaning: a wrong place or a wrong name would not be caught.` };
      return {
        text: `${compared} records compared with the notes they were made from; ${differing} differ${differing > 25 ? " (the first 25 shown)" : ""}. The note is the owner's word — but it may be the note that is out of date; say what differs and ask before proposing which to change.\n\n${lines.join("\n\n")}`,
        sources: [...sources],
      };
    },
  };

  return [search, list, read, openNote, records, check, compare, propose];
}
