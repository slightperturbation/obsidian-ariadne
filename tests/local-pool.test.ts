import { describe, expect, it, vi } from "vitest";
import { LocalPool } from "../src/model/providers/local-pool";
import { GemmaProvider, endpointLabel, resolveModel } from "../src/model/providers/gemma";
import { ModelRouter, type ReasoningProvider } from "../src/model/router";
import { makeObsidianFetch } from "../src/util/obsidian-fetch";
import { parseEndpoints, parseModelList } from "../src/settings/settings";
import { StatusStore } from "../src/core/status";
import { Logger } from "../src/util/logger";

const MAC = "http://localhost:11434/v1";
const BOX = "http://lamettrie.tail.ts.net:11434/v1";
const MODELS = ["gemma4-26b-heretic", "huihui_ai/gemma-4-abliterated:26b"];

interface Server {
  up: boolean;
  models: string[];
  /** Completions throw (the server died mid-call). */
  failCompletions?: boolean;
}

function fakeServers(servers: Record<string, Server>) {
  const calls: Array<{ host: string; path: string; body?: Record<string, unknown> }> = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const server = servers[u.host];
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ host: u.host, path: u.pathname, body });
    if (!server?.up) throw new Error("ECONNREFUSED");
    if (u.pathname.endsWith("/models")) {
      return new Response(JSON.stringify({ data: server.models.map((id) => ({ id })) }), {
        status: 200,
      });
    }
    if (server.failCompletions) throw new Error("server died");
    return new Response(
      JSON.stringify({ choices: [{ message: { content: `${u.hostname}:${String(body?.model)}` } }] }),
      { status: 200 },
    );
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

function makePool(servers: Record<string, Server>, power = { onBattery: false, avoid: true }) {
  const { fetchFn, calls } = fakeServers(servers);
  const pool = new LocalPool({
    endpoints: () => [MAC, BOX],
    models: () => MODELS,
    fetch: fetchFn,
    onBattery: () => power.onBattery,
    avoidOnBattery: () => power.avoid,
  });
  return { pool, calls, power };
}

const BOTH_UP = {
  "localhost:11434": { up: true, models: ["gemma4:31b", "gemma4-26b-heretic:latest"] },
  "lamettrie.tail.ts.net:11434": { up: true, models: ["huihui_ai/gemma-4-abliterated:26b", "gemma4:26b"] },
};

describe("model resolution", () => {
  it("picks the first preference the server has, in the server's spelling", () => {
    expect(resolveModel(MODELS, ["gemma4:31b", "gemma4-26b-heretic:latest"])).toBe(
      "gemma4-26b-heretic:latest",
    );
    expect(resolveModel(MODELS, ["huihui_ai/gemma-4-abliterated:26b", "gemma4:26b"])).toBe(
      "huihui_ai/gemma-4-abliterated:26b",
    );
  });

  it("never substitutes a model that wasn't asked for", () => {
    expect(resolveModel(MODELS, ["gemma4:26b", "qwen3:8b"])).toBeNull();
    expect(resolveModel([], ["gemma4:26b"])).toBeNull();
  });

  it("trusts the first preference when a server lists nothing", () => {
    expect(resolveModel(MODELS, [])).toBe("gemma4-26b-heretic");
  });

  it("labels loopback as this Mac and remote hosts by their first label", () => {
    expect(endpointLabel(MAC)).toEqual({ label: "this Mac", loopback: true });
    expect(endpointLabel("http://127.0.0.1:11434/v1").loopback).toBe(true);
    expect(endpointLabel(BOX)).toEqual({ label: "lamettrie", loopback: false });
    expect(endpointLabel("http://100.65.95.102:11434/v1").label).toBe("100.65.95.102");
  });

  it("an endpoint that answers but lacks every preferred model is unavailable, with a reason", async () => {
    const { fetchFn } = fakeServers({ "localhost:11434": { up: true, models: ["gemma4:26b"] } });
    const endpoint = new GemmaProvider({ baseUrl: () => MAC, models: () => MODELS, fetch: fetchFn });
    expect(await endpoint.probe()).toBe(false);
    expect(endpoint.info()).toMatchObject({
      state: "asleep",
      model: null,
      reason: "none of the preferred models is installed",
    });
  });
});

