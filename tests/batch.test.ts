/**
 * Batch jobs: one instruction, a fresh model context per note, changes made
 * as it goes — and nothing a vault cannot get back. The model is a script;
 * the vault is a Map shared by the tools (what the agent sees) and the
 * executor (what is written).
 */
import { describe, expect, it } from "vitest";
import { ActionExecutor, type FileChange, type VaultIO } from "../src/actions/framework";
import type { JobSpec } from "../src/chat/engine";
import { relink, vaultTools, type VaultAccess } from "../src/chat/tools";
import { editProperty } from "../src/chat/tag-edit";
import { overlayVault } from "../src/batch/overlay";
import { inverseOf, memoryBatchStore, tally } from "../src/batch/record";
import { BatchRunner, holdReason, saysDone, saysLeft, workOnNote, type AgentResult } from "../src/batch/runner";
import { dateInName, selectNotes } from "../src/batch/select";

function world(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const io: VaultIO = {
    exists: async (p) => files.has(p),
    read: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`not found: ${p}`);
      return v;
    },
    create: async (p, c) => {
      if (files.has(p)) throw new Error(`exists: ${p}`);
      files.set(p, c);
    },
    modify: async (p, c) => {
      if (!files.has(p)) throw new Error(`not found: ${p}`);
      files.set(p, c);
    },
    delete: async (p) => {
      if (!files.delete(p)) throw new Error(`not found: ${p}`);
    },
    rename: async (a, b) => {
      const v = files.get(a);
      if (v === undefined) throw new Error(`not found: ${a}`);
      if (files.has(b)) throw new Error(`exists: ${b}`);
      files.delete(a);
      files.set(b, v);
    },
  };
  const journal = (p: string) => p.startsWith("Journal/");
  const vault: VaultAccess = {
    search: async () => [],
    read: async (p) => files.get(p),
    readable: (p) => (p.startsWith("Sealed/") ? { ok: false, why: "it is sealed" } : { ok: true }),
    resolve: (name) => [name, `${name}.md`].find((p) => files.has(p)),
    notes: () => [...files.keys()].map((path) => ({ path, mtime: 0, tags: [] })),
    open: async () => {},
    exists: (p) => files.has(p),
    writable: (p) => (p.startsWith("Sealed/") ? { ok: false, why: "that folder is sealed" } : journal(p) ? { ok: false, why: "that is where your journal lives" } : { ok: true }),
    levelAt: (_n, at) => (at.startsWith("Sealed/") ? "sealed" : at.startsWith("Private/") || journal(at) ? "local" : "shareable"),
    linksTo: (p) => [...files].filter(([q, t]) => q !== p && t.includes(`[[${p.replace(/\.md$/, "").split("/").pop()}`)).map(([q]) => q),
    modelName: () => "test-model",
    today: () => "2026-11-22",
  };
  const executor = new ActionExecutor(io);
  const store = memoryBatchStore();
  return { files, io, vault, executor, store, journal };
}

/** A model that takes the given steps, one per call, then answers. */
function script(steps: unknown[]) {
  let i = 0;
  return async () => JSON.stringify(steps[Math.min(i++, steps.length - 1)]);
}

const MAIN = "a.md";
const spec = (paths: string[], instruction = "Tidy each note.", allowShrink = false): JobSpec => ({ instruction, selection: `${paths.length} notes`, paths, leftOut: [], allowShrink });

