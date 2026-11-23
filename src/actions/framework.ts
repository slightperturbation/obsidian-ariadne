/**
 * The action framework: every vault mutation flows through
 * propose → preview → accept → atomic undo.
 *
 * HARD INVARIANT: no EXISTING note content is modified or deleted without an
 * explicit user accept. Proposals are pure data (FileChange[]) so previews show
 * exactly what will happen — the executor validates at accept time that the
 * vault still matches what was previewed, and refuses on any drift.
 *
 * A "move" relocates a note without touching its text. It goes through the
 * VaultIO's rename, which in Obsidian is the fileManager's — so links to the
 * note are rewritten as they are when the user moves it themselves.
 *
 * Two deliberate exceptions, both non-destructive and both still undoable:
 * creating a scaffolded note and generating a Map of Content write a NEW file
 * on command without a preview (you asked for a note; here it is — read it and
 * undo if unwanted). The attachment sweep also writes outside the executor,
 * via Obsidian's fileManager so embeds get rewritten, registering its reversal
 * through pushExternalUndo.
 */

export interface FileChange {
  type: "create" | "modify" | "delete" | "move";
  path: string;
  /** Expected current content (modify/delete) — the conflict check anchor. */
  before?: string;
  /** New content (create/modify). */
  after?: string;
  /** Where the note goes (move): a full path, which must be free. */
  to?: string;
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
  /** Move a file, rewriting links to it. Absent: this vault cannot move files. */
  rename?(from: string, to: string): Promise<void>;
  /**
   * Read and write a file as one step: `fn` gets the text as it is at that
   * moment and returns the new text (or throws, and nothing is written).
   * Absent: a read then a write.
   */
  process?(path: string, fn: (current: string) => string): Promise<void>;
}

/**
 * An action failed part-way AND putting back what had landed failed too: the
 * vault holds part of it. The caller must keep its own record of how to undo.
 */
