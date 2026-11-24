/**
 * One turn of a persona conversation: the persona and its sources as the
 * system text, the conversation so far as turns. A local server is asked to
 * hold the whole of it (Ollama sizes its context only when told); Claude keeps
 * the sources cached between turns, so each turn after the first costs little.
 */
import Anthropic from "@anthropic-ai/sdk";
import { claudeRates } from "../model/providers/claude";

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface Reply {
  text: string;
  costUsd: number;
}

/** Long sources take a local model a while to read; a reply is waited for this long. */
const LOCAL_TIMEOUT_MS = 300_000;

/** The context a local model needs for this much text, with room for the conversation and the reply. */
export function contextFor(chars: number): number {
  const tokens = Math.ceil(chars / 3.2) + 8192;
  return Math.min(131_072, Math.max(8192, 2 ** Math.ceil(Math.log2(tokens))));
}

export async function talkLocal(url: string, model: string, system: string, turns: Turn[], fetchImpl: typeof fetch, opts: { json?: boolean; maxTokens?: number } = {}): Promise<Reply> {
  const base = url.replace(/\/+$/, "");
  const messages = [{ role: "system", content: system }, ...turns];
  const chars = messages.reduce((a, m) => a + m.content.length, 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOCAL_TIMEOUT_MS);
  try {
    // Ollama: its own endpoint, which takes the context size; the OpenAI-style one keeps its default, often too small.
    if (/\/v1$/.test(base)) {
      const native = await fetchImpl(`${base.replace(/\/v1$/, "")}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model, messages, stream: false, think: false, ...(opts.json ? { format: "json" } : {}), options: { num_ctx: contextFor(chars), num_predict: opts.maxTokens ?? 1500 } }),
      }).catch(() => undefined);
      if (native?.ok) {
        const body = (await native.json()) as { message?: { content?: string } };
        const text = body.message?.content?.trim() ?? "";
        if (!text) throw new Error(`${model} gave an empty reply`);
        return { text, costUsd: 0 };
      }
      // Some runners (Ollama's MLX one) have no JSON mode: ask again without it — the reply is read for its JSON either way.
      if (native && native.status === 501 && opts.json) return await talkLocal(url, model, system, turns, fetchImpl, { ...opts, json: false });
      if (native && native.status !== 404) throw new Error(`${model} answered HTTP ${native.status}`);
    }
    const resp = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 1500, reasoning_effort: "none", ...(opts.json ? { response_format: { type: "json_object" } } : {}) }),
    });
    if (resp.status === 501 && opts.json) return await talkLocal(url, model, system, turns, fetchImpl, { ...opts, json: false });
    if (!resp.ok) throw new Error(`${model} answered HTTP ${resp.status}`);
    const body = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error(`${model} gave an empty reply`);
    return { text, costUsd: 0 };
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`${model} did not answer within ${LOCAL_TIMEOUT_MS / 60_000} minutes`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function talkClaude(apiKey: string, model: string, system: string, turns: Turn[], fetchImpl?: typeof fetch): Promise<Reply> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    // The persona and its sources are the same every turn: cached, they are read again at a tenth of the price.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: turns,
  });
  if (response.stop_reason === "refusal") throw new Error(`${model} declined to answer this`);
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new Error(`${model} gave an empty reply`);
  const r = claudeRates(model);
  const u = response.usage;
  const costUsd =
    (u.input_tokens * r.input + (u.cache_creation_input_tokens ?? 0) * r.input * 1.25 + (u.cache_read_input_tokens ?? 0) * r.input * 0.1 + u.output_tokens * r.output) / 1_000_000;
  return { text, costUsd };
}

/** What the first turn of a cloud conversation is likely to cost, and each turn after it (sources cached). */
export function cloudEstimate(model: string, chars: number): { first: number; next: number } {
  const r = claudeRates(model);
  const tokens = chars / 3.5;
  return { first: (tokens * r.input * 1.25 + 400 * r.output) / 1_000_000, next: (tokens * r.input * 0.1 + 400 * r.output) / 1_000_000 };
}