describe("holdReason: no change that loses text is made without asking", () => {
  const long = "word ".repeat(100);
  it("holds a note cut by more than a third, or emptied — unless the job allows cutting", () => {
    expect(holdReason([{ type: "modify", path: "a.md", before: long, after: long.slice(0, 200) }], { main: MAIN, allowShrink: false, isJournal: (p: string) => p.startsWith("Journal/") })).toBe("it would keep only 40% of the words of a.md");
    expect(holdReason([{ type: "modify", path: "a.md", before: long, after: long.slice(0, 200) }], { main: MAIN, allowShrink: true, isJournal: (p: string) => p.startsWith("Journal/") })).toBeUndefined();
    expect(holdReason([{ type: "modify", path: "a.md", before: "short note", after: "   " }], { main: MAIN, allowShrink: true, isJournal: (p: string) => p.startsWith("Journal/") })).toBe("it would empty a.md");
    expect(holdReason([{ type: "modify", path: "a.md", before: long, after: `${long} more` }], { main: MAIN, allowShrink: false, isJournal: (p: string) => p.startsWith("Journal/") })).toBeUndefined();
  });

  it("lets a merge delete a note only when its words appear whole in what was written", () => {
    const merged: FileChange[] = [
      { type: "modify", path: "J.md", before: "# J\n", after: "# J\n\n## A\n\nThe whole of A.\n" },
      { type: "delete", path: "A.md", before: "---\ntags: [x]\n---\nThe whole of A.\n" },
    ];
    expect(holdReason(merged, { main: "A.md", allowShrink: false, isJournal: (p: string) => p.startsWith("Journal/") })).toBeUndefined();
    const lossy: FileChange[] = [
      { type: "modify", path: "J.md", before: "# J\n", after: "# J\n\n## A\n\nThe whole of\n" },
      { type: "delete", path: "A.md", before: "The whole of A.\n" },
    ];
    expect(holdReason(lossy, { main: "A.md", allowShrink: false, isJournal: (p: string) => p.startsWith("Journal/") })).toMatch(/does not appear whole/);
    expect(holdReason([{ type: "delete", path: "A.md", before: "x" }], { main: "A.md", allowShrink: false, isJournal: (p: string) => p.startsWith("Journal/") })).toBeUndefined();
  });
});

describe("inverseOf", () => {
  it("reverses a list of changes, newest first, and refuses a delete it could not put back", () => {
    expect(
      inverseOf([
        { type: "modify", path: "a.md", before: "1", after: "2" },
        { type: "move", path: "a.md", to: "B/a.md" },
        { type: "delete", path: "c.md", before: "gone" },
      ]),
    ).toEqual([
      { type: "create", path: "c.md", after: "gone" },
      { type: "move", path: "B/a.md", to: "a.md" },
      { type: "modify", path: "a.md", before: "2", after: "1" },
    ]);
    expect(() => inverseOf([{ type: "delete", path: "c.md" }])).toThrow(/cannot be undone/);
  });
});

describe("the overlay: one note's agent sees its own earlier steps", () => {
  it("reads an edited note's new text, finds a moved note at its new path, and nothing at the old", async () => {
    const w = world({ "Inbox/a.md": "one" });
    const o = overlayVault(w.vault, { journal: w.journal });
    o.record([{ type: "modify", path: "Inbox/a.md", before: "one", after: "two" }]);
    o.record([{ type: "move", path: "Inbox/a.md", to: "Done/a.md" }]);
    expect(await o.vault.read("Done/a.md")).toBe("two");
    expect(o.vault.exists("Inbox/a.md")).toBe(false);
    expect(o.vault.resolve("Done/a")).toBe("Done/a.md");
    // The real vault is untouched until the runner applies the list.
    expect(w.files.get("Inbox/a.md")).toBe("one");
    const moved = overlayVault(w.vault, { journal: w.journal });
    moved.record([{ type: "move", path: "Inbox/a.md", to: "Done/a.md" }]);
    expect(await moved.vault.read("Done/a.md")).toBe("one");
  });

  it("lets a batch put the owner's notes into the journal, never into what is sealed", () => {
    const w = world({});
    const o = overlayVault(w.vault, { journal: (p) => p.startsWith("Journal/") || p.startsWith("Sealed/") });
    expect(o.vault.writable("Journal/2026-11-22.md")).toEqual({ ok: true });
    expect(o.vault.writable("Sealed/x.md").ok).toBe(false);
  });
});

