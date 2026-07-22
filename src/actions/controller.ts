import { App, MarkdownView, Notice, TFile } from "obsidian";
import type { IndexManager } from "../index/manager";
import type { ModelRouter } from "../model/router";
import type { Logger } from "../util/logger";
import type { ScoredResult } from "../core/types";
import { ActionExecutor, type ActionProposal } from "./framework";
import { buildNewNoteProposal } from "./new-note";
import { buildWeaveProposal } from "./link-weave";
import {
  CONNECTIVE_SCHEMA,
  SCAFFOLD_SCHEMA,
  connectivePrompt,
  scaffoldPrompt,
  parseConnective,
  parseScaffold,
  fallbackScaffold,
  type ScaffoldResult,
} from "../model/tasks";
import { PreviewModal } from "../ui/preview-modal";

const EXCERPT_CHARS = 600;

/**
 * Orchestrates the Phase 3 actions: gathers context, optionally consults the
 * reasoning model, builds a pure proposal, and routes it through the preview
 * modal → executor. Every vault write in this file goes through
 * executor.apply() behind an explicit Accept.
 */
export class ActionsController {
  constructor(
    private deps: {
      app: App;
      manager: () => IndexManager | undefined;
      router: ModelRouter;
      executor: ActionExecutor;
      lastMarkdown: () => MarkdownView | null;
      log: Logger;
    },
  ) {}

  /* ── Link weaving ───────────────────────────────────────────────────── */

  async weave(result: ScoredResult): Promise<void> {
    const { app } = this.deps;
    const view = this.deps.lastMarkdown();
    const sourceFile = view?.file;
    if (!view || !sourceFile) {
      new Notice("Open a note to weave a link into.");
      return;
    }
    if (sourceFile.path === result.path) {
      new Notice("Can't weave a note to itself.");
      return;
    }
    const targetFile = app.vault.getAbstractFileByPath(result.path);
    if (!(targetFile instanceof TFile)) {
      new Notice(`Note not found: ${result.path}`);
      return;
    }

    // Flush the editor so the disk content (which the conflict check reads)
    // matches what the writer sees.
    await view.save();
    const cursor = view.editor.getCursor();
    const sourceContent = await app.vault.read(sourceFile);
    const targetContent = await app.vault.read(targetFile);

    let phrase: string | undefined;
    if (this.deps.router.available()) {
      try {
        const text = await this.deps.router.run(
          "connective",
          connectivePrompt({
            sourceTitle: sourceFile.basename,
            sourceExcerpt: sourceContent.slice(0, EXCERPT_CHARS),
            targetTitle: targetFile.basename,
            targetExcerpt: targetContent.slice(0, EXCERPT_CHARS),
          }),
          { schema: { ...CONNECTIVE_SCHEMA }, maxTokens: 300 },
        );
        phrase = parseConnective(text) ?? undefined;
      } catch (err) {
        this.deps.log.warn(`connective phrasing unavailable: ${String(err)}`);
      }
    }

    const proposal = buildWeaveProposal({
      sourcePath: sourceFile.path,
      sourceContent,
      cursor,
      targetLinktext: app.metadataCache.fileToLinktext(targetFile, sourceFile.path),
      targetPath: targetFile.path,
      targetContent,
      targetTitle: targetFile.basename,
      sourceLinktext: app.metadataCache.fileToLinktext(sourceFile, targetFile.path),
      sourceTitle: sourceFile.basename,
      phrase,
    });
    this.preview(proposal);
  }

  /* ── New-note scaffolding ───────────────────────────────────────────── */

  async createNote(seed: string): Promise<void> {
    const manager = this.deps.manager();
    const folders = this.vaultFolders();
    const related = manager ? await manager.related(seed, { limit: 6 }) : [];

    let scaffold: ScaffoldResult;
    if (this.deps.router.available()) {
      try {
        const text = await this.deps.router.run(
          "scaffold",
          scaffoldPrompt({
            seed,
            folders,
            relatedTitles: related.map((r) => r.title),
          }),
          { schema: { ...SCAFFOLD_SCHEMA }, maxTokens: 1500, thinking: true },
        );
        scaffold = parseScaffold(text);
      } catch (err) {
        this.deps.log.warn(`scaffold model call failed, using template: ${String(err)}`);
        new Notice("Model unavailable — using a plain template.");
        scaffold = fallbackScaffold(seed);
      }
    } else {
      scaffold = fallbackScaffold(seed);
    }
    if (scaffold.links.length === 0) {
      scaffold.links = related.slice(0, 3).map((r) => r.title);
    }

    const proposal = buildNewNoteProposal({
      scaffold,
      allowedFolders: folders,
      defaultFolder: "",
      isoDate: new Date().toISOString().slice(0, 10),
    });
    this.preview(proposal, () => {
      // Open the freshly created note for writing.
      const path = proposal.changes[0]?.path;
      if (path) void this.deps.app.workspace.openLinkText(path, "", false);
    });
  }

  /* ── Undo ───────────────────────────────────────────────────────────── */

  async undoLast(): Promise<void> {
    try {
      const undone = await this.deps.executor.undoLast();
      new Notice(undone ? `↶ Undid: ${undone.title}` : "Nothing to undo.");
    } catch (err) {
      new Notice(`Undo blocked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ── Internals ──────────────────────────────────────────────────────── */

  private preview(proposal: ActionProposal, afterApply?: () => void): void {
    new PreviewModal(this.deps.app, proposal, () => {
      void (async () => {
        try {
          await this.deps.executor.apply(proposal);
          new Notice(`✓ ${proposal.title} — undoable via "Undo last action".`);
          afterApply?.();
        } catch (err) {
          new Notice(
            `Not applied: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }).open();
  }

  /** Folder candidates for the scaffold's home, most-populated first. */
  private vaultFolders(): string[] {
    const manager = this.deps.manager();
    const counts = new Map<string, number>();
    for (const path of manager?.indexedPaths() ?? []) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    const folders = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([dir]) => dir);
    if (!folders.includes("")) folders.push("");
    return folders;
  }
}
