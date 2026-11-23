import type { FileChange } from "../actions/framework";

/**
 * A batch job's record: what was asked, and for each note what was done and
 * how to put it back. It is written before a note is changed and again after,
 * so an undo works after a restart, and on another device once Sync has
 * carried the record there.
 */
export interface BatchJob {
  id: string;
  /** The owner's instruction, the same for every note. */
  instruction: string;
  /** How the notes were chosen, in words ("Periodic/Daily, 8 notes"). */
  selection: string;
  /** The notes, in the order they are worked through. */
  paths: string[];
  /** The model each note is handed to, by name. */
  model: string;
  /**
   * Where it runs: a local server and model ("<server url>|<model>"), or
   * "cloud|<model>" for Claude. Absent on jobs from before the choice was
   * offered: they run on the chat's model.
   */
  route?: string;
  /** May a note lose more than a third of its text? Off: such a change is held, not applied. */
  allowShrink: boolean;
  /** Was the chat's journal switch on when the job was set up? Off: no journal entry is read, whatever the switch says later. */
  journal?: boolean;
  createdAt: string;
}

export type StepStatus = "pending" | "applied" | "left" | "held" | "failed" | "undone";

export interface BatchStep {
  /** The note as it was when the job began. */
  path: string;
  status: StepStatus;
  /** One line: what was done to the note and why — the model's, or the runner's. */
  summary: string;
  /** What was applied, in order. */
  changes: FileChange[];
  /** What puts it back, in order. Written before the changes are applied. */
  inverse: FileChange[];
  /** What the model was asked to report about this note, if anything. */
  findings: string[];
  /** Why it was held or failed, or why its undo could not be done. */
  why?: string;
  /** While applying: the change it was on. Kept if the app stops there, so undo knows what may have landed. */
  attempting?: number;
  at: string;
}

/** "ended": the owner stopped it for good; what it did stays, and can still be undone. */
export type BatchStatus = "running" | "paused" | "stopped" | "ended" | "done" | "undone";

export interface BatchRecord {
  job: BatchJob;
  status: BatchStatus;
  steps: BatchStep[];
  /** Why the job stopped by itself (a cost limit, say), shown on its card. */
  why?: string;
}

/** Where records live. Obsidian keeps them in the plugin's folder; tests in memory. */
export interface BatchStore {
  write(record: BatchRecord): Promise<void>;
  read(id: string): Promise<BatchRecord | undefined>;
  /** Every record, newest first. */
  list(): Promise<BatchRecord[]>;
  /** Delete a record (and the note text it holds). Absent: records are kept. */
  forget?(id: string): Promise<void>;
}

export function memoryBatchStore(): BatchStore & { records: Map<string, BatchRecord> } {
  const records = new Map<string, BatchRecord>();
  const copy = (r: BatchRecord): BatchRecord => JSON.parse(JSON.stringify(r)) as BatchRecord;
  return {
    records,
    write: async (r) => void records.set(r.job.id, copy(r)),
    read: async (id) => {
      const r = records.get(id);
      return r ? copy(r) : undefined;
    },
    list: async () => [...records.values()].map(copy).sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt)),
    forget: async (id) => void records.delete(id),
  };
}

/**
 * The exact reverse of a list of changes, newest first — worked out before
 * anything is applied, from what each change says the note held. A delete
 * must carry the note's text (`before`), or it could not be put back.
 */
export function inverseOf(changes: FileChange[]): FileChange[] {
  const out: FileChange[] = [];
  for (const c of changes) {
    if (c.type === "move") out.unshift({ type: "move", path: c.to ?? "", to: c.path });
    else if (c.type === "create") out.unshift({ type: "delete", path: c.path, before: c.after });
    else if (c.type === "modify") out.unshift({ type: "modify", path: c.path, before: c.after, after: c.before });
    else {
      if (c.before === undefined) throw new Error(`a delete of "${c.path}" without its text cannot be undone`);
      out.unshift({ type: "create", path: c.path, after: c.before });
    }
  }
  return out;
}

/** What a batch did, counted: "5 moved, 2 edited, 1 tagged, 3 left alone". */
export function tally(record: BatchRecord): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of record.steps) {
    const key = s.status === "applied" ? kindOf(s.changes) : s.status;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** The main kind of change a note's step made, for counting. */
export function kindOf(changes: FileChange[]): string {
  if (changes.some((c) => c.type === "delete") && changes.some((c) => c.type === "modify")) return "merged";
  if (changes.some((c) => c.type === "delete")) return "trashed";
  if (changes.some((c) => c.type === "move")) return "moved";
  if (changes.some((c) => c.type === "create")) return "created";
  return "edited";
}