describe("workOnNote: a fresh context for one note", () => {
  it("edits, retags and moves a note in one go, each step seeing the last, and says what it did", async () => {
    const w = world({ "Inbox/idea.md": "# Idea\n\nTeh garden plan.\n" });
    const r = await workOnNote("Inbox/idea.md", { instruction: "Fix typos, tag it #garden, file it in Areas/Home." }, {
      vault: w.vault,
      isJournal: w.journal,
      today: () => "2026-11-22",
      complete: script([
        { applies: true, why: "it is an idea note with a typo" },
        { tool: "propose_edit", args: { path: "Inbox/idea.md", find: "Teh", replace: "The" } },
        { tool: "propose_moves", args: { moves: [{ path: "Inbox/idea.md", folder: "Areas/Home" }], add: ["garden"], new_folder: true } },
        { tool: "answer", answer: "Changed: fixed a typo, tagged #garden, filed under Areas/Home." },
      ]),
    });
    expect(r.failed).toBeUndefined();
    expect(r.summary).toBe("fixed a typo, tagged #garden, filed under Areas/Home.");
    expect(r.changes.map((c) => [c.type, c.path, c.to])).toEqual([
      ["modify", "Inbox/idea.md", undefined],
      ["modify", "Inbox/idea.md", undefined],
      ["move", "Inbox/idea.md", "Areas/Home/idea.md"],
    ]);
    // Nothing written yet; applied as one, the result is what the steps said.
    expect(w.files.get("Inbox/idea.md")).toBe("# Idea\n\nTeh garden plan.\n");
    await w.executor.applyRaw(r.changes);
    expect(Object.fromEntries(w.files)).toEqual({ "Areas/Home/idea.md": "---\ntags:\n  - garden\n---\n# Idea\n\nThe garden plan.\n" });
  });

  it("applies nothing when the model cannot be reached or does not answer usably", async () => {
    const w = world({ "a.md": "text" });
    const down = await workOnNote("a.md", { instruction: "Do it." }, { vault: w.vault, isJournal: w.journal, today: () => "", complete: async () => Promise.reject(new Error("offline")) });
    expect(down.failed).toMatch(/could not be reached/);
    expect(down.changes).toEqual([]);
    const garbled = await workOnNote("a.md", { instruction: "Do it." }, { vault: w.vault, isJournal: w.journal, today: () => "", complete: async () => "not json" });
    expect(garbled.failed).toBeDefined();
  });

  it("is never handed a note the chat may not be shown", async () => {
    const w = world({ "Sealed/x.md": "secret" });
    const r = await workOnNote("Sealed/x.md", { instruction: "Do it." }, { vault: w.vault, isJournal: w.journal, today: () => "", complete: script([{ applies: true, why: "x" }, { tool: "answer", answer: "x" }]) });
    expect(r.failed).toMatch(/sealed/);
  });

  it("asks first whether the instruction applies, and offers no tool at all when it does not", async () => {
    const w = world({ "a.md": "A quiet evening at home." });
    const prompts: string[] = [];
    const r = await workOnNote("a.md", { instruction: "If it is a meeting log, tag it meeting." }, {
      vault: w.vault, isJournal: w.journal, today: () => "",
      complete: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ applies: false, why: "it is personal writing, not a meeting log" });
      },
    });
    expect(r).toEqual({ summary: "it is personal writing, not a meeting log", changes: [], findings: [], startText: "A quiet evening at home." });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain("propose_tags");
  });

  it("keeps back changes the model's own report contradicts, and changes it ran out of steps on", async () => {
    const w = world({ "a.md": "A quiet evening." });
    const contradicted = await workOnNote("a.md", { instruction: "Tag meetings." }, {
      vault: w.vault, isJournal: w.journal, today: () => "",
      complete: script([{ applies: true, why: "maybe" }, { tool: "propose_tags", args: { add: ["meeting"] } }, { tool: "answer", answer: "This note should be left as it is." }]),
    });
    expect(contradicted.hold).toBe("the model said it left this note, but it had changed it");
    expect(contradicted.changes).toHaveLength(1);
    for (const line of ["Left: personal.", "I left the note unchanged.", "No changes needed.", "It should be left as it is.", "The instruction does not apply."]) expect(saysLeft(line)).toBe(true);
    for (const line of ["Changed: tagged #meeting.", "Tagged it and moved it to Work."]) expect(saysLeft(line)).toBe(false);

    // Out of steps: what it started is kept back, and the report says why in plain words.
    const unfinished = await workOnNote("a.md", { instruction: "Tag meetings." }, {
      vault: w.vault, isJournal: w.journal, today: () => "",
      complete: script([{ applies: true, why: "maybe" }, { tool: "propose_tags", args: { add: ["meeting"] } }, ...Array.from({ length: 9 }, (_, i) => ({ tool: "search", args: { query: `q${i}` } }))]),
    });
    expect(unfinished.summary).toBe("");
    expect(unfinished.hold).toBe("the model used all 10 of its steps on this note before it had finished, so nothing it started is done");
    expect(unfinished.changes).toHaveLength(1);
  });

  it("does not file a note into a folder that does not exist — it points the model at merge_into — unless asked to make one", async () => {
    const w = world({ "Weekly/2024-W44.md": "A week.", "Days/2024-11-01.md": "Friday." });
    const r = await workOnNote("Weekly/2024-W44.md", { instruction: "Move it into the day's journal note." }, {
      vault: w.vault, isJournal: () => false, today: () => "",
      complete: script([
        { applies: true, why: "yes" },
        { tool: "propose_moves", args: { moves: [{ path: "Weekly/2024-W44.md", folder: "Days/2024-11-03" }] } },
        { tool: "merge_into", args: { target: "Days/2024-11-03.md" } },
        { tool: "answer", answer: "Changed: moved it to Days/2024-11-03.md." },
      ]),
    });
    expect(r.changes).toEqual([{ type: "move", path: "Weekly/2024-W44.md", to: "Days/2024-11-03.md" }]);
    expect(r.trace?.[0]).toMatch(/^propose_moves/);
    expect(r.trace?.[1]).toMatch(/^merge_into/);
  });

  it("reads a step named under another key, and says plainly when replies cannot be read", async () => {
    const w = world({ "a.md": "text" });
    const r = await workOnNote("a.md", { instruction: "Tag it x." }, {
      vault: w.vault, isJournal: w.journal, today: () => "",
      complete: script([{ applies: true, why: "yes" }, { type: "propose_tags", args: { add: ["x"] } }, { tool: "answer", answer: "Changed: tagged it." }]),
    });
    expect(r.changes).toHaveLength(1);
    const garbled = await workOnNote("a.md", { instruction: "Tag it x." }, {
      vault: w.vault, isJournal: w.journal, today: () => "",
      complete: script([{ applies: true, why: "yes" }, { nothing: 1 }, { nothing: 2 }]),
    });
    expect(garbled.summary).toBe("");
    expect(garbled.failed).toBe("the model's replies could not be read, twice in a row, so nothing was done to this note — it is tried again on the next run");
  });

  it("does not report a change the model only said it made", async () => {
    const w = world({ "a.md": "A quiet evening." });
    const r = await workOnNote("a.md", { instruction: "Move it to Journal." }, {
      vault: w.vault, isJournal: w.journal, today: () => "",
      complete: script([{ applies: true, why: "yes" }, { tool: "answer", answer: "Moved a.md to Journal/2025-04-27." }]),
    });
    expect(r.changes).toEqual([]);
    expect(r.failed).toMatch(/^the model said "Moved a\.md to Journal\/2025-04-27\.", but it made no change/);
    for (const line of ["Changed: tagged it.", "Moved it to X.", "The note has been moved to X.", "I tagged it."]) expect(saysDone(line)).toBe(true);
    for (const line of ["Left: personal.", "Nothing to do here.", "Already tagged."]) expect(saysDone(line)).toBe(false);
  });

  it("records findings for the report", async () => {
    const w = world({ "a.md": "Deadline 3 Dec." });
    const r = await workOnNote("a.md", { instruction: "Find any deadline." }, {
      vault: w.vault, isJournal: w.journal, today: () => "",
      complete: script([{ applies: true, why: "it has a deadline" }, { tool: "finding", args: { text: "Deadline: 3 Dec" } }, { tool: "answer", answer: "Changed: found a deadline." }]),
    });
    expect(r.findings).toEqual(["Deadline: 3 Dec"]);
    expect(r.changes).toEqual([]);
  });
});

