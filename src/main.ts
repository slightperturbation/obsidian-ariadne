import { Plugin, Platform, TFile, addIcon, normalizePath, requestUrl } from "obsidian";
import { AriadneSettings, DEFAULT_SETTINGS } from "./settings/settings";
import { AriadneSettingTab } from "./settings/settings-tab";
import { StatusStore } from "./core/status";
import { devicePolicy, type DevicePolicy } from "./core/device";
import { Logger } from "./util/logger";
import { IndexManager } from "./index/manager";
import { IncrementalScheduler } from "./index/scheduler";
import { VaultNoteSource } from "./index/crawler";
import { HashEmbedder } from "./index/embeddings/hash-embedder";
import type { OrtWasmPaths } from "./index/embeddings/model-ids";
import { WorkerEmbedder } from "./index/embeddings/worker-embedder";
import { WorkerClient } from "./index/embeddings/worker-client";
import { WorkerVectorIndex } from "./index/embeddings/worker-vector-index";
import { saveIndex, loadIndex, type FileIO } from "./index/persistence";
import { ARIADNE_VIEW_TYPE, AriadneView } from "./line/view";
import { DraftWatcher } from "./margin/draft-watcher";
import { GhostEngine } from "./margin/ghost/engine";
import { TensionEngine } from "./margin/tension/engine";
import { ghostExtension } from "./margin/ghost/extension";
import { MarkdownView } from "obsidian";
import { ClaudeProvider } from "./model/providers/claude";
import { GemmaProvider } from "./model/providers/gemma";
import { ModelRouter } from "./model/router";
import { ActionExecutor } from "./actions/framework";
import { ObsidianVaultIO } from "./actions/vault-io";
import { ActionsController } from "./actions/controller";
import { PromptModal } from "./ui/prompt-modal";
import { RetirementModal, surveyIncumbents } from "./actions/retirement";
import { ensureRuntimeAssets } from "./assets";
import { dateOf, localISODate, looksPeriodic } from "./core/periodic";
import { wantedTopics, type WantedTopic } from "./margin/wanted";
import { onThisDay, resurfacePick } from "./margin/resurface";
import { inFolders, parseFolderList } from "./margin/journal";
import { classifyEntry, entryTag, isLegacyDatedTag, normalizeTag } from "./margin/tags";
import { ARIADNE_BASES_VIEW, makeAriadneRelatedView } from "./bases/related-view";

/**
 * fetch over Obsidian's requestUrl: CORS-free (main-process request), which
 * direct renderer fetch to api.anthropic.com is not guaranteed to be.
 */
const obsidianFetch: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers: Record<string, string> = {};
  const h = init?.headers;
  if (h instanceof Headers) h.forEach((v, k) => (headers[k] = v));
  else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = v;
  else if (h) Object.assign(headers, h as Record<string, string>);

  const resp = await requestUrl({
    url,
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? init.body : (init?.body as ArrayBuffer | undefined),
    throw: false,
  });
  return new Response(resp.arrayBuffer, { status: resp.status, headers: resp.headers });
};

/** Debounce between the index going idle and a snapshot hitting disk. */
const SAVE_DELAY_MS = 5_000;

/**
 * Ariadne — plugin entry point.
 *
 * Phase 1 wires the read-only retrieval loop: vault → crawler → IndexManager
 * (lexical + vector + fusion), kept fresh by the incremental scheduler, and
 * surfaced through the Line view. Nothing here writes to the vault.
 */
export default class AriadnePlugin extends Plugin {
  settings!: AriadneSettings;
  status!: StatusStore;
  log!: Logger;

  private source?: VaultNoteSource;
  private manager?: IndexManager;
  private scheduler?: IncrementalScheduler;
  private io?: FileIO;
  private indexDir!: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private lastSavedRevision = -1;
  private ortBlobUrls?: OrtWasmPaths;
  private workerBlobUrl?: string;
  private workerClient?: WorkerClient;
  private watcher?: DraftWatcher;
  private ghost?: GhostEngine;
  private tensions?: TensionEngine;
  private router!: ModelRouter;
  private executor!: ActionExecutor;
  private actions!: ActionsController;
  private lastMarkdown: MarkdownView | null = null;
  private policy!: DevicePolicy;
  /** Reverse link graph, invalidated on metadata changes (see backlinks()). */
  private backlinkIndex?: Map<string, Set<string>>;
  /** Dangling-topic ranking, same invalidation cadence as the backlinks. */
  private wantedCache?: WantedTopic[];
  /** Per-path debounce for entry auto-tagging. */
  private tagTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** "Begin today's entry" was actioned; heals a format-blind detection. */
  private todayHandled?: string;
  private beginningToday = false;
  private resurfacedCache?: { date: string; pick: { path: string; title: string } | null };
  /** Panel dismissals ("for this session") — survive view rebuilds. */
  private panelSession = {
    wanted: new Set<string>(),
    tagRows: new Set<string>(),
    resurfaced: { dismissed: false },
  };

