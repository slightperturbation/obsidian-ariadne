import type { VaultIO } from "../actions/framework";

/**
 * The vault surface the gateway needs. Obsidian-free: the plugin adapts the
 * vault adapter to it, the headless service adapts node:fs.
 */
export interface GatewayIO extends VaultIO {
  /** Vault-relative paths of every Markdown file under a folder ("" = whole vault). */
  list(folder: string): Promise<string[]>;
  /** Modification time (ms), or null when absent. */
  mtime(path: string): Promise<number | null>;
}

/** Small, fast, synchronous content hash (cyrb53) — change detection only. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** In-memory IO for tests. */
export class MemoryIO implements GatewayIO {
  files = new Map<string, { content: string; mtime: number }>();
  private clock = 1;
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async read(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) throw new Error(`no such file: ${path}`);
    return f.content;
  }
  async create(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`exists: ${path}`);
    this.files.set(path, { content, mtime: this.clock++ });
  }
  async modify(path: string, content: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`no such file: ${path}`);
    this.files.set(path, { content, mtime: this.clock++ });
  }
  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }
  async list(folder: string): Promise<string[]> {
    const prefix = folder ? `${folder.replace(/\/+$/, "")}/` : "";
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith(".md")).sort();
  }
  async mtime(path: string): Promise<number | null> {
    return this.files.get(path)?.mtime ?? null;
  }
}
