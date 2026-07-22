// MUST be first: scrubs the Node globals Obsidian leaks into workers before
// transformers.js (imported transitively below) runs its environment detection.
import "./strip-node-env";
import { TransformersEmbedder } from "./transformers-provider";
import type { OrtWasmPaths } from "./transformers-provider";

/**
 * Web Worker entry: hosts the transformers.js embedder off the UI thread.
 * Crucially, a worker has no `process`, so transformers.js correctly detects
 * a browser environment and uses the WASM backend — in Obsidian's renderer it
 * mis-detects Node and demands native runtimes that aren't there. Bundled
 * separately (embed-worker.js) and instantiated from a blob: URL.
 */

export type WorkerRequest =
  | { type: "init"; id: number; model: string; wasmPaths?: OrtWasmPaths }
  | { type: "embed"; id: number; texts: string[] }
  | { type: "embedQuery"; id: number; text: string };

export type WorkerResponse =
  | { type: "ready"; id: number }
  | { type: "vectors"; id: number; dim: number; buffer: ArrayBuffer }
  | { type: "error"; id: number; message: string };

// Dedicated-worker global surface, declared locally to avoid pulling the
// webworker lib into a DOM-configured program.
declare const self: {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

let embedder: TransformersEmbedder | undefined;

function pack(vectors: Float32Array[], dim: number): ArrayBuffer {
  const out = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => out.set(v, i * dim));
  return out.buffer;
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
          self.postMessage({ type: "ready", id: msg.id });
          break;
        }
        case "embed": {
          if (!embedder) throw new Error("worker not initialized");
          const vecs = await embedder.embed(msg.texts);
          const buffer = pack(vecs, embedder.dim);
          self.postMessage({ type: "vectors", id: msg.id, dim: embedder.dim, buffer }, [buffer]);
          break;
        }
        case "embedQuery": {
          if (!embedder) throw new Error("worker not initialized");
          const vec = await embedder.embedQuery(msg.text);
          const buffer = pack([vec], embedder.dim);
          self.postMessage({ type: "vectors", id: msg.id, dim: embedder.dim, buffer }, [buffer]);
          break;
        }
      }
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, message: String(err) });
    }
  })();
};
