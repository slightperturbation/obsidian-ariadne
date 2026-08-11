import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import type { IndexManager } from "../index/manager";
import type { StatusStore } from "../core/status";
import type { ScoredResult } from "../core/types";
import type { DraftWatcher, DraftContext } from "../margin/draft-watcher";
import type { TensionFinding } from "../margin/tension/detect";
import type { WantedTopic } from "../margin/wanted";
import { renderResults, rowEl, modifiersOf, type ActivateModifiers } from "./render";

export const ARIADNE_VIEW_TYPE = "ariadne-line";

const DEBOUNCE_MS = 120;
const WARMING_HINT = "Index is warming up…";
const SEARCHING_HINT = "Searching…";
const KEY_LEGEND = "↑↓ move · ↵ open · ⌘↵ pane · ⌥↵ link · ⇧↵ weave";
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
  /** Raw-cosine floor for Margin cards; undefined shows everything ranked. */
  marginMinCosine?: () => number | undefined;
  /** Link-graph neighbourhood of the note being written (backlinks + 2-hop). */
  marginNeighbors?: (path: string) => ReadonlySet<string>;
  /** Dated journal entries: demoted in the Margin, never ghost-suggested. */
  isPeriodic?: (path: string) => boolean;
  /** Dangling [[topics]] ranked by demand (see margin/wanted). */
  wantedTopics?: () => WantedTopic[];
  /** Create a note for a wanted topic (scaffolded, undoable). */
  onCreateWanted?: (title: string) => void;
  /** Touch device: show tap targets instead of a modifier-key legend. */
  touch?: () => boolean;
  /** Ambient tension/echo analysis (see margin/tension). */
  tensions?: {
    analyze(ctx: DraftContext): Promise<TensionFinding[]>;
    /** Fires when a background verdict lands — re-analyze and re-render. */
    subscribe(listener: () => void): () => void;
    dismiss(notePath: string, targetPath: string): void;
  };
  /** Per-surface prominence bias (serendipity tuning), added to confidence. */
  lineBias?: () => number;
  marginBias?: () => number;
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
  private wantedEl!: HTMLElement;
  /** Wanted topics the user waved off — for this session. */
  private dismissedWanted = new Set<string>();

  private results: ScoredResult[] = [];
  private selected = 0;
  private queryToken = 0;
  private marginToken = 0;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** Kept so re-renders (selection moves) don't drop the current status line. */
  private lastStatusHint?: string;
  private unsubscribeStatus: (() => void) | null = null;
  private unsubscribeWatcher: (() => void) | null = null;
  private unsubscribeTensions: (() => void) | null = null;
  private lastCtx?: DraftContext;
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
    this.inputEl.setAttribute("aria-label", "Search notes");
    this.inputEl.setAttribute("role", "combobox");
    this.inputEl.setAttribute("aria-expanded", "false");
    root.appendChild(this.inputEl);

    // The keyboard model is otherwise undiscoverable — ⇧↵ especially. On a
    // touch device it would describe keys that don't exist, so the rows carry
    // their own Link/Weave buttons instead (see rowEl).
    if (!this.touch) {
      const legend = doc.createElement("div");
      legend.classList.add("ariadne-keys");
      legend.textContent = KEY_LEGEND;
      root.appendChild(legend);
    }

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

    // Topics wanting notes — the vault's open loops, kept at the foot where
    // they read as an invitation rather than a task list.
    this.wantedEl = doc.createElement("div");
    this.wantedEl.classList.add("ariadne-wanted");
    root.appendChild(this.wantedEl);

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
    // A classification verdict arriving is new information about the same
    // paragraph — re-run the analysis for the context we already have.
    this.unsubscribeTensions =
      this.deps.tensions?.subscribe(() => {
        if (this.lastCtx) void this.refreshMargin(this.lastCtx);
      }) ?? null;

    this.renderResults();
  }

  async onClose(): Promise<void> {
    this.unsubscribeStatus?.();
    this.unsubscribeWatcher?.();
    this.unsubscribeTensions?.();
    this.unsubscribeStatus = null;
    this.unsubscribeWatcher = null;
    this.unsubscribeTensions = null;
    if (this.debounce) clearTimeout(this.debounce);
  }

  focusInput(): void {
    this.inputEl?.focus();
    this.inputEl?.select();
  }

  /* ── Search half ────────────────────────────────────────────────────── */

  /** Whether this device has no modifier keys to gate actions behind. */
  private get touch(): boolean {
    return this.deps.touch?.() ?? false;
  }

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
    this.setResults(lexical, SEARCHING_HINT);

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

  private setResults(results: ScoredResult[], statusHint?: string): void {
    this.results = [
      ...results.filter((r) => !r.semanticOnly),
      ...results.filter((r) => r.semanticOnly),
    ];
    this.selected = Math.max(0, Math.min(this.selected, this.rowCount - 1));
    this.renderResults(statusHint);
  }

  private renderResults(statusHint?: string): void {
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
        onActivate: (result, mods) => this.activate(result, mods),
        onHoverSelect: (index) => {
          if (index !== this.selected) {
            this.selected = index;
            this.renderResults(this.lastStatusHint);
          }
        },
      },
      undefined,
      this.touch,
      this.deps.lineBias?.() ?? 0,
    );

    // A status line above the Do row: without it, "index still warming",
    // "searching", and "no matches" were all indistinguishable from each other
    // (the old empty-hint was routed through canCreate and never rendered).
    this.lastStatusHint = statusHint;
    const hint = statusHint ?? (this.results.length === 0 ? "No matches." : undefined);
    if (hint) {
      const el = this.resultsEl.ownerDocument.createElement("div");
      el.classList.add("ariadne-empty");
      el.textContent = hint;
      this.resultsEl.appendChild(el);
    }

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
      row.addEventListener("mousemove", () => {
        if (this.selected !== this.results.length) {
          this.selected = this.results.length;
          this.renderResults(this.lastStatusHint);
        }
      });
      this.resultsEl.appendChild(row);
    }

    this.scrollSelectionIntoView();
  }

  /** Keep the keyboard selection visible — the pane scrolls at 2/3 height. */
  private scrollSelectionIntoView(): void {
    this.resultsEl
      .querySelector(".is-selected")
      ?.scrollIntoView({ block: "nearest" });
  }

  /** Route a result activation by modifier, identically from any surface. */
  private activate(result: ScoredResult, mods: ActivateModifiers): void {
    if (mods.weave) this.deps.onWeave?.(result);
    else if (mods.insertLink) this.insertLink(result);
    else this.openResult(result, mods.newLeaf);
  }

  private onKeydown(ev: KeyboardEvent): void {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (this.rowCount === 0) return;
      const delta = ev.key === "ArrowDown" ? 1 : -1;
      this.selected = (this.selected + delta + this.rowCount) % this.rowCount;
      this.renderResults(this.lastStatusHint);
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
      this.activate(result, modifiersOf(ev));
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
    this.lastCtx = ctx;
    const token = ++this.marginToken;
    // On a blank line, fall back to whole-note context (title + opening).
    const contextText = ctx.text.trim() || `${ctx.title}\n${ctx.noteText.slice(0, 600)}`;
    // Already-linked notes are not news; and the Margin holds itself to a
    // (looser than ghost text) semantic bar, so an empty section is a valid,
    // honest outcome rather than five cards of noise.
    const linked = new Set(
      [...ctx.noteText.matchAll(/\[\[([^\]|#^]+)/g)].map((m) => m[1].trim()),
    );
    const opts = {
      excludePath: ctx.path,
      limit: CARD_LIMIT,
      excludeTitles: linked,
      minCosine: this.deps.marginMinCosine?.(),
      neighbors: this.deps.marginNeighbors?.(ctx.path),
      // While journaling, the nearest neighbors are other dated entries;
      // the permanent note on the idea must outrank last Tuesday's mention.
      deprioritize: this.deps.isPeriodic,
    };
    // Without a local model, free text can't be embedded — but the note being
    // written was embedded by whichever device owns the index, so asking in
    // terms of the note keeps the Margin semantic instead of lexical-only.
    const [results, findings] = await Promise.all([
      manager.canEmbedText() || !manager.hasStoredVectors()
        ? manager.related(contextText, opts)
        : manager.relatedToPath(ctx.path, opts),
      this.deps.tensions?.analyze(ctx) ?? Promise.resolve([]),
    ]);
    if (token !== this.marginToken) return;
    // A note flagged as tension/echo shouldn't ALSO appear as a plain related
    // card below — one note, one card, the sharper reading wins.
    const flagged = new Set(findings.map((f) => f.path));
    this.renderMargin(results.filter((r) => !flagged.has(r.path)), findings, ctx);
  }

  private renderMargin(
    results: ScoredResult[],
    findings: TensionFinding[] = [],
    ctx?: DraftContext,
  ): void {
    const doc = this.marginEl.ownerDocument;
    this.marginEl.replaceChildren();

    if (!this.deps.marginEnabled()) {
      this.marginHintEl.classList.remove("is-hidden");
      this.marginHintEl.textContent = "Margin is off — enable it in Ariadne settings.";
      return;
    }
    this.marginHintEl.textContent = MARGIN_HINT;
    this.marginHintEl.classList.toggle(
      "is-hidden",
      results.length > 0 || findings.length > 0,
    );

    // Tension/echo findings first: rarer, sharper signals than relatedness.
    findings.forEach((f, i) => {
      this.marginEl.appendChild(this.tensionRowEl(doc, f, i, ctx));
    });
    this.renderWanted();

    // Same row component as the search results, so ⇧/⌥/⌘ mean the same thing
    // in both halves of the panel.
    const bias = this.deps.marginBias?.() ?? 0;
    results.forEach((r, i) => {
      this.marginEl.appendChild(
        rowEl(
          doc,
          r,
          findings.length + i,
          false,
          {
            onActivate: (result, mods) => this.activate(result, mods),
            onHoverSelect: () => {},
          },
          { variant: "card", touch: this.touch, bias },
        ),
      );
    });
  }

  /**
   * A tension/echo card: the shared row (so open/link/weave behave normally)
   * with a small-caps kind label ahead of the title, the model's explanation
   * as the snippet, and a quiet per-session dismiss. No badge, no capsule —
   * the label is text, per the design system.
   */
  private tensionRowEl(
    doc: Document,
    f: TensionFinding,
    index: number,
    ctx?: DraftContext,
  ): HTMLElement {
    const asResult: ScoredResult = {
      path: f.path,
      title: f.title,
      snippet: f.snippet,
      score: f.cosine,
      confidence: f.confidence,
      cosine: f.cosine,
    };
    const row = rowEl(
      doc,
      asResult,
      index,
      false,
      {
        onActivate: (result, mods) => this.activate(result, mods),
        onHoverSelect: () => {},
      },
      { variant: "card", touch: this.touch },
    );
    row.classList.add(f.kind === "tension" ? "ariadne-tension" : "ariadne-echo");

    const head = row.querySelector(".ariadne-row-head");
    if (head) {
      const label = doc.createElement("span");
      label.classList.add("ariadne-kind-label");
      label.textContent = f.kind === "tension" ? "tension" : "echo";
      head.insertBefore(label, head.firstChild);

      if (this.deps.tensions && ctx) {
        const dismiss = doc.createElement("button");
        dismiss.type = "button";
        dismiss.classList.add("ariadne-dismiss");
        dismiss.textContent = "×";
        dismiss.setAttribute("aria-label", `Dismiss ${f.kind} with ${f.title}`);
        dismiss.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.deps.tensions!.dismiss(ctx.path, f.path);
          void this.refreshMargin(ctx);
        });
        head.appendChild(dismiss);
      }
    }
    return row;
  }

  /**
   * "Wanted by N notes" rows for dangling topics. Activation scaffolds the
   * note — the one-keystroke close of a loop the writer has been leaving
   * open; × waves the topic off for this session.
   */
  private renderWanted(): void {
    if (!this.wantedEl) return;
    this.wantedEl.replaceChildren();
    const topics = (this.deps.wantedTopics?.() ?? []).filter(
      (t) => !this.dismissedWanted.has(t.title),
    );
    if (topics.length === 0 || !this.deps.onCreateWanted) return;

    const doc = this.wantedEl.ownerDocument;
    const label = doc.createElement("div");
    label.classList.add("ariadne-section-label");
    label.textContent = "Wanted";
    this.wantedEl.appendChild(label);

    for (const topic of topics) {
      const row = doc.createElement("div");
      row.classList.add("ariadne-row", "ariadne-confidence-quiet");
      const head = doc.createElement("div");
      head.classList.add("ariadne-row-head");
      const title = doc.createElement("span");
      title.classList.add("ariadne-row-title");
      title.textContent = topic.title;
      const count = doc.createElement("span");
      count.classList.add("ariadne-wanted-count");
      count.textContent = `wanted by ${topic.sources}`;
      const dismiss = doc.createElement("button");
      dismiss.type = "button";
      dismiss.classList.add("ariadne-dismiss");
      dismiss.textContent = "×";
      dismiss.setAttribute("aria-label", `Dismiss ${topic.title} for this session`);
      dismiss.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.dismissedWanted.add(topic.title);
        this.renderWanted();
      });
      head.append(title, count, dismiss);
      row.appendChild(head);
      row.addEventListener("click", () => this.deps.onCreateWanted!(topic.title));
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Create the note ${topic.title}`);
      this.wantedEl.appendChild(row);
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
            : s.semantic === "synced"
              ? " · semantic synced"
              : " · semantic on";
    // Honesty as UI (PRD §4.6): say which brain answered last, and the real
    // number for cloud spend. "local" is the home box — free, so no figure.
    const brain =
      s.brain === "cloud"
        ? ` · brain ${s.sessionCostUsd >= 0.005 ? `$${s.sessionCostUsd.toFixed(2)}` : "ready"}`
        : s.brain === "local"
          ? ` · brain local${s.sessionCostUsd >= 0.005 ? ` ($${s.sessionCostUsd.toFixed(2)} cloud)` : ""}`
          : "";
    // A reader device can't embed notes edited since the owner last indexed,
    // so say how many are in that state rather than quietly ranking them worse.
    const stale =
      s.role === "consumer" && s.staleNotes > 0 ? ` · ${s.staleNotes} awaiting desktop` : "";
    this.glyphEl.textContent =
      s.index === "error"
        ? `index error — ${s.lastError ?? "unknown"}`
        : `${s.indexedNotes} notes · ${state}${semantic}${stale}${brain}`;
    this.glyphEl.classList.toggle("is-error", s.index === "error");
  }
}
