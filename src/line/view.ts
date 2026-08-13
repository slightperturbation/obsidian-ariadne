import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import type { IndexManager } from "../index/manager";
import type { StatusStore } from "../core/status";
import type { ScoredResult } from "../core/types";
import type { DraftWatcher, DraftContext } from "../margin/draft-watcher";
import type { TensionFinding } from "../margin/tension/detect";
import type { WantedTopic } from "../margin/wanted";
import { isReflectiveProse } from "../margin/journal";
import { normalizeTag, suggestTags } from "../margin/tags";
import { renderResults, rowEl, modifiersOf, type ActivateModifiers } from "./render";

export const ARIADNE_VIEW_TYPE = "ariadne-line";

const DEBOUNCE_MS = 120;
const WARMING_HINT = "Index is warming up…";
const SEARCHING_HINT = "Searching…";
const KEY_LEGEND = "↑↓ move · ↵ open · ⌘↵ pane · ⌥↵ link · ⇧↵ weave";
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
  /** Past entries sharing today's month-day (when a dated note is open). */
  onThisDay?: (currentPath: string) => string[];
  /** Today's "still true?" resurfaced note, with its opening line once read. */
  resurfaced?: () => { path: string; title: string; line?: string } | null;
  /** Offer promotion while writing reflective prose in a journal note. */
  promoteHint?: () => boolean;
  onPromote?: () => void;
  /** Tag suggestions in the Margin: the neighbors' taxonomy, never invented. */
  tagSuggestions?: () => boolean;
  tagsOf?: (path: string) => string[];
  onAddTag?: (path: string, tag: string) => void;
  /** Kind tags (daily/journal): lifecycle marks, never topical suggestions. */
  reservedTags?: () => string[];
  /**
   * Session-scoped dismissals, owned by the plugin: "for this session" must
   * survive the sidebar being closed and reopened (which rebuilds the view).
   */
  session?: { wanted: Set<string>; tagRows: Set<string>; resurfaced: { dismissed: boolean } };
  /** True when no note dated today exists yet — the day hasn't been opened. */
  todayMissing?: () => boolean;
  /** Create (or open) today's entry, honoring the Daily Notes plugin. */
  onBeginToday?: () => void;
  /** Today's entry path once it exists — the Today zone's anchor row. */
  todayEntry?: () => string | null;
  /** The evening has arrived (per the configured hour). */
  closeDayDue?: () => boolean;
  onCloseDay?: () => void;
  /** It's the week's edge (Sunday). */
  synthesisDue?: () => boolean;
  onWeeklySynthesis?: () => void;
  /** Inbox size, for the Vault zone's triage row. */
  inboxCount?: () => number;
  onTriage?: () => void;
  /** Contextual verbs for the Now zone. */
  onSplit?: () => void;
  onMerge?: () => void;
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
  private todayEl!: HTMLElement;
  /** Fallback when the plugin doesn't supply shared session state (tests). */
  private localSession = {
    wanted: new Set<string>(),
    tagRows: new Set<string>(),
    resurfaced: { dismissed: false },
  };
  private get session(): NonNullable<AriadneViewDeps["session"]> {
    return this.deps.session ?? this.localSession;
  }

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
    return "ariadne-thread";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    const doc = root.ownerDocument;
    root.classList.add("ariadne", "ariadne-panel");
    root.replaceChildren();

    // The panel names itself — a sidebar fills with lookalike tabs, and a
    // quiet wordmark is cheaper to recognize than an icon tooltip. Small-caps
    // text, no capsule, per the design system.
    const wordmark = doc.createElement("div");
    wordmark.classList.add("ariadne-wordmark");
    wordmark.textContent = "Ariadne";
    wordmark.setAttribute("aria-hidden", "true");
    root.appendChild(wordmark);

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
    this.inputEl.setAttribute("aria-controls", "ariadne-results-listbox");
    root.appendChild(this.inputEl);

    // The keyboard model is otherwise undiscoverable — ⇧↵ especially. On a
    // touch device it would describe keys that don't exist, so the rows carry
    // their own Link/Weave buttons instead (see rowEl). Shown only while the
    // input is focused: teaching material appears when it's usable — a
    // legend for keys you can't currently press would be furniture.
    if (!this.touch) {
      const legend = doc.createElement("div");
      legend.classList.add("ariadne-keys");
      legend.textContent = KEY_LEGEND;
      root.appendChild(legend);
      this.inputEl.addEventListener("focus", () => legend.classList.add("is-visible"));
      this.inputEl.addEventListener("blur", () => legend.classList.remove("is-visible"));
    }

    // Search results — shown only while a query is active, capped at 2/3 height.
    this.resultsEl = doc.createElement("div");
    this.resultsEl.classList.add("ariadne-results");
    // The options the combobox's aria-activedescendant points into.
    this.resultsEl.setAttribute("role", "listbox");
    this.resultsEl.id = "ariadne-results-listbox";
    root.appendChild(this.resultsEl);

    // The concentric zones: reading downward moves outward from the point of
    // attention — the thought under the cursor (Now), the day around it
    // (Today), the vault around that (Vault). Position encodes distance, so
    // the eye learns where a class of information lives and stops searching.
    const marginWrap = doc.createElement("div");
    marginWrap.classList.add("ariadne-margin-section", "ariadne-zone");
    this.marginHintEl = doc.createElement("div");
    this.marginHintEl.classList.add("ariadne-empty", "is-hidden");
    this.marginEl = doc.createElement("div");
    this.marginEl.classList.add("ariadne-cards");
    marginWrap.append(this.marginHintEl, this.marginEl);
    root.appendChild(marginWrap);

    this.todayEl = doc.createElement("div");
    this.todayEl.classList.add("ariadne-zone");
    root.appendChild(this.todayEl);

    this.wantedEl = doc.createElement("div");
    this.wantedEl.classList.add("ariadne-wanted", "ariadne-zone");
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
    // The foot's invitations (Today, Still true?, Wanted) don't need a draft
    // context — a fresh vault with no note open is exactly when "begin
    // today's entry" matters most.
    this.renderWanted();
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
    if (!value.trim()) {
      // Immediately, not after the debounce: Enter inside the 120 ms window
      // must not open a result from the abandoned query.
      this.results = [];
      this.lastStatusHint = undefined;
      this.queryToken++;
      this.renderResults();
      return;
    }
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

    this.inputEl.setAttribute("aria-expanded", String(active && this.rowCount > 0));
    if (active && this.selected < this.results.length) {
      this.inputEl.setAttribute("aria-activedescendant", `ariadne-opt-row-${this.selected}`);
    } else {
      this.inputEl.removeAttribute("aria-activedescendant");
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
    this.lastCtx = ctx;
    // Margin off is not "panel off": the foot sections (Wanted, Today,
    // Still true?) have their own toggles and no dependency on retrieval —
    // render them, show the honest off-state, and skip only the retrieval.
    if (!this.deps.marginEnabled()) {
      this.renderMargin([], [], ctx);
      return;
    }
    const manager = this.deps.manager();
    if (!manager) {
      this.renderMargin([], [], ctx);
      return;
    }
    const token = ++this.marginToken;
    // On a blank line, fall back to whole-note context (title + opening).
    const contextText = ctx.text.trim() || `${ctx.title}\n${ctx.noteText.slice(0, 600)}`;
    // Already-linked notes are not news; and the Margin holds itself to a
    // (looser than ghost text) semantic bar, so an empty section is a valid,
    // honest outcome rather than five cards of noise.
    // [[folder/Note]] must exclude "Note": link text can be a path.
    const linked = new Set(
      [...ctx.noteText.matchAll(/\[\[([^\]|#^]+)/g)].map((m) =>
        m[1].trim().split("/").pop()!.trim(),
      ),
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
    let results: ScoredResult[];
    let findings: TensionFinding[];
    try {
      [results, findings] = await Promise.all([
      manager.canEmbedText() || !manager.hasStoredVectors()
        ? manager.related(contextText, opts)
        : manager.relatedToPath(ctx.path, opts),
        this.deps.tensions?.analyze(ctx) ?? Promise.resolve([]),
      ]);
    } catch (err) {
      // A worker hiccup mid-retrieval leaves the previous render standing;
      // an unhandled rejection would leave it standing AND spam the console.
      console.warn("[Ariadne] margin refresh failed", err);
      return;
    }
    if (token !== this.marginToken) return;
    // The awaits above take real time (a tension verdict can trigger this
    // seconds later). If the user has moved to a PDF/canvas/other note, do
    // not repaint a stale note's cards — their click handlers would act on a
    // note that is no longer open (a tag click would write ITS frontmatter).
    const activePath = this.app.workspace.getActiveFile()?.path;
    if (activePath !== undefined && activePath !== ctx.path) return;
    // A note flagged as tension/echo shouldn't ALSO appear as a plain related
    // card below — one note, one card, the sharper reading wins.
    const flagged = new Set(findings.map((f) => f.path));
    this.renderMargin(
      results.filter((r) => !flagged.has(r.path)),
      findings,
      ctx,
      results,
    );
  }

  private renderMargin(
    results: ScoredResult[],
    findings: TensionFinding[] = [],
    ctx?: DraftContext,
    /** Pre-filter results: the taxonomy vote must see the CLOSEST neighbors,
     * which are exactly the ones the card list filters out (flagged, linked). */
    tagEvidence: ScoredResult[] = results,
  ): void {
    const doc = this.marginEl.ownerDocument;
    this.marginEl.replaceChildren();

    if (!this.deps.marginEnabled()) {
      this.marginHintEl.classList.remove("is-hidden");
      this.marginHintEl.textContent = "Margin is off — enable it in Ariadne settings.";
      this.marginEl.parentElement?.classList.remove("has-content");
      this.renderWanted();
      return;
    }

    // Tension/echo findings first: rarer, sharper signals than relatedness.
    findings.forEach((f, i) => {
      this.marginEl.appendChild(this.tensionRowEl(doc, f, i, ctx));
    });

    // Journal mode: a dated note's Margin leads with the reflective
    // companions — the offer to keep a thought, then this day in past years —
    // before topical relatedness. A logbook wants navigation; a journal
    // wants return.
    let journalSections = false;
    if (ctx && this.deps.isPeriodic?.(ctx.path)) {
      this.renderPromoteHint(doc, ctx);
      this.renderOnThisDay(this.marginEl, ctx.path);
      journalSections = this.marginEl.childElementCount > findings.length;
    } else if (ctx) {
      // Contextual verbs for permanent notes — the panel noticing occasions,
      // never listing capabilities. At most one: a near-duplicate this close
      // outranks structural advice.
      const top = tagEvidence[0];
      if (top?.cosine !== undefined && top.cosine >= 0.95 && this.deps.onMerge) {
        this.verbRow(this.marginEl, `merge with “${top.title}”`, `Merge with ${top.title}`, () =>
          this.deps.onMerge!(),
        );
      } else if (
        this.deps.onSplit &&
        ctx.noteText.length > 2500 &&
        (ctx.noteText.match(/^##\s/gm)?.length ?? 0) < 2
      ) {
        this.verbRow(this.marginEl, "split this note", "Split this note into atomic notes", () =>
          this.deps.onSplit!(),
        );
      }
    }
    if (ctx) this.renderTagSuggestions(doc, ctx, tagEvidence);
    this.renderWanted();

    // With sections above, unlabeled cards would visually belong to the last
    // label ("On this day"); name them.
    if (results.length > 0 && (findings.length > 0 || journalSections)) {
      const label = doc.createElement("div");
      label.classList.add("ariadne-section-label");
      label.textContent = "Related";
      this.marginEl.appendChild(label);
    }

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
    // An empty Now zone is empty — no rule, no label, no tautology telling
    // the writer that writing produces notes. Content earns the apparatus.
    this.marginHintEl.classList.add("is-hidden");
    const hasContent = this.marginEl.childElementCount > 0;
    this.marginEl.parentElement?.classList.toggle("has-content", hasContent);
    if (hasContent) {
      const label = doc.createElement("div");
      label.classList.add("ariadne-zone-label");
      label.textContent = "now";
      this.marginEl.insertBefore(label, this.marginEl.firstChild);
    }
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
    this.renderToday();
    this.wantedEl.replaceChildren();
    this.renderVaultRows();
    this.wantedEl.classList.toggle("has-content", this.wantedEl.childElementCount > 0);
    if (this.wantedEl.childElementCount > 0) {
      const doc = this.wantedEl.ownerDocument;
      const label = doc.createElement("div");
      label.classList.add("ariadne-zone-label");
      label.textContent = "vault";
      this.wantedEl.insertBefore(label, this.wantedEl.firstChild);
    }
  }

  /** The Vault zone: the vault's open loops — wanted, the daily reading, the inbox. */
  private renderVaultRows(): void {
    const doc = this.wantedEl.ownerDocument;
    const topics = (this.deps.wantedTopics?.() ?? []).filter(
      (t) => !this.session.wanted.has(t.title),
    );
    this.renderWantedRows(doc, topics);
    this.renderResurfaced();
    this.renderInboxRow(doc);
  }

  /** Inbox as an open loop with its count — the triage flow, one click away. */
  private renderInboxRow(doc: Document): void {
    const count = this.deps.inboxCount?.() ?? 0;
    if (count === 0 || !this.deps.onTriage) return;
    const row = doc.createElement("div");
    row.classList.add("ariadne-row", "ariadne-confidence-faint");
    const head = doc.createElement("div");
    head.classList.add("ariadne-row-head");
    const title = doc.createElement("span");
    title.classList.add("ariadne-row-title");
    title.textContent = "Inbox → triage";
    const n = doc.createElement("span");
    n.classList.add("ariadne-wanted-count");
    n.textContent = String(count);
    head.append(title, n);
    row.appendChild(head);
    row.setAttribute("aria-label", `Triage ${count} Inbox notes`);
    this.actionable(row, () => this.deps.onTriage!());
    this.wantedEl.appendChild(row);
  }

  private renderWantedRows(doc: Document, topics: import("../margin/wanted").WantedTopic[]): void {
    if (topics.length === 0 || !this.deps.onCreateWanted) return;

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
        this.session.wanted.add(topic.title);
        this.renderWanted();
      });
      head.append(title, count, dismiss);
      row.appendChild(head);
      row.setAttribute("aria-label", `Create the note ${topic.title}`);
      this.actionable(row, (ev?: Event) => {
        // The dismiss × inside the head must not create the note.
        void ev;
        this.deps.onCreateWanted!(topic.title);
      });
      this.wantedEl.appendChild(row);
    }
  }

  /**
   * A div announced as a button must also BE one: focusable, and pressable
   * with Enter/Space. Every role="button" row goes through here.
   */
  private actionable(el: HTMLElement, run: () => void): void {
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.addEventListener("click", (ev) => {
      // Buttons inside the row (dismiss ×) act on their own.
      if (ev.target instanceof Element && ev.target.closest("button")) return;
      run();
    });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        run();
      }
    });
  }

  /** A minimal open-on-click row for the foot sections. */
  private footRowEl(title: string, path: string, aria: string): HTMLElement {
    const doc = this.wantedEl.ownerDocument;
    const row = doc.createElement("div");
    row.classList.add("ariadne-row", "ariadne-confidence-faint");
    const head = doc.createElement("div");
    head.classList.add("ariadne-row-head");
    const label = doc.createElement("span");
    label.classList.add("ariadne-row-title");
    label.textContent = title;
    head.appendChild(label);
    row.appendChild(head);
    row.setAttribute("aria-label", aria);
    this.actionable(row, () => void this.app.workspace.openLinkText(path, "", false));
    return row;
  }

  /**
   * Tags for this note, drawn from its semantic neighbors' existing tags —
   * corroborated (two sources) or nearly-identical (one very close source),
   * and never invented, so the vault's taxonomy converges instead of
   * sprawling. Click adopts a tag into frontmatter; × waves the row off for
   * this note this session.
   */
  private renderTagSuggestions(doc: Document, ctx: DraftContext, results: ScoredResult[]): void {
    if (!this.deps.tagSuggestions?.() || !this.deps.tagsOf || !this.deps.onAddTag) return;
    if (this.session.tagRows.has(ctx.path)) return;
    const own = new Set([
      ...this.deps.tagsOf(ctx.path).map((t) => normalizeTag(t).toLowerCase()),
      // A permanent note near journal entries must not be offered #journal —
      // kind tags mark lifecycle, and lifecycle never propagates by topic.
      ...(this.deps.reservedTags?.() ?? []).map((t) => t.toLowerCase()),
    ]);
    const suggested = suggestTags(
      results.map((r) => ({ cosine: r.cosine, tags: this.deps.tagsOf!(r.path) })),
      own,
    );
    if (suggested.length === 0) return;

    const row = doc.createElement("div");
    row.classList.add("ariadne-tag-suggestions");
    const label = doc.createElement("span");
    label.classList.add("ariadne-kind-label");
    label.textContent = "tags";
    row.appendChild(label);
    for (const tag of suggested) {
      const el = doc.createElement("button");
      el.type = "button";
      el.classList.add("ariadne-tag-suggestion");
      el.textContent = `#${tag}`;
      el.setAttribute("aria-label", `Add the tag ${tag} to this note`);
      el.addEventListener("click", () => {
        this.deps.onAddTag!(ctx.path, tag);
        el.remove();
      });
      row.appendChild(el);
    }
    const dismiss = doc.createElement("button");
    dismiss.type = "button";
    dismiss.classList.add("ariadne-dismiss");
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "Dismiss tag suggestions for this note");
    dismiss.addEventListener("click", () => {
      this.session.tagRows.add(ctx.path);
      row.remove();
    });
    row.appendChild(dismiss);
    this.marginEl.appendChild(row);
  }

  /**
   * The moment-of-writing bridge out of the journal: when the paragraph
   * under the cursor is reflective prose (not log lines — a task list has
   * nothing to promote), one quiet row offers to keep the thought. The same
   * command exists in the palette; this makes it visible exactly when it
   * applies, and only then.
   */
  private renderPromoteHint(doc: Document, ctx: DraftContext): void {
    if (!this.deps.promoteHint?.() || !this.deps.onPromote) return;
    if (!isReflectiveProse(ctx.text)) return;
    const row = doc.createElement("div");
    row.classList.add("ariadne-promote-hint");
    row.textContent = "↳ promote this thought to a note";
    row.setAttribute("aria-label", "Promote the current paragraph to a note");
    this.actionable(row, () => this.deps.onPromote!());
    this.marginEl.appendChild(row);
  }

  /** Past entries on this month-day — rendered into a dated note's Margin. */
  private renderOnThisDay(container: HTMLElement, path: string): void {
    const past = (this.deps.onThisDay?.(path) ?? []).slice(0, 3);
    if (past.length === 0) return;
    const doc = container.ownerDocument;
    const label = doc.createElement("div");
    label.classList.add("ariadne-section-label");
    label.textContent = "On this day";
    container.appendChild(label);
    for (const p of past) {
      const title = p.split("/").pop()!.replace(/\.md$/, "");
      container.appendChild(this.footRowEl(title, p, `Open ${title}`));
    }
  }

  /** A "↳ verb" row — the panel's one idiom for an applicable action. */
  private verbRow(container: HTMLElement, text: string, aria: string, run: () => void): void {
    const row = container.ownerDocument.createElement("div");
    row.classList.add("ariadne-promote-hint");
    row.textContent = `↳ ${text}`;
    row.setAttribute("aria-label", aria);
    this.actionable(row, run);
    container.appendChild(row);
  }

  /**
   * The Today zone: where the day stands, and what the hour asks for. A verb
   * appears only on its occasion — begin when no entry exists, close the day
   * in the evening, synthesis on Sundays. A verb that appears only when it
   * applies is information; a permanent button is furniture.
   */
  private renderToday(): void {
    if (!this.todayEl) return;
    this.todayEl.replaceChildren();
    const doc = this.todayEl.ownerDocument;

    if (this.deps.todayMissing?.() && this.deps.onBeginToday) {
      this.verbRow(
        this.todayEl,
        "begin today's entry",
        "Create and open today's journal entry",
        () => this.deps.onBeginToday!(),
      );
    } else {
      const entry = this.deps.todayEntry?.();
      if (entry) {
        const name = entry.split("/").pop()!.replace(/\.md$/, "");
        this.todayEl.appendChild(this.footRowEl(name, entry, `Open today's entry ${name}`));
      }
    }
    if (this.deps.closeDayDue?.() && this.deps.onCloseDay) {
      this.verbRow(this.todayEl, "close the day", "Review the day's open loops", () =>
        this.deps.onCloseDay!(),
      );
    }
    if (this.deps.synthesisDue?.() && this.deps.onWeeklySynthesis) {
      this.verbRow(this.todayEl, "weekly synthesis", "Draw questions from the week", () =>
        this.deps.onWeeklySynthesis!(),
      );
    }

    this.todayEl.classList.toggle("has-content", this.todayEl.childElementCount > 0);
    if (this.todayEl.childElementCount > 0) {
      const label = doc.createElement("div");
      label.classList.add("ariadne-zone-label");
      label.textContent = "today";
      this.todayEl.insertBefore(label, this.todayEl.firstChild);
    }
  }

  /**
   * The daily reading: one old, barely-linked note a day, speaking its own
   * opening line — marginalia from a past self. Denser, truer, and quieter
   * than a placeholder hint.
   */
  private renderResurfaced(): void {
    if (this.session.resurfaced.dismissed) return;
    const pick = this.deps.resurfaced?.();
    if (!pick) return;
    const doc = this.wantedEl.ownerDocument;
    const row = this.footRowEl(pick.title, pick.path, `Revisit ${pick.title}`);
    const head = row.querySelector(".ariadne-row-head");
    if (head) {
      const still = doc.createElement("span");
      still.classList.add("ariadne-wanted-count");
      still.textContent = "still true?";
      head.appendChild(still);
      const dismiss = doc.createElement("button");
      dismiss.type = "button";
      dismiss.classList.add("ariadne-dismiss");
      dismiss.textContent = "×";
      dismiss.setAttribute("aria-label", "Dismiss for this session");
      dismiss.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.session.resurfaced.dismissed = true;
        this.renderWanted();
      });
      head.appendChild(dismiss);
    }
    if (pick.line) {
      const line = doc.createElement("div");
      line.classList.add("ariadne-row-snippet", "ariadne-reading");
      line.textContent = `“${pick.line}”`;
      row.appendChild(line);
    }
    this.wantedEl.appendChild(row);
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
    const capped = s.capped ? " · capped" : "";
    const brain =
      s.brain === "cloud"
        ? ` · brain ${s.sessionCostUsd >= 0.005 ? `$${s.sessionCostUsd.toFixed(2)}` : "ready"}${capped}`
        : s.brain === "local"
          ? ` · brain local${s.sessionCostUsd >= 0.005 ? ` ($${s.sessionCostUsd.toFixed(2)} cloud)` : ""}${capped}`
          : "";
    // A reader device can't embed notes edited since the owner last indexed,
    // so say how many are in that state rather than quietly ranking them worse.
    const stale =
      s.role === "consumer" && s.staleNotes > 0 ? ` · ${s.staleNotes} awaiting desktop` : "";
    // A reader with nothing to read is the one state the console shouldn't
    // own: the fix ("index on a desktop first") belongs where the user looks.
    const readerGap =
      s.role === "consumer" && s.semantic !== "synced" ? " · no synced index" : "";
    this.glyphEl.textContent =
      s.index === "error"
        ? `index error — ${s.lastError ?? "unknown"}`
        : `${s.indexedNotes} notes · ${state}${semantic}${readerGap}${stale}${brain}`;
    this.glyphEl.classList.toggle("is-error", s.index === "error");
  }
}
