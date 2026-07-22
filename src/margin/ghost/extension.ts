import type { Extension } from "@codemirror/state";
import { ghostField } from "./state";
import { ghostKeymap, type GhostKeymapOptions } from "./keymap";

export { ghostField, setGhost, type GhostSuggestion } from "./state";

/** The complete ghost-text extension bundle for registerEditorExtension. */
export function ghostExtension(opts: GhostKeymapOptions): Extension {
  return [ghostField, ghostKeymap(opts)];
}