describe("LocalPool ordering", () => {
  it("plugged in: this Mac first, each endpoint with its own resolved model", async () => {
    const { pool } = makePool(BOTH_UP);
    await pool.probeAll();
    expect(pool.available()).toBe(true);
    expect((await pool.complete("p")).text).toBe("localhost:gemma4-26b-heretic:latest");
    expect(pool.state().active).toMatchObject({ label: "this Mac", lastResort: false });
  });

  it("on battery: the remote box serves; this Mac's model is spared", async () => {
    const { pool } = makePool(BOTH_UP, { onBattery: true, avoid: true });
    await pool.probeAll();
    expect((await pool.complete("p")).text).toBe(
      "lamettrie.tail.ts.net:huihui_ai/gemma-4-abliterated:26b",
    );
    expect(pool.state()).toMatchObject({ savingBattery: true, active: { label: "lamettrie" } });
  });

  it("on battery with the box unreachable: only last-resort calls may use this Mac", async () => {
    const servers = { ...BOTH_UP, "lamettrie.tail.ts.net:11434": { up: false, models: [] } };
    const { pool, calls } = makePool(servers, { onBattery: true, avoid: true });
    await pool.probeAll();
    expect(pool.available({ lastResort: false })).toBe(false);
    expect(pool.available({ lastResort: true })).toBe(true);
    await expect(pool.complete("p", { lastResort: false })).rejects.toThrow();
    expect(calls.filter((c) => c.host === "localhost:11434" && c.path.endsWith("/chat/completions"))).toHaveLength(0);
    expect((await pool.complete("p", { lastResort: true })).text).toContain("localhost:");
    expect(pool.state().active).toMatchObject({ label: "this Mac", lastResort: true });
  });

  it("avoidance off: battery changes nothing", async () => {
    const { pool } = makePool(BOTH_UP, { onBattery: true, avoid: false });
    await pool.probeAll();
    expect((await pool.complete("p", { lastResort: false })).text).toContain("localhost:");
  });

  it("fails over to the next endpoint when the first dies mid-call", async () => {
    const servers = {
      ...BOTH_UP,
      "localhost:11434": { up: true, models: ["gemma4-26b-heretic"], failCompletions: true },
    };
    const { pool } = makePool(servers);
    await pool.probeAll();
    expect((await pool.complete("p")).text).toContain("lamettrie.tail.ts.net:");
  });

  it("warms a remote box when it becomes the preferred endpoint (unplugged)", async () => {
    const { pool, calls, power } = makePool(BOTH_UP);
    await pool.probeAll();
    const warmups = () =>
      calls.filter(
        (c) => c.host === "lamettrie.tail.ts.net:11434" && c.body?.max_tokens === 1,
      ).length;
    expect(warmups()).toBe(0); // plugged in: the Mac is preferred, nothing to warm
    power.onBattery = true;
    pool.notifyPowerChange();
    await vi.waitFor(() => expect(warmups()).toBe(1));
    pool.available(); // still preferred — no second warm-up
    expect(warmups()).toBe(1);
  });
});

