/**
 * Run a callback when the UI is idle. `requestIdleCallback` is absent on
 * iOS/WebKit, so feature-detect and fall back to a macrotask.
 */
export function onIdle(cb: () => void, timeoutMs = 200): void {
  const ric = (
    globalThis as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof ric === "function") ric(cb, { timeout: timeoutMs });
  else setTimeout(cb, 0);
}

/** Yield to the event loop so long loops (e.g. indexing) never block typing. */
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

