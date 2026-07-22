import { describe, it, expect } from "vitest";
import { IndexManager } from "../src/index/manager";
import { HashEmbedder } from "../src/index/embeddings/hash-embedder";
import type { NoteSource, SourceNote } from "../src/core/types";

const notes: SourceNote[] = [
  {
    path: "1 Zettelkasten/102 Zettels - Concepts/Open-endedness.md",
    title: "Open-endedness",
    folder: "1 Zettelkasten/102 Zettels - Concepts",
    mtime: Date.parse("2025-11-23"),
    content: "# Open-endedness\n\nExploratory search opens doorways and new dimensions in artificial life.",
    frontmatter: { type: "concept" },
  },
  {
    path: "1 Zettelkasten/100 Topics/Agents.md",
    title: "Agents",
    folder: "1 Zettelkasten/100 Topics",
    mtime: Date.parse("2025-11-28"),
    content: "# Agents\n\nPlanning, memory, and tools are the features that define an agent.",
    frontmatter: { type: "topic" },
  },
  {
    path: "Photography/Lightroom process.md",
    title: "Lightroom process",
    folder: "Photography",
    mtime: Date.parse("2025-12-14"),
    content: "# Lightroom\n\nMy raw photo editing workflow: culling, white balance, export.",
  },
];

const source: NoteSource = { all: async () => notes };

describe("IndexManager", () => {
  it("indexes a source and reports counts", async () => {
    const mgr = new IndexManager(new HashEmbedder(256));
    await mgr.buildAll(source);
    expect(mgr.noteCount).toBe(3);
    expect(mgr.chunkCount).toBeGreaterThanOrEqual(3);
  });

  it("returns the most relevant note first, deduped to one result per note", async () => {
    const mgr = new IndexManager(new HashEmbedder(256));
    await mgr.buildAll(source);
    const results = await mgr.query("planning tools agent");
    expect(results[0].path).toBe("1 Zettelkasten/100 Topics/Agents.md");
    const paths = results.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length); // no duplicate notes
    expect(results[0].confidence).toBeGreaterThan(0);
    expect(results[0].snippet.length).toBeGreaterThan(0);
  });

  it("applies the folder filter", async () => {
    const mgr = new IndexManager(new HashEmbedder(256));
    await mgr.buildAll(source);
    const results = await mgr.query("workflow in:Photography");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.path.startsWith("Photography"))).toBe(true);
  });

  it("applies the type filter", async () => {
    const mgr = new IndexManager(new HashEmbedder(256));
    await mgr.buildAll(source);
    const results = await mgr.query("evolution type:concept");
    expect(results.every((r) => r.path.includes("102 Zettels"))).toBe(true);
  });

  it("works lexically with no embedder (semantic disabled)", async () => {
    const mgr = new IndexManager();
    await mgr.buildAll(source);
    const results = await mgr.query("doorways");
    expect(results[0].path).toBe("1 Zettelkasten/102 Zettels - Concepts/Open-endedness.md");
  });

  it("re-indexing a note does not duplicate it", async () => {
    const mgr = new IndexManager(new HashEmbedder(64));
    await mgr.indexNote(notes[0]);
    await mgr.indexNote(notes[0]);
    expect(mgr.noteCount).toBe(1);
  });
});
