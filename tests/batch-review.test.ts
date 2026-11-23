/**
 * One test (or more) per finding of the independent review of batch jobs —
 * each a way a vault could lose text, keep a change it cannot undo, or let
 * something past the privacy walls. Numbers follow the review.
 */
import { describe, expect, it } from "vitest";
import { ActionExecutor, type FileChange, type VaultIO } from "../src/actions/framework";
import type { JobSpec } from "../src/chat/engine";
import { bodyOf, splitFront } from "../src/chat/frontmatter";
import { editProperty, editTags } from "../src/chat/tag-edit";
import { relink, vaultTools, type VaultAccess } from "../src/chat/tools";
import { AdapterBatchStore } from "../src/batch/obsidian-store";
import { overlayVault } from "../src/batch/overlay";
import { inverseOf, memoryBatchStore, type BatchRecord } from "../src/batch/record";
import { BatchRunner, holdReason, kept, type AgentResult } from "../src/batch/runner";
import { underFolder } from "../src/privacy/levels";
import { inFolders } from "../src/margin/journal";

function world(initial: Record<string, string>, over: Partial<VaultIO> = {}) {
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
    ...over,
  };
  const journal = (p: string) => p.toLowerCase().startsWith("journal/");
  // Modelled on the plugin: the journal folder is NOT local-only by itself (the default), only sealed folders are walled.
  const vault: VaultAccess = {
    search: async () => [],
    read: async (p) => files.get(p),
    readable: (p) => (p.startsWith("Sealed/") ? { ok: false, why: "it is sealed" } : { ok: true }),
    resolve: (name) => [name, `${name}.md`].find((p) => files.has(p)),
    notes: () => [...files.keys()].map((path) => ({ path, mtime: 0, tags: [] })),
    open: async () => {},
    exists: (p) => files.has(p),
    writable: (p) => (p.startsWith("Sealed/") ? { ok: false, why: "that folder is sealed" } : journal(p) ? { ok: false, why: "that is where your journal lives" } : { ok: true }),
    levelAt: (_n, at) => (at.startsWith("Sealed/") ? "sealed" : "shareable"),
    linksTo: (p) => [...files].filter(([q, t]) => q !== p && t.toLowerCase().includes(`[[${(p.replace(/\.md$/, "").split("/").pop() ?? "").toLowerCase()}`)).map(([q]) => q),
    modelName: () => "m",
    today: () => "2026-11-23",
  };
  return { files, io, vault, journal, executor: new ActionExecutor(io), store: memoryBatchStore() };
}

const spec = (paths: string[], allowShrink = false): JobSpec => ({ instruction: "Do the thing to each note.", selection: `${paths.length} notes`, paths, leftOut: [], allowShrink });
const ctx = (main: string, allowShrink = false) => ({ main, allowShrink, isJournal: (p: string) => p.toLowerCase().startsWith("journal/") });
const batchTool = (vault: VaultAccess, note: string, name: string, original?: string) =>
  vaultTools(overlayVault(vault, { journal: (p) => p.toLowerCase().startsWith("journal/") }).vault, { mode: "batch", note: () => note, original: original === undefined ? undefined : () => original }).find((t) => t.name === name)!;

describe("1. a job cannot run twice at once", () => {
  it("turns a second run away before it starts, so nothing is changed twice and the record stays true", async () => {
    const w = world({ "a.md": "a", "b.md": "b", "c.md": "c" });
    let calls = 0;
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: async (path) => {
        calls++;
        const before = w.files.get(path)!;
        return { summary: "", changes: [{ type: "modify", path, before, after: `${before}+` }], findings: [], startText: before };
      },
    });
    const id = (await runner.create(spec(["a.md", "b.md", "c.md"]), "m")).job.id;
    const [first, second] = await Promise.allSettled([runner.run(id), runner.run(id)]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(calls).toBe(3);
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": "a+", "b.md": "b+", "c.md": "c+" });
    await runner.undo(id);
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": "a", "b.md": "b", "c.md": "c" });
    await expect(runner.create(spec(["a.md"]), "m")).resolves.toBeDefined();
  });
});

