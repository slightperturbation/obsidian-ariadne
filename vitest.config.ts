import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    // Route `import ... from "obsidian"` to our hand-written mock in tests.
    alias: {
      obsidian: resolve(process.cwd(), "tests/mocks/obsidian.ts"),
    },
  },
});
