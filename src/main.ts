import { Notice, Plugin, Platform, TFile, TFolder, addIcon, getAllTags, normalizePath, requestUrl } from "obsidian";
import {
  AriadneSettings,
  DEFAULT_SETTINGS,
  parseEndpoints,
  parseModelList,
} from "./settings/settings";
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
import { LocalPool } from "./model/providers/local-pool";
import { makeObsidianFetch } from "./util/obsidian-fetch";
import { ModelRouter } from "./model/router";
import { ActionExecutor } from "./actions/framework";
import { ObsidianVaultIO } from "./actions/vault-io";
import { ActionsController } from "./actions/controller";
import { PromptModal } from "./ui/prompt-modal";
import { RetirementModal, surveyIncumbents } from "./actions/retirement";
import { ensureRuntimeAssets } from "./assets";
import {
  dateOf,
  formatDateName,
  inferDateNameFormat,
  localISODate,
  looksPeriodic,
} from "./core/periodic";
import { wantedTopics, type WantedTopic } from "./margin/wanted";
import { isExcludedPath, type ExclusionFilter } from "./index/crawler";
import { onThisDay, openingLine, resurfacePick } from "./margin/resurface";
import { inFolders, parseFolderList } from "./margin/journal";
import { cloudAllowed, levelOf, underFolder, type LevelPolicy, type PrivacyLevel } from "./gateway/levels";
import { ObsidianGatewayIO } from "./gateway/obsidian-io";
import { RecordStore } from "./gateway/store";
import { listReviews, markDecided, planObservation, reviewFolder, type ReviewItem } from "./gateway/submit";
import { ItemActionsModal, type ActionableItem } from "./ui/item-actions-modal";
import {
  continuityLabel,
  lastReflectiveGist,
  pickForDay,
  previousDated,
  synthesisQuestions,
  type ThreadItem,
} from "./margin/threads";
import { classifyEntry, entryTag, isLegacyDatedTag, normalizeTag } from "./margin/tags";
import type { PublishLedger } from "./publish/screen";
import { emptyThreadsLedger, type ThreadsLedger } from "./margin/thread-weave";
import { rankFillOut, type FillOutCandidate, type FillOutRow } from "./margin/fill-out";
import { ARIADNE_BASES_VIEW, makeAriadneRelatedView } from "./bases/related-view";
import { ChatEngine } from "./chat/engine";
import { vaultTools, type VaultAccess } from "./chat/tools";
import { listLocalModels, parseChoice } from "./chat/models";
import { transcriptMarkdown, transcriptTitle } from "./chat/transcript";
import { GemmaProvider } from "./model/providers/gemma";
import { CHAT_VIEW_TYPE, ChatView } from "./chat/view";

const obsidianFetch = makeObsidianFetch(requestUrl);

