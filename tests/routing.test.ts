import { describe, expect, it, vi } from "vitest";
import { ModelRouter, type ReasoningProvider, type RoutingMode } from "../src/model/router";
import { GemmaProvider } from "../src/model/providers/gemma";
import { StatusStore } from "../src/core/status";
import { Logger } from "../src/util/logger";

function provider(over: Partial<ReasoningProvider> & { name?: string } = {}): {
  p: ReasoningProvider;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(() =>
    Promise.resolve({
      text: `answer from ${over.name ?? "provider"}`,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: over.name === "local" ? 0 : 0.01 },
    }),
  );
  return { p: { available: () => true, complete, ...over } as ReasoningProvider, complete };
}

function makeRouter(over: {
  local?: ReasoningProvider;
  mode?: RoutingMode;
  cloudAvailable?: boolean;
  limit?: number;
}) {
  const cloud = provider({ name: "cloud", available: () => over.cloudAvailable ?? true });
  const status = new StatusStore();
  const router = new ModelRouter({
    provider: cloud.p,
    local: over.local,
    mode: () => over.mode ?? "auto",
    status,
    costLimitUsd: () => over.limit ?? 2,
    log: new Logger("test", false),
  });
  return { router, cloud, status };
}

describe("ModelRouter per-task routing", () => {
  it("routes cheap tasks local and quality-sensitive tasks cloud, under auto", async () => {
    const local = provider({ name: "local" });
    const { router, cloud, status } = makeRouter({ local: local.p });

    expect(await router.run("connective", "p")).toBe("answer from local");
    expect(status.get().brain).toBe("local");
    expect(await router.run("relation", "p")).toBe("answer from local");
    expect(cloud.complete).not.toHaveBeenCalled();

    expect(await router.run("scaffold", "p")).toBe("answer from cloud");
    expect(status.get().brain).toBe("cloud");
  });

  it("routes everything cloud when the box is unreachable or mode is cloud", async () => {
    const asleep = provider({ name: "local", available: () => false });
    const { router: r1, cloud: c1 } = makeRouter({ local: asleep.p });
    await r1.run("connective", "p");
    expect(c1.complete).toHaveBeenCalledOnce();
    expect(asleep.complete).not.toHaveBeenCalled();

    const awake = provider({ name: "local" });
    const { router: r2, cloud: c2 } = makeRouter({ local: awake.p, mode: "cloud" });
    await r2.run("connective", "p");
    expect(c2.complete).toHaveBeenCalledOnce();
    expect(awake.complete).not.toHaveBeenCalled();
  });

  it("local mode widens the local set to every task", async () => {
    const local = provider({ name: "local" });
    const { router, cloud } = makeRouter({ local: local.p, mode: "local" });
    expect(await router.run("scaffold", "p")).toBe("answer from local");
    expect(cloud.complete).not.toHaveBeenCalled();
  });

  it("falls back to cloud transparently when a local call fails mid-flight", async () => {
    const flaky = provider({ name: "local" });
    flaky.complete.mockRejectedValueOnce(new Error("box went to sleep"));
    const { router, cloud } = makeRouter({ local: flaky.p });
    expect(await router.run("connective", "p")).toBe("answer from cloud");
    expect(cloud.complete).toHaveBeenCalledOnce();
  });

  it("local calls are free: they proceed past the cloud cost cap", async () => {
    const local = provider({ name: "local" });
    const { router } = makeRouter({ local: local.p, limit: 0.005 });
    await router.run("scaffold", "p"); // cloud, $0.01 — cap now exceeded
    await expect(router.run("scaffold", "p")).rejects.toThrow(/cost limit/);
    // The cheap task still runs — on the box, spending nothing.
    expect(await router.run("connective", "p")).toBe("answer from local");
  });

  it("is available with only a local box (no API key)", async () => {
    const local = provider({ name: "local" });
    const { router } = makeRouter({ local: local.p, cloudAvailable: false });
    expect(router.available()).toBe(true);
    expect(await router.run("connective", "p")).toBe("answer from local");
    // But a local failure with no cloud behind it propagates.
    local.complete.mockRejectedValueOnce(new Error("asleep"));
    await expect(router.run("connective", "p")).rejects.toThrow("asleep");
  });
});

describe("GemmaProvider", () => {
  const okJson = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

  it("is unconfigured with an empty URL and never fetches", async () => {
    const fetchFn = vi.fn();
    const g = new GemmaProvider({ baseUrl: () => "", model: () => "m", fetch: fetchFn });
    expect(g.configured()).toBe(false);
    expect(g.available()).toBe(false);
    await expect(g.complete("p")).rejects.toThrow(/no local model URL/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("probes /models and caches the answer", async () => {
    const fetchFn = vi.fn(() => okJson({ data: [] }));
    const g = new GemmaProvider({
      baseUrl: () => "http://box:11434/v1/",
      model: () => "gemma3:27b",
      fetch: fetchFn as unknown as typeof fetch,
    });
    expect(await g.probe()).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith("http://box:11434/v1/models", expect.anything());
    expect(g.available()).toBe(true);
    // Within the TTL, available() answers from cache — no second fetch.
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("completes via chat/completions and reports zero cost", async () => {
    const fetchFn = vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith("/models")
        ? okJson({ data: [] })
        : okJson({ choices: [{ message: { content: '{"relation":"neither"}' } }] }),
    );
    const g = new GemmaProvider({
      baseUrl: () => "http://box:11434/v1",
      model: () => "gemma3:27b",
      fetch: fetchFn as unknown as typeof fetch,
    });
    const { text, usage } = await g.complete("p", { schema: { type: "object" } });
    expect(text).toBe('{"relation":"neither"}');
    expect(usage.costUsd).toBe(0);
    const call = fetchFn.mock.calls.find(([u]) => String(u).endsWith("/chat/completions"))!;
    const body = JSON.parse(String(call[1]?.body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content).toContain("matching this schema");
  });

  it("marks itself unreachable after a failed call", async () => {
    const fetchFn = vi.fn((url: string) =>
      String(url).endsWith("/models")
        ? okJson({ data: [] })
        : Promise.reject(new Error("ECONNREFUSED")),
    );
    const g = new GemmaProvider({
      baseUrl: () => "http://box:11434/v1",
      model: () => "m",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await g.probe();
    expect(g.available()).toBe(true);
    await expect(g.complete("p")).rejects.toThrow();
    // The route decision is honest immediately, not after the TTL.
    expect(g.available()).toBe(false);
  });

  it("treats an empty completion as a failure (router then falls back)", async () => {
    const fetchFn = vi.fn(() => okJson({ choices: [{ message: { content: "" } }] }));
    const g = new GemmaProvider({
      baseUrl: () => "http://box:11434/v1",
      model: () => "m",
      fetch: fetchFn as unknown as typeof fetch,
    });
    await expect(g.complete("p")).rejects.toThrow(/empty output/);
  });
});