describe("batch tools", () => {
  const tools = (vault: VaultAccess, note: string) => vaultTools(vault, { mode: "batch", note: () => note });
  const tool = (vault: VaultAccess, note: string, name: string) => tools(vault, note).find((t) => t.name === name)!;

  it("has no editor, no web and no batch-starting in a batch; adds rewrite, properties, merge, trash and findings", () => {
    const w = world({});
    expect(tools(w.vault, "a.md").map((t) => t.name)).toEqual(["search", "list", "read", "tags", "propose_edit", "propose_note", "propose_moves", "propose_tags", "rewrite", "set_property", "merge_into", "trash", "finding"]);
  });

  it("merges a note into another word for word, points links at its section, and trashes it", async () => {
    const w = world({
      "Daily/2024-05-19.md": "---\ntags: [daily]\n---\nWalked by the river.\n",
      "Journal/2024-05-19.md": "# Sunday\n\nEarlier thoughts.\n",
      "Trips.md": "See [[2024-05-19]] and [[2024-05-19|that day]].",
    });
    const r = await tool(overlayVault(w.vault, { journal: w.journal }).vault, "Daily/2024-05-19.md", "merge_into").run({ target: "Journal/2024-05-19.md", heading: "From the daily note" });
    const changes = r.proposal!.changes;
    expect(holdReason(changes, { main: "Daily/2024-05-19.md", allowShrink: false, isJournal: (p: string) => p.startsWith("Journal/") })).toBeUndefined();
    await w.executor.applyRaw(changes);
    expect(w.files.get("Journal/2024-05-19.md")).toBe("# Sunday\n\nEarlier thoughts.\n\n## From the daily note\n\nWalked by the river.\n");
    expect(w.files.get("Trips.md")).toBe("See [[Journal/2024-05-19#From the daily note|2024-05-19]] and [[Journal/2024-05-19#From the daily note|that day]].");
    expect(w.files.has("Daily/2024-05-19.md")).toBe(false);
  });

  it("moves a note under the new name when the note to merge into does not exist", async () => {
    const w = world({ "Daily/2024-05-20.md": "Rain." });
    const r = await tool(w.vault, "Daily/2024-05-20.md", "merge_into").run({ target: "Notes/Rainy days.md" });
    expect(r.proposal!.changes).toEqual([{ type: "move", path: "Daily/2024-05-20.md", to: "Notes/Rainy days.md" }]);
  });

  it("refuses a merge that would make text less private, and a trash of a note others link to", async () => {
    const w = world({ "Private/a.md": "mine", "Public.md": "open", "b.md": "x", "c.md": "[[b]]" });
    expect((await tool(w.vault, "Private/a.md", "merge_into").run({ target: "Public.md" })).text).toMatch(/Not merged: this note is local-only and Public\.md is shareable/);
    const t = await tool(w.vault, "b.md", "trash").run({});
    expect(t.proposal).toBeUndefined();
    expect(t.text).toMatch(/Not trashed: 1 note links to it/);
    expect((await tool(w.vault, "c.md", "trash").run({})).proposal?.changes).toEqual([{ type: "delete", path: "c.md", before: "[[b]]" }]);
  });

  it("rewrites only short notes, and sets plain properties but never the guarded ones", async () => {
    const w = world({ "a.md": "old", "long.md": "x".repeat(5000) });
    expect((await tool(w.vault, "a.md", "rewrite").run({ text: "new" })).proposal?.changes).toEqual([{ type: "modify", path: "a.md", before: "old", after: "new" }]);
    expect((await tool(w.vault, "long.md", "rewrite").run({ text: "y" })).text).toMatch(/too long to rewrite whole/);
    expect((await tool(w.vault, "a.md", "set_property").run({ key: "status", value: "done" })).proposal?.changes[0]?.after).toBe("---\nstatus: done\n---\nold");
    for (const key of ["agent-access", "publish", "authorship", "tags"]) expect((await tool(w.vault, "a.md", "set_property").run({ key, value: "x" })).text).toMatch(/^Not set/);
  });

  it("never puts a model's new note in the journal", async () => {
    const w = world({});
    const r = await tool(overlayVault(w.vault, { journal: w.journal }).vault, "a.md", "propose_note").run({ path: "Journal/new.md", content: "A note written by a model, long enough." });
    expect(r.proposal).toBeUndefined();
    expect(r.text).toMatch(/where the journal lives/);
  });

  it("tags only this note when none are named, never the whole vault", async () => {
    const w = world({ "a.md": "---\ntags: [old]\n---\nA", "b.md": "---\ntags: [old]\n---\nB" });
    const r = await tool(w.vault, "a.md", "propose_tags").run({ remove: ["old"], add: ["new"] });
    expect(r.proposal?.changes.map((c) => c.path)).toEqual(["a.md"]);
  });
});

