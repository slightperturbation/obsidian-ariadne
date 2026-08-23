import { App, TFile } from "obsidian";
import type { NoteSource, SourceNote } from "../core/types";

/** A folder-prefix string or a regex (Obsidian "Excluded files" style). */
export type ExclusionFilter = string | RegExp;

/** Pure so exclusion semantics are testable without Obsidian. */
export function isExcludedPath(path: string, filters: ExclusionFilter[]): boolean {
  for (const f of filters) {
    if (typeof f === "string") {
      if (f.length > 0 && (path === f || path.startsWith(`${f}/`))) return true;
    } else if (f.test(path)) return true;
  }
  return false;
}

/**
 * The runtime adapter between Obsidian's Vault/MetadataCache and the
 * Obsidian-free retrieval core. Reads are always `cachedRead` (we never need
 * disk-fresh content for indexing) and structure comes from the metadata cache,
 * so crawling a vault does no parsing work of its own and never writes.
 */
export class VaultNoteSource implements NoteSource {
  constructor(
    private app: App,
    /** Folders/patterns Ariadne must not see (settings + Obsidian's own
     * Excluded files). Filtering lives HERE — at the single mouth of the
     * pipeline — so exclusion means excluded everywhere: indexing, retrieval,
     * and (via the stale diff, which treats a path missing from stats() as
     * deleted) cleanup of anything indexed before the rule existed. */
    private excluded: () => ExclusionFilter[] = () => [],
  ) {}

  private files(): TFile[] {
    const filters = this.excluded();
    const all = this.app.vault.getMarkdownFiles();
    return filters.length === 0 ? all : all.filter((f) => !isExcludedPath(f.path, filters));
  }

  /** Every markdown note in the vault, loaded through the cache. */
  async all(): Promise<SourceNote[]> {
    const notes: SourceNote[] = [];
    for (const file of this.files()) notes.push(await this.load(file));
    return notes;
  }

  /** All markdown paths, cheap — used to seed the incremental scheduler. */
  paths(): string[] {
    return this.files().map((f) => f.path);
  }

  /** Path + mtime pairs, cheap — the warm-start stale diff compares these. */
  stats(): Array<{ path: string; mtime: number }> {
    return this.files().map((f) => ({ path: f.path, mtime: f.stat.mtime }));
  }

  /** Load one note by path; null if it no longer exists, isn't markdown, or
   * is excluded — the scheduler treats null as "remove from the index". */
  async loadPath(path: string): Promise<SourceNote | null> {
    if (isExcludedPath(path, this.excluded())) return null;
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
