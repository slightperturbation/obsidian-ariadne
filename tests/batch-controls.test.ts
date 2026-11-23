/**
 * The job card's controls and the tester's findings: ending a job after the
 * sample, a job that must stop as a whole (a cost limit), and an undo that
 * meets a note open in the editor and is finished once it is closed.
 */
import { describe, expect, it } from "vitest";
import { ActionExecutor, type VaultIO } from "../src/actions/framework";
import type { Complete, JobSpec } from "../src/chat/engine";
import type { VaultAccess } from "../src/chat/tools";
import { memoryBatchStore } from "../src/batch/record";
import { BatchRunner, StopJob, workOnNote } from "../src/batch/runner";

function world(initial: Record<string, string>) {
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
  return { files, io, executor: new ActionExecutor(io), store: memoryBatchStore() };
}

const spec = (paths: string[]): JobSpec => ({ instruction: "Tag each note about the project.", selection: "Inbox", paths, leftOut: [], allowShrink: false });
const tagged = (t: string) => `---\ntags:\n  - project\n---\n${t}`;

describe("ending a job after the sample", () => {
  it("ends a paused job that changed nothing, and it is not run on", async () => {
    const w = world({ "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d" });
    let worked = 0;
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: async () => (worked++, { summary: "not about it", changes: [], findings: [] }),
    });
    const id = (await runner.create(spec(["a.md", "b.md", "c.md", "d.md"]), "m")).job.id;
    expect((await runner.run(id, { pauseAfter: 3 })).status).toBe("paused");
    expect((await runner.end(id)).status).toBe("ended");
    const again = await runner.run(id);
    expect(again.status).toBe("ended");
    expect(worked).toBe(3);
  });

  it("an ended job that changed notes can still be undone, whole", async () => {
    const w = world({ "a.md": "a", "b.md": "b", "c.md": "c", "d.md": "d" });
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: async (p) => ({ summary: "tagged", changes: [{ type: "modify", path: p, before: w.files.get(p)!, after: tagged(w.files.get(p)!) }], findings: [] }),
    });
    const id = (await runner.create(spec(["a.md", "b.md", "c.md", "d.md"]), "m")).job.id;
    await runner.run(id, { pauseAfter: 3 });
    await runner.end(id);
    const r = await runner.undo(id);
    expect(r.undone).toBe(3);
    expect(r.record.status).toBe("undone");
    expect([...w.files.values()]).toEqual(["a", "b", "c", "d"]);
  });

  it("will not end a job while it runs", async () => {
    const w = world({ "a.md": "a" });
    let release!: () => void;
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: () => new Promise((ok) => (release = () => ok({ summary: "", changes: [], findings: [] }))),
    });
    const id = (await runner.create(spec(["a.md"]), "m")).job.id;
    const running = runner.run(id);
    await new Promise((r) => setTimeout(r, 0));
    await expect(runner.end(id)).rejects.toThrow(/stop the job first/);
    release();
    expect((await running).status).toBe("done");
  });
});

