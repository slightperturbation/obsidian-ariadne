import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import type { IndexManager } from "../index/manager";
import type { StatusStore } from "../core/status";
import type { ScoredResult } from "../core/types";
import type { DraftWatcher, DraftContext } from "../margin/draft-watcher";
import { renderResults } from "./render";
import { prominence } from "../index/confidence";
import { sparklineEl } from "./sparkline";

export const ARIADNE_VIEW_TYPE = "ariadne-line";

const DEBOUNCE_MS = 120;
const WARMING_HINT = "Index is warming up…";
const MARGIN_HINT = "Write, and related notes appear here.";
const CARD_LIMIT = 5;

export interface AriadneViewDeps {
  /** Getter, not instance — the manager is created after layout-ready. */
  manager: () => IndexManager | undefined;
  status: StatusStore;
  /** Feeds the Margin section (related cards following the cursor). */
  watcher: DraftWatcher;
  /** Whether the Margin section is active. */
  marginEnabled: () => boolean;
  /** Layer 3 (Do): create a scaffolded note from the query. */
  onCreateNote?: (seed: string) => void;
  /** Layer 3 (Do): weave a bidirectional link with a result (⇧↵ / ⇧-click). */
  onWeave?: (result: ScoredResult) => void;
}

/**
 * The unified Ariadne panel. One persistent input pinned at the top; when a
 * search is active its layered results occupy up to 2/3 of the panel and the
 * Margin (related notes following the cursor) fills the rest. With no active
 * search the results collapse and the Margin takes the whole panel.
 *
 * Both halves share the one input's keyboard model — ↑/↓ select, ↵ open,
 * ⌘↵ new pane, ⌥↵ insert a [[link]], ⇧↵ weave — and both surface the same
 * result cards (⇧-click weaves from the Margin too).
 */
export class AriadneView extends ItemView {
  navigation = false;

  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLElement;
  private marginEl!: HTMLElement;
  private marginHintEl!: HTMLElement;
  private glyphEl!: HTMLElement;

  private results: ScoredResult[] = [];
  private selected = 0;
  private queryToken = 0;
  private marginToken = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeWatcher: (() => void) | null = null;
  private lastMarkdown: MarkdownView | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private deps: AriadneViewDeps,
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
    root.classList.add("ariadne", "ariadne-panel");
    root.replaceChildren();

    this.inputEl = doc.createElement("input");
    this.inputEl.type = "text";
    this.inputEl.spellcheck = false;
    this.inputEl.placeholder = "Find or connect…";
    this.inputEl.classList.add("ariadne-input");
    this.inputEl.addEventListener("input", () => this.onInput(this.inputEl.value));
    this.inputEl.addEventListener("keydown", (ev) => this.onKeydown(ev));
    root.appendChild(this.inputEl);

    // Search results — shown only while a query is active, capped at 2/3 height.
    this.resultsEl = doc.createElement("div");
    this.resultsEl.classList.add("ariadne-results");
    root.appendChild(this.resultsEl);

    // The Margin fills the remaining space below.
    const marginWrap = doc.createElement("div");
    marginWrap.classList.add("ariadne-margin-section");
    this.marginHintEl = doc.createElement("div");
    this.marginHintEl.classList.add("ariadne-empty");
    this.marginHintEl.textContent = MARGIN_HINT;
    this.marginEl = doc.createElement("div");
    this.marginEl.classList.add("ariadne-cards");
    marginWrap.append(this.marginHintEl, this.marginEl);
    root.appendChild(marginWrap);

    this.glyphEl = doc.createElement("div");
    this.glyphEl.classList.add("ariadne-glyph");
    root.appendChild(this.glyphEl);

    this.unsubscribeStatus = this.deps.status.subscribe((s) => this.renderGlyph(s));

