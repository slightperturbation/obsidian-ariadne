// MUST be first: scrubs the Node globals Obsidian leaks into workers before
// transformers.js (imported transitively below) runs its environment detection.
import "./strip-node-env";
import { TransformersEmbedder } from "./transformers-provider";
import { VectorStore } from "../vectorstore";
import type { WorkerRequest, WorkerResponse } from "./worker-protocol";

/**
 * Web Worker entry: hosts the embedding model AND the vector store.
 *
 * Two reasons they live together off the main thread. First, environment: a
 * worker has no `process`, so transformers.js detects a browser and uses the
 * WASM backend (in Obsidian's renderer it mis-detects Node). Second, latency:
 * the brute-force cosine scan is ~150 ms at 30k vectors, which on the main
 * thread is a visible freeze on every typing pause — and keeping the model
 * next to the vectors means indexing and querying each take ONE round trip,
 * with vectors never crossing the thread boundary at all.
 */

declare const self: {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

let embedder: TransformersEmbedder | undefined;
let store: VectorStore | undefined;

function pack(vectors: Float32Array[], dim: number): ArrayBuffer {
  const out = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => out.set(v, i * dim));
  return out.buffer;
}

function requireEmbedder(): TransformersEmbedder {
  if (!embedder) throw new Error("worker not initialized");
  return embedder;
}

function requireStore(): VectorStore {
  if (!store) throw new Error("worker not initialized");
  return store;
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as WorkerRequest;
  void (async () => {
    try {
      switch (msg.type) {
        case "init": {
          embedder = new TransformersEmbedder(msg.model, {
            ortWasmPaths: msg.wasmPaths,
            device: "wasm",
          });
          await embedder.ready();
          store = new VectorStore(embedder.dim);
          self.postMessage({ type: "ready", id: msg.id });
          break;
        }

        case "embed": {
          const e = requireEmbedder();
          const buffer = pack(await e.embed(msg.texts), e.dim);
          self.postMessage({ type: "vectors", id: msg.id, dim: e.dim, buffer }, [buffer]);
          break;
        }

        case "embedQuery": {
          const e = requireEmbedder();
          const buffer = pack([await e.embedQuery(msg.text)], e.dim);
          self.postMessage({ type: "vectors", id: msg.id, dim: e.dim, buffer }, [buffer]);
          break;
        }

        case "vec:index": {
          // Atomic replace: embed this note's chunks and swap them in for
          // whatever the path had, so a note is never left partly indexed.
          const e = requireEmbedder();
          const s = requireStore();
          const vecs = await e.embed(msg.entries.map((entry) => entry.text));
          s.replacePath(
            msg.path,
            msg.entries.map((entry, i) => ({ ...entry, vec: vecs[i] })),
          );
          self.postMessage({ type: "ok", id: msg.id });
          break;
        }

        case "vec:upsert": {
          // Bulk load of precomputed vectors (warm start from a snapshot).
          const s = requireStore();
          const flat = new Float32Array(msg.buffer);
          msg.ids.forEach((id, i) => {
            s.upsert(id, msg.path, flat.subarray(i * s.dim, (i + 1) * s.dim));
          });
          self.postMessage({ type: "ok", id: msg.id });
          break;
        }

        case "vec:remove": {
          requireStore().removePath(msg.path);
          self.postMessage({ type: "ok", id: msg.id });
          break;
        }

        case "vec:clear": {
          const s = requireStore();
          store = new VectorStore(s.dim);
          self.postMessage({ type: "ok", id: msg.id });
          break;
        }

        case "vec:search": {
          const hits = requireStore().searchSync(
            new Float32Array(msg.buffer),
            msg.limit,
            msg.floor,
          );
          self.postMessage({ type: "hits", id: msg.id, hits });
          break;
        }

        case "vec:embedSearch": {
          const e = requireEmbedder();
          const s = requireStore();
          const vec = msg.asQuery ? await e.embedQuery(msg.text) : (await e.embed([msg.text]))[0];
          self.postMessage({
            type: "hits",
            id: msg.id,
            hits: s.searchSync(vec, msg.limit, msg.floor),
          });
          break;
        }

        case "vec:ofPath": {
          const s = requireStore();
          const vecs = s.vectorsOfPathSync(msg.path);
          const buffer = pack(vecs, s.dim);
          self.postMessage(
            { type: "entries", id: msg.id, ids: vecs.map((_, i) => String(i)), dim: s.dim, buffer },
            [buffer],
          );
          break;
        }

        case "vec:entries": {
          const s = requireStore();
          const all = s.entriesSync();
          const buffer = pack(
            all.map(([, v]) => v),
            s.dim,
          );
          self.postMessage(
            { type: "entries", id: msg.id, ids: all.map(([id]) => id), dim: s.dim, buffer },
            [buffer],
          );
          break;
        }
      }
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, message: String(err) });
    }
  })();
};
