import { describe, expect, it } from "vitest";
import { IndexManager } from "../src/index/manager";
import { IncrementalScheduler } from "../src/index/scheduler";
import { StatusStore } from "../src/core/status";
import type { SourceNote } from "../src/core/types";

function note(path: string, content: string): SourceNote {
  return {
    path,
    title: path.replace(/\.md$/, ""),
    content,
    mtime: Date.now(),
    folder: "",
  };
}

function setup(notes: SourceNote[]) {
  const store = new Map(notes.map((n) => [n.path, n]));
  const manager = new IndexManager();
  const status = new StatusStore();
  const scheduler = new IncrementalScheduler(
    manager,
    async (path) => store.get(path) ?? null,
    status,
    { debounceMs: 5, batchBudgetMs: 50 },
  );
  return { store, manager, status, scheduler };
}

describe("IncrementalScheduler", () => {
  it("indexes dirty paths on flush", async () => {
    const { manager, scheduler } = setup([note("a.md", "alpha centauri"), note("b.md", "beta")]);
    scheduler.markDirty("a.md");
    scheduler.markDirty("b.md");
    await scheduler.flush();
    expect(manager.noteCount).toBe(2);
    expect(scheduler.pending).toBe(0);
    const hits = await manager.query("alpha");
    expect(hits[0]?.path).toBe("a.md");
  });

  it("removes deleted notes and handles rename as delete+add", async () => {
    const { store, manager, scheduler } = setup([note("a.md", "alpha")]);
    scheduler.markDirty("a.md");
    await scheduler.flush();
    expect(manager.noteCount).toBe(1);

    store.delete("a.md");
    store.set("b.md", note("b.md", "alpha"));
    scheduler.markRenamed("a.md", "b.md");
    await scheduler.flush();
    expect(manager.noteCount).toBe(1);
    expect((await manager.query("alpha"))[0]?.path).toBe("b.md");
  });

  it("treats a dirty path whose note vanished as a removal", async () => {
    const { store, manager, scheduler } = setup([note("a.md", "alpha")]);
    scheduler.markDirty("a.md");
    await scheduler.flush();
    store.delete("a.md");
    scheduler.markDirty("a.md");
    await scheduler.flush();
    expect(manager.noteCount).toBe(0);
  });

  it("enqueueAll runs a full build and reports progress via status", async () => {
    const notes = Array.from({ length: 20 }, (_, i) => note(`n${i}.md`, `note number ${i}`));
    const { manager, status, scheduler } = setup(notes);
    const states: string[] = [];
    status.subscribe((s) => states.push(s.index));

    scheduler.enqueueAll(notes.map((n) => n.path));
    await scheduler.flush();

    expect(manager.noteCount).toBe(20);
    expect(states).toContain("indexing");
    expect(status.get().index).toBe("idle");
    expect(status.get().indexedNotes).toBe(20);
    // Burst progress resets once the drain completes.
    expect(status.get().progressDone).toBe(0);
    expect(status.get().progressTotal).toBe(0);
  });

  it("debounce runs the flush without an explicit call", async () => {
    const { manager, scheduler } = setup([note("a.md", "alpha")]);
    scheduler.markDirty("a.md");
    await new Promise((r) => setTimeout(r, 40));
    expect(manager.noteCount).toBe(1);
  });

  it("reports an error status when a load throws, and recovers", async () => {
    const manager = new IndexManager();
    const status = new StatusStore();
    let shouldThrow = true;
    const scheduler = new IncrementalScheduler(
      manager,
      async (path) => {
        if (shouldThrow) throw new Error("boom");
        return note(path, "recovered content");
      },
      status,
      { debounceMs: 5 },
    );

    scheduler.markDirty("a.md");
    await scheduler.flush();
    expect(status.get().index).toBe("error");
    expect(status.get().lastError).toContain("boom");

    shouldThrow = false;
    scheduler.markDirty("a.md");
    await scheduler.flush();
    expect(status.get().index).toBe("idle");
    expect(manager.noteCount).toBe(1);
  });

  it("ignores marks after dispose", async () => {
    const { manager, scheduler } = setup([note("a.md", "alpha")]);
    scheduler.dispose();
    scheduler.markDirty("a.md");
    await scheduler.flush();
    expect(manager.noteCount).toBe(0);
    expect(scheduler.pending).toBe(0);
  });
});
