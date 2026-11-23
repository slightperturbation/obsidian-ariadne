import { App, MarkdownView, TFile, normalizePath, type Editor } from "obsidian";
import type { VaultIO } from "./framework";

/**
 * Replace `current` with `next` in an editor by the one smallest edit — the
 * text between their common start and common end — so the cursor, the
 * selection and the scroll stay where they were, and Cmd+Z takes it back.
 */
export function editInPlace(editor: Editor, current: string, next: string): void {
  let start = 0;
  const max = Math.min(current.length, next.length);
  while (start < max && current.charCodeAt(start) === next.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
  editor.replaceRange(next.slice(start, next.length - end), editor.offsetToPos(start), editor.offsetToPos(current.length - end));
}

export interface ObsidianVaultIOOptions {
  /**
   * Write a note that is open through its editor, not under it on disk, and
   * read it from there: what the owner sees and types is the note. Only one
   * copy of the text, so nothing typed can be lost to a write.
   */
  throughEditor?: boolean;
  /** Told of text just put into a note's editor, so that this edit is not taken for the owner typing. */
  onEditorWrite?: (path: string, text: string) => void;
}

/**
 * VaultIO over Obsidian's typed vault API. Reads are fresh (vault.read, not
 * cachedRead) because conflict checks must see the truth on disk. Deletes go
 * to the trash unconditionally — never a hard delete — since the framework's
 * in-memory undo doesn't survive a restart and the trash does.
 */
export class ObsidianVaultIO implements VaultIO {
  constructor(
    private app: App,
    private opts: ObsidianVaultIOOptions = {},
  ) {}

  /** The open view of a note, when there is one (and writing through editors is on). */
  private view(path: string): MarkdownView | undefined {
    if (!this.opts.throughEditor) return undefined;
    const p = normalizePath(path);
    let found: MarkdownView | undefined;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view instanceof MarkdownView && leaf.view.file?.path === p) found = leaf.view;
    });
    return found;
  }

  /** A note's text as its open editor holds it — unsaved typing included — or undefined when it is not open. */
  openText(path: string): string | undefined {
    const v = this.view(path);
    return v ? (v.editor ? v.editor.getValue() : v.getViewData()) : undefined;
  }

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
    const open = this.openText(path);
    return open ?? this.app.vault.read(f);
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
    if (this.view(path)) return this.process(path, () => content);
    await this.app.vault.modify(f, content);
  }

  async process(path: string, fn: (current: string) => string): Promise<void> {
    const f = this.file(path);
    if (!f) throw new Error(`not found: ${path}`);
    const v = this.view(path);
    if (v) {
      // In the editor: read, check and change in one step of the app's single thread, so no keystroke can land
      // between them; then saved, so the file says what the editor says.
      const editor = v.editor;
      const current = editor ? editor.getValue() : v.getViewData();
      const next = fn(current);
      if (next === current) return;
      this.opts.onEditorWrite?.(f.path, next);
      if (editor) {
        editInPlace(editor, current, next);
        if (editor.getValue() !== next) throw new Error(`"${path}" could not be changed in its editor`);
      } else {
        v.setViewData(next, false);
      }
      await v.save();
      return;
    }
    // vault.process reads and writes in one step, so nothing can land between the check and the write.
    await this.app.vault.process(f, fn);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.file(from);
    if (!f) throw new Error(`not found: ${from}`);
    const target = normalizePath(to);
    const parent = target.split("/").slice(0, -1).join("/");
    if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
      await this.app.vault.createFolder(parent).catch(() => {
        /* concurrent creation is fine */
      });
    }
    // fileManager, not vault.rename: links to the note are rewritten (as the
    // user's "Automatically update internal links" setting says), exactly as
    // when the user moves a note themselves.
    await this.app.fileManager.renameFile(f, target);
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
