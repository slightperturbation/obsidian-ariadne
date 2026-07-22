import { WidgetType } from "@codemirror/view";

/**
 * The faded inline span showing what Tab would insert. eq() by text so
 * CodeMirror reuses the DOM node across unrelated view updates — no
 * per-keystroke widget churn.
 */
export class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "ariadne-ghost";
    span.textContent = this.text;
    // Screen readers should not read half-formed suggestions mid-sentence.
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
