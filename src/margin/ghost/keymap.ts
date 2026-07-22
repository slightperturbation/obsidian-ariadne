import { Prec, type Extension } from "@codemirror/state";
import { keymap, type EditorView } from "@codemirror/view";
import { ghostField, setGhost } from "./state";

export interface GhostKeymapOptions {
  /** Vim mode active? Esc then dismisses but still falls through to vim. */
  isVim(): boolean;
  /** Called after a suggestion is accepted (for dismissal memory, logging). */
  onAccept?(targetPath: string): void;
  /** Called after a suggestion is dismissed with Esc. */
  onDismiss?(targetPath: string): void;
}

function acceptGhost(view: EditorView, opts: GhostKeymapOptions): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost) return false; // no suggestion → Tab falls through (indentation)
  if (view.composing) return false; // never fight the IME
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.insertText },
    selection: { anchor: ghost.pos + ghost.insertText.length },
    effects: setGhost.of(null),
  });
  opts.onAccept?.(ghost.targetPath);
  return true;
}

function dismissGhost(view: EditorView, opts: GhostKeymapOptions): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost) return false;
  view.dispatch({ effects: setGhost.of(null) });
  opts.onDismiss?.(ghost.targetPath);
  // In vim, Esc is modal — dismiss the ghost but let vim see the key too.
  return !opts.isVim();
}

/**
 * Prec.highest so Tab reaches us before indentation/snippet handlers — but
 * every binding returns false when no suggestion is visible, so normal
 * Tab/Esc behavior is untouched the rest of the time.
 */
export function ghostKeymap(opts: GhostKeymapOptions): Extension {
  return Prec.highest(
    keymap.of([
      { key: "Tab", run: (view) => acceptGhost(view, opts) },
      { key: "Escape", run: (view) => dismissGhost(view, opts) },
    ]),
  );
}