describe("2. text loss is judged on the net effect of a note's step", () => {
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  it("holds several small cuts that add up to a big one", () => {
    const w = long.split(" ");
    const s1 = w.slice(0, 45).join(" ");
    const s2 = w.slice(0, 34).join(" ");
    const s3 = w.slice(0, 25).join(" ");
    const changes: FileChange[] = [
      { type: "modify", path: "a.md", before: long, after: s1 },
      { type: "modify", path: "a.md", before: s1, after: s2 },
      { type: "modify", path: "a.md", before: s2, after: s3 },
    ];
    expect(holdReason(changes, ctx("a.md"))).toBe("it would keep only 42% of the words of a.md");
  });

  it("holds a short note cut to nothing much, and a same-length note with every word replaced", () => {
    expect(holdReason([{ type: "modify", path: "a.md", before: "Call Ana about the boiler on Friday.", after: "x" }], ctx("a.md"))).toMatch(/keep only 0%/);
    const other = Array.from({ length: 60 }, (_, i) => `other${i}`).join(" ");
    expect(holdReason([{ type: "modify", path: "a.md", before: long, after: other }], ctx("a.md"))).toMatch(/keep only 0%/);
    expect(kept("one two three", "one two three four")).toBe(1);
  });

  it("holds a merge whose text is then edited away, and a trash followed by a different note in its place", () => {
    const undone: FileChange[] = [
      { type: "modify", path: "T.md", before: "# T\n", after: "# T\n\n## a\n\nThe whole of a.\n" },
      { type: "modify", path: "T.md", before: "# T\n\n## a\n\nThe whole of a.\n", after: "# T\n\n## a\n\n(summary)\n" },
      { type: "delete", path: "a.md", before: "The whole of a.\n" },
    ];
    expect(holdReason(undone, ctx("a.md"))).toMatch(/text does not appear whole|would rewrite T\.md/);
    const replaced: FileChange[] = [
      { type: "delete", path: "a.md", before: "My own words, many of them, carefully kept." },
      { type: "create", path: "a.md", after: "Something else entirely." },
    ];
    expect(holdReason(replaced, ctx("a.md"))).toMatch(/does not appear whole/);
  });
});

describe("3. a whole rewrite never drops what the owner typed meanwhile", () => {
  it("refuses a rewrite of a note that is not as the model was shown it", async () => {
    const w = world({ "a.md": "Shown text.\n\nAnd a paragraph the owner typed just now." });
    const r = await batchTool(w.vault, "a.md", "rewrite", "Shown text.").run({ text: "Shown text, tidied." });
    expect(r.proposal).toBeUndefined();
    expect(r.text).toMatch(/no longer as you were shown it/);
  });

  it("does not apply a step to a note that changed while its agent worked", async () => {
    const w = world({ "a.md": "as shown, then the owner typed more" });
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      read: async (p) => w.files.get(p),
      work: async () => ({ summary: "", changes: [{ type: "modify", path: "a.md", before: "as shown, then the owner typed more", after: "tidied" }], findings: [], startText: "as shown" }),
    });
    const rec = await runner.run((await runner.create(spec(["a.md"]), "m")).job.id);
    expect(rec.steps[0]?.status).toBe("failed");
    expect(rec.steps[0]?.why).toMatch(/changed while the model was working/);
    expect(w.files.get("a.md")).toBe("as shown, then the owner typed more");
  });
});

