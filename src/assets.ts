import { Notice, normalizePath, requestUrl, type App, type PluginManifest } from "obsidian";
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

/**
 * Name → minimum plausible size. A truncated download, an HTML error page,
 * or a Git-LFS pointer would otherwise be written to disk and pass the
 * `exists` check on every later start — a permanently, silently broken
 * install with no path to re-heal.
 */
const RUNTIME_ASSETS: ReadonlyArray<{ name: string; minBytes: number }> = [
  { name: "index-worker.js", minBytes: 100_000 },
  { name: "ort-wasm-simd-threaded.asyncify.mjs", minBytes: 10_000 },
  { name: "ort-wasm-simd-threaded.asyncify.wasm", minBytes: 1_000_000 },
];

/** Stamp recording which plugin version fetched the assets beside main.js. */
const STAMP_FILE = "ariadne-assets.json";

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
  const stampPath = normalizePath(`${manifest.dir}/${STAMP_FILE}`);

  const missing: string[] = [];
  for (const { name } of RUNTIME_ASSETS) {
    if (!(await adapter.exists(normalizePath(`${manifest.dir}/${name}`)))) missing.push(name);
  }

  // Version staleness: a BRAT/community update rewrites only main.js — the
  // old worker would keep running against the new main across the message
  // protocol. The stamp says which version fetched the assets; a mismatch
  // re-fetches. Files present WITHOUT a stamp are a dev build (npm run
  // build copies them): adopt them as current rather than clobbering.
  let stale: string[] = [];
  if (missing.length === 0) {
    try {
      const raw = await adapter.read(stampPath).catch(() => "");
      const stamped = raw ? (JSON.parse(raw) as { version?: string }).version : undefined;
      if (stamped === undefined) {
        await adapter.write(stampPath, JSON.stringify({ version: manifest.version }));
        return true;
      }
      if (stamped === manifest.version) return true;
      stale = RUNTIME_ASSETS.map((a) => a.name);
      log.info(`runtime assets are from v${stamped} — refreshing for v${manifest.version}`);
    } catch {
      return true; // an unreadable stamp must not break a working install
    }
  }

  const wanted = missing.length > 0 ? missing : stale;
  if (missing.length > 0) {
    log.info(`runtime assets missing (${missing.join(", ")}) — fetching from release v${manifest.version}`);
  }
  // Honesty about bytes: ~24 MB is not a silent background detail on a
  // metered connection.
  new Notice("Ariadne is downloading its search runtime (~24 MB, one-time).");
  for (const name of wanted) {
    const spec = RUNTIME_ASSETS.find((a) => a.name === name)!;
    try {
      const resp = await requestUrl({ url: assetUrl(manifest.version, name), throw: true });
      if (resp.arrayBuffer.byteLength < spec.minBytes) {
        throw new Error(
          `implausibly small (${resp.arrayBuffer.byteLength} B < ${spec.minBytes} B) — not written`,
        );
      }
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
  await adapter.write(stampPath, JSON.stringify({ version: manifest.version })).catch(() => {});
  return true;
}
