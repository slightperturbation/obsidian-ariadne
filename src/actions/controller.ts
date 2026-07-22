import { App, MarkdownView, Notice, TFile, normalizePath } from "obsidian";
import type { IndexManager } from "../index/manager";
import type { ModelRouter } from "../model/router";
import type { Logger } from "../util/logger";
import type { ScoredResult } from "../core/types";
import { ActionExecutor, type ActionProposal } from "./framework";
import { buildNewNoteProposal } from "./new-note";
import { buildWeaveProposal } from "./link-weave";
import {
  segmentNote,
  buildSplitProposal,
  fallbackSplitGroups,
  type SplitGroup,
  type SplitChild,
} from "./split";
import { buildMocProposal } from "./moc";
import { buildMergeProposal } from "./merge";
import {
  CONNECTIVE_SCHEMA,
  SCAFFOLD_SCHEMA,
  connectivePrompt,
  scaffoldPrompt,
  parseConnective,
  parseScaffold,
  fallbackScaffold,
  sanitizeTitle,
  type ScaffoldResult,
} from "../model/tasks";
import {
  SPLIT_SCHEMA,
  MOC_SCHEMA,
  splitPrompt,
  parseSplitGroups,
  mocPrompt,
  parseMoc,
  fallbackMoc,
} from "../model/refactor-tasks";
import { PreviewModal } from "../ui/preview-modal";