describe("4. privacy walls", () => {
  it("a: holds any edit that changes agent-access, publish, authorship or type — by whatever tool", () => {
    for (const [before, after] of [
      ["---\nagent-access: local\n---\nx", "---\nagent-access: shareable\n---\nx"],
      ["---\ntitle: a\n---\nx", "---\ntitle: a\npublish: true\n---\nx"],
      ["---\ntype: journal\n---\nx", "---\ntype: note\n---\nx"],
      ["---\nauthorship: ai-generated\n---\nx", "x"],
    ]) {
      expect(holdReason([{ type: "modify", path: "a.md", before, after }], ctx("a.md", true))).toMatch(/property of a\.md, which only the owner changes/);
    }
  });

  it("b: nothing leaves the journal — not by a move, not by a merge — even where its folder is not local-only", async () => {
    const w = world({ "Journal/Morning pages 12.md": "Private morning words.", "Notes/Log.md": "# Log\n" });
    const move = await batchTool(w.vault, "Journal/Morning pages 12.md", "propose_moves").run({ moves: [{ path: "Journal/Morning pages 12.md", folder: "Notes" }] });
    expect(move.proposal).toBeUndefined();
    const merge = await batchTool(w.vault, "Journal/Morning pages 12.md", "merge_into").run({ target: "Notes/Log.md" });
    expect(merge.proposal).toBeUndefined();
    expect(merge.text).toMatch(/Not merged/);
    expect(holdReason([{ type: "move", path: "Journal/x.md", to: "Notes/x.md" }], ctx("Journal/x.md"))).toMatch(/moved out of the journal/);
    // Into the journal stays possible: the owner's own note, moved, unchanged.
    expect(holdReason([{ type: "move", path: "Daily/2024-05-19.md", to: "Journal/2024-05-19.md" }], ctx("Daily/2024-05-19.md"))).toBeUndefined();
  });

  it("c: a model-written note never reaches the journal, not even by being moved there", () => {
    const changes: FileChange[] = [
      { type: "create", path: "Notes/Summary.md", after: "---\nauthorship: ai-generated\n---\nA summary." },
      { type: "move", path: "Notes/Summary.md", to: "Journal/Summary.md" },
    ];
    expect(holdReason(changes, ctx("Daily/x.md"))).toMatch(/model-written note would go into the journal/);
  });
});

describe("5. one note's agent changes that note and no other", () => {
  it("refuses edits, moves and tags of other notes in a batch, and the guard holds them if they get through", async () => {
    const w = world({ "Batch/a.md": "a", "Elsewhere/novel.md": "Chapter one." });
    expect((await batchTool(w.vault, "Batch/a.md", "propose_edit").run({ path: "Elsewhere/novel.md", find: "one", replace: "ONE" })).text).toMatch(/only this note/);
    expect((await batchTool(w.vault, "Batch/a.md", "propose_moves").run({ moves: [{ path: "Elsewhere/novel.md", folder: "Trash" }] })).proposal).toBeUndefined();
    expect((await batchTool(w.vault, "Batch/a.md", "propose_tags").run({ notes: ["Elsewhere/novel.md"], add: ["x"] })).proposal).toBeUndefined();
    expect(holdReason([{ type: "modify", path: "Elsewhere/novel.md", before: "Chapter one.", after: "Chapter one, and more." }], ctx("Batch/a.md"))).toMatch(/not the note this step is for/);
    expect(holdReason([{ type: "move", path: "Elsewhere/novel.md", to: "X/novel.md" }], ctx("Batch/a.md"))).toMatch(/not the note this step is for/);
  });
});

describe("6. properties are found and rewritten exactly", () => {
  it("finds the block Obsidian finds — an empty one stays empty, a later --- rule is body", () => {
    expect(splitFront("---\n---\nbody\n---\nmore")?.lines).toEqual([]);
    expect(bodyOf("---\n---\nbody\n---\nmore")).toBe("body\n---\nmore");
    const r = editTags("---\n---\nbody\n---\nmore", ["new"], []);
    expect("text" in r && r.text).toBe("---\ntags:\n  - new\n---\nbody\n---\nmore");
  });

  it("refuses to set a property that holds a flush-left list or runs on to a second line", () => {
    expect(editProperty("---\nproject:\n- alpha\n- beta\n---\n", "project", "gamma")).toHaveProperty("error");
    expect(editProperty("---\nproject:\n- alpha\n---\n", "project", null)).toHaveProperty("error");
    expect(editProperty("---\nsummary: short\n  runs on\n---\n", "summary", "x")).toHaveProperty("error");
  });

  it("quotes what YAML would read as another type, and reads Tags:, tags: null and flush-left items right", () => {
    for (const v of ["0123", "1e5", "0x10", "True", "+5", ".5"]) expect(editProperty("x", "code", v)).toEqual({ text: `---\ncode: ${JSON.stringify(v)}\n---\nx` });
    expect(editProperty("x", "n", "42")).toEqual({ text: "---\nn: 42\n---\nx" });
    const nul = editTags("---\ntags: null\n---\nx", ["a"], []);
    expect("text" in nul && nul.text).toBe("---\ntags:\n  - a\n---\nx");
    const cap = editTags("---\nTags: [a]\n---\nx", ["b"], []);
    expect("text" in cap && cap.text).toBe("---\nTags: [a, b]\n---\nx");
    const flush = editTags("---\ntags:\n- a\n- b\n---\nx", [], ["a"]);
    expect("text" in flush && flush.text).toBe("---\ntags:\n- b\n---\nx");
  });

  it("merges the body Obsidian sees, all of it", async () => {
    const w = world({ "a.md": "---\n---\nFirst half.\n---\nSecond half.\n", "T.md": "# T\n" });
    const r = await batchTool(w.vault, "a.md", "merge_into").run({ target: "T.md" });
    expect(r.proposal?.changes[0]?.after).toContain("First half.\n---\nSecond half.");
  });
});

