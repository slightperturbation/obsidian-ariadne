/**
 * The facts a note's model is told beside the note — the dates its name stands
 * for, the owner's own words, how a day's journal entry is named — and an undo
 * that takes away the folders a job made.
 */
import { describe, expect, it } from "vitest";
import { ActionExecutor, type VaultIO } from "../src/actions/framework";
import type { Complete, JobSpec } from "../src/chat/engine";
import type { VaultAccess } from "../src/chat/tools";
import { nameDates, wrongDay } from "../src/batch/dates";
import { memoryBatchStore } from "../src/batch/record";
import { BatchRunner, noteFacts, workOnNote } from "../src/batch/runner";

describe("the dates in a note's name", () => {
  it("gives every day of an ISO week, Monday to Sunday", () => {
    expect(nameDates("Periodic/Weekly/2025-W18.md")).toBe(
      "2025-W18 is ISO week 18 of 2025, Monday to Sunday: Monday 2025-04-28, Tuesday 2025-04-29, Wednesday 2025-04-30, Thursday 2025-05-01, Friday 2025-05-02, Saturday 2025-05-03, Sunday 2025-05-04.",
    );
  });

  it("gets the last day of every week the tester's job got wrong — and the ones at the turn of a year", () => {
    const sunday = (w: string) => /Sunday (\d{4}-\d{2}-\d{2})\.$/.exec(nameDates(`${w}.md`)!)![1];
    expect(["2024-W03", "2024-W11", "2025-W16", "2025-W20", "2024-W44", "2026-W34"].map(sunday)).toEqual([
      "2024-01-21", "2024-03-17", "2025-04-20", "2025-05-18", "2024-11-03", "2026-08-23",
    ]);
    // Week 1 can begin in the year before; week 53 exists only in some years.
    expect(nameDates("2025-W01.md")).toContain("Monday 2024-12-30");
    expect(nameDates("2020-W53.md")).toContain("Sunday 2021-01-03");
    expect(nameDates("2025-W53.md")).toBe("2025-W53: the year 2025 has no such ISO week.");
    expect(nameDates("2025-W5.md")).toContain("2025-W05 is ISO week 5 of 2025");
  });

  it("says what day a dated note is, and its week; nothing for a name with no date", () => {
    expect(nameDates("Journal/2025-05-04.md")).toBe("2025-05-04 is a Sunday, in ISO week 2025-W18 (Monday 2025-04-28 to Sunday 2025-05-04).");
    expect(nameDates("Journal/2024-12-30 Monday.md")).toContain("in ISO week 2025-W01");
    expect(nameDates("Journal/2025-02-30.md")).toBeUndefined();
    expect(nameDates("Ideas/Garden plan.md")).toBeUndefined();
  });
});

function vault(files: Map<string, string>): VaultAccess {
  return {
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
  };
}

describe("what a note's model is told beside the note", () => {
  it("the owner's own words, the week's dates, and how a day's journal entry is named", () => {
    const files = new Map([["Periodic/Weekly/2025-W18.md", "w"], ["Personal/Journal/2025-05-01.md", "d"]]);
    const journal = (p: string) => p.startsWith("Personal/Journal/");
    const facts = noteFacts("Periodic/Weekly/2025-W18.md", { request: "move them into Personal/Journal/{date}" }, vault(files), journal);
    expect(facts).toContain('The owner\'s own words, when they asked for this job:\n"move them into Personal/Journal/{date}"');
    expect(facts).toContain("Sunday 2025-05-04");
    expect(facts).toContain("A day's journal entry in this vault is a note named like Personal/Journal/2025-05-01.md.");
    expect(noteFacts("Ideas/x.md", {}, vault(new Map([["Ideas/x.md", "x"]])), journal)).toBe("");
  });

  it("is in both prompts: the decision, and the work", async () => {
    const files = new Map([["Periodic/Weekly/2025-W18.md", "A good week."]]);
    const prompts: string[] = [];
    const complete: Complete = async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? '{"applies": true, "why": "it has content"}' : '{"tool": "answer", "answer": "Left: nothing to do."}';
    };
    await workOnNote("Periodic/Weekly/2025-W18.md", { instruction: "Move it to the journal.", request: "my words" }, { vault: vault(files), complete, isJournal: () => false, today: () => "" });
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      expect(p).toContain("Sunday 2025-05-04");
      expect(p).toContain('"my words"');
    }
  });
});