describe("a job that must stop as a whole", () => {
  const vault = (files: Map<string, string>): VaultAccess => ({
    search: async () => [],
    read: async (p) => files.get(p),
    readable: () => ({ ok: true }),
    resolve: (n) => [n, `${n}.md`].find((p) => files.has(p)),
    notes: () => [...files.keys()].map((path) => ({ path, mtime: 0, tags: [] })),
    open: async () => {},
    exists: (p) => files.has(p),
    writable: () => ({ ok: true }),
    levelAt: () => "shareable",
    modelName: () => "m",
    today: () => "2026-11-23",
  });

  it("stops at the note the limit was met on, records nothing for it, and works on it when resumed", async () => {
    const w = world({ "a.md": "about the project", "b.md": "about the project too", "c.md": "and this" });
    let calls = 0;
    let limitHit = true;
    const complete: Complete = async (prompt) => {
      calls++;
      if (prompt.includes("This note: b.md") && limitHit) throw new StopJob("the session cost limit ($2.00) is reached");
      if (prompt.includes("Does the instruction call for")) return '{"applies": false, "why": "not about it"}';
      return '{"tool": "answer", "answer": "Left: nothing to do."}';
    };
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: (path, job) => workOnNote(path, job, { vault: vault(w.files), complete, isJournal: () => false, today: () => "2026-11-23" }),
    });
    const id = (await runner.create(spec(["a.md", "b.md", "c.md"]), "m")).job.id;
    const stopped = await runner.run(id);
    expect(stopped.status).toBe("stopped");
    expect(stopped.why).toMatch(/cost limit/);
    expect(stopped.steps.map((s) => s.path)).toEqual(["a.md"]);
    limitHit = false;
    const resumed = await runner.run(id);
    expect(resumed.status).toBe("done");
    expect(resumed.why).toBeUndefined();
    expect(resumed.steps.map((s) => [s.path, s.status])).toEqual([
      ["a.md", "left"],
      ["b.md", "left"],
      ["c.md", "left"],
    ]);
    expect(calls).toBeGreaterThan(3);
  });

  it("a stop in the middle of a note's work applies nothing it had decided", async () => {
    const w = world({ "a.md": "about the project" });
    let step = 0;
    const complete: Complete = async (prompt) => {
      if (prompt.includes("Does the instruction call for")) return '{"applies": true, "why": "it is"}';
      step++;
      if (step === 1) return '{"tool": "propose_tags", "args": {"paths": ["a.md"], "add": ["project"], "reason": "it is about it"}}';
      throw new StopJob("the session cost limit ($2.00) is reached");
    };
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      work: (path, job) => workOnNote(path, job, { vault: vault(w.files), complete, isJournal: () => false, today: () => "2026-11-23" }),
    });
    const id = (await runner.create(spec(["a.md"]), "m")).job.id;
    const r = await runner.run(id);
    expect(r.status).toBe("stopped");
    expect(r.steps).toEqual([]);
    expect(w.files.get("a.md")).toBe("about the project");
  });
});

describe("an undo that meets a note open in the editor", () => {
  it("puts back the others, says which is open, and finishes once it is closed — every note as it was", async () => {
    const before = {
      "Inbox/Physics Engine.md": "#virtual_creatures\n\n* rigid body simulation\n",
      "Inbox/Competitions.md": "\nA list of competitions.\n",
    };
    const w = world(before);
    const open = new Set<string>();
    const runner = new BatchRunner({
      executor: w.executor,
      store: w.store,
      // Being typed in, now: a note that is only open is undone through its editor and does not wait.
      busy: (p) => (open.has(p) ? "you are typing in it" : undefined),
      work: async (p) => ({ summary: "tagged", changes: [{ type: "modify", path: p, before: w.files.get(p)!, after: `---\ntags:\n  - Virtual_Creatures\n---\n${w.files.get(p)!}` }], findings: [] }),
    });
    const id = (await runner.create(spec(Object.keys(before)), "m")).job.id;
    await runner.run(id);
    open.add("Inbox/Physics Engine.md");
    const first = await runner.undo(id);
    expect(first.undone).toBe(1);
    expect(first.problems).toEqual(["Inbox/Physics Engine.md: not undone yet (you are typing in it)"]);
    expect(first.record.status).toBe("done");
    expect(first.record.steps.find((s) => s.path === "Inbox/Physics Engine.md")?.why).toMatch(/^not undone yet/);
    expect(w.files.get("Inbox/Competitions.md")).toBe(before["Inbox/Competitions.md"]);
    open.clear();
    const second = await runner.undo(id);
    expect(second.undone).toBe(1);
    expect(second.problems).toEqual([]);
    expect(second.record.status).toBe("undone");
    expect(Object.fromEntries(w.files)).toEqual(before);
    // A third undo has nothing left to do and changes nothing.
    const third = await runner.undo(id);
    expect(third.undone).toBe(0);
    expect(Object.fromEntries(w.files)).toEqual(before);
  });
});
