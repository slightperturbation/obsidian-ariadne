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

const SCHEMA_VERSION = 2;
const MAGIC = 0x41524941; // "ARIA"
/** Per-part JSON budget — comfortably under Obsidian Sync's 5 MB/file cap. */
const PART_BUDGET_BYTES = 3_000_000;
/** Reshard when a part outgrows the budget; also the initial part count. */
const MIN_PARTS = 4;

interface Manifest {
  schemaVersion: number;
  embedderId?: string;
  dim?: number;
  parts: number;
  notes: NoteMeta[];
}

const chunksFile = (i: number) => `chunks-${i}.json`;
const vectorsFile = (i: number) => `vectors-${i}.bin`;

/* ── Sharding ─────────────────────────────────────────────────────────── */

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Which part a note's chunks live in. Sharding by path (rather than packing
 * parts by size in document order) is what makes delta writes possible: a
 * note's chunks always land in the same part, so editing one note dirties one
 * part instead of reshuffling everything downstream of it.
 */
export function partOf(path: string, parts: number): number {
  return fnv1a(path) % parts;
}

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
  // Every record needs at least 2 + 4 + dim bytes, so a count that couldn't
  // possibly fit in the file means it's truncated or corrupt.
  if (8 + count * (6 + dim) > buf.byteLength) throw new Error("vector part truncated");

  const out: Array<{ id: string; vec: Float32Array }> = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    if (off + 2 > buf.byteLength) throw new Error("vector part truncated");
    const idLen = view.getUint16(off, true);
    off += 2;
    // Bounds-check BEFORE slicing: TypedArray.subarray CLAMPS out-of-range
    // indices instead of throwing, so a file truncated mid-record used to
    // yield an undersized vector that passed validation and then blew up
    // downstream in the vector store.
    if (off + idLen + 4 + dim > buf.byteLength) throw new Error("vector part truncated");
    const id = dec.decode(bytes.subarray(off, off + idLen));
    off += idLen;
    const scale = view.getFloat32(off, true);
    off += 4;
    const data = new Int8Array(bytes.subarray(off, off + dim));
    off += dim;
    if (data.length !== dim) throw new Error("vector part truncated");
    out.push({ id, vec: dequantize(scale, data) });
  }
  return out;
}

/* ── save / load ──────────────────────────────────────────────────────── */

export interface SaveOptions {
  /**
   * Note paths changed since the last successful save. When given (and the
   * shard count is unchanged) only the parts holding those notes are
   * rewritten; otherwise every part is.
   */
  dirtyPaths?: ReadonlySet<string>;
  /** Test seam. */
  partBudgetBytes?: number;
}

/**
 * Persist a snapshot as sharded files under dir.
 *
 * The manifest is written LAST, so an interrupted save leaves the previous
 * manifest describing the previous generation. Parts are sharded by note path,
 * which keeps a normal save proportional to what actually changed rather than
 * to the size of the vault.
 */
export async function saveIndex(
  io: FileIO,
  dir: string,
  snap: IndexSnapshot,
  opts: SaveOptions = {},
): Promise<void> {
  if (!(await io.exists(dir))) await io.mkdir(dir);
  const budget = opts.partBudgetBytes ?? PART_BUDGET_BYTES;

  const previous = await readManifest(io, dir);
  let parts = previous?.parts ?? MIN_PARTS;

  const byId = new Map(snap.vectors.map((v) => [v.id, v.vec]));

  // Group chunks into shards, and grow the shard count if any shard would
  // exceed the per-file budget (a reshard rewrites everything, but is rare).
  let shards: Chunk[][] = [];
  for (;;) {
    shards = Array.from({ length: parts }, () => [] as Chunk[]);
    for (const chunk of snap.chunks) shards[partOf(chunk.path, parts)].push(chunk);
    const worst = shards.reduce((max, s) => Math.max(max, JSON.stringify(s).length), 0);
    if (worst <= budget || parts >= 1024) break;
    parts *= 2;
  }

  const resharded = parts !== previous?.parts;
  const dirtyParts = new Set<number>();
  if (!resharded && opts.dirtyPaths) {
    for (const path of opts.dirtyPaths) dirtyParts.add(partOf(path, parts));
  }
  const writeAll = resharded || !opts.dirtyPaths;

  for (let i = 0; i < parts; i++) {
    if (!writeAll && !dirtyParts.has(i)) continue;
    await io.write(`${dir}/${chunksFile(i)}`, JSON.stringify(shards[i]));
    const withVecs = snap.dim
      ? shards[i].filter((c) => byId.has(c.id)).map((c) => ({ id: c.id, vec: byId.get(c.id)! }))
      : [];
    await io.writeBinary(`${dir}/${vectorsFile(i)}`, encodeVectorPart(withVecs, snap.dim ?? 0));
  }

  const manifest: Manifest = {
    schemaVersion: SCHEMA_VERSION,
    embedderId: snap.embedderId,
    dim: snap.dim,
    parts,
    notes: snap.notes,
  };
  await io.write(`${dir}/manifest.json`, JSON.stringify(manifest));

  // Sweep parts left over from a previous, larger shard count.
  for (const name of await io.list(dir)) {
    const m = /^(?:chunks|vectors)-(\d+)\.(?:json|bin)$/.exec(name);
    if (m && Number(m[1]) >= parts) await io.remove(`${dir}/${name}`);
  }
}

async function readManifest(io: FileIO, dir: string): Promise<Manifest | null> {
  try {
    const manifest = JSON.parse(await io.read(`${dir}/manifest.json`)) as Manifest;
    if (manifest.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Number.isInteger(manifest.parts) || manifest.parts < 1) return null;
    if (!Array.isArray(manifest.notes)) return null;
    return manifest;
  } catch {
    return null;
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
    const manifest = await readManifest(io, dir);
    if (!manifest) return null;

    const chunks: Chunk[] = [];
    const vectors: IndexSnapshot["vectors"] = [];
    for (let i = 0; i < manifest.parts; i++) {
      const part = JSON.parse(await io.read(`${dir}/${chunksFile(i)}`)) as Chunk[];
      if (!Array.isArray(part)) return null;
      chunks.push(...part);
      if (manifest.dim) {
        vectors.push(
          ...decodeVectorPart(await io.readBinary(`${dir}/${vectorsFile(i)}`), manifest.dim),
        );
      }
    }

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
