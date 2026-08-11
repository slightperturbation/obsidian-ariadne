import { App, MarkdownView, Notice, TFile, normalizePath } from "obsidian";
import type { IndexManager } from "../index/manager";
import type { ModelRouter } from "../model/router";
import { BudgetExceededError } from "../model/router";
import type { Logger } from "../util/logger";
import type { ScoredResult } from "../core/types";
import { ActionExecutor, type ActionProposal } from "./framework";
import { buildNewNoteProposal } from "./new-note";
import { buildWeaveProposal } from "./link-weave";
import {
  segmentNote,
  buildSplitProposal,
  fallbackSplitGroups,
  paragraphize,
  buildStructureProposal,
  stripProposedSplitCallout,
  type SplitGroup,
  type SplitChild,
} from "./split";
import { buildMocProposal } from "./moc";
import { buildMergeProposal } from "./merge";
import {
  planAttachmentSweep,
  isEmptyNote,
  buildDeleteProposal,
  type AttachmentMove,
} from "./filing";
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
  ANALYZE_SCHEMA,
  CRITIQUE_SCHEMA,
  splitPrompt,
  parseSplitGroups,
  analyzePrompt,
  parseAnalysis,
  critiquePrompt,
  parseCritique,
  mocPrompt,
  parseMoc,
  fallbackMoc,
} from "../model/refactor-tasks";
import { PreviewModal } from "../ui/preview-modal";
import { ListPreviewModal } from "../ui/list-preview-modal";
import { ItemActionsModal, type ActionableItem } from "../ui/item-actions-modal";
import { decideLocally, isUntitledName, titleFromContent } from "./triage";
import { paragraphAround } from "../margin/context";
import {
  TITLE_SCHEMA,
  TRIAGE_SCHEMA,
  parseTitle,
  parseTriage,
  titlePrompt,
  triagePrompt,
} from "../model/tasks";

const EXCERPT_CHARS = 600;
const SEGMENT_PREVIEW_CHARS = 200;
/**
 * Raw cosine at which two notes are treated as near-duplicates. Deliberately
 * high: merge is destructive, and 0.8 is merely "clearly related" for
 * bge-small — that would routinely propose merging distinct adjacent notes.
 */
const MERGE_COSINE = 0.95;
const MOC_NEIGHBORHOOD = 12;
/** Words of a note used as the near-duplicate probe (see mergeNote). */
const MERGE_PROBE_WORDS = 300;

