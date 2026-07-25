import type { OrtWasmPaths } from "./transformers-provider";
import type { IndexEntry, VectorHit } from "../vector-index";

/**
 * Messages between the main thread and the index worker. The worker hosts both
 * the embedding model AND the vector store, so the two operations that pair
 * them — index (embed + store) and embedAndSearch — never move vectors across
 * the thread boundary.
 */
export type WorkerRequest =
  | { type: "init"; id: number; model: string; wasmPaths?: OrtWasmPaths }
  | { type: "embed"; id: number; texts: string[] }
  | { type: "embedQuery"; id: number; text: string }
  | { type: "vec:index"; id: number; path: string; entries: IndexEntry[] }
  | { type: "vec:upsert"; id: number; path: string; ids: string[]; buffer: ArrayBuffer }
  | { type: "vec:remove"; id: number; path: string }
  | { type: "vec:clear"; id: number }
  | { type: "vec:search"; id: number; buffer: ArrayBuffer; limit: number; floor: number }
  | {
      type: "vec:embedSearch";
      id: number;
      text: string;
      asQuery: boolean;
      limit: number;
      floor: number;
    }
  | { type: "vec:entries"; id: number };

export type WorkerResponse =
  | { type: "ready"; id: number }
  | { type: "ok"; id: number }
  | { type: "vectors"; id: number; dim: number; buffer: ArrayBuffer }
  | { type: "hits"; id: number; hits: VectorHit[] }
  | { type: "entries"; id: number; ids: string[]; dim: number; buffer: ArrayBuffer }
  | { type: "error"; id: number; message: string };