describe("relink and editProperty", () => {
  it("points every form of wiki link at the new place, keeping what each one shows", () => {
    const r = relink("[[Old]] [[Folder/Old|shown]] ![[Old]] [[Old#Part]] [[Older]]", "Folder/Old.md", "New/Place.md");
    expect(r.text).toBe("[[New/Place|Old]] [[New/Place|shown]] ![[New/Place|Old]] [[New/Place#Part|Old]] [[Older]]");
    expect(r.count).toBe(4);
  });

  it("sets, replaces and removes one plain property, leaving every other line", () => {
    expect(editProperty("---\na: 1\nstatus: open\n---\nbody", "status", "done")).toEqual({ text: "---\na: 1\nstatus: done\n---\nbody" });
    expect(editProperty("---\nstatus: open\n---\nbody", "status", null)).toEqual({ text: "body" });
    expect(editProperty("body", "due", "2026-12-01")).toEqual({ text: "---\ndue: 2026-12-01\n---\nbody" });
    expect(editProperty("x", "note", "a: b # c")).toEqual({ text: '---\nnote: "a: b # c"\n---\nx' });
    expect(editProperty("---\nlist:\n  - a\n---\n", "list", "b")).toHaveProperty("error");
  });
});

describe("BatchRunner", () => {
  it("holds what the agent kept back, without applying it", async () => {
    const w = world({ "a.md": "alpha" });
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: async () => ({ summary: "Left it.", changes: [{ type: "modify", path: "a.md", before: "alpha", after: "beta" }], findings: [], hold: "the model said it left this note, but it had changed it" }),
    });
    const rec = await runner.run((await runner.create(spec(["a.md"]), "m")).job.id);
    expect(rec.steps[0]?.status).toBe("held");
    expect(w.files.get("a.md")).toBe("alpha");
  });

  /** An agent that does what the table says for each note. */
  const scripted = (plan: Record<string, AgentResult | ((files: Map<string, string>) => AgentResult)>, files: Map<string, string>) =>
    async (path: string): Promise<AgentResult> => {
      const p = plan[path];
      if (!p) return { summary: "Left it.", changes: [], findings: [] };
      return typeof p === "function" ? p(files) : p;
    };

  it("works through the notes, writes how to undo each one before touching it, and undoes all of it", async () => {
    const w = world({ "a.md": "alpha", "b.md": "beta", "c.md": "gamma" });
    const writes: string[] = [];
    const store = { ...w.store, write: async (r: Parameters<typeof w.store.write>[0]) => (writes.push(r.steps.map((s) => `${s.path}:${s.status}`).join(",")), w.store.write(r)) };
    const runner = new BatchRunner({
      executor: w.executor,
      store,
      work: scripted({
        "a.md": { summary: "Edited.", changes: [{ type: "modify", path: "a.md", before: "alpha", after: "alpha!" }], findings: [] },
        "c.md": { summary: "Filed.", changes: [{ type: "move", path: "c.md", to: "Done/c.md" }], findings: ["filed"] },
      }, w.files),
    });
    const created = await runner.create(spec(["a.md", "b.md", "c.md"]), "test-model");
    const done = await runner.run(created.job.id);
    expect(done.status).toBe("done");
    expect(done.steps.map((s) => s.status)).toEqual(["applied", "left", "applied"]);
    expect(tally(done)).toEqual({ edited: 1, left: 1, moved: 1 });
    // The record said "pending", with its undo, before each note was changed.
    expect(writes).toContain("a.md:pending");
    expect(writes).toContain("a.md:applied,b.md:left,c.md:pending");
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": "alpha!", "b.md": "beta", "Done/c.md": "gamma" });

    // A fresh runner over the same records — as after a restart — undoes it all.
    const later = new BatchRunner({ executor: new ActionExecutor(w.io), store: w.store, work: async () => ({ summary: "", changes: [], findings: [] }) });
    const r = await later.undo(created.job.id);
    expect(r.undone).toBe(2);
    expect(r.record.status).toBe("undone");
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": "alpha", "b.md": "beta", "c.md": "gamma" });
  });

  it("holds a change that would lose text, and records a failure without changing anything", async () => {
    const long = "keep these words ".repeat(30);
    const w = world({ "a.md": long, "b.md": "beta" });
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: scripted({
        "a.md": { summary: "Shortened.", changes: [{ type: "modify", path: "a.md", before: long, after: "keep" }], findings: [] },
        "b.md": { summary: "", changes: [], findings: [], failed: "model offline" },
      }, w.files),
    });
    const rec = await runner.run((await runner.create(spec(["a.md", "b.md"]), "m")).job.id);
    expect(rec.steps.map((s) => [s.status, s.why])).toEqual([
      ["held", "Not changed: it would keep only 1% of the words of a.md."],
      ["failed", "model offline"],
    ]);
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": long, "b.md": "beta" });
  });

  it("does not overwrite a note the owner changed after the agent read it", async () => {
    const w = world({ "a.md": "alpha" });
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: async () => {
        w.files.set("a.md", "alpha — edited by the owner just now");
        return { summary: "Edited.", changes: [{ type: "modify", path: "a.md", before: "alpha", after: "ALPHA" }], findings: [] };
      },
    });
    const rec = await runner.run((await runner.create(spec(["a.md"]), "m")).job.id);
    expect(rec.steps[0]?.status).toBe("failed");
    expect(rec.steps[0]?.why).toMatch(/changed since/);
    expect(w.files.get("a.md")).toBe("alpha — edited by the owner just now");
  });

  it("pauses after the sample and goes on from where it stopped; stops when asked", async () => {
    const w = world({ "1.md": "a", "2.md": "b", "3.md": "c", "4.md": "d" });
    const seen: string[] = [];
    let id = "";
    const runner: BatchRunner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: async (path) => {
        seen.push(path);
        if (path === "3.md") runner.stop(id);
        return { summary: "Left it.", changes: [], findings: [] };
      },
    });
    id = (await runner.create(spec(["1.md", "2.md", "3.md", "4.md"]), "m")).job.id;
    expect((await runner.run(id, { pauseAfter: 2 })).status).toBe("paused");
    expect(seen).toEqual(["1.md", "2.md"]);
    const stopped = await runner.run(id);
    expect(stopped.status).toBe("stopped");
    expect(seen).toEqual(["1.md", "2.md", "3.md"]);
    expect((await runner.run(id)).status).toBe("done");
    expect(seen).toEqual(["1.md", "2.md", "3.md", "4.md"]);
  });

  it("undoes one note on its own, and leaves a note changed since the job as it is, saying so", async () => {
    const w = world({ "a.md": "alpha", "b.md": "beta" });
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: scripted({
        "a.md": { summary: "", changes: [{ type: "modify", path: "a.md", before: "alpha", after: "A" }], findings: [] },
        "b.md": { summary: "", changes: [{ type: "modify", path: "b.md", before: "beta", after: "B" }], findings: [] },
      }, w.files),
    });
    const id = (await runner.run((await runner.create(spec(["a.md", "b.md"]), "m")).job.id)).job.id;
    expect((await runner.undo(id, "b.md")).undone).toBe(1);
    expect(w.files.get("b.md")).toBe("beta");
    w.files.set("a.md", "A, and the owner's later words");
    const r = await runner.undo(id);
    expect(r.undone).toBe(0);
    expect(r.problems[0]).toMatch(/a\.md: .*changed since/);
    expect(w.files.get("a.md")).toBe("A, and the owner's later words");
    expect(r.record.status).not.toBe("undone");
  });

  it("finishes an undo for a note the app stopped on half-way (a 'pending' step)", async () => {
    const w = world({ "a.md": "alpha" });
    // The record says pending, and the change did land before the app stopped.
    const rec = await new BatchRunner({ executor: w.executor, store: w.store, work: async () => ({ summary: "", changes: [], findings: [] }) }).create(spec(["a.md"]), "m");
    const changes: FileChange[] = [{ type: "modify", path: "a.md", before: "alpha", after: "A" }];
    rec.steps.push({ path: "a.md", status: "pending", summary: "", changes, inverse: inverseOf(changes), findings: [], at: "", attempting: 0 });
    await w.store.write(rec);
    w.files.set("a.md", "A");
    const runner = new BatchRunner({ executor: w.executor, store: w.store, work: async () => ({ summary: "", changes: [], findings: [] }) });
    expect((await runner.undo(rec.job.id)).undone).toBe(1);
    expect(w.files.get("a.md")).toBe("alpha");
    // And when the change had NOT landed, undoing it changes nothing.
    rec.steps[0]!.status = "pending";
    await w.store.write(rec);
    expect((await runner.undo(rec.job.id)).undone).toBe(1);
    expect(w.files.get("a.md")).toBe("alpha");
  });

  it("undoes a merge — the target, the relinked notes and the merged note — in one go", async () => {
    const w = world({ "Daily/d.md": "River walk.", "Journal/d.md": "# D\n", "x.md": "[[d]]" });
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: async (path) => {
        const r = await vaultTools(overlayVault(w.vault, { journal: w.journal }).vault, { mode: "batch", note: () => path }).find((t) => t.name === "merge_into")!.run({ target: "Journal/d.md" });
        return { summary: "Merged.", changes: r.proposal!.changes, findings: [] };
      },
    });
    const id = (await runner.run((await runner.create(spec(["Daily/d.md"]), "m")).job.id)).job.id;
    expect(w.files.has("Daily/d.md")).toBe(false);
    await runner.undo(id);
    expect(Object.fromEntries(w.files)).toEqual({ "Daily/d.md": "River walk.", "Journal/d.md": "# D\n", "x.md": "[[d]]" });
  });
});

