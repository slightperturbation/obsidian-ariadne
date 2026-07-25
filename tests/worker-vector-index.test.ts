import { describe, expect, it } from "vitest";
import { WorkerVectorIndex } from "../src/index/embeddings/worker-vector-index";
import { VectorStore } from "../src/index/vectorstore";
import { HashEmbedder } from "../src/index/embeddings/hash-embedder";
import { IndexManager } from "../src/index/manager";
import type { WorkerRequest, WorkerResponse } from "../src/index/embeddings/worker-protocol";
import type { WorkerClient } from "../src/index/embeddings/worker-client";
import type { SourceNote } from "../src/core/types";

/**
 * A stand-in for the real worker: runs the same VectorStore + embedder the
 * worker would, in-process, and records the message order so we can assert the
 * protocol's contracts without spinning up a Worker in the test environment.
 */
function fakeWorker(dim = 64) {
  const store = new VectorStore(dim);
  const embedder = new HashEmbedder(dim);
  const seen: string[] = [];

  const handle = async (msg: WorkerRequest): Promise<WorkerResponse> => {
    seen.push(msg.type);
    switch (msg.type) {
      case "vec:index": {
        const vecs = await embedder.embed(msg.entries.map((e) => e.text));
        store.replacePath(
          msg.path,
          msg.entries.map((e, i) => ({ ...e, vec: vecs[i] })),
        );
        return { type: "ok", id: msg.id };
      }
      case "vec:upsert": {
        const flat = new Float32Array(msg.buffer);
        msg.ids.forEach((id, i) => {
          store.upsert(id, msg.path, flat.subarray(i * dim, (i + 1) * dim));
        });
        return { type: "ok", id: msg.id };
      }
      case "vec:remove":
        store.removePath(msg.path);
        return { type: "ok", id: msg.id };
      case "vec:search":
        return {
          type: "hits",
          id: msg.id,
          hits: store.searchSync(new Float32Array(msg.buffer), msg.limit, msg.floor),
        };
      case "vec:embedSearch": {
        const [vec] = await embedder.embed([msg.text]);
        return { type: "hits", id: msg.id, hits: store.searchSync(vec, msg.limit, msg.floor) };
      }
      case "vec:entries": {
        const all = store.entriesSync();
        const flat = new Float32Array(all.length * dim);
        all.forEach(([, v], i) => flat.set(v, i * dim));
        return {
          type: "entries",
          id: msg.id,
          ids: all.map(([id]) => id),
          dim,
          buffer: flat.buffer,
        };
      }
      default:
        return { type: "ok", id: msg.id };
    }
  };

  // Queue posts so ordering is observable, mirroring postMessage FIFO.
  let chain: Promise<unknown> = Promise.resolve();
  const client = {
    ready: async () => {},
    request: (build: (id: number) => WorkerRequest) => {
      const run = chain.then(() => handle(build(1)));
      chain = run.catch(() => {});
      return run;
    },
    post: (build: (id: number) => WorkerRequest) => {
      chain = chain.then(() => handle(build(1))).catch(() => {});
    },
    dispose: () => {},
  } as unknown as WorkerClient;

  return { client, store, seen, settled: () => chain };
}

const note = (path: string, content: string): SourceNote => ({
  path,
  title: path.replace(/\.md$/, ""),
  content,
  mtime: 1000,
  folder: "",
});

describe("WorkerVectorIndex", () => {
  it("searches through the worker and returns its hits", async () => {
    const { client, store } = fakeWorker(8);
    store.upsert("a", "a.md", [1, 0, 0, 0, 0, 0, 0, 0]);
    store.upsert("b", "b.md", [0, 1, 0, 0, 0, 0, 0, 0]);
    const index = new WorkerVectorIndex(8, client);

    const hits = await index.search([1, 0, 0, 0, 0, 0, 0, 0], 10, -1);
    expect(hits[0].id).toBe("a");
  });

  it("indexTexts embeds and stores in one message, replacing the path", async () => {
    const { client, store, seen } = fakeWorker();
    const index = new WorkerVectorIndex(64, client);

    await index.indexTexts("n.md", [
      { id: "n#0", text: "cats are mammals" },
      { id: "n#1", text: "taxes are due" },
    ]);
    expect(store.size).toBe(2);
    // One message, not an embed round-trip plus per-chunk upserts.
    expect(seen).toEqual(["vec:index"]);

    await index.indexTexts("n.md", [{ id: "n#0", text: "cats are mammals" }]);
    expect(store.size).toBe(1);
  });

  it("applies fire-and-forget mutations before a later search", async () => {
    const { client, settled } = fakeWorker(8);
    const index = new WorkerVectorIndex(8, client);

    // upsert is posted without awaiting; the ordering guarantee is what makes
    // that safe, so the subsequent search must see it.
    index.upsert("a", "a.md", [1, 0, 0, 0, 0, 0, 0, 0]);
    const hits = await index.search([1, 0, 0, 0, 0, 0, 0, 0], 10, -1);
    await settled();
    expect(hits.map((h) => h.id)).toContain("a");
  });

  it("removePath posted before a search is reflected in that search", async () => {
    const { client, settled } = fakeWorker(8);
    const index = new WorkerVectorIndex(8, client);
    index.upsert("a", "a.md", [1, 0, 0, 0, 0, 0, 0, 0]);
    index.removePath("a.md");
    const hits = await index.search([1, 0, 0, 0, 0, 0, 0, 0], 10, -1);
    await settled();
    expect(hits).toHaveLength(0);
  });

  it("entries() round-trips vectors back for persistence", async () => {
    const { client } = fakeWorker(8);
    const index = new WorkerVectorIndex(8, client);
    index.upsertMany("n.md", [
      { id: "n#0", vec: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]) },
      { id: "n#1", vec: new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]) },
    ]);
    const entries = await index.entries();
    expect(entries.map(([id]) => id).sort()).toEqual(["n#0", "n#1"]);
    expect(entries[0][1]).toHaveLength(8);
  });
});

describe("IndexManager with a worker-hosted vector index", () => {
  it("routes indexing through indexTexts and still searches end to end", async () => {
    const { client, seen } = fakeWorker();
    const manager = new IndexManager();
    const index = new WorkerVectorIndex(64, client);
    manager.setEmbedder(new HashEmbedder(64), index);

    await manager.indexNote(note("cats.md", "Cats are small carnivorous mammals kept as pets."));
    await manager.indexNote(note("taxes.md", "Quarterly estimated tax payments are due."));

    // The manager used the combined path, so no vectors crossed the boundary.
    expect(seen.filter((t) => t === "vec:index")).toHaveLength(2);

    const hits = await manager.query("carnivorous mammals");
    expect(hits.map((r) => r.path)).toContain("cats.md");
  });

  it("keeps a note's vectors when indexTexts already replaced them", async () => {
    const { client, store } = fakeWorker();
    const manager = new IndexManager();
    manager.setEmbedder(new HashEmbedder(64), new WorkerVectorIndex(64, client));

    await manager.indexNote(note("n.md", "alpha beta gamma"));
    const afterFirst = store.size;
    expect(afterFirst).toBeGreaterThan(0);

    // Re-indexing must not delete what the atomic replace just wrote.
    await manager.indexNote(note("n.md", "alpha beta gamma delta"));
    expect(store.size).toBeGreaterThan(0);
  });
});
