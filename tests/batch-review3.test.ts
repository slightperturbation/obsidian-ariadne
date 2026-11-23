/**
 * The third review of batch jobs: one test (or more) per finding, numbered
 * as in the review.
 */
import { describe, expect, it } from "vitest";
import { ActionExecutor, type FileChange, type VaultIO } from "../src/actions/framework";
import type { JobSpec } from "../src/chat/engine";
import { splitFront } from "../src/chat/frontmatter";
import { vaultTools, type VaultAccess } from "../src/chat/tools";
import { overlayVault } from "../src/batch/overlay";
import { memoryBatchStore } from "../src/batch/record";
import { BatchRunner, authoredByModel, holdReason, kept } from "../src/batch/runner";

const journal = (p: string) => p.toLowerCase().startsWith("journal/");
/** 0 shareable, 1 local-only, 2 journal, 3 sealed. A note's own `agent-access: local` counts where it is. */
function world(initial: Record<string, string>, opts: { journalOn?: boolean } = {}) {
  const files = new Map(Object.entries(initial));
  const io: VaultIO = {
    exists: async (p) => files.has(p),
    read: async (p) => files.get(p) ?? Promise.reject(new Error(`not found: ${p}`)),
    create: async (p, c) => {
      if (files.has(p)) throw new Error("exists");
      files.set(p, c);
    },
    modify: async (p, c) => void files.set(p, c),
    delete: async (p) => void files.delete(p),
    rename: async (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
  };
  const own = (note: string) => (note && /agent-access: local/.test(files.get(note) ?? "") ? 1 : 0);
  const rankAt = (note: string, at: string) => {
    const folder = at.startsWith("Sealed/") ? 3 : at.startsWith("Private/") ? 1 : 0;
    const r = Math.max(folder, own(note));
    return journal(at) ? Math.max(r, 2) : r;
  };
  const vault: VaultAccess = {
    search: async () => [],
    read: async (p) => files.get(p),
    readable: (p) => (p.startsWith("Sealed/") ? { ok: false, why: "sealed" } : journal(p) && !opts.journalOn ? { ok: false, why: "journal off" } : { ok: true }),
    resolve: (n) => [n, `${n}.md`].find((p) => files.has(p)),
    notes: () => [...files.keys()].map((path) => ({ path, mtime: 0, tags: [] })),
    open: async () => {},
    exists: (p) => files.has(p),
    writable: (p) => (p.startsWith("Sealed/") ? { ok: false, why: "sealed" } : journal(p) ? { ok: false, why: "journal" } : { ok: true }),
    levelAt: (note, at) => (at.startsWith("Sealed/") ? "sealed" : at.startsWith("Private/") || own(note) ? "local" : "shareable"),
    rankAt,
    linksTo: (p) => [...files].filter(([q, t]) => q !== p && t.includes(`[[${p.replace(/\.md$/, "").split("/").pop()}`)).map(([q]) => q),
    modelName: () => "m",
    today: () => "2026-11-23",
  };
  return { files, io, vault, rankAt, executor: new ActionExecutor(io), store: memoryBatchStore() };
}
const tool = (vault: VaultAccess, note: string, name: string, original?: string) =>
  vaultTools(overlayVault(vault, { journal, main: note }).vault, { mode: "batch", note: () => note, original: original === undefined ? undefined : () => original }).find((t) => t.name === name)!;

describe("1. the properties fences are read exactly as Obsidian reads them", () => {
  it("a space after the opening --- is no properties at all — so an edit that adds one is held and refused", async () => {
    expect(splitFront("--- \nagent-access: local\n---\nx")).toBeNull();
    expect(splitFront("---\nagent-access: local\n----\nx")?.lines).toEqual(["agent-access: local"]);
    const before = "---\nagent-access: local\n---\nBody text here.";
    const after = "--- \nagent-access: local\n---\nBody text here.";
    expect(holdReason([{ type: "modify", path: "a.md", before, after }], { main: "a.md", allowShrink: true, isJournal: journal })).toMatch(/agent-access/);
    const w = world({ "a.md": before });
    expect((await tool(w.vault, "a.md", "propose_edit").run({ path: "a.md", find: "---\nagent-access", replace: "--- \nagent-access" })).proposal).toBeUndefined();
    expect((await tool(w.vault, "a.md", "rewrite", before).run({ text: after })).proposal).toBeUndefined();
  });
});

describe("2. a new note never takes the place of the note being moved, trashed or merged", () => {
  it("holds a create at a path an existing note held when the step began", () => {
    const w = world({ "Notes/a.md": "---\nagent-access: local\n---\nWords." });
    const ctx = { main: "Notes/a.md", allowShrink: false, isJournal: journal, rank: w.rankAt };
    const trashThenCreate: FileChange[] = [
      { type: "delete", path: "Notes/a.md", before: "---\nagent-access: local\n---\nWords." },
      { type: "create", path: "Notes/a.md", after: "Words." },
    ];
    expect(holdReason(trashThenCreate, ctx)).toMatch(/take the place of Notes\/a\.md|does not appear whole|less private/);
    const moveThenCreate: FileChange[] = [
      { type: "move", path: "Notes/a.md", to: "Private/a.md" },
      { type: "create", path: "Notes/a.md", after: "Words." },
    ];
    expect(holdReason(moveThenCreate, ctx)).toMatch(/take the place of Notes\/a\.md/);
  });

  it("ranks a new note by its folder alone, not by the note at that path now", async () => {
    const w = world({ "Notes/a.md": "---\nagent-access: local\n---\nWords." });
    // The agent's own note is local-only by its property; a new note beside it in Notes/ would be shareable.
    const r = await tool(w.vault, "Notes/a.md", "propose_note").run({ path: "Notes/b.md", content: "A copy of the private words here." });
    expect(r.proposal).toBeUndefined();
    expect(r.text).toMatch(/may not be less private/);
  });
});

describe("3. journal text stays in the journal: the journal ranks above local-only", () => {
  it("a local-only note's agent is not shown journal entries, and a journal entry's agent writes no new note outside", async () => {
    const w = world({ "Private/p.md": "p", "Journal/2026-11-01.md": "entry words" }, { journalOn: true });
    expect((await tool(w.vault, "Private/p.md", "read").run({ path: "Journal/2026-11-01.md" })).text).toMatch(/not shown/);
    expect((await tool(w.vault, "Journal/2026-11-01.md", "propose_note").run({ path: "Private/Themes.md", content: "Themes from the journal entry here." })).proposal).toBeUndefined();
    expect(holdReason([{ type: "create", path: "Private/Themes.md", after: "entry words" }], { main: "Journal/2026-11-01.md", allowShrink: false, isJournal: journal, rank: w.rankAt })).toMatch(/less private/);
  });
});

describe("4. a merge's heading never goes into links in less private notes", () => {
  it("points a less private note's links at the target without the heading — and holds one that carries it", async () => {
    const w = world({ "Private/a.md": "The result came back.", "Private/log.md": "# Log\n", "Public/index.md": "See [[a]]." });
    const r = await tool(w.vault, "Private/a.md", "merge_into").run({ target: "Private/log.md", heading: "Biopsy result came back positive" });
    const index = r.proposal!.changes.find((c) => c.path === "Public/index.md")!;
    expect(index.after).toBe("See [[Private/log|a]].");
    const ctx = { main: "Private/a.md", allowShrink: false, isJournal: journal, rank: w.rankAt };
    expect(holdReason(r.proposal!.changes, ctx)).toBeUndefined();
    const leaky = r.proposal!.changes.map((c) => (c.path === "Public/index.md" ? { ...c, after: "See [[Private/log#Biopsy result came back positive|a]]." } : c));
    expect(holdReason(leaky, ctx)).toMatch(/would carry a heading/);
  });
});

describe("5. the auto-tagger is told before a note is written", () => {
  it("hears of every path a step will write before the first write lands", async () => {
    const w = world({ "a.md": "a" });
    const order: string[] = [];
    const io: VaultIO = { ...w.io, modify: async (p, c) => (order.push(`write ${p}`), w.io.modify(p, c)) };
    const runner = new BatchRunner({
      executor: new ActionExecutor(io),
      store: w.store,
      onTouch: (paths) => order.push(`touch ${paths.join(",")}`),
      work: async () => ({ summary: "", changes: [{ type: "modify", path: "a.md", before: "a", after: "a!" }, { type: "move", path: "a.md", to: "B/a.md" }], findings: [] }),
    });
    const spec: JobSpec = { instruction: "Do it to each.", selection: "", paths: ["a.md"], leftOut: [], allowShrink: false };
    await runner.run((await runner.create(spec, "m")).job.id);
    expect(order).toEqual(["touch a.md,B/a.md", "write a.md"]);
  });
});

describe("8. the low ones", () => {
  it("knows authorship: agent and lists of marks as a model's", () => {
    expect(authoredByModel("---\nauthorship: agent\n---\nx")).toBe(true);
    expect(authoredByModel("---\nauthorship: [ai-generated]\n---\nx")).toBe(true);
    expect(authoredByModel("---\nauthorship: owner\n---\nx")).toBe(false);
    expect(holdReason([{ type: "move", path: "Notes/s.md", to: "Journal/s.md" }], { main: "Notes/s.md", allowShrink: false, isJournal: journal, known: new Map([["Notes/s.md", "---\nauthorship: agent\n---\nx"]]) })).toMatch(/written by a model/);
  });

  it("lets the agent go on seeing its own note after moving it somewhere more private", async () => {
    const w = world({ "Notes/a.md": "mine" });
    const o = overlayVault(w.vault, { journal, main: "Notes/a.md" });
    o.record([{ type: "move", path: "Notes/a.md", to: "Private/a.md" }]);
    expect(o.vault.readable("Private/a.md")).toEqual({ ok: true });
  });

  it("does not take a long note with modest edits for a rewrite", () => {
    const words = Array.from({ length: 20000 }, (_, i) => `w${i}`);
    const edited = words.map((x, i) => (i % 5 === 0 ? `${x}x` : x));
    expect(kept(words.join(" "), edited.join(" "))).toBeCloseTo(0.8, 3);
  });
});
