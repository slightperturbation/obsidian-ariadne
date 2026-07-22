import type { IndexManager } from "./manager";
import type { SourceNote } from "../core/types";
import type { StatusStore } from "../core/status";
import { yieldToUI } from "../platform";

export interface SchedulerOptions {
  /** Quiet period after a change before indexing starts. */
  debounceMs?: number;
  /** Time budget per batch before yielding back to the UI. */
  batchBudgetMs?: number;
  /** Called after a drain leaves the queue empty — the persistence hook. */
  onIdle?: () => void;
}

type LoadNote = (path: string) => Promise<SourceNote | null>;

/**
 * Incremental indexer: vault events mark paths dirty; after a debounce the
 * queue drains in time-boxed batches, yielding to the UI between batches so
 * indexing can never stall a keystroke. Deliberately Obsidian-free — the
 * plugin wires vault/metadata events to markDirty/markDeleted/markRenamed,
 * and hands in a loader closure. A full rebuild is just "everything dirty",
 * so there is exactly one indexing code path to trust.
 */
export class IncrementalScheduler {
  private dirty = new Set<string>();
  private deleted = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private disposed = false;
  /** Progress through the current burst (everything queued since last idle). */
  private burstDone = 0;
  private burstTotal = 0;

  private readonly debounceMs: number;
  private readonly batchBudgetMs: number;
  private readonly onIdle?: () => void;

  constructor(
    private manager: IndexManager,
    private load: LoadNote,
    private status?: StatusStore,
    opts: SchedulerOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 400;
    this.batchBudgetMs = opts.batchBudgetMs ?? 12;
    this.onIdle = opts.onIdle;
  }

  private isQueued(path: string): boolean {
    return this.dirty.has(path) || this.deleted.has(path);
  }

  markDirty(path: string): void {
    if (this.disposed) return;
    if (!this.isQueued(path)) this.burstTotal++;
    this.deleted.delete(path);
    this.dirty.add(path);
    this.schedule();
  }

  markDeleted(path: string): void {
    if (this.disposed) return;
    if (!this.isQueued(path)) this.burstTotal++;
    this.dirty.delete(path);
    this.deleted.add(path);
    this.schedule();
  }

  markRenamed(oldPath: string, newPath: string): void {
    this.markDeleted(oldPath);
    this.markDirty(newPath);
  }

  /** Queue every given path — a full (re)build through the incremental path. */
  enqueueAll(paths: string[]): void {
    if (this.disposed) return;
    for (const p of paths) {
      if (!this.isQueued(p)) this.burstTotal++;
      this.deleted.delete(p);
      this.dirty.add(p);
    }
    this.schedule();
  }

  get pending(): number {
    return this.dirty.size + this.deleted.size;
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Drain the queue now. Safe to call concurrently; only one drain runs. */
  async flush(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (this.pending > 0 && !this.disposed) {
        const batchStart = Date.now();

        // Deletions are cheap — clear them all first.
        for (const path of [...this.deleted]) {
          this.deleted.delete(path);
          this.manager.removeNote(path);
          this.burstDone++;
        }

        // Index dirty paths until the time budget is spent, then yield.
        for (const path of [...this.dirty]) {
          this.dirty.delete(path);
          const note = await this.load(path);
          if (note) await this.manager.indexNote(note);
          else this.manager.removeNote(path);
          this.burstDone++;
          if (Date.now() - batchStart > this.batchBudgetMs) break;
        }

        this.status?.set({
          index: "indexing",
          indexedNotes: this.manager.noteCount,
          progressDone: this.burstDone,
          progressTotal: this.burstTotal,
        });
        await yieldToUI();
      }
      this.burstDone = 0;
      this.burstTotal = 0;
      this.status?.set({
        index: "idle",
        indexedNotes: this.manager.noteCount,
        progressDone: 0,
        progressTotal: 0,
      });
      this.onIdle?.();
    } catch (err) {
      this.status?.set({ index: "error", lastError: String(err) });
    } finally {
      this.running = false;
    }
    // Changes that arrived while an error unwound: try again on the next tick.
    if (this.pending > 0 && !this.disposed && this.timer === null) this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
    this.deleted.clear();
  }
}
