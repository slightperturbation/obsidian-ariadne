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
  localEndpoint: string;

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
  localEndpoint: "http://localhost:1234/v1",

  showStatusGlyph: true,

  enableMargin: true,
  enableGhostText: true,
  // bge cosine similarities are compressed upward; 0.7 ≈ "clearly about the
  // same idea". Lower = chattier, higher = only near-certain suggestions.
  ghostMinCosine: 0.7,

  debugLogging: false,
};
