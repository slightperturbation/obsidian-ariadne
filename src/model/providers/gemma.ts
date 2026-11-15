import type { CompleteOptions, ModelUsage } from "./claude";

/**
 * One local model endpoint: any OpenAI-compatible server (Ollama, LM Studio,
 * llama.cpp, vLLM — they all speak /v1/chat/completions). Several of these
 * are composed by LocalPool (this machine, a home box over the tailnet…).
 *
 * The contract, from the PRD: a local route is used opportunistically and
 * never depended on. An endpoint may be asleep, off the network, or missing
 * the wanted model, so availability is a cached probe with a short timeout,
 * re-checked on an interval — a failed probe must cost ~a second once, not a
 * hang per call. Every task must work fully without this provider; the
 * router treats any failure here as "try the next brain", not as an error
 * the user sees.
 */

/**
 * Asymmetric trust: "awake" holds for minutes (a reachable box rarely
 * vanishes mid-session), but "asleep" is re-checked quickly — the box owner
 * arriving home or joining the VPN should not wait long to be noticed.
 * Both re-checks are background probes; nothing interactive ever waits.
 */
const REACHABLE_TTL_MS = 5 * 60_000;
const UNREACHABLE_TTL_MS = 25_000;
/** A LAN box answers in tens of ms; a second means asleep or absent. */
const PROBE_TIMEOUT_MS = 1_500;
/**
 * Local generation is slow but must not be unbounded. Sized for a dense
 * ~30B model on a laptop (Gemma 4 31B ≈ 12 tok/s) including a cold load.
 */
const COMPLETE_TIMEOUT_MS = 120_000;
/**
 * A completion whose probe is older than this re-probes FIRST (≤1.5s,
 * ~free on the LAN). The failure this prevents: leave home with the cache
 * saying "awake", and every local call would otherwise burn the full
 * completion timeout against an unroutable address before falling back.
 */
const CALL_FRESHNESS_MS = 25_000;
/** Don't re-warm an endpoint that was warmed or used this recently. */
const WARM_INTERVAL_MS = 4 * 60_000;

const normModel = (m: string): string => m.trim().toLowerCase().replace(/:latest$/, "");

/**
 * Which model should this endpoint serve? The first PREFERENCE the server
 * actually has — returned in the server's own spelling. Machines name the
 * same weights differently (`gemma4-26b-heretic` here,
 * `huihui_ai/gemma-4-abliterated:26b` there), so one ordered wish-list is
 * resolved per endpoint instead of configuring a name per machine.
 *
 * A server that lists nothing (some servers don't implement /models) is
 * trusted with the first preference. A server that lists models but none
 * that were asked for resolves to null — never to "whatever it has": the
 * writer chose these models deliberately.
 */
export function resolveModel(preferences: string[], installed: string[]): string | null {
  const prefs = preferences.map((p) => p.trim()).filter(Boolean);
  if (prefs.length === 0) return null;
  if (installed.length === 0) return prefs[0];
  for (const pref of prefs) {
    const hit = installed.find((id) => normModel(id) === normModel(pref));
    if (hit) return hit;
  }
  return null;
}

/** "this Mac" for loopback, otherwise the host's first DNS label (or its IP). */
export function endpointLabel(baseUrl: string): { label: string; loopback: boolean } {
  let host = "";
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return { label: baseUrl, loopback: false };
  }
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  if (loopback) return { label: "this Mac", loopback };
  const isIp = /^[\d.]+$/.test(host) || host.includes(":");
  return { label: isIp ? host : host.split(".")[0], loopback };
}

export interface EndpointInfo {
  url: string;
  label: string;
  loopback: boolean;
  state: "awake" | "asleep";
  /** The model this endpoint resolved to serve (null until probed / none). */
  model: string | null;
  /** Why it's asleep, when the server itself answered. */
  reason?: string;
}

/**
 * Without JSON mode, local models often wrap the object in a ```json fence
 * or a sentence of preamble. Callers JSON.parse the text strictly, so hand
 * back just the object when one is recognizable; otherwise pass through.
 */
export function unfenceJson(text: string): string {
  const t = text.trim();
  if (t.startsWith("{")) return t;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fenced && fenced[1].trim().startsWith("{")) return fenced[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  return first >= 0 && last > first ? t.slice(first, last + 1) : t;
}

export class GemmaProvider {
  private lastProbe = 0;
  private reachable = false;
  private probing?: Promise<boolean>;
  private resolved: string | null = null;
  private reason?: string;
  private lastWarm = 0;
  private lastOk = 0;

