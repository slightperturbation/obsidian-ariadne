// Bundle the headless agent gateway into one file: dist/gateway.cjs.
// Run it anywhere Node 20+ exists:  node gateway.cjs /path/to/gateway.json
import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/gateway/headless.ts"],
  outfile: "dist/gateway.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  logLevel: "info",
  banner: { js: "// Ariadne agent gateway — generated bundle; source: github.com/slightperturbation/obsidian-ariadne" },
});
