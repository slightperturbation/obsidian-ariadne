import { App, TFile, normalizePath } from "obsidian";
import type { VaultIO } from "./framework";

/**
 * VaultIO over Obsidian's typed vault API. Reads are fresh (vault.read, not
 * cachedRead) because conflict checks must see the truth on disk. Deletes go
 * to the trash unconditionally — never a hard delete — since the framework's
 * in-memory undo doesn't survive a restart and the trash does.
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
    // vault.trash(f, true) — system trash with a fallback to the vault's local
    // .trash. Deliberately NOT fileManager.trashFile(), which honors the
    // vault's "Deleted files" preference and will hard-delete for anyone who
    // set it to "Permanently delete". Our undo stack is in-memory and gone
    // after a restart, so the trash is the only durable safety net.
    await this.app.vault.trash(f, true);
  }
}
