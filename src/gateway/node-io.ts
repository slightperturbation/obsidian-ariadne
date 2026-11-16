import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import type { GatewayIO } from "./io";
import type { Ledger, LedgerEntry } from "./submit";

/**
 * The vault as a directory on disk. Paths are vault-relative; anything that
 * would escape the root, touch a dot-folder, or enter a refused folder (the
 * sealed ones) is treated as absent — even if the files are physically there.
 */
export class NodeIO implements GatewayIO {
  constructor(
    private root: string,
    private refused: (path: string) => boolean = () => false,
  ) {}

  private abs(path: string): string | null {
    const norm = nodePath.posix.normalize(path.replace(/\\/g, "/"));
    if (!norm || norm.startsWith("..") || norm.startsWith("/") || norm.split("/").some((s) => s.startsWith("."))) {
      return null;
    }
    if (this.refused(norm)) return null;
    return nodePath.join(this.root, norm);
  }

  async exists(path: string): Promise<boolean> {
    const abs = this.abs(path);
    if (!abs) return false;
    try {
      await fs.access(abs);
      return true;
    } catch {
      return false;
    }
  }

  async read(path: string): Promise<string> {
    const abs = this.abs(path);
    if (!abs) throw new Error(`no such file: ${path}`);
    return fs.readFile(abs, "utf8");
  }

  private async writeAtomic(abs: string, content: string): Promise<void> {
    await fs.mkdir(nodePath.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, abs);
  }

  async create(path: string, content: string): Promise<void> {
    const abs = this.abs(path);
    if (!abs) throw new Error(`refused path: ${path}`);
    if (await this.exists(path)) throw new Error(`exists: ${path}`);
    await this.writeAtomic(abs, content);
  }

  async modify(path: string, content: string): Promise<void> {
    const abs = this.abs(path);
    if (!abs) throw new Error(`refused path: ${path}`);
    await this.writeAtomic(abs, content);
  }

  async delete(path: string): Promise<void> {
    const abs = this.abs(path);
    if (!abs) return;
    await fs.rm(abs, { force: true });
  }

  async list(folder: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      if (rel && this.abs(rel) === null) return;
      let entries;
      try {
        entries = await fs.readdir(nodePath.join(this.root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(child);
        else if (e.isFile() && e.name.endsWith(".md") && this.abs(child)) out.push(child);
      }
    };
    await walk(folder.replace(/^\/+|\/+$/g, ""));
    return out.sort();
  }

  async mtime(path: string): Promise<number | null> {
    const abs = this.abs(path);
    if (!abs) return null;
    try {
      return (await fs.stat(abs)).mtimeMs;
    } catch {
      return null;
    }
  }
}

/** The idempotency ledger as one JSON file outside the vault. */
export class FileLedger implements Ledger {
  private entries: Map<string, LedgerEntry> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private file: string) {}

  private async load(): Promise<Map<string, LedgerEntry>> {
    if (this.entries) return this.entries;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, LedgerEntry>;
      this.entries = new Map(Object.entries(raw));
    } catch {
      this.entries = new Map();
    }
    return this.entries;
  }

  async get(key: string): Promise<LedgerEntry | undefined> {
    return (await this.load()).get(key);
  }

  async set(key: string, entry: LedgerEntry): Promise<void> {
    const entries = await this.load();
    entries.set(key, entry);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(nodePath.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(entries)), "utf8");
      await fs.rename(tmp, this.file);
    });
    await this.writing;
  }
}
