/**
 * The second review of batch jobs: one test (or more) per finding, numbered
 * as in the review.
 */
import { describe, expect, it } from "vitest";
import { ActionExecutor, type FileChange, type VaultIO } from "../src/actions/framework";
import type { JobSpec } from "../src/chat/engine";
import { parsedProperties } from "../src/chat/frontmatter";
import { cleanPath, vaultTools, type VaultAccess } from "../src/chat/tools";
import { overlayVault } from "../src/batch/overlay";
import { memoryBatchStore } from "../src/batch/record";
import { BatchRunner, commonLength, holdReason, kept } from "../src/batch/runner";
import { underFolder } from "../src/privacy/levels";
import { inFolders } from "../src/margin/journal";

const journal = (p: string) => p.toLowerCase().startsWith("journal/");
/** 0 shareable, 1 local-only, 2 journal, 3 sealed — by where the note would be. */
const rankAtPath = (p: string) => (p.startsWith("Sealed/") ? 3 : journal(p) ? 2 : p.startsWith("Private/") ? 1 : 0);
const rankOf = (_note: string, at: string) => rankAtPath(at);

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
  const vault: VaultAccess = {
    search: async (q) => [...files].filter(([, t]) => t.includes(q)).map(([path, t]) => ({ path, title: path, snippet: t.slice(0, 60) })),
    read: async (p) => files.get(p),
    readable: (p) => (p.startsWith("Sealed/") ? { ok: false, why: "it is sealed" } : journal(p) && !opts.journalOn ? { ok: false, why: "journal not switched on" } : { ok: true }),
    resolve: (n) => [n, `${n}.md`].find((p) => files.has(p)),
    notes: () => [...files.keys()].map((path) => ({ path, mtime: 0, tags: [] })),
    open: async () => {},
    exists: (p) => files.has(p),
    writable: (p) => (p.startsWith("Sealed/") ? { ok: false, why: "sealed" } : journal(p) ? { ok: false, why: "journal" } : { ok: true }),
    // Like the plugin: Private/ is local-only; the journal folder itself is not.
    levelAt: (_n, at) => (at.startsWith("Sealed/") ? "sealed" : at.startsWith("Private/") ? "local" : "shareable"),
    linksTo: (p) => [...files].filter(([q, t]) => q !== p && t.includes(`[[${p.replace(/\.md$/, "").split("/").pop()}`)).map(([q]) => q),
    modelName: () => "m",
    today: () => "2026-11-23",
  };
  return { files, io, vault, executor: new ActionExecutor(io), store: memoryBatchStore() };
}
const ctx = (main: string, over: Partial<Parameters<typeof holdReason>[1]> = {}) => ({ main, allowShrink: false, isJournal: journal, rank: rankOf, ...over });
const tool = (vault: VaultAccess, note: string, name: string, original?: string) =>
  vaultTools(overlayVault(vault, { journal, main: note }).vault, { mode: "batch", note: () => note, original: original === undefined ? undefined : () => original }).find((t) => t.name === name)!;
const spec = (paths: string[]): JobSpec => ({ instruction: "Do it to each note.", selection: "", paths, leftOut: [], allowShrink: false });

