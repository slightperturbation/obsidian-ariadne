import { BasesView, type QueryController } from "obsidian";
import type { IndexManager } from "../index/manager";
import type { ScoredResult } from "../core/types";
import { rowEl } from "../line/render";

export const ARIADNE_BASES_VIEW = "ariadne-related";

export interface RelatedViewDeps {
  manager: () => IndexManager | undefined;
  openPath: (path: string, newLeaf: boolean) => void;
}

/**
 * Builds the Bases view class **lazily**, and that is load-bearing.
 *
 * `BasesView` only exists in Obsidian 1.10+. A top-level `class X extends
 * BasesView` would evaluate at import time and throw "Class extends value
 * undefined" on any older version — taking the whole plugin down before the
 * caller's feature-detection could ever run. Defining it inside a function
 * means the `extends` clause is evaluated only once we know Bases is there.
 */
export function makeAriadneRelatedView(deps: RelatedViewDeps) {
  /**
   * A Bases view that orders the query's results by how related they are to
   * the note you currently have open.
   *
   * A Bases query already answers "which notes match these properties". The
   * one thing Ariadne adds that a table cannot is *relatedness* — so this view
   * takes the result set as given and re-orders it by semantic closeness to
   * the active note, with the same confidence prominence and sparklines as the
   * panel. Notes in the set that aren't meaningfully related are kept but
   * shown below a divider rather than dropped: the query said they belong, and
   * hiding them would misrepresent it.
   */
  return class AriadneRelatedView extends BasesView {
    type = ARIADNE_BASES_VIEW;

    constructor(
      controller: QueryController,
      private containerEl: HTMLElement,
    ) {
      super(controller);
    }

    onDataUpdated(): void {
      void this.render();
    }

    private note(text: string): void {
      this.containerEl.replaceChildren();
      const el = this.containerEl.ownerDocument.createElement("div");
      el.classList.add("ariadne-empty");
      el.textContent = text;
      this.containerEl.appendChild(el);
    }

    private async render(): Promise<void> {
      this.containerEl.classList.add("ariadne", "ariadne-bases");

      const manager = deps.manager();
      if (!manager) return this.note("Ariadne is still starting up.");

      const entries = this.data?.data ?? [];
      if (entries.length === 0) return this.note("No results in this base.");

      const focus = this.app.workspace.getActiveFile();
      if (!focus) return this.note("Open a note to rank these by relatedness to it.");

      const inQuery = new Set(entries.map((e) => e.file.path));

      // Ask for far more than we'll show: this intersects with the query's
      // result set, so the ranking has to reach deep enough to cover it.
      const ranked = await manager.relatedToPath(focus.path, { limit: 500 });
      const scored: ScoredResult[] = ranked.filter((r) => inQuery.has(r.path));
      const rankedPaths = new Set(scored.map((r) => r.path));

      const doc = this.containerEl.ownerDocument;
      const handlers = {
        onActivate: (result: ScoredResult, mods: { newLeaf: boolean }) =>
          deps.openPath(result.path, mods.newLeaf),
        onHoverSelect: () => {},
      };

      if (scored.length === 0) {
        return this.note(
          manager.hasStoredVectors()
            ? `Nothing in this base is closely related to ${focus.basename}.`
            : "No vectors yet — index this vault on the device that owns the index.",
        );
      }

      this.containerEl.replaceChildren();
      const heading = doc.createElement("div");
      heading.classList.add("ariadne-section-label");
      heading.textContent = `Related to ${focus.basename}`;
      this.containerEl.appendChild(heading);
      scored.forEach((r, i) => {
        this.containerEl.appendChild(rowEl(doc, r, i, false, handlers, { variant: "card" }));
      });

      // Everything else the query matched, in the order Bases gave it.
      const rest = entries.filter((e) => !rankedPaths.has(e.file.path));
      if (rest.length === 0) return;
      const restHeading = doc.createElement("div");
      restHeading.classList.add("ariadne-section-label");
      restHeading.textContent = `Also in this base (${rest.length})`;
      this.containerEl.appendChild(restHeading);
      for (const entry of rest) {
        const row = doc.createElement("div");
        row.classList.add("ariadne-row", "ariadne-confidence-faint");
        const title = doc.createElement("span");
        title.classList.add("ariadne-row-title");
        title.textContent = entry.file.basename;
        row.appendChild(title);
        row.addEventListener("click", () => deps.openPath(entry.file.path, false));
        this.containerEl.appendChild(row);
      }
    }
  };
}