export class PartialApplyError extends Error {
  constructor(readonly cause: unknown) {
    super(`stopped part-way and could not be fully put back: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PartialApplyError";
  }
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
  /** Serializes undo so concurrent invocations can't pop the same entry twice. */
  private busy: Promise<void> = Promise.resolve();

  constructor(private io: VaultIO) {}

  /**
   * Verify the vault still matches what the proposal was built against.
   * Called immediately before applying — a note edited between preview and
   * accept must abort the action, never silently overwrite the edit.
   */
  async validate(changes: FileChange[], retry = false): Promise<void> {
    // Checked as the changes would unfold, one after another: after a move its
    // source is empty and its destination holds the note; after an edit the
    // note holds the new text. So "edit it, move it, edit it again" — and its
    // undo — each check the file and the text that will really be there.
    // `retry`: an undo that stopped part-way is being run again, so a step
    // whose effect is already present is accepted as done.
    type Entry = { gone: true } | { gone: false; phys: string | null; text?: string };
    const state = new Map<string, Entry>();
    const entry = (p: string): Entry => state.get(p) ?? { gone: false, phys: p };
    const exists = async (p: string): Promise<boolean> => {
      const e = entry(p);
      if (e.gone) return false;
      return e.phys === null || (await this.io.exists(e.phys));
    };
    const textOf = async (p: string): Promise<string> => {
      const e = entry(p);
      if (e.gone) throw new ConflictError(`"${p}" no longer exists`, p);
      return e.text !== undefined ? e.text : await this.io.read(e.phys!);
    };
    for (const c of changes) {
      if (c.type === "move") {
        if (!c.to) throw new ConflictError(`no destination given for "${c.path}"`, c.path);
        if (retry && !(await exists(c.path)) && (await exists(c.to))) {
          state.set(c.path, { gone: true });
          continue;
        }
        if (!(await exists(c.path))) throw new ConflictError(`"${c.path}" no longer exists`, c.path);
        if (await exists(c.to)) throw new ConflictError(`"${c.to}" already exists`, c.to);
        state.set(c.to, entry(c.path));
        state.set(c.path, { gone: true });
        continue;
      }
      if (c.type === "create") {
        if (await exists(c.path)) {
          if (retry) continue;
          throw new ConflictError(`"${c.path}" already exists`, c.path);
        }
        state.set(c.path, { gone: false, phys: null, text: c.after ?? "" });
        continue;
      }
      if (!(await exists(c.path))) {
        if (retry && c.type === "delete") continue;
        throw new ConflictError(`"${c.path}" no longer exists`, c.path);
      }
      if (c.before !== undefined) {
        const current = await textOf(c.path);
        const done = retry && c.type === "modify" && current === (c.after ?? "");
        if (current !== c.before && !done) {
          throw new ConflictError(`"${c.path}" changed since the preview`, c.path);
        }
      }
      if (c.type === "modify") {
        const e = entry(c.path);
        state.set(c.path, e.gone ? e : { ...e, text: c.after ?? "" });
      } else {
        state.set(c.path, { gone: true });
      }
    }
  }

  /**
   * Write a modify, checking at the moment of writing that the note still
   * holds the text the change was made on — not only when the batch was
   * validated. Between the two, something else may have written it: the
   * owner, or Obsidian rewriting links after a move earlier in the action.
   * Returns the text that was replaced.
   */
  private async writeChecked(c: FileChange): Promise<string> {
    const after = c.after ?? "";
    if (this.io.process && c.before !== undefined) {
      const expected = c.before;
      await this.io.process(c.path, (current) => {
        if (current !== expected) throw new ConflictError(`"${c.path}" changed since the preview`, c.path);
        return after;
      });
      return expected;
    }
    const current = await this.io.read(c.path);
    if (c.before !== undefined && current !== c.before) throw new ConflictError(`"${c.path}" changed since the preview`, c.path);
    await this.io.modify(c.path, after);
    return current;
  }

  private async rename(from: string, to: string): Promise<void> {
    if (!this.io.rename) throw new Error("this vault cannot move files");
    await this.io.rename(from, to);
  }

  private async applyChange(c: FileChange): Promise<void> {
    if (c.type === "move") await this.rename(c.path, c.to ?? "");
    else if (c.type === "create") await this.io.create(c.path, c.after ?? "");
    else if (c.type === "modify") await this.io.modify(c.path, c.after ?? "");
    else await this.io.delete(c.path);
  }

  /**
   * Apply an accepted proposal as one transaction: validate everything first,
   * then apply in order, rolling back already-applied changes if any step
   * fails. On success the exact inverse is pushed onto the undo stack.
   */
  async apply(proposal: ActionProposal): Promise<ExecutedAction> {
    const inverse = await this.applyRaw(proposal.changes);
    // The text undo re-validates the inverse (so a file changed since the
    // action aborts the undo) then applies it — same abort-before-commit
    // guarantee as apply().
    const executed: ExecutedAction = {
      title: proposal.title,
      at: Date.now(),
      undo: async () => this.revert(inverse),
    };
    this.push(executed);
    return executed;
  }

  /**
   * Apply changes as one transaction — validate everything, apply in order,
   * roll back on failure — and return their exact inverse, without putting
   * anything on the undo stack. For callers that keep their own undo record
   * (a batch job's, which has to outlive a restart).
   */
  async applyRaw(changes: FileChange[], opts: { beforeEach?: (index: number) => Promise<void> } = {}): Promise<FileChange[]> {
    await this.validate(changes);

    const inverse: FileChange[] = [];
    try {
      for (const [index, c] of changes.entries()) {
        // Told first, so a caller keeping its own record knows how far it got if the app stops here.
        await opts.beforeEach?.(index);
        if (c.type === "move") {
          await this.rename(c.path, c.to ?? "");
          inverse.unshift({ type: "move", path: c.to ?? "", to: c.path });
        } else if (c.type === "create") {
          await this.io.create(c.path, c.after ?? "");
          inverse.unshift({ type: "delete", path: c.path, before: c.after });
        } else if (c.type === "modify") {
          const current = await this.writeChecked(c);
          inverse.unshift({ type: "modify", path: c.path, before: c.after, after: current });
        } else {
          // Checked again at the moment of deleting: the text that goes to the trash is the text the change was made on.
          const current = await this.io.read(c.path);
          if (c.before !== undefined && current !== c.before) throw new ConflictError(`"${c.path}" changed since the preview`, c.path);
          await this.io.delete(c.path);
          inverse.unshift({ type: "create", path: c.path, after: current });
        }
      }
    } catch (err) {
      // Roll back what was applied (inverse is already newest-first).
      let whole = true;
      for (const inv of inverse) {
        try {
          await this.applyChange(inv);
        } catch {
          whole = false;
        }
      }
      if (!whole) throw new PartialApplyError(err);
      throw err;
    }
    return inverse;
  }

  /** Put back what `applyRaw` did, given its inverse: checked first, retry-safe. */
  async revert(inverse: FileChange[]): Promise<void> {
    await this.applyReversible(inverse);
  }

  /**
   * Apply changes with rollback and idempotency — used by undo. A mid-undo
   * failure (a locked file, a sync client holding a handle) must not leave the
   * vault half-reverted with a retry that can never validate again, so steps
   * whose effect is already present are skipped and applied steps are unwound
   * on failure.
   */
  private async applyReversible(changes: FileChange[]): Promise<void> {
    await this.validate(changes, true);
    const undoSteps: Array<() => Promise<void>> = [];
    try {
      for (const c of changes) {
        if (await this.alreadySatisfied(c)) continue;
        if (c.type === "move") {
          await this.rename(c.path, c.to ?? "");
          undoSteps.unshift(() => this.rename(c.to ?? "", c.path));
        } else if (c.type === "create") {
          await this.io.create(c.path, c.after ?? "");
          undoSteps.unshift(() => this.io.delete(c.path));
        } else if (c.type === "modify") {
          const previous = await this.writeChecked(c);
          undoSteps.unshift(() => this.io.modify(c.path, previous));
        } else {
          const previous = await this.io.read(c.path);
          await this.io.delete(c.path);
          undoSteps.unshift(() => this.io.create(c.path, previous));
        }
      }
    } catch (err) {
      for (const step of undoSteps) {
        try {
          await step();
        } catch {
          /* best-effort */
        }
      }
      throw err;
    }
  }

  /** True when a change's effect is already present (so undo is retryable). */
  private async alreadySatisfied(c: FileChange): Promise<boolean> {
    if (c.type === "move") return !(await this.io.exists(c.path)) && (await this.io.exists(c.to ?? ""));
    const exists = await this.io.exists(c.path);
    if (c.type === "delete") return !exists;
    if (!exists) return false;
    return (await this.io.read(c.path)) === (c.after ?? "");
  }

  /**
   * Register an externally-performed operation (e.g. a batch of file moves via
   * Obsidian's fileManager, which the text VaultIO can't express) with its own
   * reversal, so it shares the single "Undo last Ariadne action" command and stack.
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
    // Serialize: a double-tapped hotkey would otherwise let two calls read the
    // same top-of-stack entry, run it twice, and pop two — silently discarding
    // the entry underneath without ever reversing it.
    const run = this.busy.then(async () => {
      const last = this.undoStack[this.undoStack.length - 1];
      if (!last) return null;
      await last.undo();
      this.undoStack.pop();
      return last;
    });
    this.busy = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  peekUndo(): ExecutedAction | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }
}
