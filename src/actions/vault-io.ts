import { App, TFile, normalizePath } from "obsidian";
import type { VaultIO } from "./framework";

/**
 * VaultIO over Obsidian's typed vault API. Reads are fresh (vault.read, not
 * cachedRead) because conflict checks must see the truth on disk. Deletes go
 * to Obsidian's trash, never a hard delete — the framework's undo can restore
 * content, but the trash is the belt-and-suspenders layer beneath it.
 */
export class ObsidianVaultIO implements VaultIO {
  constructor(private app: App) {}

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  }

  async exists(path: string): Promise<boolean> {
    return this.file(path) !== null;
  }

  async read(path: string): Promise<string> {
    const f = this.file(path);
    if (!f) throw new Error(`not found: ${path}`);
    return this.app.vault.read(f);
  }

  async create(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const parent = normalized.split("/").slice(0, -1).join("/");
    if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
      await this.app.vault.createFolder(parent).catch(() => {
        /* concurrent creation is fine */
      });
    }
    await this.app.vault.create(normalized, content);
  }

  async modify(path: string, content: string): Promise<void> {
    const f = this.file(path);
    if (!f) throw new Error(`not found: ${path}`);
    await this.app.vault.modify(f, content);
  }

  async delete(path: string): Promise<void> {
    const f = this.file(path);
    if (!f) throw new Error(`not found: ${path}`);
    await this.app.fileManager.trashFile(f);
  }
}
