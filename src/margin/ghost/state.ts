import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { GhostWidget } from "./widget";

/** A pending ghost-text suggestion, anchored at a document position. */
export interface GhostSuggestion {
  /** Where the widget renders and where accept inserts. */
  pos: number;
  /** Exactly what accept will insert (e.g. " [[Atomic notes]]"). */
  insertText: string;
  /** Target note path — the accept handler may want it (analytics, weaving). */
  targetPath: string;
}

/** Set (or clear, with null) the current suggestion. */
export const setGhost = StateEffect.define<GhostSuggestion | null>();

/**
 * Holds at most one suggestion. Any document change that isn't carried by a
 * setGhost effect clears it — a stale suggestion is worse than none, and the
 * engine will re-propose after the next typing pause anyway. Position maps
 * through non-clearing transactions (e.g. remote/plugin edits elsewhere).
 */
export const ghostField = StateField.define<GhostSuggestion | null>({
  create: () => null,

  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhost)) return e.value;
    }
    if (!value) return null;
    if (tr.docChanged) return null;
    if (tr.selection && tr.selection.main.head !== value.pos) return null;
    return value;
  },

  provide: (field) =>
    EditorView.decorations.from(field, (value): DecorationSet => {
      if (!value) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new GhostWidget(value.insertText),
          side: 1, // after the cursor
        }).range(value.pos),
      ]);
    }),
});
