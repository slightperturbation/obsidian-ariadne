import { describe, expect, it } from "vitest";
import { ModelRouter, BudgetExceededError, type ReasoningProvider } from "../src/model/router";
import { StatusStore } from "../src/core/status";
import { Logger } from "../src/util/logger";

function fakeProvider(costPerCall = 0.01): ReasoningProvider & { calls: number } {
  return {
    calls: 0,
    available: () => true,
    async complete(_prompt) {
      this.calls++;
      return {
        text: `response ${this.calls}`,
        usage: { inputTokens: 100, outputTokens: 50, costUsd: costPerCall },
      };
    },
  };
}

function makeRouter(provider: ReasoningProvider, limit = 0) {
  const status = new StatusStore();
  const router = new ModelRouter({
    provider,
    status,
    costLimitUsd: () => limit,
    log: new Logger("test", false),
  });
  return { router, status };
}

describe("ModelRouter", () => {
  it("accumulates session cost and surfaces it in status", async () => {
    const provider = fakeProvider(0.02);
    const { router, status } = makeRouter(provider);
    await router.run("connective", "a");
    await router.run("scaffold", "b");
    expect(router.sessionCost).toBeCloseTo(0.04, 5);
    expect(status.get().sessionCostUsd).toBeCloseTo(0.04, 5);
    expect(status.get().brain).toBe("cloud");
  });

  it("stops calls once the session cost limit is reached", async () => {
    const provider = fakeProvider(0.6);
    const { router } = makeRouter(provider, 1); // $1 limit
    await router.run("scaffold", "a"); // 0.6
    await router.run("scaffold", "b"); // 1.2 — now over
    await expect(router.run("scaffold", "c")).rejects.toThrow(BudgetExceededError);
    expect(provider.calls).toBe(2);
  });

  it("serializes calls (one at a time)", async () => {
    let active = 0;
    let maxActive = 0;
    const provider: ReasoningProvider = {
      available: () => true,
      async complete() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { text: "x", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
      },
    };
    const { router } = makeRouter(provider);
    await Promise.all([router.run("connective", "a"), router.run("connective", "b")]);
    expect(maxActive).toBe(1);
  });

  it("a failed call doesn't wedge the queue", async () => {
    let n = 0;
    const provider: ReasoningProvider = {
      available: () => true,
      async complete() {
        n++;
        if (n === 1) throw new Error("boom");
        return { text: "ok", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
      },
    };
    const { router } = makeRouter(provider);
    await expect(router.run("connective", "a")).rejects.toThrow("boom");
    await expect(router.run("connective", "b")).resolves.toBe("ok");
  });
});