  /**
   * Is this note a journal/dated entry? Three signals, most specific first:
   * dated names (2026-07-25, "June 28, 2026", weeklies…), the Daily Notes
   * core plugin's configured folder, and the user's journal folders — for
   * journals whose entries aren't date-named ("Morning pages 12").
   */
  private isJournalPath = (path: string): boolean => {
    if (looksPeriodic(path)) return true;
    if (inFolders(path, this.journalFolders())) return true;
    // Fourth signal: an entry Ariadne (or the writer) already marked. Lets an
    // undated entry outside any configured folder keep its journal treatment.
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const type = this.app.metadataCache.getFileCache(file)?.frontmatter?.type as unknown;
    return typeof type === "string" && this.managedKinds().includes(type);
  };

  private journalFolders(): string[] {
    const folders = parseFolderList(this.settings.journalFolders);
    const dailyNotes = (
      this.app as unknown as {
        internalPlugins?: {
          getPluginById?: (id: string) => { instance?: { options?: { folder?: string } } } | null;
        };
      }
    ).internalPlugins?.getPluginById?.("daily-notes")?.instance?.options?.folder?.trim();
    if (dailyNotes) folders.push(normalizePath(dailyNotes));
    return folders;
  }

  async onload(): Promise<void> {
    // Ariadne's thread: a ball of thread with the strand trailing out — the
    // guide through the labyrinth, not a magnifying glass. Drawn in Lucide's
    // stroke idiom (100-viewBox equivalent of stroke-width 2 at 24) and
    // registered as a custom icon so it exists on every Obsidian version.
    addIcon(
      "ariadne-thread",
      `<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="46" cy="42" r="30"/>
        <path d="M20 32 C 34 42, 58 42, 72 32"/>
        <path d="M18 50 C 34 60, 58 60, 74 50"/>
        <path d="M67 63 C 76 73, 84 79, 92 86"/>
      </g>`,
    );

    await this.loadSettings();
    this.log = new Logger("Ariadne", this.settings.debugLogging);
    this.status = new StatusStore();
    this.policy = devicePolicy({
      isMobile: Platform.isMobile,
      deviceRole: this.settings.deviceRole,
      enableSemantic: this.settings.enableSemantic,
    });
    this.status.set({ role: this.policy.role });

    this.addSettingTab(new AriadneSettingTab(this.app, this));

    // ── Phase 3: reasoning + safe actions ────────────────────────────────
    const provider = new ClaudeProvider({
      apiKey: () => this.settings.claudeApiKey,
      model: () => this.settings.claudeModel,
      fetch: obsidianFetch,
    });
    const gemma = new GemmaProvider({
      baseUrl: () => this.settings.gemmaBaseUrl,
      model: () => this.settings.gemmaModel,
      fetch: obsidianFetch,
    });
    this.router = new ModelRouter({
      provider,
      local: gemma,
      mode: () => this.settings.routingMode,
      status: this.status,
      costLimitUsd: () => this.settings.costLimitUsd,
      log: this.log,
    });
    this.executor = new ActionExecutor(new ObsidianVaultIO(this.app));
    this.actions = new ActionsController({
      app: this.app,
      manager: () => this.manager,
      router: this.router,
      executor: this.executor,
      lastMarkdown: () => this.resolveMarkdown(),
      attachmentsFolder: () => this.settings.attachmentsFolder,
      inboxFolder: () => this.settings.inboxFolder,
      archiveFolder: () => this.settings.archiveFolder,
      isJournal: (path) => this.isJournalPath(path),
      log: this.log,
    });
    this.status.set({
      brain: provider.available() ? "cloud" : this.settings.gemmaBaseUrl.trim() ? "local" : "none",
    });
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (mv) this.lastMarkdown = mv;
      }),
    );

    this.addCommand({
      id: "new-scaffolded-note",
      name: "New scaffolded note",
      callback: () => {
        new PromptModal(
          this.app,
          { title: "What should this note capture?", placeholder: "One idea, a few phrases…" },
          (seed) => void this.actions.createNote(seed),
        ).open();
      },
    });

    this.addCommand({
      id: "split-note",
      name: "Split this note into atomic notes",
      callback: () => void this.actions.splitNote(),
    });

    this.addCommand({
      id: "generate-moc",
      name: "Generate Map of Content from related notes",
      callback: () => void this.actions.generateMoc(),
    });

    this.addCommand({
      id: "merge-duplicate",
      name: "Merge near-duplicate into this note",
      callback: () => void this.actions.mergeNote(),
    });

    this.addCommand({
      id: "sweep-attachments",
      name: "Sweep root attachments into the attachments folder",
      callback: () => void this.actions.sweepAttachments(),
    });

    this.addCommand({
      id: "cleanup-empty-notes",
      name: "Clean up empty notes",
      callback: () => void this.actions.cleanupEmptyNotes(),
    });

    this.addCommand({
      id: "close-the-day",
      name: "Close the day",
      callback: () => void this.actions.closeTheDay(),
    });

    this.addCommand({
      id: "weekly-synthesis",
      name: "Weekly synthesis questions",
      callback: () => void this.actions.weeklySynthesis(),
    });

    this.addCommand({
      id: "find-journal-themes",
      name: "Find recurring journal themes",
      callback: () => void this.actions.findJournalThemes(),
    });

    this.addCommand({
      id: "capture-thought",
      name: "Capture a thought to the Inbox",
      callback: () => {
        new PromptModal(
          this.app,
          { title: "What's the thought?", placeholder: "Fleeting is fine — it lands in the Inbox…" },
          (seed) => void this.actions.captureThought(seed),
        ).open();
      },
    });

    this.addCommand({
      id: "promote-to-note",
      name: "Promote selection to a note",
      editorCallback: () => void this.actions.promoteToNote(),
    });

    this.addCommand({
      id: "triage-inbox",
      name: "Triage Inbox",
      callback: () => void this.actions.triageInbox(),
    });

    this.addCommand({
      id: "resolve-untitled",
      name: "Resolve untitled notes",
      callback: () => void this.actions.resolveUntitled(),
    });

    this.addCommand({
      id: "retire-incumbents",
      name: "Retire replaced plugins (Smart Connections, Omnisearch)",
      callback: () => {
        void surveyIncumbents(this.app).then((statuses) =>
          new RetirementModal(this.app, statuses, this.log).open(),
        );
      },
    });

    this.addCommand({
      id: "undo-last-action",
      name: "Undo last action",
      callback: () => void this.actions.undoLast(),
    });

    this.tensions = new TensionEngine({
      manager: () => this.manager,
      router: this.router,
      mode: () => this.settings.tensionMode,
      isJournal: (path) => this.isJournalPath(path),
      excerptOf: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return null;
        const content = await this.app.vault.cachedRead(file);
        return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").slice(0, 1200) || null;
      },
      log: this.log,
    });

    // Serendipity 0.5 is neutral; the ±0.2 swing is enough to move a card a
    // full prominence tier without ever being able to hide it.
    const biasOf = (serendipity: number) => (serendipity - 0.5) * 0.4;

    this.registerView(
      ARIADNE_VIEW_TYPE,
      (leaf) =>
        new AriadneView(leaf, {
          manager: () => this.manager,
          status: this.status,
          watcher: this.getWatcher(),
          marginEnabled: () => this.settings.enableMargin,
          // Looser than the ghost-text bar: a card is glanceable, an inline
          // suggestion interrupts, so the Margin can afford to be less certain.
          marginMinCosine: () => Math.max(0.5, this.settings.ghostMinCosine - 0.12),
          marginNeighbors: (path) => this.linkNeighborhood(path),
          isPeriodic: this.isJournalPath,
          wantedTopics: () =>
            this.settings.enableWanted
              ? (this.wantedCache ??= wantedTopics(this.app.metadataCache.unresolvedLinks))
              : [],
          onCreateWanted: (title) => void this.actions.createNote(title),
          onThisDay: (currentPath) =>
            this.settings.enableOnThisDay
              ? onThisDay(currentPath, this.app.vault.getMarkdownFiles().map((f) => f.path))
              : [],
          resurfaced: () => {
            if (!this.manager || !this.settings.enableResurfacing) return null;
            // Cached per day: the pick is deterministic all day, and the foot
            // re-renders on every margin refresh — copying all note metadata
            // each pause bought nothing.
            const today = localISODate();
            if (this.resurfacedCache?.date !== today) {
              this.resurfacedCache = {
                date: today,
                pick: resurfacePick(this.manager.noteMetas(), today, Date.now(), this.isJournalPath),
              };
            }
            const pick = this.resurfacedCache.pick;
            return pick ? { path: pick.path, title: pick.title } : null;
          },
          promoteHint: () => this.settings.enablePromoteHint,
          onPromote: () => void this.actions.promoteToNote(),
          tagSuggestions: () => this.settings.enableTagSuggestions,
          tagsOf: (path) => this.tagsOf(path),
          onAddTag: (path, tag) => void this.addTag(path, tag),
          reservedTags: () => this.managedKinds(),
          session: this.panelSession,
          todayMissing: () => {
            if (!this.settings.enableTodayHint) return false;
            const today = localISODate();
            if (this.todayHandled === today) return false;
            return !this.app.vault.getMarkdownFiles().some((f) => dateOf(f.path) === today);
          },
          onBeginToday: () => void this.beginTodaysEntry(),
          touch: () => this.policy.touch,
          tensions: this.tensions,
          lineBias: () => biasOf(this.settings.lineSerendipity),
          marginBias: () => biasOf(this.settings.marginSerendipity),
          onCreateNote: (seed) => void this.actions.createNote(seed),
          onWeave: (result) => void this.actions.weave(result),
        }),
    );

    this.addCommand({
      id: "focus-line",
      name: "Open panel",
      callback: () => void this.activateLine(),
    });

    this.registerAriadneBasesView();

    // The Margin section + ghost text listen to the writing via one shared watcher.
    this.ghost = new GhostEngine({
      app: this.app,
      manager: () => this.manager,
      enabled: () => this.settings.enableGhostText,
      minCosine: () => this.settings.ghostMinCosine,
      isPeriodic: this.isJournalPath,
      log: this.log,
    });
    this.getWatcher().subscribe((ctx) => void this.ghost?.onContext(ctx));

    this.registerEditorExtension(
      ghostExtension({
        touch: () => this.policy.touch,
        isVim: () =>
          (this.app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig?.(
            "vimMode",
          ) === true,
        onDismiss: (path) => this.ghost?.noteDismissed(path),
        onAccept: (path) => this.log.debug(`ghost link accepted → ${path}`),
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        if (info instanceof MarkdownView) this.getWatcher().onEditorChange(editor, info);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.editor) this.getWatcher().onFocusChange(view.editor, view);
      }),
    );
    // Following a link in the SAME pane fires file-open, not
    // active-leaf-change — without this, the Margin goes stale exactly while
    // chaining through old notes, which is the core reading workflow the
    // method is built on (work WITH old notes, not just write new ones).
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view?.editor) this.getWatcher().onFocusChange(view.editor, view);
      }),
    );

    this.addCommand({
      id: "rebuild-index",
      name: "Rebuild index",
      callback: () => {
        if (!this.scheduler || !this.source) return;
        this.log.info("full rebuild requested");
        this.scheduler.enqueueAll(this.source.paths());
      },
    });

    // Indexing must wait for layout-ready: before that, the metadata cache is
    // still resolving and vault events replay the initial file scan.
    this.app.workspace.onLayoutReady(() => {
      void this.startIndexing();
      // The Line is an always-present surface (PRD §3.1). A plugin reload
      // detaches its leaves and Obsidian doesn't reliably restore them, so a
      // hot-reload during development — or any update — silently removed the
      // panel. Recreate it, without stealing focus from the editor.
      if (this.app.workspace.getLeavesOfType(ARIADNE_VIEW_TYPE).length === 0) {
        void this.activateLine(false);
      }
    });

    this.log.info(
      `loaded (v${this.manifest.version}) on ${Platform.isMobile ? "mobile" : "desktop"} ` +
        `as index ${this.policy.role}`,
    );
  }

  private async startIndexing(): Promise<void> {
    this.source = new VaultNoteSource(this.app);
    this.io = this.makeFileIO();
    this.indexDir = normalizePath(`${this.manifest.dir}/index`);

    // Lexical is live immediately; the embedding model attaches when (if)
    // it finishes loading, and the affected notes are re-indexed then.
    this.manager = new IndexManager();
    this.scheduler = new IncrementalScheduler(
      this.manager,
      (path) => this.source!.loadPath(path),
      this.status,
      {
        onIdle: () => {
          this.scheduleSave();
          // Live, not boot-time: a reader edits notes all session, and the
          // owner's fresh shards arrive over Sync mid-session.
          if (!this.policy.loadsModel && this.manager) {
            this.status.set({ staleNotes: this.manager.unembeddedCount });
          }
        },
      },
    );

    // Warm start: restore the last session's snapshot, then diff mtimes so
    // only changed/new/deleted notes re-index.
    let snapshot = await loadIndex(this.io, this.indexDir);
    // Semantic off must mean OFF: restore() would rebuild the vector store
    // from the snapshot and the Margin would quietly keep semantic ranking
    // (via stored vectors) while the glyph claimed otherwise.
    if (snapshot && !this.settings.enableSemantic) {
      snapshot = { ...snapshot, vectors: [], dim: undefined, embedderId: undefined };
    }
    if (snapshot) {
      try {
        this.manager.restore(snapshot);
      } catch (err) {
        // A corrupt snapshot must cost a rebuild, not the session: without
        // this the throw escaped into the unawaited startIndexing() and the
        // rest of startup (vault events, stale diff, model load) never ran.
        this.log.warn(`snapshot restore failed, rebuilding: ${String(err)}`);
        this.manager = new IndexManager();
        snapshot = null;
      }
    }
    if (snapshot) {
      this.lastSavedRevision = this.manager.revision;
      this.status.set({ indexedNotes: this.manager.noteCount });
      this.log.info(`warm start: ${this.manager.noteCount} notes from snapshot`);
    }

    const markIfNote = (path: string) => {
      if (path.endsWith(".md")) this.scheduler?.markDirty(path);
    };
    this.registerEvent(this.app.vault.on("create", (f) => markIfNote(f.path)));
    this.registerEvent(this.app.vault.on("modify", (f) => markIfNote(f.path)));
    this.registerEvent(
      this.app.vault.on("delete", (f) => this.scheduler?.markDeleted(f.path)),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        this.scheduler?.markDeleted(oldPath);
        markIfNote(f.path);
      }),
    );
    // Re-index when Obsidian finishes parsing a note (frontmatter/links ready).
    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        this.backlinkIndex = undefined;
        this.wantedCache = undefined;
        markIfNote(file.path);
        this.maybeAutoTag(file.path);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.backlinkIndex = undefined;
        this.wantedCache = undefined;
      }),
    );

    if (this.settings.indexOnStartup) {
      if (snapshot) {
        // Stale diff: index only what changed since the snapshot.
        const current = this.source.stats();
        const currentPaths = new Set(current.map((s) => s.path));
        let dirty = 0;
        for (const { path, mtime } of current) {
          if (this.manager.mtimeOf(path) !== mtime) {
            this.scheduler.markDirty(path);
            dirty++;
          }
        }
        for (const path of this.manager.indexedPaths()) {
          if (!currentPaths.has(path)) this.scheduler.markDeleted(path);
        }
        // On a consumer these re-index lexically only — there's no model to
        // embed them with — so they stay findable by word but not by meaning
        // until the owner next writes the index. The glyph reports the gap.
        if (!this.policy.writesIndex) this.status.set({ staleNotes: dirty });
        this.log.info(`stale diff: ${dirty} changed, ${this.scheduler.pending} queued`);
      } else {
        this.scheduler.enqueueAll(this.source.paths());
        this.log.info(`cold start: full index queued (${this.source.paths().length} notes)`);
      }
    }

    if (this.policy.loadsModel) void this.startSemantic();
    else this.adoptSyncedVectors(snapshot);
  }

  /**
   * Consumer path: use the vectors the owner already computed, with no model
   * on this device at all.
   *
   * `restore()` has already loaded them into an in-process store, so there is
   * nothing to build here — the job is to report honestly. Free-text semantic
   * search does need a model (something has to embed the query), so it stays
   * unavailable; but the Margin's "related to what I'm reading" runs entirely
   * off stored vectors, which is the mobile feature that actually matters.
   */
  private adoptSyncedVectors(snapshot: { vectors: unknown[] } | null): void {
    if (!this.settings.enableSemantic) {
      this.status.set({ semantic: "off" });
      return;
    }
    const synced = !!snapshot && snapshot.vectors.length > 0;
    this.status.set({ semantic: synced ? "synced" : "off" });
    this.log.info(
      synced
        ? `synced index adopted: ${this.manager?.noteCount ?? 0} notes, no local model`
        : "no synced vectors found — lexical only (index this vault on a desktop first)",
    );
  }

  /**
   * Load the real embedding model in the background; lexical search stays live
   * throughout. On success the affected notes re-index to gain vectors; on
   * failure the deterministic hash embedder keeps the semantic pipeline alive
   * (weakly) rather than dying.
   */
  /**
   * Build blob: URLs for the ONNX runtime files shipped next to main.js.
   * Obsidian blocks dynamic import of remote modules, so ORT's default CDN
   * load fails inside the app; a blob URL is same-origin and allowed. Returns
   * undefined (→ CDN attempt) only if the files are missing.
   */
  private async ortWasmBlobUrls(): Promise<OrtWasmPaths | undefined> {
    try {
      const adapter = this.app.vault.adapter;
      const mjsPath = normalizePath(`${this.manifest.dir}/ort-wasm-simd-threaded.asyncify.mjs`);
      const wasmPath = normalizePath(`${this.manifest.dir}/ort-wasm-simd-threaded.asyncify.wasm`);
      if (!(await adapter.exists(mjsPath)) || !(await adapter.exists(wasmPath))) return undefined;
      const [mjs, wasm] = await Promise.all([
        adapter.readBinary(mjsPath),
        adapter.readBinary(wasmPath),
      ]);
      return {
        mjs: URL.createObjectURL(new Blob([mjs], { type: "text/javascript" })),
        wasm: URL.createObjectURL(new Blob([wasm], { type: "application/wasm" })),
      };
    } catch {
      return undefined;
    }
  }

  private async startSemantic(): Promise<void> {
    if (!this.manager || !this.scheduler) return;
    this.status.set({ semantic: "loading" });
    // A BRAT install ships only main.js/manifest/styles — fetch the worker
    // and ONNX runtime from this version's release if they're missing.
    await ensureRuntimeAssets(this.app, this.manifest, this.log);
    try {
      const client = await this.makeWorkerClient();
      await client.ready();
      this.workerClient = client;
      const model = new WorkerEmbedder(this.settings.embeddingModel, client);
      // The vector store lives in the same worker as the model, so the cosine
      // scan never blocks typing and indexing/querying each take one hop.
      const vectors = new WorkerVectorIndex(model.dim, client);
      const backfill = this.manager.setEmbedder(model, vectors);
      this.status.set({ semantic: "on" });
      this.log.info(`embedder ready (${model.id}); backfilling ${backfill.length} notes`);
      if (backfill.length > 0) this.scheduler.enqueueAll(backfill);
    } catch (err) {
      this.log.warn(`embedding model failed to load, using hash fallback: ${String(err)}`);
      const fallback = new HashEmbedder(256);
      const backfill = this.manager.setEmbedder(fallback);
      this.status.set({ semantic: "fallback" });
      if (backfill.length > 0) this.scheduler.enqueueAll(backfill);
    }
  }

  /**
   * The embedder lives in a Web Worker for two load-bearing reasons: a worker
   * has no `process`, so transformers.js detects a browser environment and
   * uses the WASM backend (the renderer mis-detects Node and demands native
   * runtimes); and all embedding compute runs off the UI thread, upholding
   * the never-block-typing rule during backfills.
   */
  private async makeWorkerClient(): Promise<WorkerClient> {
    const adapter = this.app.vault.adapter;
    const workerPath = normalizePath(`${this.manifest.dir}/index-worker.js`);
    if (!(await adapter.exists(workerPath))) {
      throw new Error("index-worker.js missing next to main.js — re-run `npm run build`");
    }
    const workerSrc = await adapter.read(workerPath);
    this.workerBlobUrl = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
    this.ortBlobUrls = await this.ortWasmBlobUrls();
    if (!this.ortBlobUrls) {
      this.log.warn(
        "ONNX runtime files not found next to main.js — trying the CDN path, which Obsidian may block. Re-run `npm run build` to restore them.",
      );
    }
    return new WorkerClient({
      workerUrl: this.workerBlobUrl,
      model: this.settings.embeddingModel,
      wasmPaths: this.ortBlobUrls,
    });
  }

  /**
   * Index file access. A consumer device gets the reads and no-op writes: two
   * devices writing the same shards is exactly the shape Sync resolves by
   * picking one and discarding the other, which would silently corrupt the
   * index. The no-ops sit here rather than at each call site so persistence
   * stays oblivious to who is running it.
   */
  private makeFileIO(): FileIO {
    const adapter = this.app.vault.adapter;
    const readOnly = !this.policy.writesIndex;
    const refuse = async (): Promise<void> => {};
    return {
      exists: (p) => adapter.exists(p),
      mkdir: (p) => (readOnly ? refuse() : adapter.mkdir(p)),
      read: (p) => adapter.read(p),
      write: (p, data) => (readOnly ? refuse() : adapter.write(p, data)),
      readBinary: (p) => adapter.readBinary(p),
      writeBinary: (p, data) => (readOnly ? refuse() : adapter.writeBinary(p, data)),
      remove: (p) => (readOnly ? refuse() : adapter.remove(p)),
      list: async (dir) => {
        if (!(await adapter.exists(dir))) return [];
        const listing = await adapter.list(dir);
        return listing.files.map((f) => f.substring(f.lastIndexOf("/") + 1));
      },
    };
  }

  private scheduleSave(): void {
    // Short-circuit before the timer, not inside saveIndexNow: the expensive
    // part is snapshot(), which materializes every vector.
    if (!this.policy.writesIndex) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.policy.writesIndex) void this.saveIndexNow();
    }, SAVE_DELAY_MS);
  }

  private async saveIndexNow(): Promise<void> {
    if (!this.manager || !this.io || this.saving) return;
    if (this.manager.revision === this.lastSavedRevision) return;
    this.saving = true;
    const revision = this.manager.revision;
    try {
      const dirty = new Set(this.manager.dirtyPaths());
      await saveIndex(this.io, this.indexDir, await this.manager.snapshot(), {
        // Only the shards holding changed notes are rewritten.
        dirtyPaths: this.lastSavedRevision < 0 ? undefined : dirty,
      });
      this.manager.markPersisted(dirty);
      this.lastSavedRevision = revision;
      this.log.info(`index saved (${this.manager.noteCount} notes)`);
    } catch (err) {
      this.log.warn(`index save failed: ${String(err)}`);
    } finally {
      this.saving = false;
    }
  }

  /**
   * Register the Bases view, if this Obsidian has Bases.
   *
   * Guarded rather than pinned via manifest.minAppVersion: Bases arrived in
   * 1.10, and everything else here works well before that. Requiring 1.10 to
   * gain one optional view would lock out users for no reason.
   */
  private registerAriadneBasesView(): void {
    const register = (
      this as unknown as {
        registerBasesView?: (id: string, reg: Record<string, unknown>) => boolean;
      }
    ).registerBasesView;
    if (typeof register !== "function") {
      this.log.info("Bases API not available in this Obsidian — skipping the Bases view");
      return;
    }
    const View = makeAriadneRelatedView({
      manager: () => this.manager,
      openPath: (path, newLeaf) => void this.app.workspace.openLinkText(path, "", newLeaf),
    });
    register.call(this, ARIADNE_BASES_VIEW, {
      name: "Related (Ariadne)",
      icon: "ariadne-thread",
      factory: (controller: never, containerEl: HTMLElement) => new View(controller, containerEl),
    });
  }

  /**
   * Create/open today's entry. The Daily Notes core plugin owns the user's
   * date format, folder, and template, so when it's enabled its own command
   * does the work; the fallback (plugin disabled) is a plain ISO-named note
   * in the first journal folder.
   */
  private async beginTodaysEntry(): Promise<void> {
    if (this.beginningToday) return;
    this.beginningToday = true;
    try {
      const today = localISODate();
      // The row can't always see success (an exotic daily-note format is
      // invisible to dateOf) — remember the action so it stops re-offering.
      this.todayHandled = today;
      const commands = (
        this.app as unknown as {
          commands?: { executeCommandById?: (id: string) => boolean };
        }
      ).commands;
      if (commands?.executeCommandById?.("daily-notes")) return;

      const folder = this.journalFolders()[0] ?? "";
      const path = normalizePath(folder ? `${folder}/${today}.md` : `${today}.md`);
      if (!this.app.vault.getAbstractFileByPath(path)) {
        if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
          await this.app.vault.createFolder(folder).catch(() => {});
        }
        try {
          await this.app.vault.create(path, "");
        } catch (err) {
          this.log.warn(`could not create ${path}: ${String(err)}`);
        }
      }
      await this.app.workspace.openLinkText(path, "", false);
    } finally {
      this.beginningToday = false;
    }
  }

  /**
   * Auto-tag a dated/journal entry with `<kind>/<ISO date>` — daily when
   * log-shaped, journal when narrative dominates (see margin/tags).
   *
   * This is the plugin's one unprompted vault write, so its scope is
   * surgical: only entries the journal detection already claims, only
   * frontmatter tags matching Ariadne's own dated pattern (anything else in
   * `tags:` is never touched), idempotent (the common case is a no-op
   * decided from the metadata cache, no file write), and debounced so
   * typing never races a frontmatter rewrite. The classification follows
   * the note as it grows — a to-do list that turns into an essay gets its
   * daily/ tag replaced by journal/.
   */
  private maybeAutoTag(path: string): void {
    if (!this.settings.autoTagEntries) return;
    // Owner-only: two devices auto-tagging race Sync on the same frontmatter,
    // and a ctime-derived date DIVERGES across devices (the phone's ctime is
    // the day Sync delivered the file). One writer, convergent marks.
    if (!this.policy.writesIndex) return;
    // Eligibility by name/folder only — deliberately NOT the type-property
    // signal. Marks must not self-justify: a note moved out of the journal
    // folder stops being re-marked (its type remains until hand-cleared, and
    // still counts for detection elsewhere, which is the opt-in use).
    if (!looksPeriodic(path) && !inFolders(path, this.journalFolders())) return;
    const prior = this.tagTimers.get(path);
    if (prior) clearTimeout(prior);
    this.tagTimers.set(
      path,
      setTimeout(() => {
        this.tagTimers.delete(path);
        void this.autoTag(path);
      }, 3_000),
    );
  }

  private managedKinds(): string[] {
    // normalizeTag: a user pasting "#daily" into the setting must not make
    // the idempotence check permanently unsatisfiable (tags are compared
    // post-normalization; a "#"-prefixed kind never matches and every
    // metadata change becomes a frontmatter write, forever).
    return [
      normalizeTag(this.settings.dailyTag) || "daily",
      normalizeTag(this.settings.journalTag) || "journal",
      // Always recognized, so renaming the setting doesn't strand old marks.
      "daily",
      "journal",
    ];
  }

  private async autoTag(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const iso = dateOf(path) ?? new Date(file.stat.ctime).toISOString().slice(0, 10);
    const content = await this.app.vault.cachedRead(file);
    const kind = entryTag(
      classifyEntry(content),
      this.settings.dailyTag.trim() || "daily",
      this.settings.journalTag.trim() || "journal",
    );
    const kinds = this.managedKinds();

    // Idempotence from the cache: the write (and the changed-event it fires)
    // only happens when something is actually wrong or missing.
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    const raw = fm?.tags;
    const cachedTags = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
      .filter((t): t is string => typeof t === "string")
      .map(normalizeTag);
    const prefixes = kinds.map((k) => `${k}/`);
    const tagsOk =
      cachedTags.includes(kind) &&
      !cachedTags.some((t) => t !== kind && kinds.includes(t)) &&
      !cachedTags.some((t) => isLegacyDatedTag(t) && prefixes.some((p) => t.startsWith(p)));
    // `type` is managed only while it's empty or one of our values — a hand-set
    // type on a dated note (say, type: review) is the writer's call and stands.
    const type = typeof fm?.type === "string" ? (fm.type as string) : undefined;
    const typeOk = type !== undefined && !kinds.includes(type) ? true : type === kind;
    // `date` is written only when absent: a hand-set date always wins.
    const dateOk = fm?.date !== undefined && fm?.date !== null && fm?.date !== "";
    if (tagsOk && typeOk && dateOk) return;

    // The writer may still be typing: flush open editors for this file so
    // the frontmatter rewrite merges with their buffer instead of racing it.
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path) await view.save();
    }

    await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
      const rawTags = front.tags;
      const tags = (Array.isArray(rawTags) ? rawTags : typeof rawTags === "string" ? [rawTags] : [])
        .filter((t): t is string => typeof t === "string")
        .map(normalizeTag)
        .filter((t) => !(t !== kind && kinds.includes(t)))
        .filter((t) => !(isLegacyDatedTag(t) && prefixes.some((p) => t.startsWith(p))));
      if (!tags.includes(kind)) tags.push(kind);
      front.tags = tags;

      const currentType = typeof front.type === "string" ? front.type : undefined;
      if (currentType === undefined || kinds.includes(currentType)) front.type = kind;
      if (front.date === undefined || front.date === null || front.date === "") front.date = iso;
    });
    this.log.debug(`marked ${path}: #${kind}, type=${kind}, date`);
  }

  /** All tags on a note (inline + frontmatter), for suggestion pooling. */
  private tagsOf(path: string): string[] {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return [];
    const cache = this.app.metadataCache.getFileCache(file);
    const inline = (cache?.tags ?? []).map((t) => t.tag);
    const fm = cache?.frontmatter?.tags as unknown;
    const fmTags = Array.isArray(fm) ? fm : typeof fm === "string" ? [fm] : [];
    return [...inline, ...fmTags.filter((t): t is string => typeof t === "string")].map(
      normalizeTag,
    );
  }

  private async addTag(path: string, tag: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      const raw = fm.tags;
      const tags = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [])
        .filter((t): t is string => typeof t === "string")
        .map(normalizeTag);
      if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
      fm.tags = tags;
    });
  }

  private getWatcher(): DraftWatcher {
    this.watcher ??= new DraftWatcher();
    return this.watcher;
  }

  /**
   * The note the writer is working in, for weaving/inserting links. Prefer the
   * active markdown view; when the Line/Margin has focus (so the active view
   * isn't markdown) fall back to the last-focused note, then any open note.
   * Without the fallbacks, weaving before ever switching notes finds nothing.
   */
  private resolveMarkdown(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file) return active;
    // The remembered view may have been closed since; writing through a
    // detached editor is a silent no-op at best. leaf.parent is null once
    // the leaf leaves the workspace tree.
    if (this.lastMarkdown?.file && this.lastMarkdown.leaf.parent) return this.lastMarkdown;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file) return leaf.view;
    }
    return null;
  }

  /**
   * Notes one hop away from `path` in the link graph: its backlinks, and the
   * notes its own links point on to. Directly-linked notes are deliberately
   * left out — the Margin already suppresses those as "not news". What remains
   * is the near neighbourhood, which is a much better relevance prior than
   * text similarity alone: a note two hops from what you're writing is
   * demonstrably part of the same thought.
   */
  private linkNeighborhood(path: string): Set<string> {
    const graph = this.app.metadataCache.resolvedLinks;
    const out = new Set<string>();
    for (const target of Object.keys(graph[path] ?? {})) {
      for (const second of Object.keys(graph[target] ?? {})) {
        if (second !== path) out.add(second);
      }
    }
    for (const source of this.backlinks().get(path) ?? []) out.add(source);
    return out;
  }

  /**
   * Reverse link index, rebuilt only when the metadata cache changes.
   *
   * Finding backlinks by scanning every note's outbound links is O(all links
   * in the vault), and the Margin asks for them after every typing pause —
   * cheap enough to miss on a desktop, plainly wasteful on a phone.
   */
  private backlinks(): Map<string, Set<string>> {
    if (this.backlinkIndex) return this.backlinkIndex;
    const index = new Map<string, Set<string>>();
    for (const [source, links] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      for (const target of Object.keys(links)) {
        let sources = index.get(target);
        if (!sources) {
          sources = new Set<string>();
          index.set(target, sources);
        }
        sources.add(source);
      }
    }
    this.backlinkIndex = index;
    return index;
  }

  private async activateLine(focus = true): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(ARIADNE_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: ARIADNE_VIEW_TYPE, active: focus });
    }
    if (focus) {
      await workspace.revealLeaf(leaf);
      if (leaf.view instanceof AriadneView) leaf.view.focusInput();
    }
  }

  onunload(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const timer of this.tagTimers.values()) clearTimeout(timer);
    this.tensions?.dispose();
    this.workerClient?.dispose();
    if (this.workerBlobUrl) URL.revokeObjectURL(this.workerBlobUrl);
    if (this.ortBlobUrls) {
      URL.revokeObjectURL(this.ortBlobUrls.mjs);
      URL.revokeObjectURL(this.ortBlobUrls.wasm);
    }
    this.watcher?.dispose();
    this.scheduler?.dispose();
    // Best-effort: onunload can't await, but the write usually completes.
    if (this.policy.writesIndex) void this.saveIndexNow();
    this.log?.info("unloaded");
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<AriadneSettings> & {
      cosineScale?: number;
    };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);

    // Migration: ghostMinCosine used to be compared against a [-1,1]→[0,1]
    // remapped cosine, so a stored 0.7 actually meant raw 0.4. Convert once
    // (raw = 2v-1, floored at the new slider minimum) and stamp the scale so
    // we don't convert twice.
    if (stored && stored.cosineScale !== 2 && typeof stored.ghostMinCosine === "number") {
      const converted = Math.max(0.6, 2 * stored.ghostMinCosine - 1);
      this.settings.ghostMinCosine = Number(converted.toFixed(2));
      this.settings.cosineScale = 2;
      await this.saveData(this.settings);
    } else {
      this.settings.cosineScale = 2;
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.log?.setEnabled(this.settings.debugLogging);
    // The brain glyph tracks whether a key is configured.
    this.status?.set({ brain: this.settings.claudeApiKey.trim() ? "cloud" : "none" });
  }
}
