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

export interface RowOptions {
  variant?: "row" | "card";
  /**
   * Touch device: no modifier keys exist, so every capability normally gated
   * behind ⇧/⌥ needs a visible control instead. Without this, weave and
   * insert-link are simply unreachable on a phone.
   */
  touch?: boolean;
  /**
   * Serendipity bias, added to confidence before the prominence tiers apply.
   * Positive = this surface presents bolder; negative = quieter. It shapes
   * how results LOOK, never which results exist — gating stays retrieval's
   * job, so turning serendipity down can't hide a result, only hush it.
   */
  bias?: number;
}

export const modifiersOf = (ev: MouseEvent | KeyboardEvent): ActivateModifiers => ({
  weave: ev.shiftKey,
  insertLink: ev.altKey,
  newLeaf: ev.metaKey || ev.ctrlKey,
});

const NO_MODIFIERS: ActivateModifiers = { weave: false, insertLink: false, newLeaf: false };

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
  opts: RowOptions = {},
): HTMLElement {
  const { variant = "row", touch = false, bias = 0 } = opts;
  const row = doc.createElement("div");
  const tier = prominence(Math.max(0, Math.min(1, result.confidence + bias)));
  row.classList.add("ariadne-row", `ariadne-confidence-${tier}`);
  if (variant === "card") row.classList.add("ariadne-card");
  if (selected) row.classList.add("is-selected");
  row.dataset.index = String(index);
  row.dataset.path = result.path;
  if (variant === "row") {
    // Only search rows live in the listbox; a Margin card is not selectable
    // and an option outside a listbox is ARIA noise.
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(selected));
    row.id = `ariadne-opt-${variant}-${index}`;
  }

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

  // Pointer events rather than mouse events: one path covers mouse, touch and
  // pen. preventDefault is applied only for a mouse, where it stops the editor
  // losing its selection before the handler runs; doing it for touch would
  // interfere with scrolling the list.
  //
  // Events that begin on a button INSIDE the row (dismiss ×, Link/Weave, tag
  // chips) must not activate the row: those buttons act on `click`, which
  // fires after pointerdown — stopping propagation there is too late. So the
  // row checks where the event was born. Without this, dismissing a tension
  // card first NAVIGATED to the very note the user was waving away.
  const onOwnRow = (ev: Event) =>
    !(ev.target instanceof Element) || !ev.target.closest("button");
  row.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse" && onOwnRow(ev)) {
      ev.preventDefault();
      handlers.onActivate(result, modifiersOf(ev));
    }
  });
  row.addEventListener("click", (ev) => {
    // Touch and keyboard-activated clicks land here; a mouse already fired.
    if ((ev as PointerEvent).pointerType === "mouse") return;
    if (!onOwnRow(ev)) return;
    handlers.onActivate(result, modifiersOf(ev));
  });
  row.addEventListener("mousemove", () => handlers.onHoverSelect(index));

  if (touch) row.appendChild(touchActionsEl(doc, result, handlers));

  return row;
}

/**
 * The touch stand-in for ⌥↵ and ⇧↵. Tapping the row opens the note; these two
 * cover the capabilities a phone has no modifier key to reach.
 */
function touchActionsEl(
  doc: Document,
  result: ScoredResult,
  handlers: RenderHandlers,
): HTMLElement {
  const bar = doc.createElement("div");
  bar.classList.add("ariadne-row-actions");

  const button = (label: string, mods: ActivateModifiers, aria: string): HTMLElement => {
    const el = doc.createElement("button");
    el.type = "button";
    el.classList.add("ariadne-row-action");
    el.textContent = label;
    el.setAttribute("aria-label", `${aria} ${result.title}`);
    el.addEventListener("click", (ev) => {
      // Otherwise the row's own click handler opens the note as well.
      ev.stopPropagation();
      handlers.onActivate(result, mods);
    });
    return el;
  };

  bar.appendChild(button("Link", { ...NO_MODIFIERS, insertLink: true }, "Insert a link to"));
  bar.appendChild(button("Weave", { ...NO_MODIFIERS, weave: true }, "Weave a link with"));
  return bar;
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
  touch = false,
  bias = 0,
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
      container.appendChild(
        rowEl(doc, r, indexOf.get(r)!, indexOf.get(r) === selectedIndex, handlers, { touch, bias }),
      );
    }
  }
  if (related.length > 0) {
    container.appendChild(sectionEl(doc, "Related"));
    for (const r of related) {
      container.appendChild(
        rowEl(doc, r, indexOf.get(r)!, indexOf.get(r) === selectedIndex, handlers, { touch, bias }),
      );
    }
  }
}
