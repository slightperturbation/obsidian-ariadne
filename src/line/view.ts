import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import type { IndexManager } from "../index/manager";
import type { StatusStore } from "../core/status";
import type { ScoredResult } from "../core/types";
import { renderResults } from "./render";

export const ARIADNE_VIEW_TYPE = "ariadne-line";

const DEBOUNCE_MS = 120;
const EMPTY_HINT = "Type to search — ↵ opens, ⌥↵ inserts a link.";
const WARMING_HINT = "Index is warming up…";

export interface LineDeps {
  /** Getter, not instance — the manager is created after layout-ready. */
  manager: () => IndexManager | undefined;
  status: StatusStore;
  /** Layer 3 (Do): create a scaffolded note from the query. */
  onCreateNote?: (seed: string) => void;
  /** Layer 3 (Do): weave a bidirectional link with the selected result (⇧↵). */
  onWeave?: (result: ScoredResult) => void;
}

/**
 * The Line: one persistent input, a layered result column beneath it.
 * The lexical pass paints synchronously-fast on every keystroke; the semantic
 * pass merges in when it lands (guarded by a query token so stale responses
 * never overwrite fresher ones). Keyboard-first: ↑/↓ select, ↵ opens,
 * ⌘↵ opens in a new pane, ⌥↵ inserts a [[link]] into the last active editor.
 */
export class LineView extends ItemView {
  navigation = false;

  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  private glyphEl!: HTMLElement;

  private results: ScoredResult[] = [];
  private selected = 0;
  private queryToken = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private lastMarkdown: MarkdownView | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private deps: LineDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return ARIADNE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Ariadne";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    const doc = root.ownerDocument;
    root.classList.add("ariadne", "ariadne-line");
    root.replaceChildren();

    this.inputEl = doc.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.spellcheck = false;
    this.inputEl.placeholder = "Find or connect…";
    this.inputEl.classList.add("ariadne-input");
    this.inputEl.addEventListener("input", () => this.onInput(this.inputEl.value));
    this.inputEl.addEventListener("keydown", (ev) => this.onKeydown(ev));
    root.appendChild(this.inputEl);

    this.resultsEl = doc.createElement("div");
    this.resultsEl.classList.add("ariadne-results");
    root.appendChild(this.resultsEl);

    this.glyphEl = doc.createElement("div");
    this.glyphEl.classList.add("ariadne-glyph");
    root.appendChild(this.glyphEl);

    this.unsubscribeStatus = this.deps.status.subscribe((s) => {
      const state =
        s.index === "indexing" && s.progressTotal > 0
          ? `indexing ${s.progressDone}/${s.progressTotal}`
          : s.index;
      const semantic =
        s.semantic === "off"
          ? ""
          : s.semantic === "loading"
            ? " · semantic loading…"
            : s.semantic === "fallback"
              ? " · semantic fallback"
              : " · semantic on";
      const brain =
        s.brain === "cloud"
          ? ` · brain ${
              s.sessionCostUsd >= 0.005 ? `$${s.sessionCostUsd.toFixed(2)}` : "ready"
            }`
          : "";
      this.glyphEl.textContent =
        s.index === "error"
          ? `index error — ${s.lastError ?? "unknown"}`
          : `${s.indexedNotes} notes · ${state}${semantic}${brain}`;
      this.glyphEl.classList.toggle("is-error", s.index === "error");
    });