describe("choosing the notes", () => {
  const notes = [
    { path: "Periodic/Daily/2024-05-19 Sunday.md", mtime: new Date("2024-05-19T12:00:00").getTime(), tags: ["daily"] },
    { path: "Periodic/Daily/2024-05-20.md", mtime: new Date("2024-05-21T12:00:00").getTime(), tags: [] },
    { path: "Periodic/Daily/Old/2023-01-01.md", mtime: 0, tags: [] },
    { path: "Projects/Ariadne/Plan.md", mtime: new Date("2026-11-20T12:00:00").getTime(), tags: ["project/ariadne"] },
  ];
  it("by folder (with or without subfolders), tag and subtags, name, date in the name, change date and property", () => {
    expect(selectNotes(notes, { folder: "Periodic/Daily" })).toHaveLength(3);
    expect(selectNotes(notes, { folder: "Periodic/Daily/", subfolders: false })).toEqual(["Periodic/Daily/2024-05-19 Sunday.md", "Periodic/Daily/2024-05-20.md"]);
    expect(selectNotes(notes, { tag: "#project" })).toEqual(["Projects/Ariadne/Plan.md"]);
    expect(selectNotes(notes, { name: "sunday" })).toEqual(["Periodic/Daily/2024-05-19 Sunday.md"]);
    expect(selectNotes(notes, { from: "2024-01-01", to: "2024-05-19" })).toEqual(["Periodic/Daily/2024-05-19 Sunday.md"]);
    expect(selectNotes(notes, { changedSince: "2026-01-01" })).toEqual(["Projects/Ariadne/Plan.md"]);
    const props: Record<string, Record<string, unknown>> = { "Projects/Ariadne/Plan.md": { status: "open" } };
    expect(selectNotes(notes, { property: "status=Open" }, (p) => props[p])).toEqual(["Projects/Ariadne/Plan.md"]);
    expect(dateInName("Journal/Entry 2026-11-22 late.md")).toBe("2026-11-22");
  });

  it("start_batch sets a job up without starting it, leaving out what the chat may not be shown", async () => {
    const w = world({ "Daily/2024-05-19.md": "a", "Daily/2024-05-20.md": "b", "Sealed/2024-05-21.md": "c" });
    const start = vaultTools(w.vault).find((t) => t.name === "start_batch")!;
    const r = await start.run({ instruction: "If it is personal, move it into the journal.", from: "2024-05-01" });
    expect(r.job).toEqual({
      instruction: "If it is personal, move it into the journal.",
      selection: "2 notes in the whole vault, dated from 2024-05-01",
      paths: ["Daily/2024-05-19.md", "Daily/2024-05-20.md"],
      leftOut: ["1 note: it is sealed"],
      allowShrink: false,
    });
    expect(r.text).toMatch(/^Set up, not started/);
    expect((await start.run({ instruction: "Do something to everything." })).text).toMatch(/choose the notes/);
  });
});
