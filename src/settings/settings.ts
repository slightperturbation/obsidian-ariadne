export interface AriadneSettings {
  // Indexing
  enableSemantic: boolean;
  indexOnStartup: boolean;
  embeddingModel: string;

  // Models
  claudeApiKey: string;
  claudeModel: string;
  /** Hard per-session spend cap for reasoning calls (USD); 0 disables the cap. */
  costLimitUsd: number;

  // Filing
  attachmentsFolder: string;


  // Margin
  enableMargin: boolean;
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
  indexOnStartup: true,
  embeddingModel: "bge-small-en-v1.5",

  claudeApiKey: "",
  // Haiku is the cheapest current model ($1/$5 per MTok) and ample for the
  // small structured tasks here (connective phrasing, note scaffolding).
  // Bump to a larger model in settings if scaffold quality warrants it.
  claudeModel: "claude-haiku-4-5",
  costLimitUsd: 2,

  attachmentsFolder: "Supporting Files",


  enableMargin: true,
  enableGhostText: true,
  // Raw cosine against bge-small: unrelated text sits ~0.3–0.5, genuinely
  // related ~0.7+, near-identical ~0.9+. 0.82 offers a link only when the
  // model is clearly about the same idea. Lower = chattier.
  ghostMinCosine: 0.82,

  debugLogging: false,
};