describe("7. the record store does not lose a record", () => {
  /** A fake of Obsidian's data adapter, in memory, that can be told to fail a rename once, and counts writes. */
  function adapter() {
    const files = new Map<string, string>();
    const dirs = new Set<string>();
    let failRename = false;
    const writes: string[] = [];
    return {
      files,
      writes,
      failNextRename: () => (failRename = true),
      exists: async (p: string) => files.has(p) || dirs.has(p),
      mkdir: async (p: string) => void dirs.add(p),
      write: async (p: string, t: string) => {
        writes.push(p);
        files.set(p, t);
      },
      read: async (p: string) => files.get(p) ?? Promise.reject(new Error("no file")),
      remove: async (p: string) => void files.delete(p),
      rmdir: async (p: string) => {
        dirs.delete(p);
        for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k);
      },
      rename: async (a: string, b: string) => {
        if (failRename) {
          failRename = false;
          throw new Error("stopped");
        }
        files.set(b, files.get(a)!);
        files.delete(a);
      },
      list: async (dir: string) => ({
        files: [...files.keys()].filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes("/")),
        folders: [...dirs].filter((d) => d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes("/")),
      }),
    };
  }
  const rec = (id: string, n: number, tag = ""): BatchRecord => ({ job: { id, instruction: "", selection: "", paths: [], model: "", allowShrink: false, createdAt: `2026-11-23T00:00:0${n}Z` }, status: "running", steps: Array.from({ length: n }, (_, i) => ({ path: `${i}.md`, status: "applied", summary: tag, changes: [], inverse: [], findings: [], at: "" })) });

  it("reads back what it wrote, one file per step, rewriting only the steps that changed", async () => {
    const a = adapter();
    const store = new AdapterBatchStore(a as never, "b");
    await store.write(rec("j1", 3));
    expect((await store.read("j1"))?.steps).toHaveLength(3);
    a.writes.length = 0;
    const r = rec("j1", 4);
    await store.write(r);
    // Only the new step and the small job file: steps 0-2 are as they were.
    expect(a.writes.map((w) => w.replace(/\.[^.]+\.tmp$/, ""))).toEqual(["b/j1/step-00003.json", "b/j1/job.json"]);
    expect((await store.list()).map((x) => x.job.id)).toEqual(["j1"]);
  });

  it("finds the job file from a write cut short between taking the old one away and moving the new one in", async () => {
    const a = adapter();
    const store = new AdapterBatchStore(a as never, "b");
    await store.write(rec("j1", 1));
    a.failNextRename();
    // The new step is written; the job file's own move is the one cut short.
    await expect(store.write(rec("j1", 1, "changed"))).rejects.toThrow("stopped");
    const back = await new AdapterBatchStore(a as never, "b").read("j1");
    expect(back?.steps).toHaveLength(1);
  });

  it("makes overlapping writes one after another, ending with the last, and forgets a job when asked", async () => {
    const a = adapter();
    const store = new AdapterBatchStore(a as never, "b");
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.write(rec("j2", n))));
    expect((await store.read("j2"))?.steps).toHaveLength(5);
    expect([...a.files.keys()].filter((k) => k.endsWith(".tmp"))).toEqual([]);
    await store.forget("j2");
    expect(await store.read("j2")).toBeUndefined();
    expect([...a.files.keys()]).toEqual([]);
  });
});

