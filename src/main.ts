import { Plugin, Platform, TFile, normalizePath } from "obsidian";
import { AriadneSettings, DEFAULT_SETTINGS } from "./settings/settings";
import { AriadneSettingTab } from "./settings/settings-tab";
import { StatusStore } from "./core/status";
import { Logger } from "./util/logger";
import { IndexManager } from "./index/manager";
import { IncrementalScheduler } from "./index/scheduler";
import { VaultNoteSource } from "./index/crawler";
import { HashEmbedder } from "./index/embeddings/hash-embedder";
import type { OrtWasmPaths } from "./index/embeddings/transformers-provider";
import { WorkerEmbedder } from "./index/embeddings/worker-embedder";
import { saveIndex, loadIndex, type FileIO } from "./index/persistence";
import { ARIADNE_VIEW_TYPE, LineView } from "./line/view";

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
  private embedder?: WorkerEmbedder;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.log = new Logger("Ariadne", this.settings.debugLogging);
    this.status = new StatusStore();

    this.addSettingTab(new AriadneSettingTab(this.app, this));

    this.registerView(
      ARIADNE_VIEW_TYPE,
      (leaf) =>
        new LineView(leaf, {
          manager: () => this.manager,
          status: this.status,
        }),
    );

    this.addCommand({
      id: "focus-line",
      name: "Focus the Line",
      callback: () => void this.activateLine(),
    });

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
    this.app.workspace.onLayoutReady(() => void this.startIndexing());

    this.log.info(
      `loaded (v${this.manifest.version}) on ${Platform.isMobile ? "mobile" : "desktop"}`,
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
      { onIdle: () => this.scheduleSave() },
    );

    // Warm start: restore the last session's snapshot, then diff mtimes so
    // only changed/new/deleted notes re-index.
    const snapshot = await loadIndex(this.io, this.indexDir);
    if (snapshot) {
      this.manager.restore(snapshot);
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
      this.app.metadataCache.on("changed", (file: TFile) => markIfNote(file.path)),
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
        this.log.info(`stale diff: ${dirty} changed, ${this.scheduler.pending} queued`);
      } else {
        this.scheduler.enqueueAll(this.source.paths());
        this.log.info(`cold start: full index queued (${this.source.paths().length} notes)`);
      }
    }

    if (this.settings.enableSemantic) void this.startSemantic();
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
    try {
      const model = await this.makeWorkerEmbedder();
      await model.ready();
      this.embedder = model;
      const backfill = this.manager.setEmbedder(model);
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
  private async makeWorkerEmbedder(): Promise<WorkerEmbedder> {
    const adapter = this.app.vault.adapter;
    const workerPath = normalizePath(`${this.manifest.dir}/embed-worker.js`);
    if (!(await adapter.exists(workerPath))) {
      throw new Error("embed-worker.js missing next to main.js — re-run `npm run build`");
    }
    const workerSrc = await adapter.read(workerPath);
    this.workerBlobUrl = URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" }));
    this.ortBlobUrls = await this.ortWasmBlobUrls();
    if (!this.ortBlobUrls) {
      this.log.warn(
        "ONNX runtime files not found next to main.js — trying the CDN path, which Obsidian may block. Re-run `npm run build` to restore them.",
      );
    }
    return new WorkerEmbedder(this.settings.embeddingModel, this.workerBlobUrl, this.ortBlobUrls);
  }

  private makeFileIO(): FileIO {
    const adapter = this.app.vault.adapter;
    return {
      exists: (p) => adapter.exists(p),
      mkdir: (p) => adapter.mkdir(p),
      read: (p) => adapter.read(p),
      write: (p, data) => adapter.write(p, data),
      readBinary: (p) => adapter.readBinary(p),
      writeBinary: (p, data) => adapter.writeBinary(p, data),
      remove: (p) => adapter.remove(p),
      list: async (dir) => {
        if (!(await adapter.exists(dir))) return [];
        const listing = await adapter.list(dir);
        return listing.files.map((f) => f.substring(f.lastIndexOf("/") + 1));
      },
    };
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveIndexNow();
    }, SAVE_DELAY_MS);
  }

  private async saveIndexNow(): Promise<void> {
    if (!this.manager || !this.io || this.saving) return;
    if (this.manager.revision === this.lastSavedRevision) return;
    this.saving = true;
    const revision = this.manager.revision;
    try {
      await saveIndex(this.io, this.indexDir, this.manager.snapshot());
      this.lastSavedRevision = revision;
      this.log.info(`index saved (${this.manager.noteCount} notes)`);
    } catch (err) {
      this.log.warn(`index save failed: ${String(err)}`);
    } finally {
      this.saving = false;
    }
  }

  private async activateLine(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(ARIADNE_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: ARIADNE_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    if (leaf.view instanceof LineView) leaf.view.focusInput();
  }

  onunload(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.embedder?.dispose();
    if (this.workerBlobUrl) URL.revokeObjectURL(this.workerBlobUrl);
    if (this.ortBlobUrls) {
      URL.revokeObjectURL(this.ortBlobUrls.mjs);
      URL.revokeObjectURL(this.ortBlobUrls.wasm);
    }
    this.scheduler?.dispose();
    // Best-effort: onunload can't await, but the write usually completes.
    void this.saveIndexNow();
    this.log?.info("unloaded");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.log?.setEnabled(this.settings.debugLogging);
  }
}
