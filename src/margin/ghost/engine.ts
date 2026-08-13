import { MarkdownView, type App } from "obsidian";
import type { EditorView } from "@codemirror/view";
import type { IndexManager } from "../../index/manager";
import type { DraftContext } from "../draft-watcher";
import { decideGhost } from "./suggest";
import { isLogLine } from "../journal";
import { setGhost } from "./state";
import type { Logger } from "../../util/logger";

export interface GhostEngineDeps {
  app: App;
  manager: () => IndexManager | undefined;
  enabled: () => boolean;
  minCosine: () => number;
  /** Dated journal entries — never offered as inline link targets. */
  isPeriodic?: (path: string) => boolean;
  log: Logger;
}

/** How many paragraphs' dismissals to remember before forgetting the oldest. */
const DISMISS_MEMORY = 50;

/**
 * Turns draft contexts into ghost suggestions: shared-watcher context in,
 * related() retrieval, decideGhost() policy, then a setGhost dispatch into
 * the active editor. Dismissals are remembered per paragraph (keyed by the
 * watcher's word-set paragraph key) so Esc actually means "stop it" and not
 * "ask me again in 600 ms".
 */
export class GhostEngine {
  private dismissed = new Map<string, Set<string>>();
  /** The context whose suggestion is currently VISIBLE — not the latest one
   * seen. Esc must record its dismissal against the paragraph that produced
   * the ghost, and later contexts can arrive (and early-return) while an
   * older ghost is still on screen. */
  private lastContext?: DraftContext;
  private token = 0;

  constructor(private deps: GhostEngineDeps) {}

  /** keymap onDismiss hook. */
  noteDismissed(targetPath: string): void {
    if (!this.lastContext) return;
    let set = this.dismissed.get(this.lastContext.key);
    if (!set) {
      set = new Set();
      this.dismissed.set(this.lastContext.key, set);
      // Bounded memory: drop the oldest paragraph's dismissals.
      if (this.dismissed.size > DISMISS_MEMORY) {
        const oldest = this.dismissed.keys().next().value;
        if (oldest !== undefined) this.dismissed.delete(oldest);
      }
    }
    set.add(targetPath);
  }

  async onContext(ctx: DraftContext): Promise<void> {
    if (!this.deps.enabled()) return;
    const manager = this.deps.manager();
    if (!manager) return;
    const token = ++this.token;

    const view = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    const cm = view
      ? (view.editor as unknown as { cm?: EditorView }).cm
      : undefined;
    if (!view || !cm || view.file?.path !== ctx.path) return;

    if (!ctx.text.trim()) {
      cm.dispatch({ effects: setGhost.of(null) });
      return;
    }

    // In a journal note, a log line (task, bullet, heading) is traffic, not
    // thought — an inline link suggestion there is noise. Bullets in
    // permanent notes keep their ghosts: there, lists ARE the thinking.
    if (this.deps.isPeriodic?.(ctx.path) && isLogLine(ctx.lineBefore)) {
      cm.dispatch({ effects: setGhost.of(null) });
      return;
    }

    // People link ideas, not days: an inline suggestion pointing at a dated
    // entry is nearly always noise, so periodic notes are excluded here
    // outright (the Margin still shows them, demoted — that surface is
    // glanceable, this one interrupts).
    const results = (
      await manager.related(ctx.text, { excludePath: ctx.path, limit: 8 })
    ).filter((r) => !this.deps.isPeriodic?.(r.path));
    if (token !== this.token) return; // a newer context superseded this one

    const decision = decideGhost({
      results,
      noteText: ctx.noteText,
      paragraphText: ctx.text,
      charBefore: ctx.charBefore,
      charAfter: ctx.charAfter,
      lineBefore: ctx.lineBefore,
      dismissed: this.dismissed.get(ctx.key) ?? new Set(),
      minCosine: this.deps.minCosine(),
    });

    // The editor may have changed while we retrieved: never dispatch into a
    // different note, mid-composition, or after further typing moved the
    // cursor off the paused position.
    const nowView = this.deps.app.workspace.getActiveViewOfType(MarkdownView);
    const nowCm = nowView
      ? (nowView.editor as unknown as { cm?: EditorView }).cm
      : undefined;
    if (!nowView || !nowCm || nowView.file?.path !== ctx.path) return;
    if (nowCm.composing) return;
    const cursor = nowView.editor.getCursor();
    if (cursor.line !== ctx.cursorLine || cursor.ch !== ctx.cursorCh) return;

    if (!decision) {
      nowCm.dispatch({ effects: setGhost.of(null) });
      return;
    }
    const pos = nowView.editor.posToOffset(cursor);
    this.lastContext = ctx;
    nowCm.dispatch({
      effects: setGhost.of({
        pos,
        insertText: decision.insertText,
        targetPath: decision.targetPath,
      }),
    });
    this.deps.log.debug(`ghost: [[${decision.title}]] suggested`);
  }
}
