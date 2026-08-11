import type { CompleteOptions, ModelUsage } from "./providers/claude";
import type { StatusStore } from "../core/status";
import type { Logger } from "../util/logger";

export type TaskKind = "connective" | "scaffold" | "relation" | "theme";

/** What the router needs from any reasoning backend. */
export interface ReasoningProvider {
  available(): boolean;
  complete(prompt: string, opts?: CompleteOptions): Promise<{ text: string; usage: ModelUsage }>;
}

/** User override for where reasoning runs. */
export type RoutingMode = "auto" | "cloud" | "local";

/**
 * Which tasks may route to the local box under "auto". The line is quality:
 * connective phrasing and relation classification are one-shot fragments a
 * small local model does fine; scaffolds, splits, and MoCs shape the vault's
 * structure and stay on the API (PRD §4.6: cheap/simple → local,
 * quality-sensitive → cloud).
 */
const LOCAL_OK: ReadonlySet<TaskKind> = new Set(["connective", "relation", "theme"]);

export class BudgetExceededError extends Error {
  constructor(limit: number) {
    super(`session cost limit ($${limit.toFixed(2)}) reached — raise it in settings to continue`);
    this.name = "BudgetExceededError";
  }
}

/**
 * Model router v1: one provider (Claude API), serialized calls, and honest
 * accounting. Every call adds its cost to the session total, surfaces it in
 * the status glyph, and a hard budget stops calls before they start once the
 * user's limit is hit. Reasoning calls run async — nothing here can sit in
 * the typing path. Most are initiated by an explicit user gesture; the one
 * exception is ambient tension/echo classification, which carries its own
 * per-session call cap and caching on top of the shared budget (see
 * margin/tension/engine.ts). Phase 6 adds the local-Gemma provider and
 * per-task routing behind the same interface.
 */
export class ModelRouter {
  private sessionCostUsd = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private deps: {
      provider: ReasoningProvider;
      /** The opportunistic home-network route; absent = cloud only. */
      local?: ReasoningProvider;
      mode?: () => RoutingMode;
      status: StatusStore;
      costLimitUsd: () => number;
      log: Logger;
    },
  ) {}

  available(): boolean {
    return this.deps.provider.available() || (this.deps.local?.available() ?? false);
  }

  /**
   * Pick the route for a task. "local" mode widens the local set to every
   * task but still requires the box to be awake; nothing ever *waits* for
   * the box. Cloud-only and unavailable-local both land on Claude.
   */
  private route(task: TaskKind): { provider: ReasoningProvider; brain: "cloud" | "local" } {
    const mode = this.deps.mode?.() ?? "auto";
    const local = this.deps.local;
    const localOk =
      mode !== "cloud" && !!local?.available() && (mode === "local" || LOCAL_OK.has(task));
    if (localOk) return { provider: local!, brain: "local" };
    return { provider: this.deps.provider, brain: "cloud" };
  }

  get sessionCost(): number {
    return this.sessionCostUsd;
  }

  async run(task: TaskKind, prompt: string, opts: CompleteOptions = {}): Promise<string> {
    if (!this.available()) throw new Error("no reasoning model configured");
    const chosen = this.route(task);
    // The budget gates cloud spend; a local call is free and may proceed
    // even past the cap — that's the point of having the box.
    if (chosen.brain === "cloud") {
      const limit = this.deps.costLimitUsd();
      if (limit > 0 && this.sessionCostUsd >= limit) throw new BudgetExceededError(limit);
    }

    // Serialize: one reasoning call at a time (simple, honest rate limiting).
    const work = this.queue.then(async () => {
      const started = Date.now();
      const { provider } = chosen;
      let brain = chosen.brain;
      let text: string;
      let usage: ModelUsage;
      try {
        ({ text, usage } = await provider.complete(prompt, opts));
      } catch (err) {
        // Opportunistic means the box's failures are the router's problem,
        // not the feature's: fall through to the cloud transparently. Cloud
        // failures still propagate — there is nothing behind them.
        if (brain !== "local" || !this.deps.provider.available()) throw err;
        this.deps.log.warn(`local model failed (${String(err)}); retrying on cloud`);
        const limit = this.deps.costLimitUsd();
        if (limit > 0 && this.sessionCostUsd >= limit) throw new BudgetExceededError(limit);
        brain = "cloud";
        ({ text, usage } = await this.deps.provider.complete(prompt, opts));
      }
      this.sessionCostUsd += usage.costUsd;
      this.deps.status.set({ brain, sessionCostUsd: this.sessionCostUsd });
      this.deps.log.info(
        `${task} via ${brain}: ${usage.inputTokens}→${usage.outputTokens} tok, ` +
          `$${usage.costUsd.toFixed(4)}, ${Date.now() - started}ms ` +
          `(session $${this.sessionCostUsd.toFixed(4)})`,
      );
      return text;
    });
    // Keep the chain alive even when a call fails.
    this.queue = work.catch(() => {});
    return work;
  }
}
