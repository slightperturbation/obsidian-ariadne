import { describe, expect, it } from "vitest";
import { App, TFile } from "obsidian";
import { VaultNoteSource } from "../src/index/crawler";

interface FakeCache {
  frontmatter?: Record<string, unknown>;
  links?: unknown[];
  embeds?: unknown[];
}

function makeFile(path: string, mtime = 1000, parent: string | null = null): TFile {
  const f = new TFile();
  f.path = path;
  f.basename = (path.split("/").pop() ?? path).replace(/\.md$/, "");
  f.extension = path.endsWith(".md") ? "md" : path.split(".").pop() ?? "";
  f.stat = { mtime, ctime: mtime, size: 0 };
  f.parent = parent === null ? null : { path: parent };
  return f;
}

function makeApp(
  files: TFile[],
  contents: Record<string, string>,
  caches: Record<string, FakeCache> = {},
): App {
  return {
    vault: {
      getMarkdownFiles: () => files.filter((f) => f.extension === "md"),
      cachedRead: async (f: TFile) => contents[f.path] ?? "",
      getAbstractFileByPath: (path: string) => files.find((f) => f.path === path) ?? null,
    },
    metadataCache: {
      getFileCache: (f: TFile) => caches[f.path] ?? null,
    },
  } as unknown as App;
}

describe("VaultNoteSource", () => {
  it("loads every markdown note with title, folder, and content", async () => {
    const files = [
      makeFile("Zettel/100 Ideas/Atomic notes.md", 42, "Zettel/100 Ideas"),
      makeFile("Inbox.md", 7, "/"),
      makeFile("image.png"),
    ];
    const source = new VaultNoteSource(
      makeApp(files, { "Zettel/100 Ideas/Atomic notes.md": "One idea per note." }),
    );

    const notes = await source.all();
    expect(notes).toHaveLength(2);
    const atomic = notes.find((n) => n.title === "Atomic notes")!;
    expect(atomic.content).toBe("One idea per note.");
    expect(atomic.folder).toBe("Zettel/100 Ideas");
    expect(atomic.mtime).toBe(42);
    // Root folder ("/") normalizes to "".
    expect(notes.find((n) => n.title === "Inbox")!.folder).toBe("");
  });

  it("carries frontmatter and counts links + embeds", async () => {
    const files = [makeFile("a.md")];
    const source = new VaultNoteSource(
      makeApp(files, { "a.md": "body" }, {
        "a.md": {
          frontmatter: { type: "reference" },
          links: [{}, {}],
          embeds: [{}],
        },
      }),
    );
    const [note] = await source.all();
    expect(note.frontmatter).toEqual({ type: "reference" });
    expect(note.linkCount).toBe(3);
  });

  it("loadPath returns null for missing or non-markdown files", async () => {
    const files = [makeFile("a.md"), makeFile("pic.png")];
    const source = new VaultNoteSource(makeApp(files, { "a.md": "x" }));
    expect(await source.loadPath("gone.md")).toBeNull();
    expect(await source.loadPath("pic.png")).toBeNull();
    expect((await source.loadPath("a.md"))?.title).toBe("a");
  });

  it("paths() lists markdown paths cheaply", () => {
    const files = [makeFile("a.md"), makeFile("b.md"), makeFile("c.png")];
    const source = new VaultNoteSource(makeApp(files, {}));
    expect(source.paths()).toEqual(["a.md", "b.md"]);
  });
});
