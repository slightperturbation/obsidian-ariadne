import Anthropic from "@anthropic-ai/sdk";

/** $/MTok — used for the honest running-cost glyph. Unknown models use Opus rates. */
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const DEFAULT_MODEL = "claude-haiku-4-5";

/**
 * Adaptive thinking (`{type:"adaptive"}`) is a 4.6+ family feature. Sending it
 * to Haiku 4.5 or older models returns a 400, so the provider only requests
 * thinking when the configured model supports it — the task just runs without
 * it otherwise (fine for these small structured jobs).
 */
function supportsAdaptiveThinking(model: string): boolean {
  return /claude-(fable-5|mythos-5|opus-4-[678]|sonnet-5|sonnet-4-6)/.test(model);
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CompleteOptions {
  system?: string;
  maxTokens?: number;
  /** Adaptive thinking — on for tasks with real structure (scaffolds), off for one-liners. */
  thinking?: boolean;
  /** JSON schema for structured output (output_config.format). */
  schema?: Record<string, unknown>;
}

export class ModelRefusalError extends Error {
  constructor() {
    super("the model declined this request");
    this.name = "ModelRefusalError";
  }
}

/**
 * Claude provider over the official SDK. Two Obsidian-specific notes:
 * `dangerouslyAllowBrowser` because the plugin runs in a renderer (the key is
 * the user's own, stored locally — the warning's shared-browser scenario
 * doesn't apply), and an injectable fetch so the plugin can route through
 * Obsidian's requestUrl (CORS-free) while tests inject a fake.
 */
export class ClaudeProvider {
  constructor(
    private deps: {
      apiKey: () => string;
      model: () => string;
      fetch?: typeof fetch;
    },
  ) {}

  available(): boolean {
    return this.deps.apiKey().trim().length > 0;
  }

  get modelId(): string {
    return this.deps.model().trim() || DEFAULT_MODEL;
  }

  async complete(
    prompt: string,
    opts: CompleteOptions = {},
  ): Promise<{ text: string; usage: ModelUsage }> {
    if (!this.available()) throw new Error("no Claude API key configured");
    const client = new Anthropic({
      apiKey: this.deps.apiKey(),
      dangerouslyAllowBrowser: true,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      maxRetries: 2,
    });

    const model = this.modelId;
    const useThinking = opts.thinking && supportsAdaptiveThinking(model);
    const response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.system ? { system: opts.system } : {}),
      ...(useThinking ? { thinking: { type: "adaptive" as const } } : {}),
      ...(opts.schema
        ? { output_config: { format: { type: "json_schema" as const, schema: opts.schema } } }
        : {}),
      messages: [{ role: "user", content: prompt }],
    });

    if (response.stop_reason === "refusal") throw new ModelRefusalError();

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (response.stop_reason === "max_tokens") {
      throw new Error("model output truncated (max_tokens) — not safe to act on");
    }

    const rates = PRICING_PER_MTOK[model] ?? PRICING_PER_MTOK["claude-opus-4-8"];
    const usage: ModelUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      costUsd:
        (response.usage.input_tokens * rates.input +
          response.usage.output_tokens * rates.output) /
        1_000_000,
    };
    return { text, usage };
  }
}