  constructor(
    private deps: {
      /** e.g. "http://gemma.local:11434/v1" — empty disables the provider. */
      baseUrl: () => string;
      /** A single model name, as the server knows it (legacy form). */
      model?: () => string;
      /** Ordered model preferences; the first one the server has is used. */
      models?: () => string[];
      /** Injected (requestUrl-backed in the app) — never the renderer's fetch. */
      fetch: typeof fetch;
    },
  ) {}

  private preferences(): string[] {
    return this.deps.models?.() ?? [this.deps.model?.() ?? ""];
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetch;
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
    const ttl = this.reachable ? REACHABLE_TTL_MS : UNREACHABLE_TTL_MS;
    if (Date.now() - this.lastProbe > ttl) void this.probe();
    return this.reachable;
  }

  /** Cached state for surfaces that must not trigger probes as a side effect. */
  state(): "off" | "awake" | "asleep" {
    if (!this.configured()) return "off";
    return this.reachable ? "awake" : "asleep";
  }

  /** Was this endpoint probed recently enough to trust a "no" without asking again? */
  fresh(): boolean {
    return Date.now() - this.lastProbe <= CALL_FRESHNESS_MS;
  }

  info(): EndpointInfo {
    const url = this.base();
    return {
      url,
      ...endpointLabel(url),
      state: this.reachable ? "awake" : "asleep",
      model: this.resolved,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }

  /**
   * Load the model ahead of need. A remote box can take over a minute to
   * pull ~18 GB into memory (measured: 79s cold, 0.7s warm), so when an
   * endpoint BECOMES the one that will serve the next call, one throwaway
   * token now is the difference between an instant first answer and a
   * timeout. Fire-and-forget, rate-limited, never surfaced.
   */
  warm(): void {
    if (!this.configured() || !this.reachable || !this.resolved) return;
    const now = Date.now();
    if (now - Math.max(this.lastWarm, this.lastOk) < WARM_INTERVAL_MS) return;
    this.lastWarm = now;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COMPLETE_TIMEOUT_MS);
    void this.fetchImpl(`${this.base()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: this.resolved,
        max_tokens: 1,
        reasoning_effort: "none",
        messages: [{ role: "user", content: "ok" }],
      }),
    })
      .then((resp) => {
        if (resp.ok) this.lastOk = Date.now();
      })
      .catch(() => {
        /* warming is best-effort */
      })
      .finally(() => clearTimeout(timer));
  }

  /**
   * The network likely changed (wake, refocus, online event, VPN toggle
   * noticed indirectly): drop the cache and re-probe in the background, so
   * the next route decision is right without any call paying for it.
   */
  notifyNetworkChange(): void {
    if (!this.configured()) return;
    this.lastProbe = 0;
    void this.probe();
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
        if (!resp.ok) {
          this.reachable = false;
          this.reason = `server answered HTTP ${resp.status}`;
        } else {
          let installed: string[] = [];
          try {
            const body = (await resp.json()) as { data?: Array<{ id?: unknown }> };
            installed = (body.data ?? [])
              .map((m) => m.id)
              .filter((id): id is string => typeof id === "string");
          } catch {
            /* a server without a parseable model list is trusted as-is */
          }
          this.resolved = resolveModel(this.preferences(), installed);
          this.reachable = this.resolved !== null;
          this.reason = this.reachable ? undefined : "none of the preferred models is installed";
        }
      } catch {
        this.reachable = false;
        this.reason = undefined;
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
    // Fail in ≤1.5s on a stale cache instead of in 60s against a dead route.
    if (Date.now() - this.lastProbe > CALL_FRESHNESS_MS && !(await this.probe())) {
      throw new Error("local box unreachable");
    }

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
      const send = (jsonMode: boolean) =>
        this.fetchImpl(`${this.base()}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: this.resolved ?? (this.preferences()[0]?.trim() || "gemma4:26b"),
            max_tokens: opts.maxTokens ?? 2048,
            // Thinking-capable local models (Gemma 4, Qwen 3.5) reason by
            // default, which turns a ~2s fragment into ~30s+ and can blow the
            // timeout. Ariadne's tasks are one-shot fragments: ask for none.
            // Servers that don't know the field (LM Studio, llama.cpp) ignore it.
            reasoning_effort: "none",
            ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
            messages,
          }),
        });
      let resp = await send(!!opts.schema);
      // Some engines reject JSON mode outright (Ollama's MLX runner answers
      // 4xx/5xx "structured output is unavailable"). The schema is already in
      // the prompt and the parser is lenient, so retry once without it.
      if (!resp.ok && opts.schema) resp = await send(false);
      if (!resp.ok) throw new Error(`local model HTTP ${resp.status}`);
      const body = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = body.choices?.[0]?.message?.content ?? "";
      if (!raw.trim()) throw new Error("local model returned empty output");
      const text = opts.schema ? unfenceJson(raw) : raw;
      this.lastOk = Date.now();
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