describe("1. guarded properties are judged as YAML reads them", () => {
  it("holds a quoted key, a duplicate, a ? key, and properties left unreadable", () => {
    const before = "---\ntitle: a\nagent-access: local\n---\nBody text.";
    for (const after of [
      '---\ntitle: a\n"publish": true\nagent-access: local\n---\nBody text.',
      "---\nagent-access: shareable\ntitle: a\nagent-access: local\n---\nBody text.",
      "---\ntitle: a\n? publish\n: true\nagent-access: local\n---\nBody text.",
      "---\ntitle: Meeting: budget [draft\nagent-access: local\n---\nBody text.",
    ]) {
      expect(holdReason([{ type: "modify", path: "a.md", before, after }], ctx("a.md", { allowShrink: true }))).toMatch(/property|cannot read/);
    }
    expect(parsedProperties('---\n"Publish": true\n---\n')).toEqual({ ok: true, props: new Map([["publish", "true"]]) });
  });

  it("in a batch, a text edit or a rewrite cannot touch the properties block", async () => {
    const w = world({ "a.md": "---\ntitle: a\n---\nBody." });
    const edit = await tool(w.vault, "a.md", "propose_edit").run({ path: "a.md", find: "title: a", replace: "title: a\npublish: true" });
    expect(edit.proposal).toBeUndefined();
    expect(edit.text).toMatch(/would change the note's properties/);
    const rw = await tool(w.vault, "a.md", "rewrite", "---\ntitle: a\n---\nBody.").run({ text: "---\ntitle: b\n---\nBody." });
    expect(rw.proposal).toBeUndefined();
    // Text below the properties may be edited as before.
    expect((await tool(w.vault, "a.md", "propose_edit").run({ path: "a.md", find: "Body.", replace: "Body!" })).proposal).toBeDefined();
  });
});

describe("2. private text is not copied out", () => {
  it("an agent working on a shareable note is not shown more private notes", async () => {
    const w = world({ "Notes/a.md": "open", "Private/secret.md": "secret words" });
    expect((await tool(w.vault, "Notes/a.md", "read").run({ path: "Private/secret.md" })).text).toMatch(/not shown/);
    expect((await tool(w.vault, "Notes/a.md", "search").run({ query: "secret" })).text).not.toContain("secret words");
    // Working on the private note itself, it is shown.
    expect((await tool(w.vault, "Private/secret.md", "read").run({ path: "Private/secret.md" })).text).toContain("secret words");
  });

  it("a new note drawn from a private or journal note may not be less private", async () => {
    const w = world({ "Private/p.md": "p", "Journal/2026-11-01.md": "entry" }, { journalOn: true });
    expect((await tool(w.vault, "Private/p.md", "propose_note").run({ path: "Public/Extract.md", content: "The private words, copied out here." })).proposal).toBeUndefined();
    expect((await tool(w.vault, "Journal/2026-11-01.md", "propose_note").run({ path: "Public/Extract.md", content: "The journal words, copied out here." })).proposal).toBeUndefined();
    expect(holdReason([{ type: "create", path: "Public/x.md", after: "copied" }], ctx("Private/p.md"))).toMatch(/less private/);
    expect(holdReason([{ type: "delete", path: "Private/p.md", before: "words here" }, { type: "create", path: "Public/x.md", after: "words here" }], ctx("Private/p.md"))).toMatch(/less private/);
  });
});

describe("3. model-written notes never reach the journal", () => {
  const ai = "---\nauthorship: ai-generated\n---\nA model's summary.";
  it("not by a bare move (the guard reads the moved note), not by a merge into an entry", () => {
    expect(holdReason([{ type: "move", path: "Notes/s.md", to: "Journal/s.md" }], ctx("Notes/s.md", { known: new Map([["Notes/s.md", ai]]) }))).toMatch(/written by a model/);
    const merge: FileChange[] = [
      { type: "modify", path: "Journal/2026-11-01.md", before: "# Entry\n", after: "# Entry\n\n## s\n\nA model's summary.\n" },
      { type: "delete", path: "Notes/s.md", before: ai },
    ];
    expect(holdReason(merge, ctx("Notes/s.md"))).toMatch(/model would be merged into the journal/);
  });

  it("a merge into the journal needs the journal switched on", async () => {
    const w = world({ "Daily/d.md": "Mine.", "Journal/d.md": "# D\n" });
    const r = await tool(w.vault, "Daily/d.md", "merge_into").run({ target: "Journal/d.md" });
    expect(r.proposal).toBeUndefined();
    expect(r.text).toMatch(/Not merged: Journal\/d\.md/);
    const on = world({ "Daily/d.md": "Mine.", "Journal/d.md": "# D\n" }, { journalOn: true });
    expect((await tool(on.vault, "Daily/d.md", "merge_into").run({ target: "Journal/d.md" })).proposal).toBeDefined();
  });
});

describe("4. how much text is kept, measured exactly", () => {
  const para = (n: number, w: number) => Array.from({ length: w }, (_, i) => `p${n}w${i}`).join(" ");
  it("sees whole paragraphs gone from a long note, and keeps a typo fix in one as a typo fix", () => {
    const long = Array.from({ length: 5 }, (_, n) => para(n, 1500)).join("\n\n");
    const cut = [para(0, 1500), para(4, 1500)].join("\n\n");
    expect(kept(long, cut)).toBeCloseTo(0.4, 2);
    const essay = Array.from({ length: 8 }, (_, n) => para(n, 350)).join("\n\n");
    const fixed = essay.replace("p1w3 ", "p1w3x ").replace("p4w9 ", "p4w9x ").replace("p7w100 ", "p7w100x ");
    expect(kept(essay, fixed)).toBeGreaterThan(0.99);
    expect(holdReason([{ type: "modify", path: "a.md", before: essay, after: fixed }], ctx("a.md"))).toBeUndefined();
  });

  it("measures the body, not the properties, and scripts written without spaces", () => {
    const props = `---\n${Array.from({ length: 9 }, (_, i) => `k${i}: value ${i}`).join("\n")}\n---\n`;
    expect(holdReason([{ type: "modify", path: "a.md", before: `${props}Call Ana about the boiler on Friday.`, after: `${props}x` }], ctx("a.md"))).toMatch(/keep only 0%/);
    const jp = "今日は朝から雨が降っていた。母に電話して、来週の予定を話した。";
    expect(holdReason([{ type: "modify", path: "a.md", before: jp, after: "要約：電話。" }], ctx("a.md"))).toMatch(/keep only/);
    expect(kept(jp, `${jp}\n\n追記。`)).toBe(1);
  });

  it("works out exact common lengths, and gives up rather than guess when too much differs", () => {
    expect(commonLength(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"])).toBe(3);
    expect(commonLength(["a", "b"], ["c", "d"], 1)).toBeUndefined();
  });
});

describe("5. undo and run never overlap", () => {
  it("turns away a run while an undo is going, and a second undo", async () => {
    const w = world({ "a.md": "a" });
    const runner = new BatchRunner({ executor: w.executor, store: w.store, work: async () => ({ summary: "", changes: [{ type: "modify", path: "a.md", before: "a", after: "a+" }], findings: [] }) });
    const id = (await runner.run((await runner.create(spec(["a.md"]), "m")).job.id)).job.id;
    const [u1, u2, run] = await Promise.allSettled([runner.undo(id), runner.undo(id), runner.run(id)]);
    expect(u1.status).toBe("fulfilled");
    expect(u2.status).toBe("rejected");
    expect(run.status).toBe("rejected");
    expect(w.files.get("a.md")).toBe("a");
    expect((await w.store.read(id))?.steps[0]?.status).toBe("undone");
  });

  it("leaves a note open in the editor for later, saying so", async () => {
    const w = world({ "a.md": "a" });
    let open = false;
    const runner = new BatchRunner({ executor: w.executor, store: w.store, isOpen: () => open, work: async () => ({ summary: "", changes: [{ type: "modify", path: "a.md", before: "a", after: "a+" }], findings: [] }) });
    const id = (await runner.run((await runner.create(spec(["a.md"]), "m")).job.id)).job.id;
    open = true;
    const r = await runner.undo(id);
    expect(r.undone).toBe(0);
    expect(r.problems[0]).toMatch(/open in the editor/);
    expect(w.files.get("a.md")).toBe("a+");
    open = false;
    expect((await runner.undo(id)).undone).toBe(1);
  });

  it("undoing one note does not end the job", async () => {
    const w = world({ "a.md": "a", "b.md": "b", "c.md": "c" });
    const runner = new BatchRunner({ executor: w.executor, store: w.store, work: async (p) => ({ summary: "", changes: [{ type: "modify", path: p, before: w.files.get(p)!, after: `${w.files.get(p)}+` }], findings: [] }) });
    const id = (await runner.create(spec(["a.md", "b.md", "c.md"]), "m")).job.id;
    await runner.run(id, { pauseAfter: 1 });
    const r = await runner.undo(id, "a.md");
    expect(r.record.status).toBe("paused");
    expect((await runner.run(id)).status).toBe("done");
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": "a", "b.md": "b+", "c.md": "c+" });
  });

  it("works again a step written ahead but stopped before anything landed", async () => {
    const w = world({ "a.md": "a" });
    let calls = 0;
    const runner = new BatchRunner({ executor: w.executor, store: w.store, work: async () => (calls++, { summary: "", changes: [{ type: "modify", path: "a.md", before: "a", after: "a+" }], findings: [] }) });
    const rec = await runner.create(spec(["a.md"]), "m");
    rec.steps.push({ path: "a.md", status: "pending", summary: "", changes: [{ type: "modify", path: "a.md", before: "a", after: "a+" }], inverse: [], findings: [], at: "" });
    rec.status = "done";
    await w.store.write(rec);
    const again = await runner.run(rec.job.id);
    expect(calls).toBe(1);
    expect(again.steps.map((s) => s.status)).toEqual(["applied"]);
  });
});

describe("7. paths are checked as the vault will read them", () => {
  it("refuses a backslash in any folder of a new note's path, and folds Unicode and odd spaces before the walls", async () => {
    const w = world({ "a.md": "a" });
    const r = await tool(w.vault, "a.md", "propose_note").run({ path: "Journal\\2026/Model note.md", content: "Some text a model wrote here." });
    expect(r.proposal).toBeUndefined();
    expect(cleanPath("Daily Notes/x.md")).toBe("Daily Notes/x.md");
    expect(underFolder("Diário/x.md", "Diário")).toBe(true);
    expect(inFolders("Daily Notes/x.md", ["Daily Notes"])).toBe(true);
  });
});

describe("11. the low ones", () => {
  it("refuses a merge when another note shares its name (a bare link could mean either) — but not the target itself", async () => {
    const w = world({ "Notes/Plan.md": "mine", "Other/Plan.md": "another", "T.md": "# T\n", "x.md": "[[Notes/Plan]] and [[Plan]]" });
    const r = await tool(w.vault, "Notes/Plan.md", "merge_into").run({ target: "T.md" });
    expect(r.proposal).toBeUndefined();
    expect(r.text).toMatch(/another note is also named/);
  });

  it("lets a small edit before a merge through, and still holds a lossy one", () => {
    const text = "One two three four five six seven eight nine ten.";
    const edited = "One two three four five six seven eight nine ten!";
    const ok: FileChange[] = [
      { type: "modify", path: "a.md", before: text, after: edited },
      { type: "modify", path: "T.md", before: "# T\n", after: `# T\n\n## a\n\n${edited}\n` },
      { type: "delete", path: "a.md", before: edited },
    ];
    expect(holdReason(ok, ctx("a.md"))).toBeUndefined();
    const lossy: FileChange[] = [
      { type: "modify", path: "a.md", before: text, after: "One." },
      { type: "modify", path: "T.md", before: "# T\n", after: "# T\n\n## a\n\nOne.\n" },
      { type: "delete", path: "a.md", before: "One." },
    ];
    expect(holdReason(lossy, ctx("a.md"))).toMatch(/before merging it/);
  });

  it("does not offer to set the type property", async () => {
    const w = world({ "a.md": "a" });
    expect((await tool(w.vault, "a.md", "set_property").run({ key: "type", value: "journal" })).text).toMatch(/^Not set/);
  });

  it("leaves excluded notes out of a batch", async () => {
    const w = world({ "Notes/a.md": "a", "Notes/Moments/b.md": "b" });
    const vault = { ...w.vault, excluded: (p: string) => p.startsWith("Notes/Moments/") };
    const r = await vaultTools(vault).find((t) => t.name === "start_batch")!.run({ instruction: "Tag each note please.", folder: "Notes" });
    expect(r.job?.paths).toEqual(["Notes/a.md"]);
    expect(r.job?.leftOut).toEqual(["1 note: in a folder or file you excluded from Ariadne"]);
  });
});
