import type { IndexSnapshot, NoteMeta } from "./manager";
import type { Chunk } from "../core/types";

/**
 * Minimal file surface the persistence layer needs — implemented over
 * Obsidian's DataAdapter at runtime and an in-memory map in tests.
 * Paths are vault-relative with forward slashes.
 */
export interface FileIO {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  /** File names (not paths) directly inside dir; [] if dir is missing. */
  list(dir: string): Promise<string[]>;
}

const SCHEMA_VERSION = 1;
const MAGIC = 0x41524941; // "ARIA"
/** Per-part JSON budget — comfortably under Obsidian Sync's 5 MB/file cap. */
const PART_BUDGET_BYTES = 3_000_000;

interface Manifest {
  schemaVersion: number;
  embedderId?: string;
  dim?: number;
  parts: number;
  notes: NoteMeta[];
}

const chunksFile = (i: number) => `chunks-${i}.json`;
const vectorsFile = (i: number) => `vectors-${i}.bin`;

/* ── int8 quantization ────────────────────────────────────────────────── */

function quantize(vec: Float32Array): { scale: number; data: Int8Array } {
  let maxAbs = 0;
  for (const v of vec) maxAbs = Math.max(maxAbs, Math.abs(v));
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const data = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) data[i] = Math.round(vec[i] / scale);
  return { scale, data };
}

function dequantize(scale: number, data: Int8Array): Float32Array {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] * scale;
  return out;
}

/* ── binary part encoding ─────────────────────────────────────────────── */

function encodeVectorPart(
  records: Array<{ id: string; vec: Float32Array }>,
  dim: number,
): ArrayBuffer {
  const enc = new TextEncoder();
  const encodedIds = records.map((r) => enc.encode(r.id));
  let size = 8; // magic + count
  for (const idBytes of encodedIds) size += 2 + idBytes.length + 4 + dim;

  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;
  view.setUint32(off, MAGIC, true);
  view.setUint32((off += 4), records.length, true);
  off += 4;
  records.forEach((r, i) => {
    const idBytes = encodedIds[i];
    view.setUint16(off, idBytes.length, true);
    bytes.set(idBytes, (off += 2));
    off += idBytes.length;
    const { scale, data } = quantize(r.vec);
    view.setFloat32(off, scale, true);
    off += 4;
    bytes.set(new Uint8Array(data.buffer, data.byteOffset, dim), off);
    off += dim;
  });
  return buf;
}

function decodeVectorPart(
  buf: ArrayBuffer,
  dim: number,
): Array<{ id: string; vec: Float32Array }> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const dec = new TextDecoder();
  if (buf.byteLength < 8 || view.getUint32(0, true) !== MAGIC) {
    throw new Error("bad vector part header");
  }
  const count = view.getUint32(4, true);
  const out: Array<{ id: string; vec: Float32Array }> = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    const idLen = view.getUint16(off, true);
    off += 2;
    const id = dec.decode(bytes.subarray(off, off + idLen));
    off += idLen;
    const scale = view.getFloat32(off, true);
    off += 4;
    const data = new Int8Array(bytes.subarray(off, off + dim));
    off += dim;
    out.push({ id, vec: dequantize(scale, data) });
  }
  return out;
}

/* ── save / load ──────────────────────────────────────────────────────── */

/**
 * Persist a snapshot as chunked files under dir. Chunk parts are JSON, vector
 * parts are int8-quantized binary aligned to the same chunk split, and the
 * manifest is written LAST so a crash mid-save leaves a stale-but-consistent
 * manifest rather than a torn one. Leftover higher-numbered parts from a
 * previous, larger save are removed.
 */
export async function saveIndex(
  io: FileIO,
  dir: string,
  snap: IndexSnapshot,
  opts: { partBudgetBytes?: number } = {},
): Promise<void> {
  const partBudget = opts.partBudgetBytes ?? PART_BUDGET_BYTES;
  if (!(await io.exists(dir))) await io.mkdir(dir);

  const byId = new Map(snap.vectors.map((v) => [v.id, v.vec]));

  // Split chunks into parts by serialized size.
  const parts: Chunk[][] = [];
  let current: Chunk[] = [];
  let currentBytes = 0;
  for (const chunk of snap.chunks) {
    const bytes = JSON.stringify(chunk).length + 1;
    if (currentBytes + bytes > partBudget && current.length > 0) {
      parts.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(chunk);
    currentBytes += bytes;
  }
  if (current.length > 0 || parts.length === 0) parts.push(current);

  for (let i = 0; i < parts.length; i++) {
    await io.write(`${dir}/${chunksFile(i)}`, JSON.stringify(parts[i]));
    const withVecs = snap.dim
      ? parts[i]
          .filter((c) => byId.has(c.id))
          .map((c) => ({ id: c.id, vec: byId.get(c.id)! }))
      : [];
    await io.writeBinary(`${dir}/${vectorsFile(i)}`, encodeVectorPart(withVecs, snap.dim ?? 0));
  }

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    embedderId: snap.embedderId,
    dim: snap.dim,
    parts: parts.length,
    notes: snap.notes,
  };
  await io.write(`${dir}/manifest.json`, JSON.stringify(manifest));

  // Sweep leftovers from an earlier save that had more parts.
  for (const name of await io.list(dir)) {
    const m = /^(?:chunks|vectors)-(\d+)\.(?:json|bin)$/.exec(name);
    if (m && Number(m[1]) >= parts.length) await io.remove(`${dir}/${name}`);
  }
}

/**
 * Load a snapshot back. Returns null on ANY validation failure — a missing or
 * torn file, a schema bump, a bad header — because the index is always
 * rebuildable from the vault; corruption is an inconvenience, never an error
 * the user has to deal with.
 */
export async function loadIndex(io: FileIO, dir: string): Promise<IndexSnapshot | null> {
  try {
    const manifest = JSON.parse(await io.read(`${dir}/manifest.json`)) as Manifest;
    if (manifest.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Number.isInteger(manifest.parts) || manifest.parts < 0) return null;

    const chunks: Chunk[] = [];
    const vectors: IndexSnapshot["vectors"] = [];
    for (let i = 0; i < manifest.parts; i++) {
      const part = JSON.parse(await io.read(`${dir}/${chunksFile(i)}`)) as Chunk[];
      if (!Array.isArray(part)) return null;
      chunks.push(...part);
      if (manifest.dim) {
        vectors.push(...decodeVectorPart(await io.readBinary(`${dir}/${vectorsFile(i)}`), manifest.dim));
      }
    }
    if (!Array.isArray(manifest.notes)) return null;

    return {
      embedderId: manifest.embedderId,
      dim: manifest.dim,
      notes: manifest.notes,
      chunks,
      vectors,
    };
  } catch {
    return null;
  }
}
