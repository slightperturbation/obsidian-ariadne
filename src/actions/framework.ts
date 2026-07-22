/**
 * The action framework: every vault mutation flows through
 * propose → preview → accept → atomic undo.
 *
 * HARD INVARIANT: nothing in Ariadne writes to the vault except
 * ActionExecutor.apply()/undoLast(), and apply() is only ever called after an
 * explicit user accept. Proposals are pure data (FileChange[]) so previews
 * show exactly what will happen — the executor validates at accept time that
 * the vault still matches what was previewed, and refuses on any drift.
 */

export interface FileChange {
  type: "create" | "modify" | "delete";
  path: string;
  /** Expected current content (modify/delete) — the conflict check anchor. */
  before?: string;
  /** New content (create/modify). */
  after?: string;
}

export interface ActionProposal {
  /** Short human title, e.g. `Create note "Atomic habits"`. */
  title: string;
  description?: string;
  changes: FileChange[];
}

export interface ExecutedAction {
  title: string;
  /** Changes that exactly reverse the action, in application order. */
  inverse: FileChange[];
  at: number;
}

/** Minimal vault surface; Obsidian adapter + in-memory test double implement it. */
export interface VaultIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  modify(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
}

export class ConflictError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

const MAX_UNDO = 20;

export class ActionExecutor {
  private undoStack: ExecutedAction[] = [];

  constructor(private io: VaultIO) {}

  /**
   * Verify the vault still matches what the proposal was built against.
   * Called immediately before applying — a note edited between preview and
   * accept must abort the action, never silently overwrite the edit.
   */
  async validate(changes: FileChange[]): Promise<void> {
    for (const c of changes) {
      if (c.type === "create") {
        if (await this.io.exists(c.path)) {
          throw new ConflictError(`"${c.path}" already exists`, c.path);
        }
      } else {
        if (!(await this.io.exists(c.path))) {
          throw new ConflictError(`"${c.path}" no longer exists`, c.path);
        }
        if (c.before !== undefined) {
          const current = await this.io.read(c.path);
          if (current !== c.before) {
            throw new ConflictError(`"${c.path}" changed since the preview`, c.path);
          }
        }
      }
    }
  }

  private async applyChange(c: FileChange): Promise<void> {
    if (c.type === "create") await this.io.create(c.path, c.after ?? "");
    else if (c.type === "modify") await this.io.modify(c.path, c.after ?? "");
    else await this.io.delete(c.path);
  }

  /**
   * Apply an accepted proposal as one transaction: validate everything first,
   * then apply in order, rolling back already-applied changes if any step
   * fails. On success the exact inverse is pushed onto the undo stack.
   */
  async apply(proposal: ActionProposal): Promise<ExecutedAction> {
    await this.validate(proposal.changes);

    const inverse: FileChange[] = [];
    try {
      for (const c of proposal.changes) {
        if (c.type === "create") {
          await this.io.create(c.path, c.after ?? "");
          inverse.unshift({ type: "delete", path: c.path, before: c.after });
        } else if (c.type === "modify") {
          const current = await this.io.read(c.path);
          await this.io.modify(c.path, c.after ?? "");
          inverse.unshift({ type: "modify", path: c.path, before: c.after, after: current });
        } else {
          const current = await this.io.read(c.path);
          await this.io.delete(c.path);
          inverse.unshift({ type: "create", path: c.path, after: current });
        }
      }
    } catch (err) {
      // Roll back what was applied (inverse is already newest-first).
      for (const inv of inverse) {
        try {
          await this.applyChange(inv);
        } catch {
          /* best-effort rollback; original error is the one that matters */
        }
      }
      throw err;
    }

    const executed: ExecutedAction = { title: proposal.title, inverse, at: Date.now() };
    this.undoStack.push(executed);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    return executed;
  }

  /**
   * Undo the most recent action in one step — including multi-file actions.
   * The inverse gets the same conflict validation: if any touched file changed
   * after the action, the undo aborts rather than destroying newer work.
   */
  async undoLast(): Promise<ExecutedAction | null> {
    const last = this.undoStack[this.undoStack.length - 1];
    if (!last) return null;
    await this.validate(last.inverse);
    this.undoStack.pop();
    for (const c of last.inverse) await this.applyChange(c);
    return last;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  peekUndo(): ExecutedAction | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }
}
