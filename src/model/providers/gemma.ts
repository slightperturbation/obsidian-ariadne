import type { CompleteOptions, ModelUsage } from "./claude";

/**
 * Local Gemma-class provider over any OpenAI-compatible server (Ollama,
 * LM Studio, llama.cpp, vLLM — they all speak /v1/chat/completions).
 *
 * The contract, from the PRD: this route is a home-network-only *bonus*,
 * used opportunistically and never depended on. The box is only reachable on
 * the home network and may be asleep, so availability is a cached probe with
 * a short timeout, re-checked on an interval — a failed probe must cost
 * ~a second once, not a hang per call. Every task must work fully without
 * this provider; the router treats any failure here as "route to Claude",
 * not as an error the user sees.
 */

/** Probe result is trusted for this long before re-checking. */
const PROBE_TTL_MS = 5 * 60_000;
/** A LAN box answers in tens of ms; a second means asleep or absent. */
const PROBE_TIMEOUT_MS = 1_500;
/** Local generation is slow but must not be unbounded. */
const COMPLETE_TIMEOUT_MS = 60_000;

export class GemmaProvider {
  private lastProbe = 0;
  private reachable = false;
  private probing?: Promise<boolean>;

  constructor(
    private deps: {
      /** e.g. "http://gemma.local:11434/v1" — empty disables the provider. */
      baseUrl: () => string;
      /** Model name as the server knows it, e.g. "gemma3:27b". */
      model: () => string;
      fetch?: typeof fetch;
    },
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.deps.fetch ?? fetch;
  }

  /** Configured at all? (Cheap, synchronous — the router's first gate.) */
  configured(): boolean {
    return this.deps.baseUrl().trim().length > 0;
  }

  /**
   * Reachable right now, per the cached probe. Synchronous by design: the
   * router must pick a route without awaiting the network. A stale cache
   * kicks off a background re-probe and answers with the old value — worst
   * case one cheap task goes to the cloud while the probe refreshes.
   */
  available(): boolean {
    if (!this.configured()) return false;
    if (Date.now() - this.lastProbe > PROBE_TTL_MS) void this.probe();
    return this.reachable;
  }

  /** Ask the box if it's awake; cache the answer. Single-flight. */
  async probe(): Promise<boolean> {
    if (!this.configured()) return false;
    this.probing ??= (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const resp = await this.fetchImpl(`${this.base()}/models`, {
          signal: controller.signal,
        });
        this.reachable = resp.ok;
      } catch {
        this.reachable = false;
      } finally {
        clearTimeout(timer);
        this.lastProbe = Date.now();
        this.probing = undefined;
      }
      return this.reachable;
    })();
    return this.probing;
  }

  private base(): string {
    return this.deps.baseUrl().trim().replace(/\/+$/, "");
  }

  async complete(
    prompt: string,
    opts: CompleteOptions = {},
  ): Promise<{ text: string; usage: ModelUsage }> {
    if (!this.configured()) throw new Error("no local model URL configured");

    // Structured output: OpenAI-compatible servers vary — json_schema support
    // is rare, json_object is common. Ask for json_object and put the schema
    // in the prompt; the caller's parser is lenient and falls back to safe
    // defaults, which is the same posture it takes with Claude.
    const messages = [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      {
        role: "user",
        content: opts.schema
          ? `${prompt}\n\nAnswer with ONLY a JSON object matching this schema:\n${JSON.stringify(opts.schema)}`
          : prompt,
      },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPLETE_TIMEOUT_MS);
    try {
      const resp = await this.fetchImpl(`${this.base()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.deps.model().trim() || "gemma3:27b",
          max_tokens: opts.maxTokens ?? 2048,
          ...(opts.schema ? { response_format: { type: "json_object" } } : {}),
          messages,
        }),
      });
      if (!resp.ok) throw new Error(`local model HTTP ${resp.status}`);
      const body = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = body.choices?.[0]?.message?.content ?? "";
      if (!text.trim()) throw new Error("local model returned empty output");
      // Free by definition — electricity notwithstanding. Token counts are
      // not consistently reported across servers, so don't pretend.
      return { text, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    } catch (err) {
      // A mid-call failure means the box just went away; make the next
      // route decision honest without waiting for the TTL.
      this.reachable = false;
      this.lastProbe = Date.now();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