describe("router × pool: battery policy", () => {
  function setup(opts: {
    onBattery: boolean;
    boxUp: boolean;
    mode?: "auto" | "cloud" | "local";
    cloud?: Partial<ReasoningProvider>;
  }) {
    const servers = {
      ...BOTH_UP,
      "lamettrie.tail.ts.net:11434": opts.boxUp ? BOTH_UP["lamettrie.tail.ts.net:11434"] : { up: false, models: [] },
    };
    const { pool, calls } = makePool(servers, { onBattery: opts.onBattery, avoid: true });
    const cloudComplete = vi.fn(() =>
      Promise.resolve({ text: "cloud", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } }),
    );
    const cloud = { available: () => true, complete: cloudComplete, ...opts.cloud } as ReasoningProvider;
    const router = new ModelRouter({
      provider: cloud,
      local: pool,
      mode: () => opts.mode ?? "auto",
      status: new StatusStore(),
      costLimitUsd: () => 2,
      log: new Logger("test", false),
    });
    const macCompletions = () =>
      calls.filter((c) => c.host === "localhost:11434" && c.path.endsWith("/chat/completions")).length;
    return { router, pool, cloudComplete, macCompletions };
  }

  it("on battery, a cheap task prefers the cloud over this Mac's model", async () => {
    const { router, pool, macCompletions } = setup({ onBattery: true, boxUp: false });
    await pool.probeAll();
    expect(await router.run("relation", "p", { sources: [] })).toBe("cloud");
    expect(macCompletions()).toBe(0);
  });

  it("on battery, a user-initiated local-only call uses this Mac as the last resort", async () => {
    const { router, pool, cloudComplete } = setup({ onBattery: true, boxUp: false });
    await pool.probeAll();
    expect(await router.run("relation", "p", { sources: [], privacy: "local" })).toContain("localhost:");
    expect(cloudComplete).not.toHaveBeenCalled();
  });

  it("on battery, BACKGROUND local-only work waits rather than spend battery", async () => {
    const { router, pool, macCompletions, cloudComplete } = setup({ onBattery: true, boxUp: false });
    await pool.probeAll();
    expect(router.localAvailable({ background: true })).toBe(false);
    expect(router.localAvailable()).toBe(true);
    await expect(
      router.run("relation", "p", { sources: [], privacy: "local", background: true }),
    ).rejects.toThrow(/local-only/);
    expect(macCompletions()).toBe(0);
    expect(cloudComplete).not.toHaveBeenCalled();
  });

  it("on battery with the box reachable, background work goes to the box", async () => {
    const { router, pool } = setup({ onBattery: true, boxUp: true });
    await pool.probeAll();
    expect(await router.run("relation", "p", { sources: [], privacy: "local", background: true })).toContain(
      "lamettrie",
    );
  });

  it("a cloud failure is answered locally (offline with 'automatic' routing)", async () => {
    const offline = { complete: vi.fn(() => Promise.reject(new Error("ENOTFOUND api.anthropic.com"))) };
    const { router, pool } = setup({ onBattery: false, boxUp: false, cloud: offline });
    await pool.probeAll();
    // "scaffold" is a cloud task under auto — the cloud is down, the Mac answers.
    expect(await router.run("scaffold", "p", { sources: [] })).toContain("localhost:");
  });

  it("cloud-only mode never falls back to a local model", async () => {
    const offline = { complete: vi.fn(() => Promise.reject(new Error("offline"))) };
    const { router, pool } = setup({ onBattery: false, boxUp: true, mode: "cloud", cloud: offline });
    await pool.probeAll();
    await expect(router.run("scaffold", "p", { sources: [] })).rejects.toThrow("offline");
  });
});

describe("settings parsing", () => {
  it("parses endpoints one per line, trimmed, de-duplicated, order kept", () => {
    expect(parseEndpoints(` ${MAC}/ \n\n${BOX}\n${MAC}`)).toEqual([MAC, BOX]);
    expect(parseEndpoints("")).toEqual([]);
  });

  it("parses the model preference list", () => {
    expect(parseModelList("gemma4-26b-heretic, huihui_ai/gemma-4-abliterated:26b ,")).toEqual(MODELS);
  });
});

describe("abortable requestUrl fetch", () => {
  it("releases the caller when the signal aborts, even though the request can't be cancelled", async () => {
    let finish!: (v: { status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }) => void;
    const hanging = new Promise<{ status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>(
      (resolve) => (finish = resolve),
    );
    const f = makeObsidianFetch(() => hanging);
    const controller = new AbortController();
    const pending = f("http://unroutable:11434/v1/models", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    finish({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) }); // late result is dropped
  });

  it("passes a normal response through", async () => {
    const f = makeObsidianFetch(async (req) => ({
      status: 200,
      headers: { "content-type": "application/json" },
      arrayBuffer: new TextEncoder().encode(JSON.stringify({ url: req.url, method: req.method })).buffer as ArrayBuffer,
    }));
    const resp = await f("http://x/y", { method: "POST", body: "{}" });
    expect(await resp.json()).toEqual({ url: "http://x/y", method: "POST" });
  });
});
