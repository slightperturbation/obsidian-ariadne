import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ghostField } from "./state";
import { acceptGhost, ghostKeymap, type GhostKeymapOptions } from "./keymap";

export { ghostField, setGhost, type GhostSuggestion } from "./state";

/**
 * Tap-to-accept, for devices whose keyboard has no Tab.
 *
 * Lives here rather than in the widget so the widget stays a dumb span: the
 * decoration is built inside the state field, which has no access to options.
 */
function tapToAccept(opts: GhostKeymapOptions): Extension {
  return EditorView.domEventHandlers({
    pointerup: (ev, view) => {
      const target = ev.target as HTMLElement | null;
      if (!target?.closest?.(".ariadne-ghost")) return false;
      return acceptGhost(view, opts);
    },
  });
}

/** The complete ghost-text extension bundle for registerEditorExtension. */
export function ghostExtension(opts: GhostKeymapOptions): Extension {
  return [ghostField, ghostKeymap(opts), ...(opts.touch?.() ? [tapToAccept(opts)] : [])];
}