const EXCERPT_CHARS = 600;
const SEGMENT_PREVIEW_CHARS = 200;
/** Notes at least this semantically close are offered as merge candidates. */
const MERGE_COSINE = 0.9;
const MOC_NEIGHBORHOOD = 12;

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
    // Creating a note is non-destructive and trivially reversible, so it skips
    // the preview modal (unlike edits to existing notes, which keep it). It
    // still goes through the executor — so a title collision auto-disambiguates
    // and the create is one-key undoable — then opens for writing immediately.
    const change = proposal.changes[0];
    change.path = this.uniquePath(change.path);
    try {
      await this.deps.executor.apply(proposal);
      new Notice(`✓ Created “${scaffold.title}” — ⌘Z-style undo via "Undo last action".`);
      await this.deps.app.workspace.openLinkText(change.path, "", false);
    } catch (err) {
      new Notice(`Not created: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * First free path at or after `path`, appending " 2", " 3"… before the
   * extension. `claimed` lets a batch (e.g. split children) avoid colliding
   * with paths reserved earlier in the same batch, not just with the vault.
   */
  private uniquePath(path: string, claimed?: Set<string>): string {
    const { app } = this.deps;
    const free = (p: string) => !app.vault.getAbstractFileByPath(p) && !claimed?.has(p);
    const normalized = normalizePath(path);
    const take = (p: string) => {
      claimed?.add(p);
      return p;
    };
    if (free(normalized)) return take(normalized);
    const dot = normalized.lastIndexOf(".");
    const base = dot === -1 ? normalized : normalized.slice(0, dot);
    const ext = dot === -1 ? "" : normalized.slice(dot);
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} ${i}${ext}`;
      if (free(candidate)) return take(candidate);
    }
    return take(normalized);
  }

  /* ── Semantic split ─────────────────────────────────────────────────── */

  async splitNote(): Promise<void> {
    const { app } = this.deps;
    const view = this.deps.lastMarkdown();
    const file = view?.file;
    if (!view || !file) {
      new Notice("Open a note to split.");
      return;
    }
    await view.save();
    const content = await app.vault.read(file);
    const seg = segmentNote(content);
    if (seg.segments.length < 2) {
      new Notice("This note has too few sections to split (needs ≥2 headings).");
      return;
    }

    let groups: SplitGroup[];
    if (this.deps.router.available()) {
      try {
        const text = await this.deps.router.run(
          "scaffold",
          splitPrompt({
            title: file.basename,
            segments: seg.segments.map((s) => ({
              index: s.index,
              heading: s.heading,
              preview: s.text.replace(/\s+/g, " ").slice(0, SEGMENT_PREVIEW_CHARS),
            })),
          }),
          { schema: { ...SPLIT_SCHEMA }, maxTokens: 1500, thinking: true },
        );
        groups = parseSplitGroups(text);
        if (groups.length === 0) groups = fallbackSplitGroups(seg);
      } catch (err) {
        this.deps.log.warn(`split model call failed, using per-section fallback: ${String(err)}`);
        groups = fallbackSplitGroups(seg);
      }
    } else {
      groups = fallbackSplitGroups(seg);
    }
    if (groups.length < 2) {
      new Notice("Couldn't find a sensible split for this note.");
      return;
    }

    const folder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
    const claimed = new Set<string>();
    const children: SplitChild[] = groups.map((g) => {
      const title = sanitizeTitle(g.title);
      const path = this.uniquePath(folder ? `${folder}/${title}.md` : `${title}.md`, claimed);
      return { ...g, path };
    });

    this.preview(
      buildSplitProposal({
        originalPath: file.path,
        originalContent: content,
        parentTitle: file.basename,
        children,
        isoDate: new Date().toISOString().slice(0, 10),
      }),
    );
  }

  /* ── Map of Content ─────────────────────────────────────────────────── */

  async generateMoc(): Promise<void> {
    const { app } = this.deps;
    const manager = this.deps.manager();
    const view = this.deps.lastMarkdown();
    const file = view?.file;
    if (!manager || !view || !file) {
      new Notice("Open a note to build a Map of Content around it.");
      return;
    }
    await view.save();
    const content = await app.vault.read(file);
    const neighborhood = await manager.related(`${file.basename}\n${content.slice(0, 800)}`, {
      excludePath: file.path,
      limit: MOC_NEIGHBORHOOD,
    });
    if (neighborhood.length < 2) {
      new Notice("Not enough related notes to map.");
      return;
    }
    const titles = neighborhood.map((r) => r.title);

    let moc = fallbackMoc(file.basename, titles);
    if (this.deps.router.available()) {
      try {
        const text = await this.deps.router.run(
          "scaffold",
          mocPrompt({
            seedTitle: file.basename,
            neighborhood: neighborhood.map((r) => ({ title: r.title, excerpt: r.snippet })),
          }),
          { schema: { ...MOC_SCHEMA }, maxTokens: 1500, thinking: true },
        );
        moc = parseMoc(text, new Set(titles)) ?? moc;
      } catch (err) {
        this.deps.log.warn(`MoC model call failed, using flat list: ${String(err)}`);
      }
    }

    const folder = file.parent && file.parent.path !== "/" ? file.parent.path : "";
    const path = this.uniquePath(folder ? `${folder}/${sanitizeTitle(moc.title)}.md` : `${sanitizeTitle(moc.title)}.md`);
    const proposal = buildMocProposal({
      title: moc.title,
      path,
      sections: moc.sections,
      isoDate: new Date().toISOString().slice(0, 10),
    });
    // Pure creation → no preview gate (same as scaffolding); open it after.
    try {
      await this.deps.executor.apply(proposal);
      new Notice(`✓ Created MoC “${moc.title}” — undoable via "Undo last action".`);
      await app.workspace.openLinkText(path, "", false);
    } catch (err) {
      new Notice(`MoC not created: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* ── Merge near-duplicate ───────────────────────────────────────────── */

  async mergeNote(): Promise<void> {
    const { app } = this.deps;
    const manager = this.deps.manager();
    const view = this.deps.lastMarkdown();
    const file = view?.file;
    if (!manager || !view || !file) {
      new Notice("Open a note to check for a near-duplicate.");
      return;
    }
    await view.save();
    const content = await app.vault.read(file);
    const results = await manager.related(content, { excludePath: file.path, limit: 3 });
    const top = results[0];
    if (!top || (top.cosine ?? 0) < MERGE_COSINE) {
      new Notice("No near-duplicate found for this note.");
      return;
    }
    const otherFile = app.vault.getAbstractFileByPath(top.path);
    if (!(otherFile instanceof TFile)) {
      new Notice(`Note not found: ${top.path}`);
      return;
    }
    const otherContent = await app.vault.read(otherFile);

    this.preview(
      buildMergeProposal({
        keepPath: file.path,
        keepContent: content,
        keepTitle: file.basename,
        otherPath: otherFile.path,
        otherContent,
        otherTitle: otherFile.basename,
      }),
    );
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

  /** Preview → accept gate for actions that edit existing notes (weaving). */
  private preview(proposal: ActionProposal): void {
    new PreviewModal(this.deps.app, proposal, () => {
      void (async () => {
        try {
          await this.deps.executor.apply(proposal);
          new Notice(`✓ ${proposal.title} — undoable via "Undo last action".`);
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
