import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  {
    ignores: [
      "main.js",
      "index-worker.js",
      "ort-wasm-simd-threaded.asyncify.mjs",
      "node_modules/",
      "dist/",
      "coverage/",
    ],
  },
  ...tseslint.configs.recommended,
  // The community-plugin submission checklist expects obsidianmd clean. Its
  // recommended set includes typed rules (hence the project service), and it
  // is scoped to plugin source: tests and build scripts are not plugin code.
  // Configs for other languages (its manifest.json checks) keep their own
  // file patterns — overriding those was how this config once tried to parse
  // TypeScript as JSON.
  ...obsidianmd.configs.recommended.map((c) =>
    c.language ? c : { ...c, files: ["src/**/*.ts"] },
  ),
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The Bases API needs 1.10.0 and minAppVersion is deliberately lower:
    // the view is feature-detected (registerBasesView probed in main.ts) and
    // the class is built lazily, so these APIs are never touched on an
    // Obsidian without Bases. The rule can't see runtime guards.
    files: ["src/bases/**/*.ts"],
    rules: { "obsidianmd/no-unsupported-api": "off" },
  },
  {
    // The one sanctioned console call site: every log funnels through the
    // Logger, and info/debug are gated behind the debug setting.
    files: ["src/util/logger.ts"],
    rules: { "obsidianmd/rule-custom-message": "off" },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      // UI modules build DOM via each element's ownerDocument, which is
      // exactly the popout-safety these rules exist to enforce — and keeps
      // the components free of Obsidian imports, hence unit-testable.
      "obsidianmd/prefer-create-el": "off",
      // Timers here are plugin-lifecycle (debounces, schedulers), not bound
      // to any document; window.setTimeout would add nothing in a worker.
      "obsidianmd/prefer-window-timers": "off",
      "obsidianmd/no-global-this": "off",
      // The auto-fix lowercases proper nouns and acronyms (BM25 → bm25);
      // UI copy is reviewed by hand instead.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
