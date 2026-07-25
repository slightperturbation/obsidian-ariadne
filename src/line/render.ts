import type { ScoredResult } from "../core/types";
import { prominence } from "../index/confidence";
import { sparklineEl } from "./sparkline";

/** What the user asked for, independent of which surface they clicked. */
export interface ActivateModifiers {
  /** ⇧ — weave a bidirectional link. */
  weave: boolean;
  /** ⌥ — insert a [[link]] at the cursor. */
  insertLink: boolean;
  /** ⌘/⌃ — open in a new pane. */
  newLeaf: boolean;
}

export interface RenderHandlers {
  onActivate(result: ScoredResult, mods: ActivateModifiers): void;
  onHoverSelect(index: number): void;
}

export const modifiersOf = (ev: MouseEvent | KeyboardEvent): ActivateModifiers => ({
  weave: ev.shiftKey,
  insertLink: ev.altKey,
  newLeaf: ev.metaKey || ev.ctrlKey,
});

/**
 * One result row, shared by the search results and the Margin cards so the
 * same modifier means the same thing in both halves of the panel.
 */
export function rowEl(
  doc: Document,
  result: ScoredResult,
  index: number,
  selected: boolean,
  handlers: RenderHandlers,
  variant: "row" | "card" = "row",
): HTMLElement {
  const row = doc.createElement("div");
  row.classList.add("ariadne-row", `ariadne-confidence-${prominence(result.confidence)}`);
  if (variant === "card") row.classList.add("ariadne-card");
  if (selected) row.classList.add("is-selected");
  row.dataset.index = String(index);
  row.dataset.path = result.path;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(selected));
  row.id = `ariadne-opt-${variant}-${index}`;

  const head = doc.createElement("div");
  head.classList.add("ariadne-row-head");

  const title = doc.createElement("span");
  title.classList.add("ariadne-row-title");
  title.textContent = result.title;
  // Titles ellipsize in a narrow sidebar; the full path is the disambiguator.
  title.title = result.path;
  head.appendChild(title);

  if (result.spark) head.appendChild(sparklineEl(result.spark, doc));
  row.appendChild(head);

  if (result.snippet) {
    const snippet = doc.createElement("div");
    snippet.classList.add("ariadne-row-snippet");
    snippet.textContent = result.snippet;
    row.appendChild(snippet);
  }

  row.addEventListener("mousedown", (ev) => {
    // mousedown (not click) so the editor's selection/focus isn't lost first.
    ev.preventDefault();
    handlers.onActivate(result, modifiersOf(ev));
  });
  row.addEventListener("mousemove", () => handlers.onHoverSelect(index));

  return row;
}

function sectionEl(doc: Document, label: string): HTMLElement {
  const el = doc.createElement("div");
  el.classList.add("ariadne-section-label");
  el.textContent = label;
  return el;
}

/**
 * Render the layered result column: Layer 1 (Found — lexical∩semantic fusion)
 * then Layer 2 (Related — semantically near but lexically silent). Pure
 * DOM-building over standard APIs; no Obsidian imports, so it is testable and
 * portable. The caller owns the container and event wiring beyond row clicks.
 */
export function renderResults(
  container: HTMLElement,
  results: ScoredResult[],
  selectedIndex: number,
  handlers: RenderHandlers,
  emptyHint?: string,
): void {
  const doc = container.ownerDocument;
  container.replaceChildren();

  if (results.length === 0) {
    if (emptyHint) {
      const hint = doc.createElement("div");
      hint.classList.add("ariadne-empty");
      hint.textContent = emptyHint;
      container.appendChild(hint);
    }
    return;
  }

  const found = results.filter((r) => !r.semanticOnly);
  const related = results.filter((r) => r.semanticOnly);

  // Index-into-results must match keyboard selection, which walks the full
  // ordered list — so compute each row's global index, not its per-layer one.
  const indexOf = new Map(results.map((r, i) => [r, i] as const));

  if (found.length > 0) {
    container.appendChild(sectionEl(doc, "Found"));
    for (const r of found) {
      container.appendChild(rowEl(doc, r, indexOf.get(r)!, indexOf.get(r) === selectedIndex, handlers));
    }
  }
  if (related.length > 0) {
    container.appendChild(sectionEl(doc, "Related"));
    for (const r of related) {
      container.appendChild(rowEl(doc, r, indexOf.get(r)!, indexOf.get(r) === selectedIndex, handlers));
    }
  }
}
