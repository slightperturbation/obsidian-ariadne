import type { DeviceRoleSetting } from "../core/device";
import type { TensionMode } from "../margin/tension/detect";
import type { JournalPrivacy, RoutingMode } from "../model/router";

export interface AriadneSettings {
  // Indexing
  enableSemantic: boolean;
  /**
   * Whether this device owns the index (runs the model, writes the shards) or
   * consumes the owner's index over Sync. "auto" = desktop owns, mobile reads.
   */
  deviceRole: DeviceRoleSetting;
  indexOnStartup: boolean;
  embeddingModel: string;

  // Models
  claudeApiKey: string;
  /**
   * OpenAI-compatible local server (Ollama/LM Studio/llama.cpp) on the home
   * network, e.g. "http://gemma.local:11434/v1". Empty = no local route.
   * Opportunistic: used when awake, never waited for, never required.
   */
  gemmaBaseUrl: string;
  gemmaModel: string;
  /** auto = cheap tasks local when reachable; cloud/local = user override. */
  routingMode: RoutingMode;
  claudeModel: string;
  /** Hard per-session spend cap for reasoning calls (USD); 0 disables the cap. */
  costLimitUsd: number;

  // Filing
  attachmentsFolder: string;
  /** Lifecycle folders (PRD §4.5): capture lands in Inbox; inert notes rest in Archive. */
  inboxFolder: string;
  archiveFolder: string;


  // Journaling
  /**
   * Folders whose notes are journal entries even without dated names, on top
   * of two automatic signals: dated-name detection (2026-07-25, "June 28,
   * 2026", weeklies…) and the Daily Notes core plugin's folder.
   */
  journalFolders: string;
  /** Offer "promote this thought" while writing reflective prose in a journal note. */
  enablePromoteHint: boolean;
  /** Past entries sharing today's month-day, shown in a dated note's Margin. */
  enableOnThisDay: boolean;
  /** One old, barely-linked note per day at the panel foot ("Still true?"). */
  enableResurfacing: boolean;
  /** The Wanted section (dangling topics ranked by demand) at the panel foot. */
  enableWanted: boolean;
  /** Invite today's journal entry at the panel foot when none exists yet. */
  enableTodayHint: boolean;
  /**
   * Auto-tag dated/journal entries with `<kind>/<ISO date>` in frontmatter
   * (e.g. journal/2026-08-12) — daily = log-shaped, journal = narrative.
   * Ariadne manages ONLY its own dated tags and never touches others.
   */
  autoTagEntries: boolean;
  dailyTag: string;
  journalTag: string;
  /** Offer tags from semantically-near notes in the Margin (never invented). */
  enableTagSuggestions: boolean;
  /** Local hour (0–23) after which the panel offers "close the day". */
  closeDayHour: number;
  /**
   * Which brain may read journal content (tension checks, theme naming,
   * weekly synthesis). "cloud" is most capable; "local" walls journal text
   * to the home box; "none" makes no model calls on journal content.
   */
  journalModelCalls: JournalPrivacy;
  /** One quiet Notice on the day's first launch when no entry exists. */
  remindOnLaunch: boolean;
  /** Internal: persisted promoted-today tally. */
  promotedLog?: { date: string; count: number };

  // Publishing
  /** The departure lounge: screen notes before Obsidian Publish uploads. */
  enablePublishReview: boolean;
  /** Derive new-note placement from referrers + semantic neighbors.
   * Off = every Ariadne-created note goes to the inbox folder. */
  inferPlacement: boolean;
  /** Folders Ariadne ignores entirely (indexing, retrieval, suggestions).
   * Comma-separated; Obsidian's "Excluded files" setting is honored too. */
  excludedFolders: string;
  /** Frontmatter types kept out of ambient surfaces (Related, ghost,
   * tension, resurfacing, themes/threads). Search still finds them. */
  quietTypes: string;
  /** Notes marked authorship: ai-generated stay out of ambient surfaces. */
  quietAiGenerated: boolean;
  /** Suggest recurring journal threads and thread-page weaves. */
  suggestJournalThreads: boolean;
  /** Subfolder of the journal where thread pages live. */
  threadsFolder: string;
  /**
   * Folders that are categorically private (never publish candidates), on
   * top of journal detection. Comma-separated.
   */
  privateFolders: string;

  // Margin
  enableMargin: boolean;
  /**
   * Tension/echo surfacing: contradiction and "you've said this before"
   * cards. quiet interrupts only when nearly certain; eager casts wider.
   * Classification calls are ambient (no user gesture), so they are cached,
   * per-session capped, and stop entirely at the cost limit.
   */
  tensionMode: TensionMode;
  /**
   * Serendipity: how boldly each surface presents its results (0..1, 0.5 =
   * neutral). Shapes prominence only — never hides a result.
   */
  lineSerendipity: number;
  marginSerendipity: number;
  enableGhostText: boolean;
  /** Minimum semantic closeness (raw cosine 0..1) before a ghost link is offered. */
  ghostMinCosine: number;

  // Advanced
  debugLogging: boolean;

  /** Internal: marks which cosine scale ghostMinCosine is stored on. */
  cosineScale?: number;
}

export const DEFAULT_SETTINGS: AriadneSettings = {
  enableSemantic: true,
  deviceRole: "auto",
  indexOnStartup: true,
  embeddingModel: "bge-small-en-v1.5",

  claudeApiKey: "",
  // Haiku is the cheapest current model ($1/$5 per MTok) and ample for the
  // small structured tasks here (connective phrasing, note scaffolding).
  // Bump to a larger model in settings if scaffold quality warrants it.
  claudeModel: "claude-haiku-4-5",
  gemmaBaseUrl: "",
  gemmaModel: "gemma4:26b",
  routingMode: "auto",
  costLimitUsd: 2,

  attachmentsFolder: "Supporting Files",
  inboxFolder: "Inbox",
  archiveFolder: "Archive",


  journalFolders: "Journal",
  enablePromoteHint: true,
  enableOnThisDay: true,
  enableResurfacing: true,
  enableWanted: true,
  enableTodayHint: true,
  autoTagEntries: true,
  dailyTag: "daily",
  journalTag: "journal",
  enableTagSuggestions: true,
  closeDayHour: 18,
  journalModelCalls: "cloud",
  remindOnLaunch: false,

  enablePublishReview: true,
  inferPlacement: true,
  excludedFolders: "",
  quietTypes: "correspondence-moment, project-artifact",
  quietAiGenerated: true,
  suggestJournalThreads: true,
  threadsFolder: "Threads",
  privateFolders: "Journal, Inbox, Archive",

  enableMargin: true,
  tensionMode: "quiet",
  lineSerendipity: 0.5,
  marginSerendipity: 0.5,
  enableGhostText: true,
  // Raw cosine against bge-small: unrelated text sits ~0.3–0.5, genuinely
  // related ~0.7+, near-identical ~0.9+. 0.82 offers a link only when the
  // model is clearly about the same idea. Lower = chattier.
  ghostMinCosine: 0.82,

  debugLogging: false,
};
