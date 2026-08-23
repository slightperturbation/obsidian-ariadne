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
import { clusterThemes, type EntryNeighbors } from "./themes";
import {
  JOURNAL_AFFINITY_FLAG,
  JOURNAL_AFFINITY_HOLD,
  changedSince,
  contentHash,
  journalAffinity,
  personalSignals,
  polishProblems,
  selectPrecedents,
  type LedgerEntry,
  type PublishLedger,
  type ScreenNeighbor,
} from "../publish/screen";
import { dateOf, isoWeekLabel, localISODate } from "../core/periodic";
import { classifyEntry } from "../margin/tags";
import { onThisDay, resurfacePick } from "../margin/resurface";
import { wantedTopics } from "../margin/wanted";
import {
  TITLE_SCHEMA,
  TRIAGE_SCHEMA,
  THEME_SCHEMA,
  SYNTHESIS_SCHEMA,
  PUBLISH_SCREEN_SCHEMA,
  parsePublishScreen,
  publishScreenPrompt,
  parseTitle,
  parseTriage,
  parseTheme,
  parseSynthesis,
  titlePrompt,
  triagePrompt,
  themePrompt,
  synthesisPrompt,
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
      /** Journal/dated-entry detection (names + configured folders). */
      isJournal: (path: string) => boolean;
      /** Categorically-private folders (publishing). */
      privateFolders: () => string[];
      /** The publish ledger's home (plugin-dir JSON, adapter-backed). */
      publishLedger: { load(): Promise<PublishLedger>; save(l: PublishLedger): Promise<void> };
      /** Which brain may read journal content (tension/themes/synthesis). */
      journalPrivacy: () => "cloud" | "local" | "none";
      /** An indexing burst is active — interactive paths go lexical-only. */
      indexingBusy: () => boolean;
      /** Persisted promoted-today tally (survives restarts). */
      promotedStore: {
        get(): { date: string; count: number } | undefined;
        set(v: { date: string; count: number }): void;
      };
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

  /** Single-flight: an impatient double-click must not create twice. */
  private creatingNote = false;

  async createNote(seed: string): Promise<void> {
    // Guarded HERE, not at the click sites, so every entry point (Wanted
    // row, the Do row, themes, close-the-day, the command) shares one gate.
    // The incident this prevents: a slow first click looked dead, the user
    // clicked again, and each click grew another note.
    if (this.creatingNote) {
      new Notice("Already creating a note…");
      return;
    }
    this.creatingNote = true;
    try {
      await this.createNoteInner(seed);
    } finally {
      this.creatingNote = false;
    }
  }

  private async createNoteInner(seed: string): Promise<void> {
    const manager = this.deps.manager();
    const folders = this.vaultFolders();

    let related: ScoredResult[] = [];
    let scaffold: ScaffoldResult = fallbackScaffold(seed);
    // ONE notice covers the whole thinking phase — the neighbor lookup used
    // to run before any feedback, and during an indexing burst that await
    // was the multi-second silence that read as "nothing happened".
    await this.withWorkingNotice("Ariadne is drafting the note…", async () => {
      // During a backfill burst the semantic path queues behind the
      // worker's embedding jobs; a clicked create must not wait for that.
      related = manager
        ? await manager.related(seed, { limit: 6, semantic: !this.deps.indexingBusy() })
        : [];

      if (!this.deps.router.available()) return;
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
        // Distinguish "you hit your spend cap" from "the model is down" —
        // they call for completely different user responses.
        new Notice(
          err instanceof BudgetExceededError
            ? `${err.message} Using a plain template for now.`
            : "Model unavailable — using a plain template.",
        );
        scaffold = fallbackScaffold(seed);
      }
    });
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
      new Notice(`✓ Created “${scaffold.title}” · reversible with "Undo last action".`);
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
    if (!manager.canEmbedText()) {
      new Notice(
        "Duplicate detection needs the embedding model — on this device the index is read-only.",
      );
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
    // The fallback must pass through sanitizeTitle like every other title:
    // an ISO timestamp carries ":", which Windows and mobile refuse.
    const title =
      titleFromContent(text) ??
      sanitizeTitle(`Capture ${localISODate()} ${new Date().toTimeString().slice(0, 5)}`);
    const path = this.uniquePath(`${inbox}/${title}.md`);
    try {
      await this.deps.executor.apply({
        title: `Capture "${title}"`,
        changes: [{ type: "create", path, after: `${text}\n` }],
      });
      new Notice(`Captured to ${path}`);
    } catch (err) {
      // A lost capture must never be silent — the prompt is already gone.
      new Notice(`Capture failed: ${err instanceof Error ? err.message : String(err)}`);
      this.deps.log.warn(`capture failed: ${String(err)}`);
    }
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
          await this.deps.router.run("theme", titlePrompt(text.slice(0, EXCERPT_CHARS)), {
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

    // Capture what the insertion point looked like BEFORE any await: the
    // title call can take seconds, and the same Editor instance is reused
    // when the user navigates — writing into stale coordinates would drop a
    // link into the middle of an unrelated note.
    const lineAtCapture = insertAt ? editor.getLine(insertAt.line) : undefined;

    const inbox = normalizePath(this.deps.inboxFolder());
    const path = this.uniquePath(`${inbox}/${title}.md`);
    const body = `${text}\n\n— promoted from [[${file.basename}]]\n`;
    try {
      await this.deps.executor.apply({
        title: `Promote "${title}"`,
        changes: [{ type: "create", path, after: body }],
      });
    } catch (err) {
      new Notice(`Promote failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Appended via the editor, not a file rewrite: an addition in the
    // writer's buffer, reversible with ordinary ⌘Z, and never a whole-file
    // modify racing their live typing. Revalidated first, ghost-engine
    // style: same file still open, same line still present and unchanged.
    const noteName = path.split("/").pop()!.replace(/\.md$/, "");
    const nowView = this.deps.lastMarkdown();
    const sameFile = nowView?.file?.path === file.path;
    const sameLine =
      sameFile &&
      insertAt !== undefined &&
      insertAt.line < nowView!.editor.lineCount() &&
      nowView!.editor.getLine(insertAt.line) === lineAtCapture;
    this.notePromotion();
    if (insertAt && sameLine) {
      nowView!.editor.replaceRange(` [[${noteName}]]`, insertAt);
      new Notice(`Promoted to ${path} — elaborate it when ready.`);
    } else {
      new Notice(
        `Promoted to ${path}. The journal changed while the title was drafted, ` +
          `so no [[link]] was inserted — add one where it belongs.`,
      );
    }
  }

  /**
   * Close the day — the evening review ritual, composed entirely from pieces
   * that already exist. Journaling advice converges on the same point: the
   * review is where the value compounds, and a ritual with a surface gets
   * done. One modal: today's entry, this date in past years, the Inbox
   * count, the most-wanted topic, and one old note asking "still true?".
   * Nothing here is new machinery; it is the day's open loops in one place.
   */
  async closeTheDay(): Promise<void> {
    const { app } = this.deps;
    const manager = this.deps.manager();
    const today = localISODate();
    const allPaths = app.vault.getMarkdownFiles().map((f) => f.path);
    const items: ActionableItem[] = [];

    const todaysEntry = allPaths.find((p) => dateOf(p) === today);
    if (todaysEntry) {
      const name = todaysEntry.split("/").pop()!.replace(/\.md$/, "");
      items.push({
        title: name,
        detail: "today's entry — a promotable line in it?",
        actions: [
          {
            label: "Open",
            run: () => {
              void app.workspace.openLinkText(todaysEntry, "", false);
              return false;
            },
          },
        ],
      });
    }

    for (const past of onThisDay(`${today}.md`, allPaths).slice(0, 2)) {
      const name = past.split("/").pop()!.replace(/\.md$/, "");
      items.push({
        title: name,
        detail: "on this day",
        actions: [
          {
            label: "Open",
            run: () => {
              void app.workspace.openLinkText(past, "", false);
              return false;
            },
          },
        ],
      });
    }

    const inbox = normalizePath(this.deps.inboxFolder());
    const inboxCount = allPaths.filter((p) => p.startsWith(`${inbox}/`)).length;
    if (inboxCount > 0) {
      items.push({
        title: `Inbox: ${inboxCount} note${inboxCount === 1 ? "" : "s"}`,
        detail: "an Inbox trends toward empty",
        actions: [
          {
            label: "Triage",
            closesModal: true,
            run: () => this.triageInbox().then(() => true),
          },
        ],
      });
    }

    const wanted = wantedTopics(app.metadataCache.unresolvedLinks, 1)[0];
    if (wanted) {
      items.push({
        title: wanted.title,
        detail: `wanted by ${wanted.sources} notes — no note exists`,
        actions: [
          {
            label: "Create",
            closesModal: true,
            run: () => this.createNote(wanted.title).then(() => true),
          },
        ],
      });
    }

    if (manager) {
      const pick = resurfacePick(manager.noteMetas(), today, Date.now(), this.deps.isJournal);
      if (pick) {
        items.push({
          title: pick.title,
          detail: "still true? — old and barely linked",
          actions: [
            {
              label: "Revisit",
              run: () => {
                void app.workspace.openLinkText(pick.path, "", false);
                return false;
              },
            },
          ],
        });
      }
    }

    if (items.length === 0) {
      new Notice("Nothing open — the day is already closed.");
      return;
    }
    new ItemActionsModal(app, {
      title: "Close the day",
      description: "The day's open loops, in one place. Take what's useful; dismiss the rest.",
      items,
    }).open();
  }

  /**
   * Weekly synthesis: a created note that links the week's entries and asks
   * elaboration QUESTIONS — never prose. Prompting elaboration is exactly
   * what a thinking partner should do; writing the synthesis for you is
   * exactly what it shouldn't (the AI-writing boundary, PRD §9.3).
   */
  async weeklySynthesis(): Promise<void> {
    const { app } = this.deps;
    const privacy = this.deps.journalPrivacy();
    if (privacy === "none") {
      new Notice(
        "Journal model calls are set to None — allow the local box or cloud in " +
          "Settings → Journaling to synthesize the week.",
      );
      return;
    }
    if (privacy === "local" && !this.deps.router.localAvailable()) {
      new Notice("Journal privacy is local-only and the local model is unreachable.");
      return;
    }
    if (!this.deps.router.available()) {
      new Notice("Weekly synthesis needs a reasoning model — set an API key or local model URL.");
      return;
    }
    const now = new Date();
    const weekAgo = localISODate(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
    // Date-named entries carry their date; journal-folder entries without
    // dated names ("Morning pages 12") fall back to their modification time —
    // a journal is defined by the activity, not the filename.
    const weekAgoMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
    const entries: Array<{ path: string; date: string }> = [];
    for (const f of app.vault.getMarkdownFiles()) {
      const d = dateOf(f.path);
      if (d && d >= weekAgo) {
        entries.push({ path: f.path, date: d });
      } else if (!d && this.deps.isJournal(f.path) && f.stat.mtime >= weekAgoMs) {
        entries.push({ path: f.path, date: localISODate(new Date(f.stat.mtime)) });
      }
    }
    entries.sort((a, b) => a.date.localeCompare(b.date));
    if (entries.length < 2) {
      new Notice("Not enough journal entries this week to synthesize.");
      return;
    }

    const excerpts: Array<{ date: string; excerpt: string; path: string }> = [];
    for (const e of entries) {
      const file = app.vault.getAbstractFileByPath(e.path);
      if (!(file instanceof TFile)) continue;
      const raw = await app.vault.cachedRead(file);
      // Task lists produce garbage elaboration questions; only entries where
      // narrative dominates feed the synthesis.
      if (classifyEntry(raw) !== "journal") continue;
      const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      if (content) excerpts.push({ date: e.date, excerpt: content.slice(0, 500), path: e.path });
    }
    if (excerpts.length < 2) {
      new Notice("This week's entries are all logs — nothing narrative to synthesize.");
      return;
    }

    let questions: string[] = [];
    await this.withWorkingNotice("Ariadne is reading the week…", async () => {
      try {
        questions = parseSynthesis(
          await this.deps.router.run("scaffold", synthesisPrompt(excerpts), {
            schema: SYNTHESIS_SCHEMA as unknown as Record<string, unknown>,
            maxTokens: 500,
            thinking: true,
            ...(privacy === "local" ? { privacy: "local" as const } : {}),
          }),
        );
      } catch (err) {
        this.deps.log.warn(`synthesis failed: ${String(err)}`);
      }
    });
    if (questions.length === 0) {
      new Notice("Couldn't draw questions from the week — see console.");
      return;
    }

    const title = `Weekly synthesis ${isoWeekLabel(now)}`;
    const inbox = normalizePath(this.deps.inboxFolder());
    const path = this.uniquePath(`${inbox}/${title}.md`);
    const body = [
      `# ${title}`,
      ``,
      `Entries: ${excerpts.map((e) => `[[${e.path.split("/").pop()!.replace(/\.md$/, "")}]]`).join(" · ")}`,
      ``,
      `## Questions to elaborate`,
      ``,
      ...questions.map((q) => `- ${q}`),
      ``,
    ].join("\n");
    await this.deps.executor.apply({ title: `Create "${title}"`, changes: [{ type: "create", path, after: body }] });
    await app.workspace.openLinkText(path, "", false);
  }

  /* ── Publishing: the departure lounge ───────────────────────────────── */

  /** Notes screened per review run — bounds reads and model calls. */
  private static readonly SCREEN_BATCH = 15;

  /** Tier 0: is this note even a candidate? The bedroom never is. */
  private isPublishCandidate(path: string): boolean {
    if (this.deps.isJournal(path)) return false;
    const folders = this.deps.privateFolders();
    return !folders.some((f) => f.length > 0 && (path === f || path.startsWith(`${f}/`)));
  }

  /** Changed-candidate count for the Vault affordance — mtime-cheap. */
  async publishChangedCount(): Promise<number> {
    const ledger = await this.deps.publishLedger.load();
    const files = this.deps.app.vault
      .getMarkdownFiles()
      .filter((f) => this.isPublishCandidate(f.path))
      .map((f) => ({ path: f.path, mtime: f.stat.mtime }));
    return changedSince(ledger, files).length;
  }

  /**
   * The departure lounge. Screens changed candidates (tier 1 local nets →
   * tier 2 model, biased to hold, parse failure = hold), embodies the
   * verdicts as `publish:` frontmatter, and presents the full ledger for
   * review. Obsidian's own Publish dialog remains the actuator: this flow
   * cannot upload anything, and a held note can only be released by a loud
   * two-step per-note override. With no model, nothing auto-clears — every
   * candidate awaits the human's explicit clear, which is the correct
   * reviewer of last resort.
   */
  async reviewForPublish(): Promise<void> {
    const { app } = this.deps;
    const ledger = await this.deps.publishLedger.load();
    const candidates = app.vault.getMarkdownFiles().filter((f) => this.isPublishCandidate(f.path));

    // Drop ledger entries for notes that moved into the bedroom or vanished.
    const candidatePaths = new Set(candidates.map((f) => f.path));
    for (const path of Object.keys(ledger)) {
      if (!candidatePaths.has(path)) delete ledger[path];
    }

    const stale = new Set(
      changedSince(
        ledger,
        candidates.map((f) => ({ path: f.path, mtime: f.stat.mtime })),
      ),
    );
    const batch = candidates.filter((f) => stale.has(f.path)).slice(0, ActionsController.SCREEN_BATCH);

    // Bootstrap precedents: a hand-set `publish:` flag with no ledger entry
    // is a decision the writer made before (or outside) Ariadne — honor it,
    // record it as a human precedent, and don't second-guess it with a call.
    for (const file of candidates) {
      if (ledger[file.path]) continue;
      const flag = app.metadataCache.getFileCache(file)?.frontmatter?.publish;
      if (typeof flag !== "boolean") continue;
      ledger[file.path] = {
        hash: contentHash(await app.vault.cachedRead(file)),
        mtime: file.stat.mtime,
        state: flag ? "cleared" : "held",
        reasons: flag ? [] : ["hand-marked publish: false"],
        human: true,
      };
      stale.delete(file.path);
    }

    let modelOk = this.deps.router.available();
    const manager = this.deps.manager();
    await this.withWorkingNotice(
      batch.length > 0 ? `Ariadne is screening ${batch.length} changed note(s)…` : "Ariadne is checking the ledger…",
      async () => {
        for (const file of batch) {
          if (ledger[file.path]?.human && ledger[file.path].mtime >= file.stat.mtime) continue;
          const content = await app.vault.cachedRead(file);
          const hash = contentHash(content);
          const prior = ledger[file.path];
          if (prior?.hash === hash) {
            // mtime moved but content didn't (e.g. frontmatter-only churn we
            // wrote ourselves) — keep the verdict, refresh the probe.
            prior.mtime = file.stat.mtime;
            continue;
          }
          const flags = personalSignals(content);

          // The embedding ensemble: the note's stored vectors already know
          // its neighborhood — full-note by construction, model-free, and it
          // catches the register regex can't (writing about people and
          // feelings without journal keywords still LANDS near the journal).
          let neighbors: ScreenNeighbor[] = [];
          if (manager?.hasStoredVectors()) {
            neighbors = (await manager.relatedToPath(file.path, { limit: 8 })).map((h) => ({
              path: h.path,
              title: h.title,
              cosine: h.cosine,
              journal: this.deps.isJournal(h.path),
            }));
          }
          const affinity = journalAffinity(neighbors);
          if (affinity >= JOURNAL_AFFINITY_FLAG) {
            flags.push("reads like your journal entries (semantic)");
          }
          const precedents = selectPrecedents(neighbors, ledger);

          let entry: LedgerEntry;
          if (modelOk) {
            try {
              const verdict = parsePublishScreen(
                await this.deps.router.run(
                  "scaffold",
                  publishScreenPrompt({
                    title: file.basename,
                    // Complete text: he doesn't write that much, and a note
                    // that turns personal in its last paragraph must not
                    // slip a truncation window. The cap is a guard against
                    // pathological pastes, not a screening budget.
                    content: content.slice(0, 20_000),
                    localFlags: flags,
                    precedents,
                  }),
                  { schema: PUBLISH_SCREEN_SCHEMA as unknown as Record<string, unknown>, maxTokens: 150 },
                ),
              );
              if (verdict.verdict === "hold") {
                entry = {
                  hash,
                  mtime: file.stat.mtime,
                  state: "held",
                  reasons: [verdict.reason ?? "personal content", ...flags].slice(0, 3),
                };
              } else {
                const problems = this.polishFor(file.path, content);
                entry = {
                  hash,
                  mtime: file.stat.mtime,
                  state: problems.length > 0 ? "polish" : "cleared",
                  reasons: problems,
                };
              }
            } catch (err) {
              if (err instanceof BudgetExceededError) {
                modelOk = false;
                new Notice("Session cost limit reached — remaining notes await your review.");
              }
              this.deps.log.warn(`publish screen failed for ${file.path}: ${String(err)}`);
              entry = { hash, mtime: file.stat.mtime, state: "unreviewed", reasons: flags };
            }
          } else if (flags.length > 0 || affinity >= JOURNAL_AFFINITY_HOLD) {
            // No model: a locally-flagged or journal-shaped note is held,
            // not merely queued.
            entry = {
              hash,
              mtime: file.stat.mtime,
              state: "held",
              reasons: [...flags, "no model to review — held on local signals"],
            };
          } else {
            entry = { hash, mtime: file.stat.mtime, state: "unreviewed", reasons: [] };
          }
          ledger[file.path] = entry;
          await this.embodyVerdict(file.path, entry);
        }
      },
    );
    await this.deps.publishLedger.save(ledger);
    this.presentPublishReview(ledger, stale.size - batch.length);
  }

  /** Polish problems for a cleared note — including the bedroom-link leak. */
  private polishFor(path: string, content: string): string[] {
    const { app } = this.deps;
    const resolved = app.metadataCache.resolvedLinks[path] ?? {};
    const privateLinks = Object.keys(resolved)
      .filter((target) => target.endsWith(".md") && !this.isPublishCandidate(target))
      .map((t) => t.split("/").pop()!.replace(/\.md$/, ""));
    const unresolvedLinks = Object.keys(app.metadataCache.unresolvedLinks[path] ?? {});
    return polishProblems({ content, privateLinks, unresolvedLinks });
  }

  /** Advice embodied: the verdict becomes the note's `publish:` frontmatter. */
  private async embodyVerdict(path: string, entry: LedgerEntry): Promise<void> {
    const file = this.deps.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const shouldPublish = entry.state === "cleared" || entry.overridden === true;
    await this.deps.app.fileManager
      .processFrontMatter(file, (fm: Record<string, unknown>) => {
        fm.publish = shouldPublish;
      })
      .catch((err) => this.deps.log.warn(`publish mark failed for ${path}: ${String(err)}`));
  }

  private presentPublishReview(ledger: PublishLedger, remaining: number): void {
    const { app } = this.deps;
    const rows = Object.entries(ledger);
    const held = rows.filter(([, e]) => e.state === "held" && !e.overridden);
    const unreviewed = rows.filter(([, e]) => e.state === "unreviewed");
    const polish = rows.filter(([, e]) => e.state === "polish");
    const cleared = rows.filter(([, e]) => e.state === "cleared" || e.overridden);

    const open = (path: string) => ({
      label: "Open",
      run: () => {
        void app.workspace.openLinkText(path, "", false);
        return false;
      },
    });
    const clearAction = (path: string, entry: LedgerEntry) => ({
      label: "Clear",
      run: async () => {
        entry.state = "cleared";
        entry.reasons = [];
        entry.human = true; // a precedent for future screening
        await this.embodyVerdict(path, entry);
        await this.deps.publishLedger.save(ledger);
        return true;
      },
    });

    const items: ActionableItem[] = [];
    for (const [path, entry] of held) {
      items.push({
        title: path.split("/").pop()!.replace(/\.md$/, ""),
        detail: `held — ${entry.reasons.join("; ") || "personal content"}`,
        actions: [
          open(path),
          {
            label: "Override…",
            destructive: true,
            confirmLabel: "Yes, publish this",
            run: async () => {
              entry.overridden = true;
              entry.human = true; // a precedent for future screening
              await this.embodyVerdict(path, entry);
              await this.deps.publishLedger.save(ledger);
              return true;
            },
          },
        ],
      });
    }
    for (const [path, entry] of unreviewed) {
      items.push({
        title: path.split("/").pop()!.replace(/\.md$/, ""),
        detail: "awaiting your review" + (entry.reasons.length ? ` — ${entry.reasons.join("; ")}` : ""),
        actions: [open(path), clearAction(path, entry)],
      });
    }
    for (const [path, entry] of polish) {
      items.push({
        title: path.split("/").pop()!.replace(/\.md$/, ""),
        detail: `needs polish — ${entry.reasons.join("; ")}`,
        actions: [open(path), { ...clearAction(path, entry), label: "Clear anyway" }],
      });
    }
    // The cleared list IS the outbound manifest — it must be scannable, and
    // overruling the model toward safety takes exactly one click.
    for (const [path, entry] of cleared) {
      items.push({
        title: path.split("/").pop()!.replace(/\.md$/, ""),
        detail: entry.overridden ? "cleared — by your override" : "cleared",
        actions: [
          open(path),
          {
            label: "Hold",
            run: async () => {
              entry.state = "held";
              entry.overridden = false;
              entry.reasons = ["held by you"];
              entry.human = true;
              await this.embodyVerdict(path, entry);
              await this.deps.publishLedger.save(ledger);
              return true;
            },
          },
        ],
      });
    }

    if (items.length === 0) {
      new Notice(
        `Nothing to review. Open Obsidian's Publish dialog to upload.` +
          (remaining > 0 ? ` (${remaining} more changed notes — run again.)` : ""),
      );
      return;
    }
    new ItemActionsModal(app, {
      title: "Review for publish",
      description:
        `Cleared: ${cleared.length} (marked publish: true). Journals and private folders are ` +
        `never offered here — that exception is a hand-written publish: true, deliberately ` +
        `outside this flow. Obsidian's Publish dialog does the uploading; publish what's cleared.` +
        (remaining > 0 ? ` ${remaining} more changed notes await the next run.` : ""),
      items,
    }).open();
  }

  /** Recent dated entries examined for recurring themes. */
  private static readonly THEME_ENTRIES = 60;

  /**
   * Recurring journal themes: dated entries clustering in embedding space
   * with no permanent note nearby — a thought the writer keeps having but
   * never keeps. Each theme gets a name (writer's vocabulary, cheap model
   * call — local box when awake) and one keystroke to become a scaffolded
   * note whose seed carries the journal evidence.
   */
  /**
   * The free half of theme discovery: gather + cluster, no model, no modal.
   * Shared by the full command and the Vault zone's once-per-session teaser.
   * Returns null when the device can't answer (no stored vectors) or the
   * journal is too thin to cluster.
   */
  async gatherThemeClusters(): Promise<ReturnType<typeof clusterThemes> | null> {
    const { app } = this.deps;
    const manager = this.deps.manager();
    if (!manager?.hasStoredVectors()) return null;
    // Only narrative entries seed themes. A log-shaped daily note recurs for
    // operational reasons — the same project's meeting notes cluster tightly
    // every week — and proposing that as a "recurring theme" would be a
    // confident false positive. Themes live where thinking happens.
    const candidates = app.vault
      .getMarkdownFiles()
      .filter((f) => this.deps.isJournal(f.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, ActionsController.THEME_ENTRIES);
    const dated: typeof candidates = [];
    for (const f of candidates) {
      if (classifyEntry(await app.vault.cachedRead(f)) === "journal") dated.push(f);
    }
    this.deps.log.debug(`themes: ${dated.length} narrative entries of ${candidates.length} dated`);
    if (dated.length < 3) return null;

    const neighborhoods: EntryNeighbors[] = [];
    for (const file of dated) {
      const hits = await manager.relatedToPath(file.path, { limit: 8 });
      if (hits.length === 0) continue; // no vectors yet (edited on a reader)
      neighborhoods.push({
        path: file.path,
        hits: hits.map((h) => ({
          path: h.path,
          title: h.title,
          snippet: h.snippet,
          cosine: h.cosine,
          periodic: this.deps.isJournal(h.path),
        })),
      });
    }
    return clusterThemes(neighborhoods);
  }

  async findJournalThemes(): Promise<void> {
    const { app } = this.deps;
    const manager = this.deps.manager();
    if (!manager?.hasStoredVectors()) {
      new Notice("Themes need the semantic index — wait for it to finish, or check the glyph.");
      return;
    }

    const items: ActionableItem[] = [];
    let themesModelOk = true;
    await this.withWorkingNotice(`Ariadne is reading the journal…`, async () => {
      const clusters = (await this.gatherThemeClusters()) ?? [];
      for (const theme of clusters.slice(0, 5)) {
        // Name it — cheap labeling, so the local box takes it when awake.
        // Theme evidence is journal excerpts — the privacy setting governs.
        const privacy = this.deps.journalPrivacy();
        let named: { title: string; gist?: string } | null = null;
        if (
          themesModelOk &&
          privacy !== "none" &&
          this.deps.router.available() &&
          (privacy !== "local" || this.deps.router.localAvailable())
        ) {
          try {
            named = parseTheme(
              await this.deps.router.run("theme", themePrompt(theme.evidence), {
                schema: THEME_SCHEMA as unknown as Record<string, unknown>,
                maxTokens: 150,
                ...(privacy === "local" ? { privacy: "local" as const } : {}),
              }),
            );
          } catch (err) {
            if (err instanceof BudgetExceededError) themesModelOk = false;
            this.deps.log.warn(`theme naming failed: ${String(err)}`);
          }
        }
        const title = named?.title ?? titleFromContent(theme.evidence[0] ?? "") ?? "Recurring theme";

        items.push({
          title,
          detail:
            `${theme.entries.length} entries` +
            (named?.gist ? ` — ${named.gist}` : "") +
            " · no permanent note nearby",
          actions: [
            {
              label: "Create note",
              closesModal: true,
              run: async () => {
                // The scaffold's seed carries the theme's own evidence, so
                // the note starts from what the writer actually wrote.
                const seed = [title, ...(named?.gist ? [named.gist] : []), ...theme.evidence].join(
                  "\n",
                );
                await this.createNote(seed);
                return true;
              },
            },
            {
              label: "Open latest",
              run: () => {
                void app.workspace.openLinkText(theme.entries[0], "", false);
                return false;
              },
            },
          ],
        });
      }
    });

    if (items.length === 0) {
      new Notice("No uncaptured recurring themes found — the journal's ideas all have notes.");
      return;
    }
    new ItemActionsModal(app, {
      title: "Recurring journal themes",
      description:
        "Thoughts you keep having but haven't kept: dated entries that cluster together with " +
        "no permanent note nearby. Creating one starts it from your own journal's words.",
      items,
    }).open();
    this.deps.log.info(`themes: ${items.length} uncaptured recurring themes surfaced`);
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
    // Two Untitled notes can want the same title: claim each target so the
    // second gets "Title 2" instead of a rename that rejects at click time.
    const claimed = new Set<string>();
    let modelOk = this.deps.router.available();
    await this.withWorkingNotice("Ariadne is reading untitled notes…", async () => {
      for (const file of candidates) {
        const content = await app.vault.read(file);
        // The writer's own first heading/line beats a generated title — and
        // is free. The model is only asked when the note offers nothing.
        let title = titleFromContent(content);
        if (!title && modelOk) {
          try {
            title = parseTitle(
              await this.deps.router.run("scaffold", titlePrompt(content.slice(0, EXCERPT_CHARS)), {
                schema: TITLE_SCHEMA as unknown as Record<string, unknown>,
                maxTokens: 100,
              }),
            );
          } catch (err) {
            if (err instanceof BudgetExceededError) {
              // Distinguish "cap hit" from "nothing renameable" — a false
              // explanation is worse than none.
              modelOk = false;
              new Notice("Session cost limit reached — titles below use only the notes' own text.");
            }
            this.deps.log.warn(`title proposal failed for ${file.path}: ${String(err)}`);
          }
        }
        if (!title) continue;

        const folder = file.parent?.path && file.parent.path !== "/" ? file.parent.path : "";
        const toPath = this.uniquePath(folder ? `${folder}/${title}.md` : `${title}.md`, claimed);
        claimed.add(toPath);
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

  /** Reset per run; false after the cost cap stops mid-batch model calls. */
  private triageModelOk = true;
  promotedToday(): number {
    const stored = this.deps.promotedStore.get();
    return stored?.date === localISODate() ? stored.count : 0;
  }

  private notePromotion(): void {
    const today = localISODate();
    this.deps.promotedStore.set({ date: today, count: this.promotedToday() + 1 });
  }

  async triageInbox(): Promise<void> {
    this.triageModelOk = true;
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
        if (!proposal && this.triageModelOk && this.deps.router.available()) {
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
            if (err instanceof BudgetExceededError) {
              this.triageModelOk = false;
              new Notice("Session cost limit reached — remaining items default to your judgment.");
            }
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
          // Closing first also makes the opened note the ACTIVE view, so
          // mergeNote resolves the right source instead of whatever editor
          // was focused behind the modal.
          closesModal: true,
          run: async () => {
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
    // become unrevertable and "Undo last action" reverses something unrelated.
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
        `✓ Swept ${done.length} attachment${done.length === 1 ? "" : "s"} into ${folder} — undoable via "Undo last action".`,
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
            new Notice(`✓ ${proposal.title} — undoable via "Undo last action".`);
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