describe("8–9. a step stopped part-way can still be undone", () => {
  it("8: keeps the undo of a step whose own rollback failed, as 'pending', and undo puts it back", async () => {
    let failDelete = true;
    let failModify = false;
    const w = world({ "a.md": "The whole of a.", "T.md": "# T\n" }, {});
    const io = w.io;
    const flaky: VaultIO = {
      ...io,
      delete: async (p) => {
        if (failDelete) {
          failDelete = false;
          failModify = true;
          throw new Error("trash failed");
        }
        return io.delete(p);
      },
      modify: async (p, c) => {
        if (failModify) {
          failModify = false;
          throw new Error("disk busy");
        }
        return io.modify(p, c);
      },
    };
    const runner = new BatchRunner({
      executor: new ActionExecutor(flaky),
      store: w.store,
      work: async () => ({
        summary: "",
        changes: [
          { type: "modify", path: "T.md", before: "# T\n", after: "# T\n\n## a\n\nThe whole of a.\n" },
          { type: "delete", path: "a.md", before: "The whole of a." },
        ],
        findings: [],
      }),
    });
    const id = (await runner.run((await runner.create(spec(["a.md"]), "m")).job.id)).job.id;
    const rec = (await w.store.read(id))!;
    expect(rec.steps[0]?.status).toBe("pending");
    expect(w.files.get("T.md")).toContain("The whole of a.");
    await runner.undo(id);
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": "The whole of a.", "T.md": "# T\n" });
  });

  it("9: undoes exactly what landed of a step the app stopped in the middle of", async () => {
    const w = world({ "a.md": "text" });
    const changes: FileChange[] = [
      { type: "modify", path: "a.md", before: "text", after: "---\ntags: [x]\n---\ntext" },
      { type: "move", path: "a.md", to: "B/a.md" },
      { type: "modify", path: "B/a.md", before: "---\ntags: [x]\n---\ntext", after: "---\ntags: [x]\n---\ntext!" },
    ];
    const runner = new BatchRunner({ executor: w.executor, store: w.store, work: async () => ({ summary: "", changes: [], findings: [] }) });
    const rec = await runner.create(spec(["a.md"]), "m");
    // The first change landed; the app stopped while on the second.
    w.files.set("a.md", "---\ntags: [x]\n---\ntext");
    rec.steps.push({ path: "a.md", status: "pending", summary: "", changes, inverse: inverseOf(changes), findings: [], at: "", attempting: 1 });
    await w.store.write(rec);
    const r = await runner.undo(rec.job.id);
    expect(r.problems).toEqual([]);
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": "text" });
    expect(r.record.status).toBe("undone");
  });

  it("9: a step stopped before its first change has nothing to undo", async () => {
    const w = world({ "a.md": "text" });
    const runner = new BatchRunner({ executor: w.executor, store: w.store, work: async () => ({ summary: "", changes: [], findings: [] }) });
    const rec = await runner.create(spec(["a.md"]), "m");
    const changes: FileChange[] = [{ type: "move", path: "a.md", to: "B/a.md" }, { type: "modify", path: "B/a.md", before: "text", after: "t" }];
    rec.steps.push({ path: "a.md", status: "pending", summary: "", changes, inverse: inverseOf(changes), findings: [], at: "" });
    await w.store.write(rec);
    expect((await runner.undo(rec.job.id)).record.status).toBe("undone");
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": "text" });
  });

  it("9: the record says which change it was on, before each one", async () => {
    const w = world({ "a.md": "text" });
    const seen: Array<number | undefined> = [];
    const store = { ...w.store, write: async (r: BatchRecord) => (seen.push(r.steps[0]?.attempting), w.store.write(r)) };
    const runner = new BatchRunner({
      executor: w.executor,
      store,
      work: async (): Promise<AgentResult> => ({ summary: "", changes: [{ type: "modify", path: "a.md", before: "text", after: "text!" }, { type: "move", path: "a.md", to: "B/a.md" }], findings: [] }),
    });
    await runner.run((await runner.create(spec(["a.md"]), "m")).job.id);
    expect(seen).toContain(0);
    expect(seen).toContain(1);
  });
});

describe("10. link guards hold after a move in the same step", () => {
  it("will not trash a linked note it has just moved", async () => {
    const w = world({ "a.md": "a", "index.md": "[[a]]" });
    const o = overlayVault(w.vault, { journal: () => false });
    o.record([{ type: "move", path: "a.md", to: "B/a.md" }]);
    const t = await vaultTools(o.vault, { mode: "batch", note: () => "B/a.md" }).find((x) => x.name === "trash")!.run({});
    expect(t.proposal).toBeUndefined();
    expect(t.text).toMatch(/links to it/);
  });
});

