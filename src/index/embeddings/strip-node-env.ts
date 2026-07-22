/**
 * WORKER-ONLY — never import from main-thread code.
 *
 * Obsidian's Electron enables Node integration in workers, so `process` leaks
 * into this worker's global scope. transformers.js keys its environment
 * detection on `process.release.name === "node"` and, seeing it, demands the
 * native ONNX runtimes (cpu/coreml/…) that we don't ship. Scrubbing `process`
 * makes detection resolve to "browser" and the WASM backend we do ship.
 *
 * This module must be the FIRST import of the worker entry: ES module
 * evaluation order runs it before transformers.js's module-scope detection.
 */
const g = globalThis as { process?: unknown };
try {
  delete g.process;
} catch {
  /* non-configurable — fall through to overwrite */
}
if (typeof g.process !== "undefined") {
  // `typeof process !== "undefined"` checks the VALUE, so this works too.
  g.process = undefined;
}

export {};
