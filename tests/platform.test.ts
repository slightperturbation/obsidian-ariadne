import { describe, it, expect, vi } from "vitest";
import { yieldToUI, onIdle } from "../src/platform";

describe("platform helpers", () => {
  it("yieldToUI resolves on a macrotask", async () => {
    await expect(yieldToUI()).resolves.toBeUndefined();
  });

  it("onIdle falls back to setTimeout when requestIdleCallback is absent", () => {
    const original = (globalThis as Record<string, unknown>).requestIdleCallback;
    delete (globalThis as Record<string, unknown>).requestIdleCallback;
    const cb = vi.fn();
    onIdle(cb);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb).toHaveBeenCalledOnce();
        if (original) (globalThis as Record<string, unknown>).requestIdleCallback = original;
        resolve();
      }, 5);
    });
  });
});
