import type { DataAdapter } from "obsidian";
import type { BatchRecord, BatchStep, BatchStore } from "./record";

/**
 * Batch records in the plugin's own folder
 * (`.obsidian/plugins/ariadne/batches/<job>/`): a small `job.json` (the job,
 * its status and how many steps there are) and one `step-NNNNN.json` per note.
 * Outside the notes, so they never show up as notes; carried by Sync with the
 * plugin's other files when the owner syncs plugins.
 *
 * A record is what makes "undo all" possible, so losing one is losing the undo:
 *   - a write rewrites only the steps that changed, and job.json — never the
 *     whole record (which, rewritten after every change, came to gigabytes of
 *     writes over a few hundred notes);
 *   - a step's file is written before job.json counts it, so a crash never
 *     leaves job.json counting a step that is not on disk;
 *   - each file is written whole to a temporary file of its own and then moved
 *     into place, and a reader that finds a file missing uses the newest whole
 *     temporary one left by a write that was cut short;
 *   - writes for one job are made one after another.
 */
export class AdapterBatchStore implements BatchStore {
  /** Per job, the write in flight: the next one waits for it. */
  private queue = new Map<string, Promise<void>>();
  /** Per job, each step's file as last written, so unchanged steps are not written again. */
  private written = new Map<string, string[]>();
  private seq = 0;

  constructor(
    private adapter: DataAdapter,
    private dir: string,
  ) {}

  private folder(id: string): string {
    return `${this.dir}/${id.replace(/[^\w-]/g, "_")}`;
  }

  private stepFile(id: string, n: number): string {
    return `${this.folder(id)}/step-${String(n).padStart(5, "0")}.json`;
  }

  write(record: BatchRecord): Promise<void> {
    const id = record.job.id;
    const steps = record.steps.map((s) => JSON.stringify(s));
    const head = JSON.stringify({ job: record.job, status: record.status, steps: steps.length });
    return this.serial(id, () => this.writeNow(id, head, steps));
  }

  private serial(id: string, task: () => Promise<void>): Promise<void> {
    const prev = this.queue.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.queue.set(id, next);
    const clear = () => {
      if (this.queue.get(id) === next) this.queue.delete(id);
    };
    // Cleared either way, without a second, unhandled copy of a failure: the caller gets the failure.
    next.then(clear, clear);
    return next;
  }

  private async ensure(dir: string): Promise<void> {
    if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
  }

  /** One file, whole: to a temporary file, then into place. */
  private async put(target: string, text: string): Promise<void> {
    const temp = `${target}.${Date.now().toString(36)}-${(this.seq++).toString(36)}.tmp`;
    await this.adapter.write(temp, text);
    if (await this.adapter.exists(target)) await this.adapter.remove(target);
    await this.adapter.rename(temp, target);
  }

  private async writeNow(id: string, head: string, steps: string[]): Promise<void> {
    await this.ensure(this.dir);
    const folder = this.folder(id);
    await this.ensure(folder);
    const before = this.written.get(id) ?? (await this.onDisk(id));
    // Steps first, then the head that counts them.
    for (let n = 0; n < steps.length; n++) {
      if (before[n] === steps[n]) continue;
      await this.put(this.stepFile(id, n), steps[n]!);
    }
    await this.put(`${folder}/job.json`, head);
    // Fewer steps than before (failed ones are tried again): the files past the end go.
    for (let n = steps.length; n < before.length; n++) await this.adapter.remove(this.stepFile(id, n)).catch(() => {});
    this.written.set(id, steps);
    await this.sweep(folder);
  }

  /** Temporary files left by writes that were cut short, for which the real file is now in place. */
  private async sweep(folder: string): Promise<void> {
    const { files } = await this.adapter.list(folder);
    for (const f of files) {
      if (!f.endsWith(".tmp")) continue;
      const real = f.replace(/\.[^.]+\.tmp$/, "");
      if (await this.adapter.exists(real)) await this.adapter.remove(f).catch(() => {});
    }
  }

  /** A file's text, or — when it is missing or unreadable — the newest whole temporary copy of it. */
  private async readFile<T>(target: string): Promise<T | undefined> {
    const parse = async (f: string): Promise<T | undefined> => {
      try {
        return JSON.parse(await this.adapter.read(f)) as T;
      } catch {
        return undefined;
      }
    };
    if (await this.adapter.exists(target)) {
      const r = await parse(target);
      if (r !== undefined) return r;
    }
    const folder = target.slice(0, target.lastIndexOf("/"));
    if (!(await this.adapter.exists(folder))) return undefined;
    const name = target.split("/").pop()!;
    const { files } = await this.adapter.list(folder);
    const temps = files.filter((f) => (f.split("/").pop() ?? "").startsWith(`${name}.`) && f.endsWith(".tmp")).sort().reverse();
    for (const t of temps) {
      const r = await parse(t);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  private async onDisk(id: string): Promise<string[]> {
    const r = await this.readNow(id);
    return r ? r.steps.map((s) => JSON.stringify(s)) : [];
  }

  private async readNow(id: string): Promise<BatchRecord | undefined> {
    const folder = this.folder(id);
    const head = await this.readFile<{ job: BatchRecord["job"]; status: BatchRecord["status"]; steps: number }>(`${folder}/job.json`);
    if (!head) return undefined;
    const steps: BatchStep[] = [];
    for (let n = 0; n < head.steps; n++) {
      const s = await this.readFile<BatchStep>(this.stepFile(id, n));
      // job.json is written after its steps, so a step it counts is on disk; one that is not, cannot be trusted.
      if (!s) throw new Error(`the record of batch job ${id} is missing step ${n + 1}`);
      steps.push(s);
    }
    return { job: head.job, status: head.status, steps };
  }

  async read(id: string): Promise<BatchRecord | undefined> {
    await this.queue.get(id)?.catch(() => {});
    return this.readNow(id);
  }

  async list(): Promise<BatchRecord[]> {
    if (!(await this.adapter.exists(this.dir))) return [];
    const { folders } = await this.adapter.list(this.dir);
    const out: BatchRecord[] = [];
    for (const f of folders) {
      const id = f.split("/").pop() ?? f;
      try {
        const r = await this.read(id);
        if (r) out.push(r);
      } catch {
        // A damaged record is left where it is, not shown.
      }
    }
    return out.sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt));
  }

  /** Delete a job's record — and with it the note text it holds. Its changes can no longer be undone. */
  forget(id: string): Promise<void> {
    return this.serial(id, async () => {
      const folder = this.folder(id);
      if (await this.adapter.exists(folder)) await this.adapter.rmdir(folder, true);
      this.written.delete(id);
    });
  }
}