describe("undoing a job takes away the folders it made", () => {
  it("removes a folder a move made once the undo leaves it empty, deepest first — and keeps folders that were there", async () => {
    const files = new Map([["Weekly/2025-W18.md", "w"], ["Journal/old.md", "o"]]);
    const folders = new Set(["Weekly", "Journal"]);
    const removed: string[] = [];
    const io: VaultIO = {
      exists: async (p) => files.has(p),
      read: async (p) => files.get(p) ?? Promise.reject(new Error(`not found: ${p}`)),
      create: async (p, c) => void files.set(p, c),
      modify: async (p, c) => void files.set(p, c),
      delete: async (p) => void files.delete(p),
      rename: async (a, b) => {
        files.set(b, files.get(a)!);
        files.delete(a);
        b.split("/").slice(0, -1).forEach((_, i, parts) => folders.add(parts.slice(0, i + 1).join("/")));
      },
    };
    const runner = new BatchRunner({
      executor: new ActionExecutor(io),
      store: memoryBatchStore(),
      folders: {
        exists: (p) => folders.has(p),
        removeIfEmpty: async (p) => {
          if ([...files.keys()].some((f) => f.startsWith(`${p}/`)) || [...folders].some((f) => f.startsWith(`${p}/`))) return;
          folders.delete(p);
          removed.push(p);
        },
      },
      work: async () => ({ summary: "", changes: [{ type: "move", path: "Weekly/2025-W18.md", to: "Journal/2025/05-04/2025-W18.md" }], findings: [] }),
    });
    const spec: JobSpec = { instruction: "Move it.", selection: "Weekly", paths: ["Weekly/2025-W18.md"], leftOut: [], allowShrink: false };
    const done = await runner.run((await runner.create(spec, "m")).job.id);
    expect(done.steps[0]?.folders).toEqual(["Journal/2025", "Journal/2025/05-04"]);
    await runner.undo(done.job.id);
    expect(files.has("Weekly/2025-W18.md")).toBe(true);
    expect(removed).toEqual(["Journal/2025/05-04", "Journal/2025"]);
    expect(folders.has("Journal")).toBe(true);
  });
});

describe("a dated note put into a note for another day is held", () => {
  const week = "A week of notes, long enough to count as its text.";
  it("holds a weekly note merged into today's journal entry, or moved to a day outside its week", () => {
    expect(wrongDay("Weekly/2024-W03.md", [
      { type: "modify", path: "Journal/2026-11-23.md", before: "Today.", after: `Today.\n\n## 2024-W03\n\n${week}` },
      { type: "delete", path: "Weekly/2024-W03.md", before: week },
    ])).toBe("it would go into Journal/2026-11-23.md, but this note's name dates it to 2024-W03 (2024-01-15 to 2024-01-21)");
    expect(wrongDay("Weekly/2025-W18.md", [{ type: "move", path: "Weekly/2025-W18.md", to: "Journal/2025-04-27.md" }])).toMatch(/2025-W18 \(2025-04-28 to 2025-05-04\)/);
    expect(wrongDay("Daily/2025-05-04.md", [{ type: "move", path: "Daily/2025-05-04.md", to: "Journal/2025-05-05.md" }])).toBe("it would go into Journal/2025-05-05.md, but this note's name dates it to 2025-05-04");
  });

  it("lets any day of its own week through, a link pointed elsewhere in another day's note, and notes with no date", () => {
    expect(wrongDay("Weekly/2025-W15.md", [{ type: "move", path: "Weekly/2025-W15.md", to: "Journal/2025-04-07.md" }])).toBeUndefined();
    expect(wrongDay("Weekly/2025-W15.md", [{ type: "move", path: "Weekly/2025-W15.md", to: "Journal/2025-04-13.md" }])).toBeUndefined();
    expect(wrongDay("Weekly/2024-W03.md", [
      { type: "modify", path: "Journal/2024-01-21.md", before: "Sunday.", after: `Sunday.\n\n## 2024-W03\n\n${week}` },
      { type: "modify", path: "Journal/2026-11-23.md", before: "See [[2024-W03]].", after: "See [[Journal/2024-01-21#2024-W03|2024-W03]]." },
      { type: "delete", path: "Weekly/2024-W03.md", before: week },
    ])).toBeUndefined();
    expect(wrongDay("Ideas/Garden.md", [{ type: "move", path: "Ideas/Garden.md", to: "Journal/2026-11-23.md" }])).toBeUndefined();
  });

  it("tells the model when the note's date property disagrees with its name", () => {
    const files = new Map([["Weekly/2024-W03.md", "w"]]);
    const v = { ...vault(files), properties: () => ({ date: "2026-11-23" }) };
    expect(noteFacts("Weekly/2024-W03.md", {}, v, () => false)).toContain('This note\'s "date" property says 2026-11-23, which is outside 2024-W03, the week its name stands for');
    const fits = { ...vault(files), properties: () => ({ date: "2024-01-15" }) };
    expect(noteFacts("Weekly/2024-W03.md", {}, fits, () => false)).not.toContain('"date" property');
  });
});
