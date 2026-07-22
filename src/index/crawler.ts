import { App, TFile } from "obsidian";
import type { NoteSource, SourceNote } from "../core/types";

/**
 * The runtime adapter between Obsidian's Vault/MetadataCache and the
 * Obsidian-free retrieval core. Reads are always `cachedRead` (we never need
 * disk-fresh content for indexing) and structure comes from the metadata cache,
 * so crawling a vault does no parsing work of its own and never writes.
 */
export class VaultNoteSource implements NoteSource {
  constructor(private app: App) {}

  /** Every markdown note in the vault, loaded through the cache. */
  async all(): Promise<SourceNote[]> {
    const files = this.app.vault.getMarkdownFiles();
    const notes: SourceNote[] = [];
    for (const file of files) notes.push(await this.load(file));
    return notes;
  }

  /** All markdown paths, cheap — used to seed the incremental scheduler. */
  paths(): string[] {
    return this.app.vault.getMarkdownFiles().map((f) => f.path);
  }

  /** Path + mtime pairs, cheap — the warm-start stale diff compares these. */
  stats(): Array<{ path: string; mtime: number }> {
    return this.app.vault.getMarkdownFiles().map((f) => ({ path: f.path, mtime: f.stat.mtime }));
  }

  /** Load one note by path; null if it no longer exists or isn't markdown. */
  async loadPath(path: string): Promise<SourceNote | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== "md") return null;
    return this.load(file);
  }

  async load(file: TFile): Promise<SourceNote> {
    const content = await this.app.vault.cachedRead(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter ? { ...cache.frontmatter } : undefined;
    const linkCount = (cache?.links?.length ?? 0) + (cache?.embeds?.length ?? 0);
    const parent = file.parent?.path ?? "";
    return {
      path: file.path,
      title: file.basename,
      content,
      mtime: file.stat.mtime,
      folder: parent === "/" ? "" : parent,
      frontmatter,
      linkCount,
    };
  }
}