/** A bounded, representative slice of a note for duplicate detection. */
function mergeProbe(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").split(/\s+/).slice(0, MERGE_PROBE_WORDS).join(" ");
}

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
      attachmentsFolder: () => string;
      inboxFolder: () => string;
      archiveFolder: () => string;
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
        const text = await this.withWorkingNotice("Ariadne is drafting the connection…", () =>
          this.deps.router.run(
            "connective",
            connectivePrompt({
              sourceTitle: sourceFile.basename,
              sourceExcerpt: sourceContent.slice(0, EXCERPT_CHARS),
              targetTitle: targetFile.basename,
              targetExcerpt: targetContent.slice(0, EXCERPT_CHARS),
            }),
            { schema: { ...CONNECTIVE_SCHEMA }, maxTokens: 300 },
          ),
        );
        phrase = parseConnective(text) ?? undefined;
      } catch (err) {
        this.deps.log.warn(`connective phrasing unavailable: ${String(err)}`);
        if (err instanceof BudgetExceededError) new Notice(err.message);
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
        const text = await this.withWorkingNotice("Ariadne is scaffolding the note…", () =>
          this.deps.router.run(
            "scaffold",
            scaffoldPrompt({
              seed,
              folders,
              relatedTitles: related.map((r) => r.title),
            }),
            { schema: { ...SCAFFOLD_SCHEMA }, maxTokens: 1500, thinking: true },
          ),
        );
        scaffold = parseScaffold(text);
      } catch (err) {
        this.deps.log.warn(`scaffold model call failed, using template: ${String(err)}`);
        // Distinguish "you hit your spend cap" from "the model is down" —
        // they call for completely different user responses.
        new Notice(
          err instanceof BudgetExceededError
            ? `${err.message} Using a plain template for now.`
            : "Model unavailable — using a plain template.",
        );
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
      new Notice(`✓ Created “${scaffold.title}” · reversible with "Undo last Ariadne action".`);
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

  /* ── Semantic split (two-pass) ──────────────────────────────────────── */

  /**
   * Split dispatches on structure. A note with ≥2 heading-sections is extracted
   * into atomic child files now; an unstructured note is first analyzed — if it
   * reads as one atomic idea we refuse and ask for sections, otherwise we
   * restructure it in place into editable proposed sections. The second run on
   * the now-structured note takes the extract path.
   */
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

    if (seg.segments.length >= 2) {
      await this.extractSplit(file, content, seg);
    } else {
      await this.structureSplit(file, content);
    }
  }

  /** Pass 2: an already-sectioned note → atomic child files + MoC stub. */
  private async extractSplit(
    file: TFile,
    content: string,
    seg: ReturnType<typeof segmentNote>,
  ): Promise<void> {
    let groups: SplitGroup[];
    if (this.deps.router.available()) {
      try {
        const text = await this.withWorkingNotice("Ariadne is grouping sections to split…", () =>
          this.deps.router.run(
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
          ),
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

    const proposal = buildSplitProposal({
      originalPath: file.path,
      originalContent: content,
      parentTitle: file.basename,
      children,
      isoDate: new Date().toISOString().slice(0, 10),
    });
    // Drop the stale "proposed split" callout from the resulting MoC stub (only
    // the produced `after`, never the conflict-check `before`).
    for (const c of proposal.changes) {
      if (c.type === "modify" && c.after) c.after = stripProposedSplitCallout(c.after);
    }
    this.preview(proposal);
  }

  /** Pass 1: an unstructured note → refuse if atomic, else restructure in place. */
  private async structureSplit(file: TFile, content: string): Promise<void> {
    if (!this.deps.router.available()) {
      new Notice(
        "Splitting an unstructured note needs a reasoning model. Add a Claude API key, or add ## sections marking the parts and run Split again.",
      );
      return;
    }
    const { paragraphs } = paragraphize(content);
    if (paragraphs.length < 2) {
      new Notice("This note is too short to split.");
      return;
    }

    let analysis;
    try {
      const text = await this.withWorkingNotice("Ariadne is analyzing this note to split…", () =>
        this.deps.router.run(
          "scaffold",
          analyzePrompt({
            title: file.basename,
            paragraphs: paragraphs.map((p) => ({ index: p.index, text: p.text })),
          }),
          { schema: { ...ANALYZE_SCHEMA }, maxTokens: 2000, thinking: true },
        ),
      );
      analysis = parseAnalysis(text);
    } catch (err) {
      new Notice(`Split analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!analysis) {
      new Notice("Couldn't analyze this note for splitting.");
      return;
    }
    if (analysis.atomic || analysis.clusters.length < 2) {
      new Notice(
        analysis.reason
          ? `Looks like a single atomic note: ${analysis.reason} Add ## sections to force a split.`
          : "This reads as a single idea — add ## sections marking the parts you want, then run Split again.",
      );
      return;
    }

    // Second pass: critique the proposed sections for coherence and title
    // quality and refine them before the user sees anything. Falls back to the
    // first proposal if the critique can't run or returns something degenerate.
    let clusters = analysis.clusters;
    try {
      const critiqueText = await this.withWorkingNotice(
        "Ariadne is refining the proposed split…",
        () =>
          this.deps.router.run(
            "scaffold",
            critiquePrompt({
              title: file.basename,
              paragraphs: paragraphs.map((p) => ({ index: p.index, text: p.text })),
              proposal: clusters,
            }),
            { schema: { ...CRITIQUE_SCHEMA }, maxTokens: 2000, thinking: true },
          ),
      );
      const refined = parseCritique(critiqueText);
      if (refined.length >= 2) clusters = refined;
    } catch (err) {
      this.deps.log.warn(`split critique pass failed, using first proposal: ${String(err)}`);
    }

    this.preview(
      buildStructureProposal({
        path: file.path,
        content,
        parentTitle: file.basename,
        clusters,
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
        const text = await this.withWorkingNotice("Ariadne is building the Map of Content…", () =>
          this.deps.router.run(
            "scaffold",
            mocPrompt({
              seedTitle: file.basename,
              neighborhood: neighborhood.map((r) => ({ title: r.title, excerpt: r.snippet })),
            }),
            { schema: { ...MOC_SCHEMA }, maxTokens: 1500, thinking: true },
          ),
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
      new Notice(`✓ Created MoC “${moc.title}” — undoable via "Undo last Ariadne action".`);
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
    // Compare on a bounded slice, not the whole note: the embedder truncates
    // around 380 words (so a long note's tail never counted anyway), and an
    // OR-lexical query built from thousands of terms is both slow and
    // effectively "any note sharing any word".
    const probe = mergeProbe(content);
    const results = await manager.related(probe, { excludePath: file.path, limit: 3 });
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

    // Deleting a note does NOT rewrite links to it (Obsidian only auto-updates
    // on rename), so collect the notes pointing at the duplicate and repoint
    // them at the kept note as part of the same atomic action.
    const inbound: Array<{ path: string; content: string }> = [];
    for (const [from, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (from === file.path || from === otherFile.path) continue;
      if (!targets[otherFile.path]) continue;
      const source = app.vault.getAbstractFileByPath(from);
      if (source instanceof TFile) {
        inbound.push({ path: from, content: await app.vault.read(source) });
      }
    }

    this.preview(
      buildMergeProposal({
        inbound,
        keepLinktext: app.metadataCache.fileToLinktext(file, file.path),
        keepPath: file.path,
        keepContent: content,
        keepTitle: file.basename,
        otherPath: otherFile.path,
        otherContent,
        otherTitle: otherFile.basename,
      }),
    );
  }

  /* ── Filing: attachments sweep ──────────────────────────────────────── */

  async sweepAttachments(): Promise<void> {
    const { app } = this.deps;
    const folder = this.deps.attachmentsFolder().replace(/\/+$/, "");
    if (!folder) {
      new Notice("Set an attachments folder in Ariadne settings first.");
      return;
    }
    const files = app.vault.getFiles().map((f) => ({
      path: f.path,
      name: f.name,
      extension: f.extension,
      parentPath: f.parent?.path ?? "",
    }));
    const moves = planAttachmentSweep(files, folder, (p) => !!app.vault.getAbstractFileByPath(p));
    if (moves.length === 0) {
      new Notice("No root-level attachments to sweep.");
      return;
    }

    new ListPreviewModal(
      app,
      {
        title: `Move ${moves.length} attachment${moves.length === 1 ? "" : "s"} into "${folder}"`,
        description: "Embeds and links are updated automatically.",
        lines: moves.map((m) => `${m.name}  →  ${folder}/`),
      },
      () => void this.applyAttachmentSweep(folder, moves),
    ).open();
  }

  /* ── Journaling bridge: capture + promote ───────────────────────────── */

  /**
   * Zero-ceremony capture: a thought becomes an Inbox note *instantly* —
   * titled from its own words, no model call, no home to choose, no
   * structure imposed. Ahrens's fleeting notes work only when capture costs
   * nothing; the scaffolded create (which calls the API and picks a
   * permanent home) is for when a thought is ready to become a note, not
   * for getting it out of your head.
   */
  async captureThought(seed: string): Promise<void> {
    const text = seed.trim();
    if (!text) return;
    const inbox = normalizePath(this.deps.inboxFolder());
    const title =
      titleFromContent(text) ?? `Capture ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const path = this.uniquePath(`${inbox}/${title}.md`);
    await this.deps.executor.apply({
      title: `Capture "${title}"`,
      changes: [{ type: "create", path, after: `${text}\n` }],
    });
    new Notice(`Captured to ${path}`);
  }

  /**
   * Promote a fleeting line out of the journal (PRD §4.4): the selection —
   * or the paragraph at the cursor — becomes an Inbox note carrying a
   * provenance link back to the source, and a [[link]] is appended after the
   * text in the source so the journal points at the idea's new home.
   *
   * The journal text itself is never altered or removed: the daily note
   * keeps the fleeting form (that's the record of the day), the new note is
   * where elaboration happens, and the link ties them. Instant and local; a
   * model is consulted only if the text yields no usable title.
   */
  async promoteToNote(): Promise<void> {
    const view = this.deps.lastMarkdown();
    const file = view?.file;
    if (!view || !file) {
      new Notice("Open a note to promote from.");
      return;
    }
    const editor = view.editor;
    let text = editor.getSelection().trim();
    let insertAt = text ? editor.getCursor("to") : undefined;
    if (!text) {
      const cursor = editor.getCursor();
      const para = paragraphAround(editor.getValue().split("\n"), cursor.line);
      text = para.text.trim();
      insertAt = { line: para.endLine, ch: editor.getLine(para.endLine).length };
    }
    if (text.length < 20) {
      new Notice("Select (or stand in) the passage to promote.");
      return;
    }

    let title = titleFromContent(text);
    if (!title && this.deps.router.available()) {
      try {
        title = parseTitle(
          await this.deps.router.run("scaffold", titlePrompt(text.slice(0, EXCERPT_CHARS)), {
            schema: TITLE_SCHEMA as unknown as Record<string, unknown>,
            maxTokens: 100,
          }),
        );
      } catch (err) {
        this.deps.log.warn(`promote title failed: ${String(err)}`);
      }
    }
    if (!title) {
      new Notice("Couldn't derive a title from that passage.");
      return;
    }

    const inbox = normalizePath(this.deps.inboxFolder());
    const path = this.uniquePath(`${inbox}/${title}.md`);
    const body = `${text}\n\n— promoted from [[${file.basename}]]\n`;
    await this.deps.executor.apply({
      title: `Promote "${title}"`,
      changes: [{ type: "create", path, after: body }],
    });

    // Appended via the editor, not a file rewrite: an addition in the
    // writer's buffer, reversible with ordinary ⌘Z, and never a whole-file
    // modify racing their live typing.
    const noteName = path.split("/").pop()!.replace(/\.md$/, "");
    if (insertAt) editor.replaceRange(` [[${noteName}]]`, insertAt);
    new Notice(`Promoted to ${path} — elaborate it when ready.`);
  }

  /* ── Filing 4c: Untitled renaming + Inbox triage ────────────────────── */

  /** Most items examined per triage/rename run — bounds reads and API calls. */
  private static readonly TRIAGE_BATCH = 15;

  async resolveUntitled(): Promise<void> {
    const { app } = this.deps;
    const candidates = app.vault
      .getMarkdownFiles()
      .filter((f) => isUntitledName(f.basename) && f.stat.size >= 20)
      .slice(0, ActionsController.TRIAGE_BATCH);
    if (candidates.length === 0) {
      new Notice("No untitled notes with content found.");
      return;
    }

    const items: ActionableItem[] = [];
    await this.withWorkingNotice("Ariadne is reading untitled notes…", async () => {
      for (const file of candidates) {
        const content = await app.vault.read(file);
        // The writer's own first heading/line beats a generated title — and
        // is free. The model is only asked when the note offers nothing.
        let title = titleFromContent(content);
        if (!title && this.deps.router.available()) {
          try {
            title = parseTitle(
              await this.deps.router.run("scaffold", titlePrompt(content.slice(0, EXCERPT_CHARS)), {
                schema: TITLE_SCHEMA as unknown as Record<string, unknown>,
                maxTokens: 100,
              }),
            );
          } catch (err) {
            this.deps.log.warn(`title proposal failed for ${file.path}: ${String(err)}`);
          }
        }
        if (!title) continue;

        const folder = file.parent?.path && file.parent.path !== "/" ? file.parent.path : "";
        const toPath = this.uniquePath(folder ? `${folder}/${title}.md` : `${title}.md`);
        items.push({
          title: `${file.basename} → ${toPath.split("/").pop()!.replace(/\.md$/, "")}`,
          detail: content.replace(/\s+/g, " ").slice(0, 120),
          actions: [
            {
              label: "Rename",
              run: async () => {
                const fromPath = file.path;
                await app.fileManager.renameFile(file, toPath);
                this.deps.executor.pushExternalUndo(
                  `Renamed ${fromPath.split("/").pop()} to ${title}`,
                  async () => {
                    const moved = app.vault.getAbstractFileByPath(toPath);
                    if (moved instanceof TFile && !app.vault.getAbstractFileByPath(fromPath)) {
                      await app.fileManager.renameFile(moved, fromPath);
                    }
                  },
                );
                return true;
              },
            },
            {
              label: "Open",
              run: () => {
                void app.workspace.openLinkText(file.path, "", false);
                return false;
              },
            },
          ],
        });
      }
    });

    if (items.length === 0) {
      new Notice("Nothing renameable — the untitled notes offered no usable title.");
      return;
    }
    new ItemActionsModal(app, {
      title: "Untitled notes",
      description: "Links to renamed notes are rewritten automatically. Each rename is undoable.",
      items,
    }).open();
  }

  async triageInbox(): Promise<void> {
    const { app } = this.deps;
    const manager = this.deps.manager();
    const inbox = normalizePath(this.deps.inboxFolder());
    const files = app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(`${inbox}/`));
    if (files.length === 0) {
      new Notice(`Nothing in ${inbox}/ to triage.`);
      return;
    }
    const batch = files.slice(0, ActionsController.TRIAGE_BATCH);

    const items: ActionableItem[] = [];
    await this.withWorkingNotice(`Ariadne is triaging ${batch.length} Inbox notes…`, async () => {
      for (const file of batch) {
        const content = await app.vault.read(file);
        // Local signals first: emptiness and near-duplication are free calls.
        const related = manager
          ? await manager.related(mergeProbe(content), { excludePath: file.path, limit: 1 })
          : [];
        let proposal = decideLocally(content, related[0]);
        if (!proposal && this.deps.router.available()) {
          try {
            const verdict = parseTriage(
              await this.deps.router.run(
                "scaffold",
                triagePrompt({ name: file.basename, content: content.slice(0, EXCERPT_CHARS) }),
                { schema: TRIAGE_SCHEMA as unknown as Record<string, unknown>, maxTokens: 150 },
              ),
            );
            proposal = { disposition: verdict.disposition, reason: verdict.reason };
          } catch (err) {
            this.deps.log.warn(`triage failed for ${file.path}: ${String(err)}`);
          }
        }
        // No model, no local signal → the honest default is the writing desk.
        proposal ??= { disposition: "elaborate", reason: "needs your judgment" };

        const open = {
          label: "Open",
          run: () => {
            void app.workspace.openLinkText(file.path, "", false);
            return false;
          },
        };
        const archive = {
          label: "Archive",
          destructive: true,
          run: async () => {
            const folder = normalizePath(this.deps.archiveFolder());
            if (!app.vault.getAbstractFileByPath(folder)) {
              await app.vault.createFolder(folder).catch(() => {});
            }
            const fromPath = file.path;
            const toPath = this.uniquePath(`${folder}/${file.name}`);
            await app.fileManager.renameFile(file, toPath);
            this.deps.executor.pushExternalUndo(`Archived ${file.name}`, async () => {
              const moved = app.vault.getAbstractFileByPath(toPath);
              if (moved instanceof TFile && !app.vault.getAbstractFileByPath(fromPath)) {
                await app.fileManager.renameFile(moved, fromPath);
              }
            });
            return true;
          },
        };
        const merge = {
          label: "Merge…",
          run: async () => {
            // Reuse the whole merge flow (preview included): open the note so
            // it is the merge source, then let mergeNote re-detect the target.
            await app.workspace.openLinkText(file.path, "", false);
            await this.mergeNote();
            return false;
          },
        };

        const actions =
          proposal.disposition === "merge"
            ? [merge, open, archive]
            : proposal.disposition === "archive"
              ? [archive, open]
              : [open, archive];
        items.push({
          title: file.basename,
          detail: `${proposal.disposition}${proposal.reason ? " — " + proposal.reason : ""}`,
          actions,
        });
      }
    });

    new ItemActionsModal(app, {
      title: `Inbox triage (${batch.length}${files.length > batch.length ? ` of ${files.length}` : ""})`,
      description:
        "One disposition per item, the Ahrens way: elaborate it, merge it, or archive it — " +
        "an Inbox trends toward empty. Archive moves are undoable.",
      items,
    }).open();
    if (files.length > batch.length) {
      new Notice(`Showing the first ${batch.length} — run again for the rest.`);
    }
  }

  private async applyAttachmentSweep(folder: string, moves: AttachmentMove[]): Promise<void> {
    const { app } = this.deps;
    // Declared outside the try: a partial failure must still register an undo
    // for the moves that DID land, or those files (and their rewritten embeds)
    // become unrevertable and "Undo last Ariadne action" reverses something unrelated.
    const done: Array<AttachmentMove & { size: number; mtime: number }> = [];
    let failure: unknown;
    try {
      if (!app.vault.getAbstractFileByPath(folder)) {
        await app.vault.createFolder(folder).catch(() => {
          /* concurrent creation */
        });
      }
      for (const m of moves) {
        const file = app.vault.getAbstractFileByPath(m.fromPath);
        if (!(file instanceof TFile)) continue;
        // Re-check at apply time: the target may have been taken while the
        // preview was open.
        if (app.vault.getAbstractFileByPath(m.toPath)) continue;
        await app.fileManager.renameFile(file, m.toPath);
        done.push({ ...m, size: file.stat.size, mtime: file.stat.mtime });
      }
    } catch (err) {
      failure = err;
    }

    if (done.length > 0) {
      this.deps.executor.pushExternalUndo(
        `Swept ${done.length} attachment${done.length === 1 ? "" : "s"} into ${folder}`,
        async () => {
          const problems: string[] = [];
          for (const m of [...done].reverse()) {
            const moved = app.vault.getAbstractFileByPath(m.toPath);
            // Identity check: the file at that path may be a different one the
            // user put there since the sweep — moving it would be destructive.
            if (!(moved instanceof TFile)) continue;
            if (moved.stat.size !== m.size) {
              problems.push(m.name);
              continue;
            }
            if (app.vault.getAbstractFileByPath(m.fromPath)) {
              problems.push(m.name);
              continue;
            }
            await app.fileManager.renameFile(moved, m.fromPath);
          }
          if (problems.length > 0) {
            new Notice(`Left in place (changed since the sweep): ${problems.join(", ")}`);
          }
        },
      );
    }

    if (failure) {
      new Notice(
        `Sweep stopped after ${done.length} file${done.length === 1 ? "" : "s"}: ` +
          `${failure instanceof Error ? failure.message : String(failure)}` +
          (done.length ? ` — those moves are undoable.` : ""),
      );
    } else {
      new Notice(
        `✓ Swept ${done.length} attachment${done.length === 1 ? "" : "s"} into ${folder} — undoable via "Undo last Ariadne action".`,
      );
    }
  }

  /* ── Filing: empty-note cleanup ─────────────────────────────────────── */

  async cleanupEmptyNotes(): Promise<void> {
    const { app } = this.deps;
    // Only small files can be empty — bound the reads.
    const candidates = app.vault.getMarkdownFiles().filter((f) => f.stat.size < 500);
    const empties: Array<{ path: string; content: string }> = [];
    for (const f of candidates) {
      const content = await app.vault.read(f);
      if (isEmptyNote(content)) empties.push({ path: f.path, content });
    }
    if (empties.length === 0) {
      new Notice("No empty notes found.");
      return;
    }

    const proposal = buildDeleteProposal(
      `Clean up ${empties.length} empty note${empties.length === 1 ? "" : "s"}`,
      empties,
    );
    new ListPreviewModal(
      app,
      {
        title: proposal.title,
        description: "These notes are empty (frontmatter/whitespace only). They go to trash.",
        lines: empties.map((e) => e.path),
        destructive: true,
      },
      () => {
        void (async () => {
          try {
            await this.deps.executor.apply(proposal);
            new Notice(`✓ ${proposal.title} — undoable via "Undo last Ariadne action".`);
          } catch (err) {
            new Notice(`Not applied: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      },
    ).open();
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

  /**
   * Run an async model task behind a persistent "working" notice, so the user
   * gets immediate feedback that Ariadne is thinking instead of an apparent
   * hang until the preview appears. The notice clears when the task settles
   * (success or error), before the next UI step.
   */
  private async withWorkingNotice<T>(message: string, work: () => Promise<T>): Promise<T> {
    const notice = new Notice(message, 0);
    try {
      return await work();
    } finally {
      notice.hide();
    }
  }

  /**
   * Flush any open editor holding a note this proposal touches.
   *
   * The conflict check compares against disk, but a model call takes seconds —
   * long enough for the writer to type a paragraph that is still sitting in the
   * CodeMirror buffer (continuous typing means Obsidian's idle autosave never
   * fires). Without this, validate() reads stale-but-matching disk content and
   * the write silently destroys what they just typed.
   */
  private async flushEditorsFor(proposal: ActionProposal): Promise<void> {
    const paths = new Set(proposal.changes.map((c) => c.path));
    for (const leaf of this.deps.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && paths.has(view.file.path)) {
        await view.save();
      }
    }
  }

  /** Preview → accept gate for actions that edit existing notes (weaving). */
  private preview(proposal: ActionProposal): void {
    new PreviewModal(this.deps.app, proposal, () => {
      void (async () => {
        try {
          await this.flushEditorsFor(proposal);
          await this.deps.executor.apply(proposal);
          new Notice(`✓ ${proposal.title} — undoable via "Undo last Ariadne action".`);
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
