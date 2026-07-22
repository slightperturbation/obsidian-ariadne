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
  at: number;
  /**
   * Reverse the action. For text actions this validates the inverse then
   * applies it (aborting before any change on conflict); filing ops register
   * their own reversal via pushExternalUndo. Called by undoLast; if it throws,
   * the action stays on the stack so the user can resolve and retry.
   */
  undo: () => Promise<void>;
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

    // The text undo re-validates the inverse (so a file changed since the
    // action aborts the undo) then applies it — same abort-before-commit
    // guarantee as apply().
    const executed: ExecutedAction = {
      title: proposal.title,
      at: Date.now(),
      undo: async () => {
        await this.validate(inverse);
        for (const c of inverse) await this.applyChange(c);
      },
    };
    this.push(executed);
    return executed;
  }

  /**
   * Register an externally-performed operation (e.g. a batch of file moves via
   * Obsidian's fileManager, which the text VaultIO can't express) with its own
   * reversal, so it shares the single "Undo last action" command and stack.
   */
  pushExternalUndo(title: string, undo: () => Promise<void>): void {
    this.push({ title, at: Date.now(), undo });
  }

  private push(action: ExecutedAction): void {
    this.undoStack.push(action);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  /**
   * Undo the most recent action in one step. The reversal runs before the
   * action is popped, so a validation failure (a touched file changed since)
   * leaves it on the stack to resolve and retry, rather than destroying newer
   * work or losing the undo.
   */
  async undoLast(): Promise<ExecutedAction | null> {
    const last = this.undoStack[this.undoStack.length - 1];
    if (!last) return null;
    await last.undo();
    this.undoStack.pop();
    return last;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  peekUndo(): ExecutedAction | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }
}
