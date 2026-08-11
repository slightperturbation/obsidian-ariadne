import type { DeviceRoleSetting } from "../core/device";
import type { TensionMode } from "../margin/tension/detect";

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
  claudeModel: string;
  /** Hard per-session spend cap for reasoning calls (USD); 0 disables the cap. */
  costLimitUsd: number;

  // Filing
  attachmentsFolder: string;


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
  costLimitUsd: 2,

  attachmentsFolder: "Supporting Files",


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