    // Remember the most recent markdown editor so ⌥↵ knows where to insert.
    this.lastMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (mv) this.lastMarkdown = mv;
      }),
    );

    this.renderNow();
  }

  async onClose(): Promise<void> {
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    if (this.debounce) clearTimeout(this.debounce);
  }

  focusInput(): void {
    this.inputEl?.focus();
    this.inputEl?.select();
  }

  private onInput(value: string): void {
    this.selected = 0;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.runQuery(value), DEBOUNCE_MS);
  }

  private async runQuery(raw: string): Promise<void> {
    const token = ++this.queryToken;
    const manager = this.deps.manager();
    if (!manager) {
      this.results = [];
      this.renderNow(WARMING_HINT);
      return;
    }
    if (!raw.trim()) {
      this.results = [];
      this.renderNow();
      return;
    }

    // Fast lexical paint first…
    const lexical = await manager.query(raw, { semantic: false });
    if (token !== this.queryToken) return;
    this.setResults(lexical);

    // …then the semantic merge when it lands.
    const fused = await manager.query(raw);
    if (token !== this.queryToken) return;
    this.setResults(fused);
  }

  /** Total selectable rows: results + the Layer-3 create row when present. */
  private get rowCount(): number {
    return this.results.length + (this.canCreate ? 1 : 0);
  }

  private get canCreate(): boolean {
    return !!this.deps.onCreateNote && !!this.inputEl?.value.trim();
  }

  private setResults(results: ScoredResult[]): void {
    // Display order: Layer 1 (Found) block, then Layer 2 (Related) block —
    // selection walks the same order, so keyboard and eyes agree.
    this.results = [
      ...results.filter((r) => !r.semanticOnly),
      ...results.filter((r) => r.semanticOnly),
    ];
    this.selected = Math.max(0, Math.min(this.selected, this.rowCount - 1));
    this.renderNow();
  }

  private renderNow(emptyHint = this.inputEl?.value.trim() ? undefined : EMPTY_HINT): void {
    if (!this.resultsEl) return;
    renderResults(this.resultsEl, this.results, this.selected, {
      onOpen: (result, newLeaf) => this.openResult(result, newLeaf),
      onHoverSelect: (index) => {
        if (index !== this.selected) {
          this.selected = index;
          this.renderNow();
        }
      },
    }, this.canCreate ? undefined : emptyHint);

    // Layer 3 (Do): the create row sits after the results, index rowCount-1.
    if (this.canCreate) {
      const doc = this.resultsEl.ownerDocument;
      const label = doc.createElement("div");
      label.classList.add("ariadne-section-label");
      label.textContent = "Do";
      this.resultsEl.appendChild(label);

      const row = doc.createElement("div");
      row.classList.add("ariadne-row", "ariadne-do-row");
      if (this.selected === this.results.length) row.classList.add("is-selected");
      row.textContent = `＋ Create note “${this.inputEl.value.trim()}”`;
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        this.deps.onCreateNote?.(this.inputEl.value.trim());
      });
      this.resultsEl.appendChild(row);
    }
  }

  private onKeydown(ev: KeyboardEvent): void {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (this.rowCount === 0) return;
      const delta = ev.key === "ArrowDown" ? 1 : -1;
      this.selected = (this.selected + delta + this.rowCount) % this.rowCount;
      this.renderNow();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      // The Layer-3 create row.
      if (this.canCreate && this.selected === this.results.length) {
        this.deps.onCreateNote?.(this.inputEl.value.trim());
        return;
      }
      const result = this.results[this.selected];
      if (!result) return;
      if (ev.shiftKey) this.deps.onWeave?.(result);
      else if (ev.altKey) this.insertLink(result);
      else this.openResult(result, ev.metaKey || ev.ctrlKey);
      return;
    }
    if (ev.key === "Escape") {
      ev.preventDefault();
      // Hand focus back to writing.
      this.lastMarkdown?.editor.focus();
    }
  }

  private openResult(result: ScoredResult, newLeaf: boolean): void {
    void this.app.workspace.openLinkText(result.path, "", newLeaf);
  }

  private insertLink(result: ScoredResult): void {
    const target = this.lastMarkdown;
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (!target || !(file instanceof TFile)) return;
    const linktext = this.app.metadataCache.fileToLinktext(
      file,
      target.file?.path ?? "",
    );
    target.editor.replaceSelection(`[[${linktext}]]`);
    target.editor.focus();
  }
}
