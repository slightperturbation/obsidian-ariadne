import { normalizePath, requestUrl, type App, type PluginManifest } from "obsidian";
import type { Logger } from "./util/logger";

/**
 * Runtime assets that must sit next to main.js but that BRAT does not ship.
 *
 * BRAT (and the community-plugin installer) download exactly three files from
 * a release: manifest.json, main.js, styles.css. Ariadne additionally needs
 * the worker bundle and the two ONNX runtime files — ~24 MB that would be
 * absurd to inline into main.js (it is parsed on the UI thread at every
 * load). So releases attach them as extra assets, and on startup an install
 * that lacks them heals itself: each missing file is fetched from THIS
 * version's GitHub release via requestUrl (main-process, no CORS) and
 * written beside main.js. A dev install (npm run build copies everything)
 * never triggers this.
 *
 * Only the index owner needs any of these — readers never construct the
 * worker — so the check runs from startSemantic(), not unconditionally.
 */

/** GitHub repo the release assets live in. Set before the first release. */
export const RELEASE_REPO = "dexterba/ariadne";

const RUNTIME_ASSETS = [
  "index-worker.js",
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
] as const;

export function assetUrl(version: string, name: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/${version}/${name}`;
}

/**
 * Ensure the worker + ONNX runtime files exist next to main.js, downloading
 * any that are missing. Returns false (with a logged reason) if the install
 * stays incomplete — the caller then falls back exactly as it does today
 * (hash embedder), rather than surfacing a new failure mode.
 */
export async function ensureRuntimeAssets(
  app: App,
  manifest: PluginManifest,
  log: Logger,
): Promise<boolean> {
  const adapter = app.vault.adapter;
  const missing: string[] = [];
  for (const name of RUNTIME_ASSETS) {
    if (!(await adapter.exists(normalizePath(`${manifest.dir}/${name}`)))) missing.push(name);
  }
  if (missing.length === 0) return true;

  log.info(`runtime assets missing (${missing.join(", ")}) — fetching from release v${manifest.version}`);
  for (const name of missing) {
    try {
      const resp = await requestUrl({ url: assetUrl(manifest.version, name), throw: true });
      await adapter.writeBinary(normalizePath(`${manifest.dir}/${name}`), resp.arrayBuffer);
      log.info(`fetched ${name} (${Math.round(resp.arrayBuffer.byteLength / 1024)} KB)`);
    } catch (err) {
      log.warn(
        `could not fetch ${name} from the v${manifest.version} release: ${String(err)} — ` +
          `semantic search will use the fallback until the file exists next to main.js`,
      );
      return false;
    }
  }
  return true;
}