    // Remember the most recent markdown editor so ⌥↵ / ⇧↵ know the source note.
    this.lastMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (mv) this.lastMarkdown = mv;
      }),
    );

    this.unsubscribeWatcher = this.deps.watcher.subscribe((ctx) => void this.refreshMargin(ctx));

    this.renderResults();
  }

  async onClose(): Promise<void> {
    this.unsubscribeStatus?.();
    this.unsubscribeWatcher?.();
    this.unsubscribeStatus = null;
    this.unsubscribeWatcher = null;
    if (this.debounce) clearTimeout(this.debounce);
  }

  focusInput(): void {
    this.inputEl?.focus();
    this.inputEl?.select();
  }

  /* ── Search half ────────────────────────────────────────────────────── */

  private get hasQuery(): boolean {
    return !!this.inputEl?.value.trim();
  }

  private onInput(value: string): void {
    this.selected = 0;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.runQuery(value), DEBOUNCE_MS);
  }

  private async runQuery(raw: string): Promise<void> {
    const token = ++this.queryToken;
    const manager = this.deps.manager();
    if (!raw.trim()) {
      this.results = [];
      this.renderResults();
      return;
    }
    if (!manager) {
      this.results = [];
      this.renderResults(WARMING_HINT);
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

  private get rowCount(): number {
    return this.results.length + (this.canCreate ? 1 : 0);
  }

  private get canCreate(): boolean {
    return !!this.deps.onCreateNote && this.hasQuery;
  }

  private setResults(results: ScoredResult[]): void {
    this.results = [
      ...results.filter((r) => !r.semanticOnly),
      ...results.filter((r) => r.semanticOnly),
    ];
    this.selected = Math.max(0, Math.min(this.selected, this.rowCount - 1));
    this.renderResults();
  }

  private renderResults(emptyHint?: string): void {
    if (!this.resultsEl) return;
    // Collapse the search section entirely when there's nothing to show, so
    // the Margin gets the full panel.
    const active = this.hasQuery;
    this.resultsEl.classList.toggle("is-active", active);
    if (!active) {
      this.resultsEl.replaceChildren();
      return;
    }

    renderResults(
      this.resultsEl,
      this.results,
      this.selected,
      {
        onOpen: (result, newLeaf) => this.openResult(result, newLeaf),
        onHoverSelect: (index) => {
          if (index !== this.selected) {
            this.selected = index;
            this.renderResults();
          }
        },
      },
      this.canCreate ? undefined : emptyHint,
    );

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
      this.renderResults();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
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
    const linktext = this.app.metadataCache.fileToLinktext(file, target.file?.path ?? "");
    target.editor.replaceSelection(`[[${linktext}]]`);
    target.editor.focus();
  }

  /* ── Margin half ────────────────────────────────────────────────────── */

  private async refreshMargin(ctx: DraftContext): Promise<void> {
    if (!this.deps.marginEnabled()) return;
    const manager = this.deps.manager();
    if (!manager) return;
    const token = ++this.marginToken;
    // On a blank line, fall back to whole-note context (title + opening).
    const contextText = ctx.text.trim() || `${ctx.title}\n${ctx.noteText.slice(0, 600)}`;
    const results = await manager.related(contextText, { excludePath: ctx.path, limit: CARD_LIMIT });
    if (token !== this.marginToken) return;
    this.renderMargin(results);
  }

  private renderMargin(results: ScoredResult[]): void {
    const doc = this.marginEl.ownerDocument;
    this.marginEl.replaceChildren();
    this.marginHintEl.style.display = results.length === 0 ? "" : "none";

    for (const r of results) {
      const card = doc.createElement("div");
      card.classList.add("ariadne-card", `ariadne-confidence-${prominence(r.confidence)}`);

      const head = doc.createElement("div");
      head.classList.add("ariadne-row-head");
      const title = doc.createElement("span");
      title.classList.add("ariadne-row-title");
      title.textContent = r.title;
      head.appendChild(title);
      if (r.spark) head.appendChild(sparklineEl(r.spark, doc));
      card.appendChild(head);

      if (r.snippet) {
        const snippet = doc.createElement("div");
        snippet.classList.add("ariadne-row-snippet");
        snippet.textContent = r.snippet;
        card.appendChild(snippet);
      }

      card.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        if (ev.shiftKey) this.deps.onWeave?.(r);
        else if (ev.altKey) this.insertLink(r);
        else void this.app.workspace.openLinkText(r.path, "", ev.metaKey || ev.ctrlKey);
      });
      this.marginEl.appendChild(card);
    }
  }

  /* ── Status glyph ───────────────────────────────────────────────────── */

  private renderGlyph(s: import("../core/status").AriadneStatus): void {
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
        ? ` · brain ${s.sessionCostUsd >= 0.005 ? `$${s.sessionCostUsd.toFixed(2)}` : "ready"}`
        : "";
    this.glyphEl.textContent =
      s.index === "error"
        ? `index error — ${s.lastError ?? "unknown"}`
        : `${s.indexedNotes} notes · ${state}${semantic}${brain}`;
    this.glyphEl.classList.toggle("is-error", s.index === "error");
  }
}