describe("11–12. nothing is written over text that changed since it was read", () => {
  it("11: an edit made after a move in the same step does not overwrite the link Obsidian rewrote", async () => {
    const w = world({ "a.md": "a", "index.md": "See [[a]]." });
    const io = w.io;
    // Obsidian, on a move, rewrites links to the moved note in other notes.
    const linking: VaultIO = {
      ...io,
      rename: async (from, to) => {
        await io.rename!(from, to);
        w.files.set("index.md", w.files.get("index.md")!.replace("[[a]]", `[[${to.replace(/\.md$/, "")}]]`));
      },
    };
    const exec = new ActionExecutor(linking);
    await expect(
      exec.applyRaw([
        { type: "move", path: "a.md", to: "B/a.md" },
        { type: "modify", path: "index.md", before: "See [[a]].", after: "See [[a]]. Edited." },
      ]),
    ).rejects.toThrow(/changed since/);
    // Rolled back whole: the note is back, and Obsidian's own rewrite was not overwritten by the stale edit.
    expect(w.files.has("a.md")).toBe(true);
    expect(w.files.get("index.md")).not.toContain("Edited.");
  });

  it("12: checks and writes in one step where the vault can, so a write landing in between is never overwritten", async () => {
    const w = world({ "a.md": "old" });
    let calls = 0;
    const io: VaultIO = {
      ...w.io,
      process: async (p, fn) => {
        calls++;
        // Someone typed between the action being checked and the write.
        w.files.set(p, "old, and what the owner typed");
        w.files.set(p, fn(w.files.get(p)!));
      },
    };
    await expect(new ActionExecutor(io).applyRaw([{ type: "modify", path: "a.md", before: "old", after: "new" }])).rejects.toThrow(/changed since/);
    expect(calls).toBe(1);
    expect(w.files.get("a.md")).toBe("old, and what the owner typed");
  });

  it("leaves a note open in the editor, so nothing being typed is lost", async () => {
    const w = world({ "a.md": "a" });
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      isOpen: (p) => p === "a.md",
      work: async () => ({ summary: "", changes: [{ type: "modify", path: "a.md", before: "a", after: "b" }], findings: [] }),
    });
    const rec = await runner.run((await runner.create(spec(["a.md"]), "m")).job.id);
    expect(rec.steps[0]?.why).toMatch(/open in the editor/);
    expect(w.files.get("a.md")).toBe("a");
  });
});

describe("low: links in code, case, and folder walls", () => {
  it("relinks without regard to case and never inside code", () => {
    const r = relink("[[a]] `[[A]]`\n```\n[[A]]\n```\n[[A|x]]", "A.md", "T.md");
    expect(r.text).toBe("[[T|A]] `[[A]]`\n```\n[[A]]\n```\n[[T|x]]");
    expect(r.count).toBe(2);
  });

  it("walls folders without regard to case", () => {
    expect(underFolder("journal/x.md", "Journal")).toBe(true);
    expect(inFolders("PERSONAL/Journal/x.md", ["Personal/Journal"])).toBe(true);
  });
});

describe("failed notes are tried again", () => {
  it("retries, on the next run, a note that failed with nothing applied — and only that one", async () => {
    const w = world({ "a.md": "a", "b.md": "b" });
    let open = true;
    const calls: string[] = [];
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      isOpen: (p) => open && p === "a.md",
      work: async (path) => {
        calls.push(path);
        const before = w.files.get(path)!;
        return { summary: "", changes: [{ type: "modify", path, before, after: `${before}!` }], findings: [] };
      },
    });
    const id = (await runner.create(spec(["a.md", "b.md"]), "m")).job.id;
    const first = await runner.run(id);
    expect(first.steps.map((s) => s.status)).toEqual(["failed", "applied"]);
    open = false;
    const second = await runner.run(id);
    expect(calls).toEqual(["a.md", "b.md", "a.md"]);
    expect(second.steps.map((s) => [s.path, s.status])).toEqual([["b.md", "applied"], ["a.md", "applied"]]);
    expect(Object.fromEntries(w.files)).toEqual({ "a.md": "a!", "b.md": "b!" });
  });
});

