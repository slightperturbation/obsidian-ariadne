import type { CompleteOptions, ModelUsage } from "./providers/claude";
import type { StatusStore } from "../core/status";
import type { Logger } from "../util/logger";

export type TaskKind = "connective" | "scaffold" | "relation";

/** What the router needs from any reasoning backend (Claude now, Gemma in Phase 6). */
export interface ReasoningProvider {
  available(): boolean;
  complete(prompt: string, opts?: CompleteOptions): Promise<{ text: string; usage: ModelUsage }>;
}

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
      status: StatusStore;
      costLimitUsd: () => number;
      log: Logger;
    },
  ) {}

  available(): boolean {
    return this.deps.provider.available();
  }

  get sessionCost(): number {
    return this.sessionCostUsd;
  }

  async run(task: TaskKind, prompt: string, opts: CompleteOptions = {}): Promise<string> {
    if (!this.available()) throw new Error("no reasoning model configured");
    const limit = this.deps.costLimitUsd();
    if (limit > 0 && this.sessionCostUsd >= limit) throw new BudgetExceededError(limit);

    // Serialize: one reasoning call at a time (simple, honest rate limiting).
    const work = this.queue.then(async () => {
      const started = Date.now();
      const { text, usage } = await this.deps.provider.complete(prompt, opts);
      this.sessionCostUsd += usage.costUsd;
      this.deps.status.set({ brain: "cloud", sessionCostUsd: this.sessionCostUsd });
      this.deps.log.info(
        `${task}: ${usage.inputTokens}→${usage.outputTokens} tok, ` +
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
