import { describe, expect, it } from "vitest";
import { saveIndex, loadIndex, type FileIO } from "../src/index/persistence";
import type { IndexSnapshot } from "../src/index/manager";
import type { Chunk } from "../src/core/types";

function memIO(): FileIO & { store: Map<string, string | ArrayBuffer> } {
  const store = new Map<string, string | ArrayBuffer>();
  const dirs = new Set<string>();
  return {
    store,
    exists: async (p) => store.has(p) || dirs.has(p),
    mkdir: async (p) => void dirs.add(p),
    read: async (p) => {
      const v = store.get(p);
      if (typeof v !== "string") throw new Error(`missing text file ${p}`);
      return v;
    },
    write: async (p, data) => void store.set(p, data),
    readBinary: async (p) => {
      const v = store.get(p);
      if (!(v instanceof ArrayBuffer)) throw new Error(`missing binary file ${p}`);
      return v;
    },
    writeBinary: async (p, data) => void store.set(p, data),
    remove: async (p) => void store.delete(p),
    list: async (dir) =>
      [...store.keys()]
        .filter((p) => p.startsWith(dir + "/"))
        .map((p) => p.slice(dir.length + 1))
        .filter((rest) => !rest.includes("/")),
  };
}

function chunk(path: string, ordinal: number, text: string): Chunk {
  return { id: `${path}#${ordinal}`, path, ordinal, text };
}

function normalized(seed: number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * 31 + i * 7);
  const norm = Math.hypot(...v);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
};

function sampleSnapshot(dim = 32): IndexSnapshot {
  const chunks = [chunk("a.md", 0, "alpha"), chunk("a.md", 1, "beta"), chunk("b.md", 0, "gamma")];
  return {
    embedderId: "test-embedder",
    dim,
    notes: [
      { path: "a.md", title: "a", mtime: 100, folder: "", linkCount: 2, chunkCount: 2 },
      { path: "b.md", title: "b", mtime: 200, folder: "x", type: "ref", linkCount: 0, chunkCount: 1 },
    ],
    chunks,
    vectors: chunks.map((c, i) => ({ id: c.id, vec: normalized(i + 1, dim) })),
  };
}

describe("index persistence", () => {
  it("round-trips notes, chunks, and vectors (int8 ≈ lossless for cosine)", async () => {
    const io = memIO();
    const snap = sampleSnapshot();
    await saveIndex(io, "idx", snap);
    const loaded = await loadIndex(io, "idx");

    expect(loaded).not.toBeNull();
    expect(loaded!.embedderId).toBe("test-embedder");
    expect(loaded!.notes).toEqual(snap.notes);
    expect(loaded!.chunks).toEqual(snap.chunks);
    expect(loaded!.vectors).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(loaded!.vectors[i].id).toBe(snap.vectors[i].id);
      expect(cosine(loaded!.vectors[i].vec, snap.vectors[i].vec)).toBeGreaterThan(0.999);
    }
  });

  it("round-trips a lexical-only snapshot (no vectors)", async () => {
    const io = memIO();
    const snap: IndexSnapshot = { ...sampleSnapshot(), embedderId: undefined, dim: undefined, vectors: [] };
    await saveIndex(io, "idx", snap);
    const loaded = await loadIndex(io, "idx");
    expect(loaded).not.toBeNull();
    expect(loaded!.vectors).toEqual([]);
    expect(loaded!.chunks).toHaveLength(3);
  });

  it("splits into multiple parts under a small budget and still loads", async () => {
    const io = memIO();
    const snap = sampleSnapshot();
    await saveIndex(io, "idx", snap, { partBudgetBytes: 80 });
    expect(io.store.has("idx/chunks-0.json")).toBe(true);
    expect(io.store.has("idx/chunks-1.json")).toBe(true);
    const loaded = await loadIndex(io, "idx");
    expect(loaded!.chunks).toEqual(snap.chunks);
    expect(loaded!.vectors).toHaveLength(3);
  });

  it("sweeps leftover parts from a previous larger save", async () => {
    const io = memIO();
    await saveIndex(io, "idx", sampleSnapshot(), { partBudgetBytes: 80 });
    expect(io.store.has("idx/chunks-1.json")).toBe(true);
    await saveIndex(io, "idx", sampleSnapshot()); // default budget → 1 part
    expect(io.store.has("idx/chunks-1.json")).toBe(false);
    expect(io.store.has("idx/vectors-1.bin")).toBe(false);
    expect((await loadIndex(io, "idx"))!.chunks).toHaveLength(3);
  });

  it("returns null on missing manifest, torn parts, or corrupt binary", async () => {
    const io = memIO();
    expect(await loadIndex(io, "idx")).toBeNull();

    await saveIndex(io, "idx", sampleSnapshot());
    io.store.delete("idx/chunks-0.json");
    expect(await loadIndex(io, "idx")).toBeNull();

    const io2 = memIO();
    await saveIndex(io2, "idx", sampleSnapshot());
    io2.store.set("idx/vectors-0.bin", new ArrayBuffer(4)); // bad header
    expect(await loadIndex(io2, "idx")).toBeNull();

    const io3 = memIO();
    await saveIndex(io3, "idx", sampleSnapshot());
    io3.store.set("idx/manifest.json", "{not json");
    expect(await loadIndex(io3, "idx")).toBeNull();
  });

  it("rejects snapshots from a different schema version", async () => {
    const io = memIO();
    await saveIndex(io, "idx", sampleSnapshot());
    const manifest = JSON.parse(io.store.get("idx/manifest.json") as string);
    manifest.schemaVersion = 999;
    io.store.set("idx/manifest.json", JSON.stringify(manifest));
    expect(await loadIndex(io, "idx")).toBeNull();
  });
});
