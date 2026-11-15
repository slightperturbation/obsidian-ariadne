import type { CompleteOptions, ModelUsage } from "./claude";
import { GemmaProvider, type EndpointInfo } from "./gemma";

/**
 * The local brain as a POOL of endpoints rather than one box.
 *
 * The setup this is built for: a laptop that can run a ~30B model itself,
 * plus a home machine reachable over a tailnet from anywhere. Neither is
 * always the right answer — the laptop's model costs battery, the home box
 * needs a network — so the pool orders them per call:
 *
 *   plugged in   →  endpoints in the configured order (laptop first: no
 *                   network hop, 0.2s warm vs 0.7s)
 *   on battery   →  remote endpoints first; this machine's own model only
 *                   as a LAST RESORT, and only for calls that say they
 *                   accept one (user-initiated, with no cloud alternative)
 *
 * "This machine" is detected, not configured: a loopback URL is the device
 * whose battery we'd be spending. Each endpoint resolves which of the
 * preferred models it actually has, so the same wish-list works on machines
 * that name the same weights differently.
 *
 * Failover is per call: if the chosen endpoint fails mid-flight, the next
 * candidate gets the same request before the router ever hears about it.
 */

export interface LocalCallOptions {
  /**
   * May this call fall back to the battery-powered machine's own model when
   * nothing better can serve it? False for ambient/deferrable work — that is
   * what "avoid the laptop's model on battery, if possible" means.
   */
  lastResort?: boolean;
}

export interface PoolState {
  configured: boolean;
  /** On battery with avoidance enabled — the ordering above is in effect. */
  savingBattery: boolean;
  endpoints: EndpointInfo[];
  /** The endpoint that would serve a user-initiated call right now. */
  active: (EndpointInfo & { lastResort: boolean }) | null;
}

export class LocalPool {
  private byUrl = new Map<string, GemmaProvider>();
  private lastPreferred?: string;

  constructor(
    private deps: {
      /** Base URLs in preference order, e.g. ["http://localhost:11434/v1", …]. */
      endpoints: () => string[];
      /** Model preferences in order; each endpoint serves the first it has. */
      models: () => string[];
      fetch: typeof fetch;
      onBattery: () => boolean;
      avoidOnBattery: () => boolean;
      log?: { debug(msg: string): void };
    },
  ) {}

  /** Endpoint objects for the current setting, created/dropped as it changes. */
  private endpoints(): GemmaProvider[] {
    const urls = this.deps.endpoints();
    for (const url of urls) {
      if (!this.byUrl.has(url)) {
        this.byUrl.set(
          url,
          new GemmaProvider({
            baseUrl: () => url,
            models: () => this.deps.models(),
            fetch: this.deps.fetch,
          }),
        );
      }
    }
    for (const url of [...this.byUrl.keys()]) {
      if (!urls.includes(url)) this.byUrl.delete(url);
    }
    return urls.map((url) => this.byUrl.get(url)!);
  }

  private savingBattery(): boolean {
    return this.deps.onBattery() && this.deps.avoidOnBattery();
  }

  /** Candidates for one call, in the order they should be tried. */
  private candidates(lastResort: boolean): GemmaProvider[] {
    const all = this.endpoints();
    if (!this.savingBattery()) return all;
    const remote = all.filter((e) => !e.info().loopback);
    return lastResort ? [...remote, ...all.filter((e) => e.info().loopback)] : remote;
  }

  configured(): boolean {
    return this.deps.endpoints().length > 0;
  }

  /**
   * Can a local endpoint serve a call right now? Synchronous (cached probes);
   * asking keeps every candidate's cache refreshing in the background, so a
   * failover target is never discovered cold.
   */
  available(opts: LocalCallOptions = {}): boolean {
    const candidates = this.candidates(opts.lastResort ?? true);
    const flags = candidates.map((e) => e.available());
    this.noticePreferred();
    return flags.some(Boolean);
  }

  /**
   * When the endpoint that would serve the next call CHANGES to a remote
   * one (unplugged the laptop; its own server stopped), warm that box now —
   * its cold load is the slow one.
   */
  private noticePreferred(): void {
    const preferred = this.candidates(false).find((e) => e.state() === "awake");
    const url = preferred?.info().url;
    if (url === this.lastPreferred) return;
    this.lastPreferred = url;
    if (preferred && !preferred.info().loopback) {
      this.deps.log?.debug(`local pool: ${preferred.info().label} is now preferred — warming`);
      preferred.warm();
    }
  }

  async complete(
    prompt: string,
    opts: CompleteOptions & LocalCallOptions = {},
  ): Promise<{ text: string; usage: ModelUsage }> {
    const { lastResort = true, ...completeOpts } = opts;
    let lastErr: unknown;
    for (const endpoint of this.candidates(lastResort)) {
      // Skip only what was RECENTLY seen down; anything else gets an attempt
      // (its own pre-flight probe bounds the cost at ~1.5s).
      if (!endpoint.available() && endpoint.fresh()) continue;
      try {
        return await endpoint.complete(prompt, completeOpts);
      } catch (err) {
        lastErr = err;
        this.deps.log?.debug(`local pool: ${endpoint.info().label} failed (${String(err)})`);
      }
    }
    throw lastErr ?? new Error("no local model endpoint is reachable");
  }

  state(): PoolState {
    const endpoints = this.endpoints().map((e) => e.info());
    const normal = this.candidates(false).find((e) => e.state() === "awake");
    const any = normal ?? this.candidates(true).find((e) => e.state() === "awake");
    return {
      configured: endpoints.length > 0,
      savingBattery: this.savingBattery(),
      endpoints,
      active: any ? { ...any.info(), lastResort: !normal } : null,
    };
  }

  /** Network likely changed: re-probe everything in the background. */
  notifyNetworkChange(): void {
    for (const endpoint of this.endpoints()) endpoint.notifyNetworkChange();
  }

  /** Plugged/unplugged: the candidate order just changed. */
  notifyPowerChange(): void {
    this.notifyNetworkChange();
    this.noticePreferred();
  }

  /** Await fresh probes of every endpoint (startup, diagnostics, tests). */
  async probeAll(): Promise<void> {
    await Promise.all(this.endpoints().map((e) => e.probe()));
    this.noticePreferred();
  }
}
