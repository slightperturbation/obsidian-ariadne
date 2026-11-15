import type { CompleteOptions, ModelUsage } from "./providers/claude";
import type { StatusStore } from "../core/status";
import type { Logger } from "../util/logger";

export type TaskKind = "connective" | "scaffold" | "relation" | "theme";

/**
 * `lastResort`: may the call use the battery-powered machine's own model
 * when nothing better is available? Only the local pool gives it meaning.
 */
export interface LocalCallOptions {
  lastResort?: boolean;
}

/** What the router needs from any reasoning backend. */
export interface ReasoningProvider {
  available(opts?: LocalCallOptions): boolean;
  complete(
    prompt: string,
    opts?: CompleteOptions & LocalCallOptions,
  ): Promise<{ text: string; usage: ModelUsage }>;
}

/** User override for where reasoning runs. */
export type RoutingMode = "auto" | "cloud" | "local";

/** Where journal content may be sent. "none" is enforced by callers. */
export type JournalPrivacy = "cloud" | "local" | "none";

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
    return (
      this.deps.provider.available() || (this.deps.local?.available({ lastResort: true }) ?? false)
    );
  }

  /**
   * On battery, this machine's own model is a last resort: acceptable only
   * for a call the user is waiting on that has no cloud alternative — the
   * content is walled to local, the user chose local-only routing, or there
   * is no cloud brain at all. Ambient work never qualifies: it can wait for
   * a charger or the home box.
   */
  private acceptsLastResort(privacy: "cloud" | "local" | undefined, background: boolean): boolean {
    if (background) return false;
    const mode = this.deps.mode?.() ?? "auto";
    return privacy === "local" || mode === "local" || !this.deps.provider.available();
  }

  /**
   * Pick the route for a task. "local" mode widens the local set to every
   * task but still requires a local endpoint to be awake; nothing ever
   * *waits* for one. Cloud-only and unavailable-local both land on Claude.
   */
  private route(
    task: TaskKind,
    privacy: "cloud" | "local" | undefined,
    background: boolean,
  ): { provider: ReasoningProvider; brain: "cloud" | "local" } {
    const lastResort = this.acceptsLastResort(privacy, background);
    // Privacy "local" is a wall, not a preference: journal content must not
    // reach the cloud even when the box is asleep — the call fails instead.
    if (privacy === "local") {
      if (this.deps.local?.available({ lastResort })) {
        return { provider: this.deps.local, brain: "local" };
      }
      throw new Error("journal privacy is local-only and the local model is unreachable");
    }
    const mode = this.deps.mode?.() ?? "auto";
    const local = this.deps.local;
    const localOk =
      mode !== "cloud" &&
      !!local?.available({ lastResort }) &&
      (mode === "local" || LOCAL_OK.has(task));
    if (localOk) return { provider: local!, brain: "local" };
    return { provider: this.deps.provider, brain: "cloud" };
  }

  /**
   * Is the local route usable right now? (For privacy-gated callers.)
   * Ambient callers pass `background: true` so that, on battery, they don't
   * count the laptop's own model as available.
   */
  localAvailable(opts: { background?: boolean } = {}): boolean {
    return this.deps.local?.available({ lastResort: !opts.background }) ?? false;
  }

  get sessionCost(): number {
    return this.sessionCostUsd;
  }

  async run(
    task: TaskKind,
    prompt: string,
    opts: CompleteOptions & {
      privacy?: "cloud" | "local";
      /** Ambient/deferrable work (nobody is waiting on it). */
      background?: boolean;
    } = {},
  ): Promise<string> {
    if (!this.available()) throw new Error("no reasoning model configured");
    const { privacy, background = false, ...completeOpts } = opts;
    const chosen = this.route(task, privacy, background);
    const lastResort = this.acceptsLastResort(privacy, background);
    // The budget gates cloud spend; a local call is free and may proceed
    // even past the cap — that's the point of having the box.
    if (chosen.brain === "cloud") {
      const limit = this.deps.costLimitUsd();
      if (limit > 0 && this.sessionCostUsd >= limit) {
        this.deps.status.set({ capped: true });
        throw new BudgetExceededError(limit);
      }
    }

    // Serialize: one reasoning call at a time (simple, honest rate limiting).
    const work = this.queue.then(async () => {
      const started = Date.now();
      const { provider } = chosen;
      let brain = chosen.brain;
      let text: string;
      let usage: ModelUsage;
      try {
        ({ text, usage } = await provider.complete(prompt, { ...completeOpts, lastResort }));
      } catch (err) {
        if (brain === "local") {
          // Opportunistic means the local side's failures are the router's
          // problem, not the feature's: fall through to the cloud
          // transparently. A privacy-walled call NEVER retries on the
          // cloud: for journal content, failing is the correct fallback.
          if (privacy === "local" || !this.deps.provider.available()) throw err;
          this.deps.log.warn(`local model failed (${String(err)}); retrying on cloud`);
          const limit = this.deps.costLimitUsd();
          if (limit > 0 && this.sessionCostUsd >= limit) throw new BudgetExceededError(limit);
          brain = "cloud";
          ({ text, usage } = await this.deps.provider.complete(prompt, completeOpts));
        } else {
          // The mirror image: the cloud failed (offline, API down) and a
          // local model is right here. Unless the user asked for cloud-only,
          // answer locally rather than not at all — this is what makes
          // "automatic" routing keep working on a plane. A user-initiated
          // call may spend battery for it; ambient work may not.
          const mode = this.deps.mode?.() ?? "auto";
          const local = this.deps.local;
          const fallbackOk = { lastResort: !background };
          if (mode === "cloud" || !local?.available(fallbackOk)) throw err;
          this.deps.log.warn(`cloud model failed (${String(err)}); answering locally`);
          brain = "local";
          ({ text, usage } = await local.complete(prompt, { ...completeOpts, ...fallbackOk }));
        }
      }
      this.sessionCostUsd += usage.costUsd;
      const limit = this.deps.costLimitUsd();
      this.deps.status.set({
        brain,
        sessionCostUsd: this.sessionCostUsd,
        capped: limit > 0 && this.sessionCostUsd >= limit,
      });
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
