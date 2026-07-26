import { describe, expect, it } from "vitest";
import { saveIndex, loadIndex, partOf, type FileIO } from "../src/index/persistence";
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
    // Chunks are sharded by note path, so order across shards isn't document
    // order — compare as sets.
    expect([...loaded!.chunks].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...snap.chunks].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(loaded!.vectors).toHaveLength(3);
    for (const original of snap.vectors) {
      const round = loaded!.vectors.find((v) => v.id === original.id)!;
      expect(cosine(round.vec, original.vec)).toBeGreaterThan(0.999);
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

  it("reshards when a part outgrows the budget, and still loads", async () => {
    const io = memIO();
    const snap = sampleSnapshot();
    await saveIndex(io, "idx", snap, { partBudgetBytes: 40 });
    const manifest = JSON.parse(io.store.get("idx/manifest.json") as string);
    expect(manifest.parts).toBeGreaterThan(4);
    const loaded = await loadIndex(io, "idx");
    expect(loaded!.chunks).toHaveLength(3);
    expect(loaded!.vectors).toHaveLength(3);
  });

  it("sweeps parts left over from a previous, larger shard count", async () => {
    const io = memIO();
    await saveIndex(io, "idx", sampleSnapshot(), { partBudgetBytes: 40 });
    const wide = JSON.parse(io.store.get("idx/manifest.json") as string).parts as number;
    expect(io.store.has(`idx/chunks-${wide - 1}.json`)).toBe(true);

    // Start clean so the shard count drops back to the minimum.
    const io2 = memIO();
    await saveIndex(io2, "idx", sampleSnapshot());
    const narrow = JSON.parse(io2.store.get("idx/manifest.json") as string).parts as number;
    expect(narrow).toBeLessThan(wide);
    expect(io2.store.has(`idx/chunks-${narrow}.json`)).toBe(false);
    expect((await loadIndex(io2, "idx"))!.chunks).toHaveLength(3);
  });

  it("delta save rewrites only the shards holding changed notes", async () => {
    const io = memIO();
    const snap = sampleSnapshot();
    await saveIndex(io, "idx", snap);

    const before = new Map(io.store);
    // Change only a.md's content and save with it marked dirty.
    const edited: IndexSnapshot = {
      ...snap,
      chunks: snap.chunks.map((c) =>
        c.path === "a.md" ? { ...c, text: `${c.text} (edited)` } : c,
      ),
    };
    await saveIndex(io, "idx", edited, { dirtyPaths: new Set(["a.md"]) });

    const aPart = partOf("a.md", 4);
    const bPart = partOf("b.md", 4);
    expect(io.store.get(`idx/chunks-${aPart}.json`)).not.toBe(
      before.get(`idx/chunks-${aPart}.json`),
    );
    if (bPart !== aPart) {
      // b.md's shard is untouched — that is the whole point of sharding.
      expect(io.store.get(`idx/chunks-${bPart}.json`)).toBe(
        before.get(`idx/chunks-${bPart}.json`),
      );
    }
    const loaded = await loadIndex(io, "idx");
    expect(loaded!.chunks.find((c) => c.path === "a.md")!.text).toContain("(edited)");
  });

  it("detects a truncated vector part instead of returning a short vector", async () => {
    const io = memIO();
    await saveIndex(io, "idx", sampleSnapshot());
    // Find a vectors part that actually has records and chop its tail.
    for (const [key, val] of io.store) {
      if (key.endsWith(".bin") && val instanceof ArrayBuffer && val.byteLength > 16) {
        io.store.set(key, val.slice(0, val.byteLength - 3));
        break;
      }
    }
    // subarray CLAMPS rather than throwing, so this used to yield an
    // undersized vector that passed validation and blew up in the store.
    expect(await loadIndex(io, "idx")).toBeNull();
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
