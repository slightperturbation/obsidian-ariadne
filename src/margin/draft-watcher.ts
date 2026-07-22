import type { Editor, MarkdownView } from "obsidian";
import { paragraphAround, paragraphKey } from "./context";

/** What the writer is working on right now — the input to Margin + ghost. */
export interface DraftContext {
  path: string;
  title: string;
  /** Paragraph around the cursor (empty on a blank line). */
  text: string;
  /** Full note text, for already-linked checks. */
  noteText: string;
  /** Cursor position, for ghost anchoring. */
  cursorLine: number;
  cursorCh: number;
  /** Character immediately before the cursor ("" at line start). */
  charBefore: string;
  /** Character immediately after the cursor ("" at line end). */
  charAfter: string;
  /** The cursor's line up to the cursor — for unclosed-wikilink detection. */
  lineBefore: string;
  /** Stable identity of the paragraph (see paragraphKey). */
  key: string;
}

type ContextListener = (ctx: DraftContext) => void;

/**
 * Watches the active draft and emits a DraftContext after a typing pause or
 * on switching notes. Pure coordination: the plugin forwards Obsidian's
 * editor-change / active-leaf events into it, both the Margin view and the
 * ghost engine subscribe, and heavy work (retrieval) happens downstream —
 * so one keystroke never triggers two extractions.
 */
export class DraftWatcher {
  private listeners = new Set<ContextListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastKey = "";

  constructor(private pauseMs = 600) {}

  subscribe(listener: ContextListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Forward from workspace "editor-change" — debounced (typing pause). */
  onEditorChange(editor: Editor, view: MarkdownView): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emitFrom(editor, view, false);
    }, this.pauseMs);
  }

  /** Forward from active-leaf/file-open changes — immediate, always emits. */
  onFocusChange(editor: Editor, view: MarkdownView): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.emitFrom(editor, view, true);
  }

  private emitFrom(editor: Editor, view: MarkdownView, force: boolean): void {
    const file = view.file;
    if (!file) return;
    const cursor = editor.getCursor();
    const noteText = editor.getValue();
    const lines = noteText.split("\n");
    const para = paragraphAround(lines, cursor.line);
    const key = paragraphKey(file.path, para.text);
    // Same paragraph, materially unchanged → nothing new to say (unless the
    // emit is forced by a focus change).
    if (!force && key === this.lastKey) return;
    this.lastKey = key;

    const lineText = lines[cursor.line] ?? "";
    this.emit({
      path: file.path,
      title: file.basename,
      text: para.text,
      noteText,
      cursorLine: cursor.line,
      cursorCh: cursor.ch,
      charBefore: cursor.ch > 0 ? lineText.charAt(cursor.ch - 1) : "",
      charAfter: cursor.ch < lineText.length ? lineText.charAt(cursor.ch) : "",
      lineBefore: lineText.slice(0, cursor.ch),
      key,
    });
  }

  private emit(ctx: DraftContext): void {
    for (const l of this.listeners) l(ctx);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
