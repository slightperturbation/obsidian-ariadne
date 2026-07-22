import { ItemView, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import type { IndexManager } from "../index/manager";
import type { DraftWatcher, DraftContext } from "./draft-watcher";
import type { ScoredResult } from "../core/types";
import { prominence } from "../index/confidence";
import { sparklineEl } from "../line/sparkline";

export const ARIADNE_MARGIN_VIEW_TYPE = "ariadne-margin";

const CARD_LIMIT = 5;

export interface MarginDeps {
  manager: () => IndexManager | undefined;
  watcher: DraftWatcher;
  enabled: () => boolean;
  /** ⇧-click: weave a bidirectional link with this card's note. */
  onWeave?: (result: ScoredResult) => void;
}

/**
 * The Margin: related notes that follow the writing, updated on typing
 * pauses via the shared DraftWatcher (one extraction feeds this and the
 * ghost engine — no double querying). Confidence scales prominence, so weak
 * relations sit faint at the edge of attention. Click opens; ⌥-click inserts
 * a [[link]] at the cursor. Read-only toward the vault except that insert.
 */
export class MarginView extends ItemView {
  navigation = false;

  private cardsEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private queryToken = 0;
  private lastMarkdown: MarkdownView | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private deps: MarginDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return ARIADNE_MARGIN_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Ariadne margin";
  }

  getIcon(): string {
    return "links-coming-in";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    const doc = root.ownerDocument;
    root.classList.add("ariadne", "ariadne-margin");
    root.replaceChildren();

    this.hintEl = doc.createElement("div");
    this.hintEl.classList.add("ariadne-empty");
    this.hintEl.textContent = "Write, and related notes appear here.";
    root.appendChild(this.hintEl);

    this.cardsEl = doc.createElement("div");
    this.cardsEl.classList.add("ariadne-cards");
    root.appendChild(this.cardsEl);

    this.lastMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (mv) this.lastMarkdown = mv;
      }),
    );

    this.unsubscribe = this.deps.watcher.subscribe((ctx) => void this.refresh(ctx));
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async refresh(ctx: DraftContext): Promise<void> {
    if (!this.deps.enabled()) return;
    const manager = this.deps.manager();
    if (!manager) return;
    const token = ++this.queryToken;
    // On a blank line, fall back to whole-note context (title + opening).
    const contextText = ctx.text.trim() || `${ctx.title}\n${ctx.noteText.slice(0, 600)}`;
    const results = await manager.related(contextText, {
      excludePath: ctx.path,
      limit: CARD_LIMIT,
    });
    if (token !== this.queryToken) return;
    this.render(results);
  }

  private render(results: ScoredResult[]): void {
    const doc = this.cardsEl.ownerDocument;
    this.cardsEl.replaceChildren();
    this.hintEl.style.display = results.length === 0 ? "" : "none";

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
      this.cardsEl.appendChild(card);
    }
  }

  private insertLink(result: ScoredResult): void {
    const target = this.lastMarkdown;
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (!target || !(file instanceof TFile)) return;
    const linktext = this.app.metadataCache.fileToLinktext(file, target.file?.path ?? "");
    target.editor.replaceSelection(`[[${linktext}]]`);
    target.editor.focus();
  }
}
