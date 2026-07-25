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

/** Attempts before a path is left out of the queue and reported as failed. */
const MAX_ATTEMPTS = 3;

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
  /** Consecutive failures per path, so a poison note can't loop forever. */
  private failures = new Map<string, number>();

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

  /**
   * Drain the queue now. Safe to call concurrently; only one drain runs.
   *
   * Each path is isolated: a note that throws is retried a bounded number of
   * times and then reported, rather than taking down the whole drain. That
   * matters because indexNote() removes a note before re-adding it — an
   * unhandled throw there used to leave the note deleted from the index and
   * never re-queued, silently making it unsearchable for the session.
   */
  async flush(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    let lastError: unknown;
    try {
      while (this.pending > 0 && !this.disposed) {
        const batchStart = Date.now();

        // Deletions are cheap individually, but a folder delete can queue
        // thousands — so they respect the time budget too.
        for (const path of [...this.deleted]) {
          this.deleted.delete(path);
          try {
            this.manager.removeNote(path);
          } catch (err) {
            lastError = err;
          }
          this.burstDone++;
          if (Date.now() - batchStart > this.batchBudgetMs) break;
        }

        // Index dirty paths until the time budget is spent, then yield.
        for (const path of [...this.dirty]) {
          this.dirty.delete(path);
          try {
            const note = await this.load(path);
            if (note) await this.manager.indexNote(note);
            else this.manager.removeNote(path);
            this.failures.delete(path);
          } catch (err) {
            lastError = err;
            const attempts = (this.failures.get(path) ?? 0) + 1;
            this.failures.set(path, attempts);
            // Re-queue transient failures (a file mid-write, a worker hiccup)
            // instead of dropping the note out of the index for good.
            if (attempts < MAX_ATTEMPTS) this.dirty.add(path);
          }
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
        // A path re-queued above would otherwise spin this loop immediately;
        // let the debounce reschedule it instead.
        if (this.pending > 0 && this.dirty.size > 0 && lastError && this.allPendingFailed()) break;
      }
    } finally {
      // Always reset progress and persist, even after errors — the save hook
      // is the only persistence trigger, so skipping it on error meant an
      // errored session never wrote its index at all. Anything still queued
      // (a re-queued failure) becomes the next burst's baseline, so progress
      // can't exceed its own total.
      this.burstDone = 0;
      this.burstTotal = this.pending;
      this.status?.set({
        index: lastError ? "error" : "idle",
        indexedNotes: this.manager.noteCount,
        progressDone: 0,
        progressTotal: 0,
        ...(lastError ? { lastError: String(lastError) } : {}),
      });
      this.running = false;
      try {
        this.onIdle?.();
      } catch {
        /* persistence failures are reported by the caller */
      }
    }
    // Changes that arrived (or were re-queued) while draining: try again.
    if (this.pending > 0 && !this.disposed && this.timer === null) this.schedule();
  }

  /** True when every still-queued path has already failed at least once. */
  private allPendingFailed(): boolean {
    for (const path of this.dirty) if (!this.failures.has(path)) return false;
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
    this.deleted.clear();
  }
}