/** Debounce between the index going idle and a snapshot hitting disk. */
const SAVE_DELAY_MS = 5_000;
/** Minimum spacing of mid-drain (backfill) saves. */
const MID_DRAIN_SAVE_MS = 90_000;
/** Queue depth below which a drain is "about to finish" — let onIdle save. */
const MID_DRAIN_MIN_REMAINING = 50;

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
  private lastMidDrainSaveAt = 0;
  private lastMidDrainDone = 0;
  private saving = false;
  private lastSavedRevision = -1;
  private ortBlobUrls?: OrtWasmPaths;
  private workerBlobUrl?: string;
  private workerClient?: WorkerClient;
  private watcher?: DraftWatcher;
  private ghost?: GhostEngine;
  private tensions?: TensionEngine;
  private router!: ModelRouter;
  private localPool?: LocalPool;
  /** From the Battery Status API; false where it doesn't exist (desktops). */
  private onBattery = false;
  private debugStatusTimer: ReturnType<typeof setTimeout> | null = null;
  private executor!: ActionExecutor;
  /** The vault chat's engine, made when the pane first needs it. */
  private chatEngine?: ChatEngine;
  /** Journal entries may be read in the vault chat. Off at every start: it is turned on in the pane, for that session. */
  private chatReadsJournal = false;
  /** How the open chat pane asks the owner whether something may be sent outside. No pane: nothing is sent. */
  private chatWebAsk: ((what: string) => Promise<boolean>) | null = null;
  /** The provider for the model picked in the chat, kept while the pick stands. */
  private chatPicked?: { key: string; provider: GemmaProvider };
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
  private resurfacedCache?: {
    date: string;
    pick: { path: string; title: string; line?: string } | null;
  };
  private publishLedgerCache?: PublishLedger;
  private publishCount?: { at: number; n: number };
  private threadsLedgerCache?: ThreadsLedger;
  private fillOutCache: FillOutRow[] = [];
  private fillOutTimer: ReturnType<typeof setTimeout> | null = null;
  private threadScanTimer: ReturnType<typeof setTimeout> | null = null;

  private publishLedgerPath(): string {
    return normalizePath(`${this.manifest.dir}/ariadne-publish.json`);
  }

  private threadsLedgerPath(): string {
    return normalizePath(`${this.manifest.dir}/ariadne-threads.json`);
  }

  /**
   * Background thread scan, debounced: the work is worker round trips plus
   * (rarely) a cached local-model verdict, so re-scanning after journal
   * edits is cheap — but never immediate, and never two at once.
   */
  private scheduleThreadScan(delayMs: number): void {
    if (!this.settings.suggestJournalThreads) return;
    if (this.threadScanTimer) clearTimeout(this.threadScanTimer);
    if (this.fillOutTimer) clearTimeout(this.fillOutTimer);
    if (this.debugStatusTimer) clearTimeout(this.debugStatusTimer);
    this.threadScanTimer = setTimeout(() => {
      this.threadScanTimer = null;
      void this.actions
        .scanThreads()
        .then(() => this.refreshFootPanels())
        .catch((err) => this.log.warn(`thread scan failed: ${String(err)}`));
    }, delayMs);
  }

  private refreshFootPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(ARIADNE_VIEW_TYPE)) {
      if (leaf.view instanceof AriadneView) leaf.view.refreshFoot();
    }
  }

  /** Is the Obsidian Publish core plugin present and enabled? */
  private publishAvailable(): boolean {
    const plugin = (
      this.app as unknown as {
        internalPlugins?: { getPluginById?: (id: string) => { enabled?: boolean } | null };
      }
    ).internalPlugins?.getPluginById?.("publish");
    return !!plugin && plugin.enabled !== false;
  }

  /** Once-per-session theme teaser: cluster count without naming or modal. */
  private themesTeaserCount?: number;
  private themesScanned = false;
  /** Panel dismissals ("for this session") — survive view rebuilds. */
  private panelSession = {
    wanted: new Set<string>(),
    tagRows: new Set<string>(),
    threads: new Set<string>(),
    fillOut: new Set<string>(),
    resurfaced: { dismissed: false },
  };

  /**
   * Is this note a journal/dated entry? Three signals, most specific first:
   * dated names (2026-07-25, "June 28, 2026", weeklies…), the Daily Notes
   * core plugin's configured folder, and the user's journal folders — for
   * journals whose entries aren't date-named ("Morning pages 12").
   */
  private isJournalPath = (path: string): boolean => {
    // What the agent keeps is never the writer's journal, however it is named.
    if (underFolder(path, this.levelPolicy().agentFolder)) return false;
    if (looksPeriodic(path)) return true;
    if (inFolders(path, this.journalFolders())) return true;
    // Fourth signal: an entry Ariadne (or the writer) already marked. Lets an
    // undated entry outside any configured folder keep its journal treatment.
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const type = this.app.metadataCache.getFileCache(file)?.frontmatter?.type as unknown;
    return typeof type === "string" && this.managedKinds().includes(type);
  };

  /**
   * Everything Ariadne must not see: the excludedFolders setting plus
   * Obsidian's own "Excluded files" (userIgnoreFilters — prefix strings, or
   * /regex/ entries). Read defensively: getConfig is undocumented API.
   */
  private exclusionFilters(): ExclusionFilter[] {
    const filters: ExclusionFilter[] = parseFolderList(this.settings.excludedFolders);
    // The agent's review queue is plumbing, not notes.
    filters.push(reviewFolder(this.levelPolicy().agentFolder));
    const raw = (
      this.app.vault as unknown as { getConfig?: (k: string) => unknown }
    ).getConfig?.("userIgnoreFilters");
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry !== "string" || !entry) continue;
        if (entry.length > 2 && entry.startsWith("/") && entry.endsWith("/")) {
          try {
            filters.push(new RegExp(entry.slice(1, -1)));
          } catch {
            /* invalid user regex — skip */
          }
        } else {
          filters.push(entry.replace(/\/+$/, ""));
        }
      }
    }
    return filters;
  }

  /** publish: true frontmatter — the note is (or is marked for) the public site. */
  private isPublishedNote = (path: string): boolean => {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.publish === true;
  };

  /**
   * Fill-out rows for the Vault zone, publish-anchored (see margin/fill-out).
   * Recomputed in the background, debounced — reads only published notes and
   * a bounded set of notes they link to.
   */
  private scheduleFillOut(delayMs = 30_000): void {
    if (this.fillOutTimer) clearTimeout(this.fillOutTimer);
    this.fillOutTimer = setTimeout(() => {
      this.fillOutTimer = null;
      void this.computeFillOut().catch((err) =>
        this.log.warn(`fill-out scan failed: ${String(err)}`),
      );
    }, delayMs);
  }

  private async computeFillOut(): Promise<void> {
    const published = this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.isPublishedNote(f.path) && !this.isJournalPath(f.path));
    if (published.length === 0) {
      this.fillOutCache = [];
      return;
    }
    const pubPaths = new Set(published.map((f) => f.path));
    const unresolved = this.app.metadataCache.unresolvedLinks;
    const candidates: FillOutCandidate[] = [];
    for (const f of published) {
      candidates.push({
        path: f.path,
        title: f.basename,
        published: true,
        content: await this.app.vault.cachedRead(f),
        unresolvedCount: Object.keys(unresolved[f.path] ?? {}).length,
      });
    }
    // Unpublished notes reachable from published ones: a doorway on the
    // public site that opens onto a stub. Bounded, and quiet/journal notes
    // stay out (linking to source material is not a demand to write it).
    const resolved = this.app.metadataCache.resolvedLinks;
    const via = new Map<string, string>();
    for (const f of published) {
      for (const target of Object.keys(resolved[f.path] ?? {})) {
        if (pubPaths.has(target) || !target.endsWith(".md") || via.has(target)) continue;
        if (this.isJournalPath(target) || this.isQuietNote(target)) continue;
        via.set(target, f.basename);
        if (via.size >= 40) break;
      }
      if (via.size >= 40) break;
    }
    for (const [target, viaTitle] of via) {
      const file = this.app.vault.getAbstractFileByPath(target);
      if (!(file instanceof TFile)) continue;
      candidates.push({
        path: target,
        title: file.basename,
        published: false,
        viaPublished: viaTitle,
        content: await this.app.vault.cachedRead(file),
        unresolvedCount: Object.keys(unresolved[target] ?? {}).length,
      });
    }
    this.fillOutCache = rankFillOut(candidates, 2);
    this.refreshFootPanels();
  }

  /** unresolvedLinks minus excluded sources — parked copies must not vote. */
  private unresolvedLinksFiltered(): Record<string, Record<string, number>> {
    const filters = this.exclusionFilters();
    const all = this.app.metadataCache.unresolvedLinks;
    if (filters.length === 0) return all;
    const out: Record<string, Record<string, number>> = {};
    for (const [source, links] of Object.entries(all)) {
      if (!isExcludedPath(source, filters)) out[source] = links;
    }
    return out;
  }

  /**
   * Ambient quiet (settings: quietTypes + quietAiGenerated): source material
   * and machine-generated notes never appear in ambient surfaces — Related,
   * ghost links, tension, resurfacing, theme/thread detection. Deliberate
   * surfaces (Line search, backlinks) are untouched. Frontmatter is read at
   * query time, so changing the setting needs no re-index.
   */
  private isQuietNote = (path: string): boolean => {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return false;
    if (
      this.settings.quietAiGenerated &&
      (fm.authorship === "ai-generated" || fm.authorship === "agent")
    ) {
      return true;
    }
    const type = fm.type as unknown;
    return (
      typeof type === "string" && parseFolderList(this.settings.quietTypes).includes(type)
    );
  };

  /**
   * Power state via the Battery Status API (present in Obsidian's desktop
   * runtime; absent on some platforms, where we simply never save battery).
   * A plug/unplug re-orders the local endpoints — see LocalPool.
   */
  private watchPower(pool: LocalPool): void {
    interface BatteryLike extends EventTarget {
      charging: boolean;
    }
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    if (!nav.getBattery) {
      this.log.info("battery API unavailable — local model is never spared");
      return;
    }
    void nav
      .getBattery()
      .then((battery) => {
        const update = () => {
          const onBattery = !battery.charging;
          if (onBattery === this.onBattery) return;
          this.onBattery = onBattery;
          this.log.info(`power: now ${onBattery ? "on battery" : "plugged in"}`);
          pool.notifyPowerChange();
          this.status.set({});
          this.scheduleDebugStatus();
        };
        update();
        battery.addEventListener("chargingchange", update);
        this.register(() => battery.removeEventListener("chargingchange", update));
      })
      .catch((err) => this.log.warn(`battery API failed: ${String(err)}`));
  }

  /** The glyph's account of the local brain ("" when none is configured). */
  private localGlyph(): string {
    const state = this.localPool?.state();
    if (!state?.configured) return "";
    if (!state.active) return state.savingBattery ? "local asleep · on battery" : "local asleep";
    const where = state.active.label;
    if (state.active.lastResort) return `local ${where} (battery — last resort)`;
    return state.savingBattery ? `local ${where} · on battery` : `local ${where}`;
  }

  /**
   * With debug logging on, mirror the routing/index state to a small file in
   * the plugin folder. It exists so behavior that only happens inside
   * Obsidian (power events, endpoint probes, which model resolved) can be
   * checked from outside it. Debounced; never written when debug is off.
   */
  private scheduleDebugStatus(delayMs = 2500): void {
    if (!this.settings.debugLogging) return;
    if (this.debugStatusTimer) clearTimeout(this.debugStatusTimer);
    this.debugStatusTimer = setTimeout(() => {
      this.debugStatusTimer = null;
      const status = this.status.get();
      const body = {
        at: new Date().toISOString(),
        version: this.manifest.version,
        power: { onBattery: this.onBattery, avoidOnBattery: this.settings.avoidLocalOnBattery },
        routing: { mode: this.settings.routingMode, journal: this.settings.journalModelCalls },
        local: this.localPool?.state() ?? null,
        glyph: this.localGlyph(),
        index: {
          notes: this.manager?.noteCount ?? 0,
          embedder: this.manager?.embedderRecipeId ?? null,
          unembedded: this.manager?.unembeddedCount ?? 0,
          state: status.index,
          progress: [status.progressDone, status.progressTotal],
          semantic: status.semantic,
          lastError: status.lastError ?? null,
        },
      };
      void this.app.vault.adapter
        .write(normalizePath(`${this.manifest.dir}/ariadne-debug.json`), JSON.stringify(body, null, 2))
        .catch(() => {
          /* diagnostics must never surface an error */
        });
    }, delayMs);
  }

  private agentReviews: ReviewItem[] = [];
  private agentReviewTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleAgentReviews(): void {
    if (this.agentReviewTimer) clearTimeout(this.agentReviewTimer);
    this.agentReviewTimer = setTimeout(() => {
      this.agentReviewTimer = null;
      void this.loadAgentReviews();
    }, 800);
  }

  private async loadAgentReviews(): Promise<void> {
    try {
      const io = new ObsidianGatewayIO(this.app);
      const all = await listReviews(io, this.levelPolicy().agentFolder);
      this.agentReviews = all.filter((r) => !r.decision);
    } catch (err) {
      this.log.warn(`agent reviews unreadable: ${String(err)}`);
      this.agentReviews = [];
    }
    this.refreshFootPanels();
  }

  /**
   * Changes your agent proposed that the gateway held for you. Approving
   * applies the change through the action executor (so it can be undone);
   * either way the decision is recorded on the review file, which Sync
   * carries back to the gateway.
   */
  private async reviewAgentChanges(): Promise<void> {
    await this.loadAgentReviews();
    if (this.agentReviews.length === 0) {
      new Notice("Nothing from your agent is waiting for review.");
      return;
    }
    const io = new ObsidianGatewayIO(this.app);
    const agentFolder = this.levelPolicy().agentFolder;
    const ctx = { io, store: new RecordStore(io, agentFolder), agentFolder, now: () => new Date() };
    const decided = async (item: ReviewItem, decision: "approved" | "dismissed") => {
      await markDecided(io, item, decision);
      this.agentReviews = this.agentReviews.filter((r) => r.key !== item.key);
      this.refreshFootPanels();
    };
    const items: ActionableItem[] = this.agentReviews.map((item) => ({
      title: item.summary || "A change from your agent",
      detail: `Held because ${item.reason}.${item.target ? ` → ${item.target}` : ""}`,
      actions: [
        {
          label: "Approve",
          run: async () => {
            const plan = await planObservation(ctx, item.observation, { force: true });
            if (plan.decision !== "apply") {
              new Notice(`Can't apply: ${plan.reason}`);
              return false;
            }
            await this.executor.apply({ title: plan.summary, changes: plan.changes });
            await decided(item, "approved");
            return true;
          },
        },
        {
          label: "Dismiss",
          run: async () => {
            await decided(item, "dismissed");
            return true;
          },
        },
      ],
    }));
    new ItemActionsModal(this.app, {
      title: "From your agent",
      description:
        "Changes your agent proposed that were not certain enough to apply on their own. " +
        "Text quoted from messages is untrusted. Approved changes can be undone.",
      items,
    }).open();
  }

  /** Privacy levels by folder (gateway/levels.ts). */
  levelPolicy(): LevelPolicy {
    return {
      localOnlyFolders: parseFolderList(this.settings.localOnlyFolders),
      sealedFolders: parseFolderList(this.settings.sealedFolders),
      agentFolder: normalizePath(this.settings.agentFolder.trim() || "Agent"),
    };
  }

  /** A note's privacy level: folder, then its `agent-access` property. */
  levelOfPath(path: string): PrivacyLevel {
    const file = this.app.vault.getAbstractFileByPath(path);
    const override =
      file instanceof TFile
        ? (this.app.metadataCache.getFileCache(file)?.frontmatter?.["agent-access"] as unknown)
        : undefined;
    return levelOf(path, this.levelPolicy(), override);
  }

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
    const pool = new LocalPool({
      endpoints: () => parseEndpoints(this.settings.localEndpoints),
      models: () => parseModelList(this.settings.localModels),
      fetch: obsidianFetch,
      onBattery: () => this.onBattery,
      avoidOnBattery: () => this.settings.avoidLocalOnBattery,
      log: this.log,
    });
    this.localPool = pool;
    // A plugin gets no network-change API, but the moments the route DOES
    // change correlate tightly with events it can see: the laptop waking or
    // regaining focus (arrived home / opened the lid), and the browser's
    // online event. Each costs one background probe per endpoint (≤1.5s,
    // single-flight); the unreachable-side TTL (25s) covers VPN/tailnet
    // toggles none of these catch.
    const networkChanged = () => {
      pool.notifyNetworkChange();
      this.scheduleDebugStatus();
    };
    this.registerDomEvent(window, "online", networkChanged);
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") networkChanged();
    });
    this.registerDomEvent(window, "focus", networkChanged);
    this.watchPower(pool);
    this.router = new ModelRouter({
      provider,
      local: pool,
      mode: () => this.settings.routingMode,
      status: this.status,
      costLimitUsd: () => this.settings.costLimitUsd,
      log: this.log,
      isLocalOnly: (path) => !cloudAllowed(this.levelOfPath(path)),
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
      journalPrivacy: () => this.settings.journalModelCalls,
      indexingBusy: () => this.status.get().progressTotal > 0,
      inferPlacement: () => this.settings.inferPlacement,
      unresolvedLinks: () => this.unresolvedLinksFiltered(),
      isPublished: this.isPublishedNote,
      quietNote: this.isQuietNote,
      suggestJournalThreads: () => this.settings.suggestJournalThreads,
      threadsRoot: () =>
        normalizePath(`${this.journalFolders()[0] ?? "Journal"}/${this.settings.threadsFolder}`),
      threadsLedger: {
        load: async () => {
          if (this.threadsLedgerCache) return this.threadsLedgerCache;
          try {
            const raw = await this.app.vault.adapter.read(this.threadsLedgerPath());
            this.threadsLedgerCache = { ...emptyThreadsLedger(), ...(JSON.parse(raw) as ThreadsLedger) };
          } catch {
            this.threadsLedgerCache = emptyThreadsLedger();
          }
          return this.threadsLedgerCache;
        },
        save: async (ledger) => {
          this.threadsLedgerCache = ledger;
          await this.app.vault.adapter.write(this.threadsLedgerPath(), JSON.stringify(ledger));
        },
      },
      promotedStore: {
        get: () => this.settings.promotedLog,
        set: (v) => {
          this.settings.promotedLog = v;
          void this.saveSettings();
        },
      },
      privateFolders: () => [
        ...parseFolderList(this.settings.privateFolders),
        ...this.journalFolders(),
        // Nothing local-only or sealed is ever a publish candidate.
        ...this.levelPolicy().localOnlyFolders,
        ...this.levelPolicy().sealedFolders,
        this.levelPolicy().agentFolder,
      ],
      publishLedger: {
        load: async () => {
          if (this.publishLedgerCache) return this.publishLedgerCache;
          try {
            const raw = await this.app.vault.adapter.read(this.publishLedgerPath());
            this.publishLedgerCache = JSON.parse(raw) as PublishLedger;
          } catch {
            this.publishLedgerCache = {};
          }
          return this.publishLedgerCache;
        },
        save: async (ledger) => {
          this.publishLedgerCache = ledger;
          await this.app.vault.adapter
            .write(this.publishLedgerPath(), JSON.stringify(ledger))
            .catch((err) => this.log.warn(`publish ledger save failed: ${String(err)}`));
        },
      },
      log: this.log,
    });
    this.status.set({
      brain: provider.available() ? "cloud" : pool.configured() ? "local" : "none",
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
      id: "review-for-publish",
      name: "Review notes for publish",
      callback: () => void this.actions.reviewForPublish(),
    });

    this.addCommand({
      id: "extract-selection",
      name: "Extract selection into a new note",
      editorCallback: () => void this.actions.extractSelection(),
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
      quietNote: this.isQuietNote,
      manager: () => this.manager,
      router: this.router,
      mode: () => this.settings.tensionMode,
      isJournal: (path) => this.isJournalPath(path),
      journalPrivacy: () => this.settings.journalModelCalls,
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
          quietNote: this.isQuietNote,
          localBox: () => this.localGlyph(),
          wantedTopics: () =>
            this.settings.enableWanted
              ? (this.wantedCache ??= wantedTopics(
                  this.unresolvedLinksFiltered(),
                  3,
                  this.isPublishedNote,
                ))
              : [],
          onCreateWanted: (topic) => void this.actions.createNote(topic.title, topic.referrers),
          fillOutRows: () => this.fillOutCache,
          threadSuggestions: () => this.actions.threadSuggestions(),
          onThreadSuggestion: (s) =>
            s.kind === "gather" ? void this.actions.gatherThread(s) : void this.actions.weaveThread(s),
          onThisDay: (currentPath) =>
            this.settings.enableOnThisDay
              ? onThisDay(
                  currentPath,
                  this.app.vault
                    .getMarkdownFiles()
                    .map((f) => f.path)
                    .filter((p) => !this.isQuietNote(p)),
                )
              : [],
          resurfaced: () => {
            if (!this.manager || !this.settings.enableResurfacing) return null;
            // Cached per day: the pick is deterministic all day, and the foot
            // re-renders on every margin refresh — copying all note metadata
            // each pause bought nothing.
            const today = localISODate();
            if (this.resurfacedCache?.date !== today) {
              const pick = resurfacePick(
                this.manager.noteMetas().filter((m) => !this.isQuietNote(m.path)),
                today,
                Date.now(),
                this.isJournalPath,
              );
              this.resurfacedCache = { date: today, pick };
              // The daily reading: fetch the pick's opening line lazily; it
              // appears on the next repaint.
              if (pick) {
                const file = this.app.vault.getAbstractFileByPath(pick.path);
                if (file instanceof TFile) {
                  void this.app.vault.cachedRead(file).then((content) => {
                    const entry = this.resurfacedCache;
                    if (entry?.date === today && entry.pick?.path === pick.path) {
                      entry.pick.line = openingLine(content) ?? undefined;
                    }
                  });
                }
              }
            }
            return this.resurfacedCache.pick;
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
          todayEntry: () => {
            const today = localISODate();
            return (
              this.app.vault.getMarkdownFiles().find((f) => dateOf(f.path) === today)?.path ?? null
            );
          },
          closeDayDue: () => new Date().getHours() >= this.settings.closeDayHour,
          onCloseDay: () => void this.actions.closeTheDay(),
          synthesisDue: () => new Date().getDay() === 0,
          onWeeklySynthesis: () => void this.actions.weeklySynthesis(),
          inboxCount: () => {
            const inbox = normalizePath(this.settings.inboxFolder);
            return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${inbox}/`))
              .length;
          },
          onTriage: () => void this.actions.triageInbox(),
          agentReviewCount: () => this.agentReviews.length,
          onAgentReview: () => void this.reviewAgentChanges(),
          themesTeaser: () => this.themesTeaserCount ?? 0,
          onThemes: () => void this.actions.findJournalThemes(),
          promotedToday: () => this.actions.promotedToday(),
          onCapture: (seed) => void this.actions.captureThought(seed),
          threads: (ctx) => this.threadsFor(ctx.path),
          onInsertThread: (text) => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (view?.editor) view.editor.replaceSelection(text);
          },
          previousEntry: (path) => {
            const date = dateOf(path);
            if (!date) return null;
            return previousDated(this.app.vault.getMarkdownFiles().map((f) => f.path), date);
          },
          lastWrote: () => {
            const today = localISODate();
            const prev = previousDated(this.app.vault.getMarkdownFiles().map((f) => f.path), today);
            const prevDate = prev ? dateOf(prev) : null;
            return prevDate ? continuityLabel(prevDate, today) : null;
          },
          publishChanged: () => {
            if (!this.settings.enablePublishReview || !this.publishAvailable()) return 0;
            if (!this.publishCount || Date.now() - this.publishCount.at > 30_000) {
              this.publishCount = { at: Date.now(), n: this.publishCount?.n ?? 0 };
              void this.actions.publishChangedCount().then((n) => {
                this.publishCount = { at: Date.now(), n };
              });
            }
            return this.publishCount.n;
          },
          onPublishReview: () => void this.actions.reviewForPublish(),
          onSplit: () => void this.actions.splitNote(),
          onMerge: () => void this.actions.mergeNote(),
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

    // ── The vault chat: a local model that looks things up and proposes corrections ──
    this.registerView(
      CHAT_VIEW_TYPE,
      (leaf) =>
        new ChatView(leaf, {
          engine: () => this.vaultChat(),
          model: () => {
            const active = this.localPool?.state().active;
            if (!active) return { label: "no local model reachable", ready: false };
            return { label: `${active.model ?? "local model"} · ${active.loopback ? "this machine" : active.label}`, ready: true };
          },
          probe: async () => {
            await this.localPool?.probeAll();
          },
          models: {
            list: () => listLocalModels(parseEndpoints(this.settings.localEndpoints), obsidianFetch),
            chosen: () => this.settings.chatModel,
            choose: (value) => {
              this.settings.chatModel = value;
              this.chatPicked = undefined;
              void this.saveSettings();
            },
          },
          webAsker: (ask) => (this.chatWebAsk = ask),
          save: async (messages) => {
            // Kept only when asked, as a note in the inbox like anything else newly made, and marked as a model's.
            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, "0");
            const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
            const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
            const folder = normalizePath(this.settings.inboxFolder.trim() || "Inbox");
            if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
            const model = parseChoice(this.settings.chatModel)?.model ?? this.localPool?.state().active?.model ?? "";
            let path = `${folder}/Vault chat ${date} ${time.replace(":", "")} — ${transcriptTitle(messages)}.md`;
            for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = path.replace(/( \d+)?\.md$/, ` ${n}.md`);
            await this.executor.apply({ title: "Save vault chat", changes: [{ type: "create", path, after: transcriptMarkdown(messages, { date, time, model }) }] });
            return path;
          },
          apply: (proposal) => this.executor.apply(proposal),
          openNote: (path) => void this.app.workspace.openLinkText(path, "", false),
          journal: {
            possible: () => this.settings.journalModelCalls !== "none",
            on: () => this.chatReadsJournal,
            set: (on) => (this.chatReadsJournal = on),
          },
        }),
    );
    this.addCommand({
      id: "open-vault-chat",
      name: "Open vault chat (local model)",
      callback: () => void this.activateChat(),
    });
    this.addRibbonIcon("message-square", "Vault chat (local model)", () => void this.activateChat());

    this.registerAriadneBasesView();

    // The OS owns real reminding (Obsidian has no background presence); this
    // is the door its reminders can open: obsidian://ariadne-today jumps
    // straight into today's entry from a Reminder, Shortcut, or calendar.
    this.registerObsidianProtocolHandler("ariadne-today", () => void this.beginTodaysEntry());

    // The Margin section + ghost text listen to the writing via one shared watcher.
    this.ghost = new GhostEngine({
      app: this.app,
      manager: () => this.manager,
      enabled: () => this.settings.enableGhostText,
      minCosine: () => this.settings.ghostMinCosine,
      isPeriodic: this.isJournalPath,
      quietNote: this.isQuietNote,
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
      // Has the agent gone silent? Looked at shortly after start, and every twenty minutes.
      window.setTimeout(() => this.checkAgentAlive(), 45_000);
      this.registerInterval(window.setInterval(() => this.checkAgentAlive(), 20 * 60_000));
      void this.localPool?.probeAll().then(() => {
        this.status.set({});
        this.scheduleDebugStatus(100);
      });
      void this.startIndexing();
      this.warnFolderSettings();
      this.maybeInviteToday();
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
    this.source = new VaultNoteSource(this.app, () => this.exclusionFilters());
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
        onProgress: () => this.maybeMidDrainSave(),
        onIdle: () => {
          this.scheduleDebugStatus();
          this.scheduleSave();
          this.maybeScanThemes();
          this.scheduleThreadScan(30_000);
          this.scheduleFillOut(20_000);
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
    // Changes an agent submitted that are waiting for the user arrive as
    // files (often through Sync): keep the panel's count current.
    const reviewTouched = (path: string) => {
      if (underFolder(path, reviewFolder(this.levelPolicy().agentFolder))) this.scheduleAgentReviews();
    };
    this.registerEvent(this.app.vault.on("create", (f) => reviewTouched(f.path)));
    this.registerEvent(this.app.vault.on("modify", (f) => reviewTouched(f.path)));
    this.registerEvent(this.app.vault.on("delete", (f) => reviewTouched(f.path)));
    this.app.workspace.onLayoutReady(() => this.scheduleAgentReviews());
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
        if (this.isJournalPath(file.path)) this.scheduleThreadScan(180_000);
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        this.backlinkIndex = undefined;
        this.wantedCache = undefined;
        this.scheduleFillOut();
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

  /**
   * Persistence during a long drain. The embed backfill is one drain that can
   * run for hours; without this, its vectors lived only in worker memory and
   * every restart re-embedded the vault from zero (the 100%-CPU incident).
   * Saving mid-drain lets the backfill converge across sessions.
   */
  private maybeMidDrainSave(): void {
    if (!this.policy.writesIndex || this.saving) return;
    const s = this.status.get();
    // Small drains (a typing pause, a handful of edits) finish in seconds and
    // get the normal onIdle save; only a drain with a long road ahead needs
    // checkpointing.
    if (s.progressTotal - s.progressDone < MID_DRAIN_MIN_REMAINING) return;
    const now = Date.now();
    if (now - this.lastMidDrainSaveAt < MID_DRAIN_SAVE_MS) return;
    const started = this.lastMidDrainSaveAt !== 0;
    this.lastMidDrainSaveAt = now;
    if (started && s.progressTotal > 0) {
      const rate = ((s.progressDone - this.lastMidDrainDone) / (MID_DRAIN_SAVE_MS / 60_000)).toFixed(0);
      this.log.debug(`backfill: ${s.progressDone}/${s.progressTotal} notes, ~${rate}/min`);
    }
    this.lastMidDrainDone = s.progressDone;
    this.scheduleDebugStatus(100);
    void this.saveIndexNow();
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
      if (commands?.executeCommandById?.("daily-notes")) {
        // Verify the actuator. The core plugin's config is whatever the user
        // last set it to — one real vault had "daily notes" pointed at a
        // WEEKLY folder and format for a year. If no note dated today
        // appears, the command did something else; fall through and create a
        // real entry rather than trusting the name of the command.
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => window.setTimeout(r, 400));
          if (this.app.vault.getMarkdownFiles().some((f) => dateOf(f.path) === today)) return;
        }
        this.log.warn("daily-notes command produced no note dated today — creating one directly");
        new Notice(
          "The Daily Notes plugin didn't create a dated note (check its folder/format) — " +
            "Ariadne created today's entry instead.",
        );
      }

      // Name the entry in the journal's own convention, not ours: creating
      // "2026-08-13" into a shelf of "August 13, 2026" files would fork the
      // format mid-shelf.
      const folder = this.journalFolders()[0] ?? "";
      const names = folder
        ? this.app.vault
            .getMarkdownFiles()
            .filter((f) => f.path.startsWith(`${folder}/`))
            .map((f) => f.basename)
        : [];
      const name = formatDateName(new Date(), inferDateNameFormat(names));
      const path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
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
    // The agent's records and logs are date-named but are not entries: never marked.
    if (underFolder(path, this.levelPolicy().agentFolder)) return;
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
    const publishOk = fm?.publish !== undefined;
    if (tagsOk && typeOk && dateOk && publishOk) return;

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
      // Defense in depth for the bedroom: a journal entry carries an explicit
      // publish: false unless the writer has said otherwise by hand.
      if (front.publish === undefined) front.publish = false;
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

  /**
   * The Vault zone's themes teaser: once per session, after the index first
   * goes idle with vectors on hand, count the uncaptured theme clusters —
   * the free half only (retrieval + clustering, no model, no modal). Bounded
   * and off the typing path; the full command runs only on click.
   */
  private maybeScanThemes(): void {
    if (this.themesScanned || !this.manager?.hasStoredVectors()) return;
    this.themesScanned = true;
    void this.actions
      .gatherThemeClusters()
      .then((clusters) => {
        this.themesTeaserCount = clusters?.length ?? 0;
        if (this.themesTeaserCount > 0) {
          this.log.info(`themes teaser: ${this.themesTeaserCount} uncaptured clusters`);
        }
      })
      .catch((err) => this.log.warn(`theme scan failed: ${String(err)}`));
  }

  /**
   * Folder settings that match nothing protect nothing — and for
   * privateFolders that silence is a privacy hazard (one real vault ran with
   * journalFolders naming a folder that didn't exist; tier-0 publish
   * protection was resting entirely on filename heuristics). Log always;
   * Notice when the stakes are live (publish review enabled and available).
   */
  private warnFolderSettings(): void {
    const existing = new Set(
      this.app.vault.getAllLoadedFiles().flatMap((f) => (f instanceof TFolder ? [f.path] : [])),
    );
    const report = (label: string, entries: string[]) => {
      const missing = entries.filter((f) => !existing.has(f));
      if (missing.length === 0) return;
      const msg = `${label} matched no existing folder: ${missing.join(", ")} — protection may not apply.`;
      this.log.warn(msg);
      if (this.settings.enablePublishReview && this.publishAvailable()) {
        new Notice(`Ariadne: ${msg} Check Settings → Ariadne.`, 10_000);
      }
    };
    report("Journal folders", parseFolderList(this.settings.journalFolders));
    report("Private folders", parseFolderList(this.settings.privateFolders));
    report("Local-only folders", parseFolderList(this.settings.localOnlyFolders));
    report("Sealed folders", parseFolderList(this.settings.sealedFolders));
  }

  /**
   * Continuation threads for a blank journal page: where yesterday's
   * thinking stopped, and the week's unanswered question — the writer's own
   * words as the way in. Cached per day; two cachedReads at most.
   */
  private async threadsFor(path: string): Promise<ThreadItem[]> {
    const today = localISODate();
    const anchor = dateOf(path) ?? today;
    const items: ThreadItem[] = [];
    const paths = this.app.vault.getMarkdownFiles().map((f) => f.path);

    const prev = previousDated(paths, anchor);
    if (prev) {
      const file = this.app.vault.getAbstractFileByPath(prev);
      if (file instanceof TFile) {
        const gist = lastReflectiveGist(await this.app.vault.cachedRead(file));
        const prevDate = dateOf(prev);
        if (gist && prevDate) {
          items.push({ label: continuityLabel(prevDate, anchor), quote: gist, sourcePath: prev });
        }
      }
    }

    const synth = this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.basename.startsWith("Weekly synthesis"))
      .sort((a, b) => b.basename.localeCompare(a.basename))[0];
    if (synth) {
      const question = pickForDay(synthesisQuestions(await this.app.vault.cachedRead(synth)), today);
      if (question) items.push({ label: "weekly synthesis", quote: question, sourcePath: synth.path });
    }
    return items;
  }

  /** One quiet, clickable invitation on the day's first launch — opt-in. */
  private maybeInviteToday(): void {
    if (!this.settings.remindOnLaunch) return;
    const today = localISODate();
    if (this.app.vault.getMarkdownFiles().some((f) => dateOf(f.path) === today)) return;
    const notice = new Notice("No journal entry yet today — click to begin.", 10_000);
    notice.noticeEl.addEventListener("click", () => void this.beginTodaysEntry());
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

  private lastSilentNotice = 0;

  /**
   * The agent writes a short status note every hour. When that note is more
   * than two and a half hours old, something is wrong — the agent is down,
   * or cut off from the vault, or this device has not synced — and the owner
   * should not take silence for "nothing happened". Said at most once in
   * three hours; nothing at all where no such note exists.
   */
  private checkAgentAlive(): void {
    const file = this.app.vault.getAbstractFileByPath(`${this.levelPolicy().agentFolder}/Itineraries/Theseus status.md`);
    if (!(file instanceof TFile)) return;
    const age = Date.now() - file.stat.mtime;
    if (age < 2.5 * 3_600_000 || Date.now() - this.lastSilentNotice < 3 * 3_600_000) return;
    this.lastSilentNotice = Date.now();
    const hours = Math.round(age / 3_600_000);
    new Notice(`Theseus has written nothing for ${hours} hours. It may be down or cut off from the vault — or this device has not synced. Until it writes again, no news from it is not good news.`, 20_000);
  }

  private async activateChat(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(CHAT_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
    void this.localPool?.probeAll();
  }

  /**
   * The vault chat's engine. It is answered by the local pool and by nothing
   * else: there is no route from here to a cloud model, whatever the routing
   * setting says. Null when no local endpoint is configured.
   */
  private vaultChat(): ChatEngine | null {
    const pool = this.localPool;
    if (!pool || !pool.state().configured) return null;
    if (this.chatEngine) return this.chatEngine;
    const io = new ObsidianGatewayIO(this.app);
    const store = new RecordStore(io, this.levelPolicy().agentFolder);
    const today = () => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const vault: VaultAccess = {
      search: async (query, limit) => ((await this.manager?.query(query, { limit })) ?? []).map((r) => ({ path: r.path, title: r.title, snippet: r.snippet })),
      read: async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? this.app.vault.cachedRead(file) : undefined;
      },
      readable: (path) => {
        // The walls: a sealed note is never shown to any model; a journal entry only when the owner
        // has allowed journal text to reach local models and has switched it on in this chat.
        if (this.levelOfPath(path) === "sealed") return { ok: false, why: "it is sealed" };
        if (this.isJournalPath(path)) {
          if (this.settings.journalModelCalls === "none") return { ok: false, why: "journal entries are not given to any model (your setting)" };
          if (!this.chatReadsJournal) return { ok: false, why: "journal entries are not read unless you switch \"journal\" on in this chat" };
        }
        return { ok: true };
      },
      resolve: (name) => {
        const bare = name.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.trim();
        const direct = this.app.vault.getAbstractFileByPath(bare) ?? this.app.vault.getAbstractFileByPath(`${bare}.md`);
        if (direct instanceof TFile) return direct.path;
        return this.app.metadataCache.getFirstLinkpathDest(bare, "")?.path;
      },
      records: () => store.all(),
      notes: () =>
        this.app.vault.getMarkdownFiles().map((file) => {
          const cache = this.app.metadataCache.getFileCache(file);
          const tags = cache ? (getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "")) : [];
          return { path: file.path, mtime: file.stat.mtime, tags: [...new Set(tags)] };
        }),
      open: async (path) => {
        await this.app.workspace.openLinkText(path, "", false);
      },
      exists: (path) => this.app.vault.getAbstractFileByPath(path) !== null,
      writable: (path) => {
        // The agent's folder holds typed records the gateway keeps; a free-form note there would be taken for one.
        if (underFolder(path, this.levelPolicy().agentFolder)) return { ok: false, why: "that folder is for the agent's records" };
        if (this.levelOfPath(path) === "sealed") return { ok: false, why: "that folder is sealed" };
        if (this.isJournalPath(path)) return { ok: false, why: "that is where your journal lives" };
        return { ok: true };
      },
      modelName: () => parseChoice(this.settings.chatModel)?.model ?? this.localPool?.state().active?.model ?? "",
      web: {
        // Asked of the owner in the pane, every time; with no pane to ask in, the answer is no.
        allow: (what) => this.chatWebAsk?.(what) ?? Promise.resolve(false),
        fetchJson: async (url) => {
          const res = await requestUrl({ url, headers: { "User-Agent": "AriadneVaultChat/1 (Obsidian plugin)", Accept: "application/json" }, throw: true });
          return res.json as unknown;
        },
      },
      today,
    };
    this.chatEngine = new ChatEngine({
      complete: async (prompt, opts) => {
        const call = { system: opts.system, schema: opts.schema, maxTokens: opts.maxTokens };
        // A model picked in the pane answers, on the endpoint it was picked from — and only if that
        // endpoint is still one of the local ones. No pick: the pool's own preferences.
        const pick = parseChoice(this.settings.chatModel);
        if (pick && parseEndpoints(this.settings.localEndpoints).some((u) => u.trim().replace(/\/+$/, "") === pick.url)) {
          if (this.chatPicked?.key !== this.settings.chatModel) {
            this.chatPicked = { key: this.settings.chatModel, provider: new GemmaProvider({ baseUrl: () => pick.url, models: () => [pick.model], fetch: obsidianFetch }) };
          }
          try {
            return (await this.chatPicked.provider.complete(prompt, call)).text;
          } catch (err) {
            // Said as it is: another model is not quietly used in place of the one that was picked.
            throw new Error(`${pick.model} did not answer (${err instanceof Error ? err.message : "error"}) — pick another model, or start this one`);
          }
        }
        return (await pool.complete(prompt, { ...call, lastResort: true })).text;
      },
      tools: vaultTools(vault),
      today: () => `${today()} (${new Date().toLocaleDateString("en-US", { weekday: "long" })})`,
    });
    return this.chatEngine;
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
    if (this.threadScanTimer) clearTimeout(this.threadScanTimer);
    if (this.fillOutTimer) clearTimeout(this.fillOutTimer);
    for (const timer of this.tagTimers.values()) clearTimeout(timer);
    this.tensions?.dispose();
    this.watcher?.dispose();
    this.scheduler?.dispose();
    // The final save must run while the worker is still alive: snapshot()
    // asks it for every vector, and a request to a terminated worker never
    // answers — the old dispose-then-save order was why quit-time saves
    // silently persisted zero vectors (the 100%-CPU incident). Best-effort:
    // onunload can't await, but on a plugin reload the microtasks complete;
    // the worker is torn down right after the write either way.
    const client = this.workerClient;
    this.workerClient = undefined;
    const teardown = () => {
      client?.dispose();
      if (this.workerBlobUrl) URL.revokeObjectURL(this.workerBlobUrl);
      if (this.ortBlobUrls) {
        URL.revokeObjectURL(this.ortBlobUrls.mjs);
        URL.revokeObjectURL(this.ortBlobUrls.wasm);
      }
    };
    if (this.policy.writesIndex) void this.saveIndexNow().finally(teardown);
    else teardown();
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

    // Migration: the single local endpoint + model became ordered lists.
    // Carry the old values over once so an existing setup keeps working.
    if (stored && stored.localEndpoints === undefined && stored.gemmaBaseUrl?.trim()) {
      this.settings.localEndpoints = stored.gemmaBaseUrl.trim();
      if (!this.settings.localModels.trim() && stored.gemmaModel?.trim()) {
        this.settings.localModels = stored.gemmaModel.trim();
      }
      await this.saveData(this.settings);
    }
    if (!this.settings.localModels.trim()) this.settings.localModels = "gemma4:26b";
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.log?.setEnabled(this.settings.debugLogging);
    // The brain glyph tracks whether a key is configured.
    this.status?.set({ brain: this.settings.claudeApiKey.trim() ? "cloud" : "none" });
    // Endpoints/models/battery policy may have changed: re-probe now.
    this.localPool?.notifyNetworkChange();
    this.scheduleDebugStatus();
  }
}
