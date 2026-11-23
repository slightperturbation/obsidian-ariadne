/**
 * Batch jobs write an open note through its editor: the smallest edit, the
 * owner's cursor kept, checked and changed in one step, then saved — and a
 * note that is not open is written on disk as before.
 */
import { describe, expect, it } from "vitest";
import { App, MarkdownView, TFile } from "obsidian";
import { ObsidianVaultIO, editInPlace } from "../src/actions/vault-io";
import { ActionExecutor, ConflictError } from "../src/actions/framework";

/** An editor over a string, with positions as CodeMirror gives them: line and column. */
class FakeEditor {
  edits = 0;
  constructor(public text: string) {}
  getValue(): string {
    return this.text;
  }
  offsetToPos(offset: number): { line: number; ch: number } {
    const before = this.text.slice(0, offset).split("\n");
    return { line: before.length - 1, ch: before[before.length - 1]!.length };
  }
  posToOffset(pos: { line: number; ch: number }): number {
    const lines = this.text.split("\n");
    return lines.slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.ch;
  }
  replaceRange(text: string, from: { line: number; ch: number }, to: { line: number; ch: number }): void {
    this.edits++;
    const a = this.posToOffset(from);
    const b = this.posToOffset(to);
    this.text = this.text.slice(0, a) + text + this.text.slice(b);
  }
}

function setup(disk: Record<string, string>, open: Record<string, string>) {
  const files = new Map(Object.entries(disk));
  const saved: string[] = [];
  const tfile = (path: string) => Object.assign(new TFile(), { path });
  const views = Object.entries(open).map(([path, text]) => {
    const editor = new FakeEditor(text);
    const view = Object.assign(Object.create(MarkdownView.prototype) as MarkdownView, {
      file: tfile(path),
      editor,
      getViewData: () => editor.getValue(),
      save: async () => {
        files.set(path, editor.getValue());
        saved.push(path);
      },
    });
    return { path, editor, view };
  });
  const app = Object.assign(new App(), {
    vault: {
      getAbstractFileByPath: (p: string) => (files.has(p) ? tfile(p) : null),
      read: async (f: TFile) => files.get(f.path)!,
      modify: async (f: TFile, c: string) => void files.set(f.path, c),
      process: async (f: TFile, fn: (s: string) => string) => void files.set(f.path, fn(files.get(f.path)!)),
    },
    workspace: { iterateAllLeaves: (cb: (leaf: { view: unknown }) => void) => views.forEach((v) => cb({ view: v.view })) },
  });
  const wrote: string[] = [];
  const io = new ObsidianVaultIO(app as unknown as App, { throughEditor: true, onEditorWrite: (p) => wrote.push(p) });
  return { files, views, saved, wrote, io, executor: new ActionExecutor(io) };
}

describe("the smallest edit", () => {
  it("changes only the text between the common start and end", () => {
    const e = new FakeEditor("line one\nline two\nline three");
    editInPlace(e as never, e.text, "line one\nline 2\nline three");
    expect(e.text).toBe("line one\nline 2\nline three");
    expect(e.edits).toBe(1);
  });

  it("gets every case right: insert, delete, at the ends, repeated letters, all of it", () => {
    const cases: Array<[string, string]> = [
      ["abc", "abXc"],
      ["abc", "ac"],
      ["abc", "Xabc"],
      ["abc", "abcX"],
      ["aaaa", "aaa"],
      ["aaa", "aaaa"],
      ["", "new\ntext"],
      ["old\ntext", ""],
      ["#virtual_creatures\n\n* rigid", "---\ntags:\n  - Virtual_Creatures\n---\n#virtual_creatures\n\n* rigid"],
      ["é😀x", "é😀yx"],
    ];
    for (const [from, to] of cases) {
      const e = new FakeEditor(from);
      editInPlace(e as never, from, to);
      expect(e.text).toBe(to);
    }
  });
});

describe("an open note is written through its editor", () => {
  it("reads the editor's text, unsaved typing included, and writes there — then saves", async () => {
    const s = setup({ "a.md": "on disk" }, { "a.md": "on disk, and typed" });
    expect(await s.io.read("a.md")).toBe("on disk, and typed");
    await s.executor.applyRaw([{ type: "modify", path: "a.md", before: "on disk, and typed", after: "on disk, and typed — tagged" }]);
    expect(s.views[0]!.editor.text).toBe("on disk, and typed — tagged");
    expect(s.files.get("a.md")).toBe("on disk, and typed — tagged");
    expect(s.saved).toEqual(["a.md"]);
    expect(s.wrote).toEqual(["a.md"]);
  });

  it("refuses, and changes nothing, when the editor's text is not what the change was made from", async () => {
    const s = setup({ "a.md": "as shown" }, { "a.md": "as shown, and the owner typed on" });
    await expect(s.executor.applyRaw([{ type: "modify", path: "a.md", before: "as shown", after: "tidied" }])).rejects.toBeInstanceOf(ConflictError);
    expect(s.views[0]!.editor.text).toBe("as shown, and the owner typed on");
    expect(s.views[0]!.editor.edits).toBe(0);
    expect(s.saved).toEqual([]);
  });

  it("undoes through the editor too", async () => {
    const s = setup({ "a.md": "a" }, { "a.md": "a" });
    const inverse = await s.executor.applyRaw([{ type: "modify", path: "a.md", before: "a", after: "a!" }]);
    await s.executor.revert(inverse);
    expect(s.views[0]!.editor.text).toBe("a");
    expect(s.files.get("a.md")).toBe("a");
  });

  it("writes a note that is not open on disk, as before", async () => {
    const s = setup({ "a.md": "a", "b.md": "b" }, { "a.md": "a" });
    await s.executor.applyRaw([{ type: "modify", path: "b.md", before: "b", after: "b!" }]);
    expect(s.files.get("b.md")).toBe("b!");
    expect(s.saved).toEqual([]);
    expect(s.wrote).toEqual([]);
  });

  it("without the option, writes on disk even when the note is open (the rest of Ariadne)", async () => {
    const s = setup({ "a.md": "a" }, { "a.md": "a" });
    const plain = new ObsidianVaultIO((s.io as unknown as { app: App }).app);
    await new ActionExecutor(plain).applyRaw([{ type: "modify", path: "a.md", before: "a", after: "a!" }]);
    expect(s.files.get("a.md")).toBe("a!");
    expect(s.views[0]!.editor.text).toBe("a");
  });
});
