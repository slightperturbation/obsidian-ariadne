export type BrainKind = "none" | "local" | "cloud";
export type IndexState = "idle" | "indexing" | "error";
/**
 * off = disabled; loading = model download/init; on = real model;
 * fallback = hash embedder; synced = reading another device's vectors with no
 * local model (a consumer device — see core/platform.ts).
 */
export type SemanticState = "off" | "loading" | "on" | "fallback" | "synced";

export interface AriadneStatus {
  index: IndexState;
  brain: BrainKind;
  semantic: SemanticState;
  /** Notes currently in the index (the whole-index size, not progress). */
  indexedNotes: number;
  /** Progress through the current indexing burst; both 0 when idle. */
  progressDone: number;
  progressTotal: number;
  /** Cumulative reasoning-model spend this session (USD). */
  sessionCostUsd: number;
  /** The session cost cap has been reached — cloud calls are refused. */
  capped: boolean;
  /** Whether this device writes the index or reads a synced one. */
  role: "owner" | "consumer";
  /**
   * Notes changed since the owner last wrote the index. A consumer can search
   * these lexically but has no vectors for them until the owner catches up, so
   * the glyph says so rather than quietly returning worse results.
   */
  staleNotes: number;
  lastError?: string;
}

type Listener = (s: AriadneStatus) => void;

/**
 * A tiny observable store for the status glyph. Any subsystem (indexer, model
 * router) pushes partial updates; the UI subscribes and renders. Kept free of
 * Obsidian imports so it is trivially unit-testable.
 */
export class StatusStore {
  private state: AriadneStatus = {
    index: "idle",
    brain: "none",
    semantic: "off",
    indexedNotes: 0,
    progressDone: 0,
    progressTotal: 0,
    sessionCostUsd: 0,
    capped: false,
    role: "owner",
    staleNotes: 0,
  };
  private listeners = new Set<Listener>();

  get(): AriadneStatus {
    return { ...this.state };
  }

  set(patch: Partial<AriadneStatus>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.get());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
  }
}
