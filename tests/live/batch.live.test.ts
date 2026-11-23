/**
 * Batch jobs with a real local model, on invented notes: one fresh context
 * per note, changes made as it goes, and the whole of it undone at the end.
 *   LIVE_OLLAMA=http://host:11434 LIVE_MODEL=gemma4:26b npx vitest run tests/live/batch.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { ActionExecutor, type VaultIO } from "../../src/actions/framework";
import type { Complete } from "../../src/chat/engine";
import type { VaultAccess } from "../../src/chat/tools";
import { memoryBatchStore } from "../../src/batch/record";
import { BatchRunner, workOnNote } from "../../src/batch/runner";

const base = process.env.LIVE_OLLAMA;
const modelName = process.env.LIVE_MODEL ?? "gemma4:26b";
const run = base ? describe : describe.skip;

const complete: Complete = async (prompt, opts) => {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ model: modelName, stream: false, think: false, format: opts.schema, options: { temperature: 0, num_predict: opts.maxTokens }, messages: [{ role: "system", content: opts.system }, { role: "user", content: prompt }] }),
  });
  return ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
};

function world(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const io: VaultIO = {
    exists: async (p) => files.has(p),
    read: async (p) => files.get(p) ?? Promise.reject(new Error(`not found: ${p}`)),
    create: async (p, c) => void files.set(p, c),
    modify: async (p, c) => void files.set(p, c),
    delete: async (p) => void files.delete(p),
    rename: async (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
  };
  const vault: VaultAccess = {
    search: async () => [],
    read: async (p) => files.get(p),
    readable: () => ({ ok: true }),
    resolve: (n) => [n, `${n}.md`].find((p) => files.has(p)),
    notes: () => [...files.keys()].map((path) => ({ path, mtime: 0, tags: [] })),
    open: async () => {},
    exists: (p) => files.has(p),
    writable: () => ({ ok: true }),
    levelAt: () => "shareable",
    linksTo: () => [],
    modelName: () => modelName,
    today: () => "2026-11-22",
  };
  return { files, io, vault };
}

run("batch jobs, live model", () => {
  it("sorts notes one by one — tags and files the meeting logs, leaves personal writing — and undoes it all", async () => {
    const start = {
      "Inbox/2026-11-03.md": "# Standup\n\nAttendees: Priya, Tom.\n- Release slipped to Friday.\n- Tom owns the migration.\n",
      "Inbox/2026-11-04.md": "# Evening\n\nI sat by the window for an hour and thought about my father's garden, the way he talked to the tomatoes.\n",
      "Inbox/2026-11-05.md": "# Design review\n\nPresent: Ana, Priya.\nDecision: keep the old API for one more release.\n",
    };
    const w = world(start);
    const runner = new BatchRunner({
      executor: new ActionExecutor(w.io),
      store: memoryBatchStore(),
      work: (path, job) => workOnNote(path, job, { vault: w.vault, complete, isJournal: () => false, today: () => "2026-11-22 (Sunday)" }),
    });
    const job = await runner.create(
      { instruction: "If this note is a log of a work meeting, add the tag meeting and move it to the folder Work/Meetings. If it is personal writing, leave it exactly as it is.", selection: "3 notes", paths: Object.keys(start), leftOut: [], allowShrink: false },
      modelName,
    );
    const rec = await runner.run(job.job.id);
    console.log(JSON.stringify(rec.steps.map((s) => [s.path, s.status, s.summary, s.changes.map((c) => `${c.type} ${c.path}${c.to ? ` → ${c.to}` : ""}`)]), null, 1));
    expect(Object.keys(Object.fromEntries(w.files)).sort()).toEqual(["Inbox/2026-11-04.md", "Work/Meetings/2026-11-03.md", "Work/Meetings/2026-11-05.md"]);
    expect(w.files.get("Work/Meetings/2026-11-03.md")).toMatch(/tags:[\s\S]*meeting/);
    expect(w.files.get("Inbox/2026-11-04.md")).toBe(start["Inbox/2026-11-04.md"]);
    // Every word of the meeting notes is still there.
    expect(w.files.get("Work/Meetings/2026-11-05.md")).toContain(start["Inbox/2026-11-05.md"].trim());
    await runner.undo(job.job.id);
    expect(Object.fromEntries(w.files)).toEqual(start);
  }, 900_000);

  it("transforms text in place — fixes the spelling — and keeps everything else word for word", async () => {
    const start = { "Notes/Trip.md": "# Lisbon\n\nWe took the tram to Belem and ate pasteis in the sun. The musuem was closed on Monday, wich was a shame.\n\nNext time: Sintra.\n" };
    const w = world(start);
    const runner = new BatchRunner({
      executor: new ActionExecutor(w.io),
      store: memoryBatchStore(),
      work: (path, job) => workOnNote(path, job, { vault: w.vault, complete, isJournal: () => false, today: () => "2026-11-22 (Sunday)" }),
    });
    const job = await runner.create({ instruction: "Fix spelling mistakes in English words. Change nothing else.", selection: "1 note", paths: ["Notes/Trip.md"], leftOut: [], allowShrink: false }, modelName);
    const rec = await runner.run(job.job.id);
    console.log(JSON.stringify(rec.steps, null, 1).slice(0, 2000));
    const after = w.files.get("Notes/Trip.md")!;
    console.log(after);
    expect(after).toContain("museum");
    expect(after).toContain("which was a shame");
    // Accents a model adds to names it was not asked about are a known overreach, and show in the report's diff;
    // what must hold is that no word is lost or rewritten.
    const fold = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    expect(fold(after)).toContain("We took the tram to Belem and ate pasteis in the sun.");
    expect(after).toContain("Next time: Sintra.");
    await runner.undo(job.job.id);
    expect(w.files.get("Notes/Trip.md")).toBe(start["Notes/Trip.md"]);
  }, 600_000);
});
