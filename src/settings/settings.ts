/** How the expensive "reasoning" tasks (MoC synthesis, splits, scaffolding) are routed. */
export type BrainPreference = "cloud-first" | "local-first" | "smart";

export interface AriadneSettings {
  // Indexing
  enableSemantic: boolean;
  indexOnStartup: boolean;
  embeddingModel: string;
  indexDir: string;

  // Models
  brain: BrainPreference;
  claudeApiKey: string;
  claudeModel: string;
  /** Hard per-session spend cap for reasoning calls (USD); 0 disables the cap. */
  costLimitUsd: number;
  localEndpoint: string;

  // Filing
  attachmentsFolder: string;

  // UI
  showStatusGlyph: boolean;

  // Margin
  enableMargin: boolean;
  enableGhostText: boolean;
  /** Minimum semantic closeness (raw cosine 0..1) before a ghost link is offered. */
  ghostMinCosine: number;

  // Advanced
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: AriadneSettings = {
  enableSemantic: true,
  indexOnStartup: true,
  embeddingModel: "bge-small-en-v1.5",
  // The one location Obsidian Sync carries across devices; keeps the shared index in step with the PRD.
  indexDir: ".obsidian/plugins/ariadne/index",

  brain: "cloud-first",
  claudeApiKey: "",
  // Haiku is the cheapest current model ($1/$5 per MTok) and ample for the
  // small structured tasks here (connective phrasing, note scaffolding).
  // Bump to a larger model in settings if scaffold quality warrants it.
  claudeModel: "claude-haiku-4-5",
  costLimitUsd: 2,
  localEndpoint: "http://localhost:1234/v1",

  attachmentsFolder: "Supporting Files",

  showStatusGlyph: true,

  enableMargin: true,
  enableGhostText: true,
  // bge cosine similarities are compressed upward; 0.7 ≈ "clearly about the
  // same idea". Lower = chattier, higher = only near-certain suggestions.
  ghostMinCosine: 0.7,

  debugLogging: false,
};
