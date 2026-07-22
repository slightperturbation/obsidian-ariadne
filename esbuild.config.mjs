import esbuild from "esbuild";
import process from "process";
import fs from "node:fs";
import builtins from "builtin-modules";

// Ship the ONNX runtime next to main.js: Obsidian blocks dynamic import of
// remote modules, so the default CDN load of these files fails inside the app.
// main.ts turns them into blob: URLs at runtime.
const ORT_DIST = "node_modules/onnxruntime-web/dist";
for (const f of ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"]) {
  fs.copyFileSync(`${ORT_DIST}/${f}`, f);
}

const banner = `/*
Ariadne — generated bundle; do not edit directly.
Source and license: https://github.com/  (set on publish)
*/`;

const prod = process.argv[2] === "production";

const shared = {
  banner: { js: banner },
  bundle: true,
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
};

const context = await esbuild.context({
  ...shared,
  entryPoints: ["src/main.ts"],
  external: [
    "obsidian",
    "electron",
    // Node-only optional deps of @huggingface/transformers; the browser/wasm
    // path is used at runtime inside Obsidian.
    "onnxruntime-node",
    "sharp",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  outfile: "main.js",
});

// The embedding worker: bundled separately, loaded via a blob: URL at runtime.
// IIFE (a worker has no module system); node-only optional deps stay external
// and are never reached on the worker's browser-env code path.
const workerContext = await esbuild.context({
  ...shared,
  entryPoints: ["src/index/embeddings/embed-worker.ts"],
  format: "iife",
  external: ["onnxruntime-node", "sharp", ...builtins],
  outfile: "embed-worker.js",
});

if (prod) {
  await context.rebuild();
  await workerContext.rebuild();
  process.exit(0);
} else {
  await Promise.all([context.watch(), workerContext.watch()]);
}
