import { describe, expect, it } from "vitest";
import { looksPeriodic } from "../src/core/periodic";
import { IndexManager } from "../src/index/manager";
import { HashEmbedder } from "../src/index/embeddings/hash-embedder";
import type { SourceNote } from "../src/core/types";

describe("looksPeriodic", () => {
  it("recognizes the common daily/weekly/monthly name conventions", () => {
    for (const name of [
      "2026-07-25.md",
      "Daily/2026-07-25 Friday.md",
      "June 28, 2026.md",
      "28 June 2026.md",
      "2026-W31.md",
      "2026-07.md",
      "2026-Q3.md",
      "Journal/2026.md",
    ]) {
      expect(looksPeriodic(name), name).toBe(true);
    }
  });

  it("leaves ordinary notes alone — including ones that merely contain dates", () => {
    for (const name of [
      "Open-endedness.md",
      "Meeting notes 2026-07-25 review.md", // date not at the start
      "1984.md notes.md",
      "Morphogenesis.md",
      "100 Topics.md",
    ]) {
      expect(looksPeriodic(name), name).toBe(false);
    }
  });
});

describe("related() demotes periodic notes without hiding them", () => {
  const note = (path: string, content: string): SourceNote => ({
    path,
    title: path.replace(/\.md$/, "").split("/").pop()!,
    content,
    mtime: 1,
    folder: "",
  });

  it("a permanent note outranks a dated entry that says the same words", async () => {
    const manager = new IndexManager(new HashEmbedder(64));
    // The dated entry matches the query MORE strongly (verbatim), the
    // permanent note less — demotion must still put the permanent note first.
    await manager.indexNote(
      note("2026-07-20.md", "Thinking again about motivation and habit loops today."),
    );
    await manager.indexNote(
      note("Motivation.md", "Motivation follows action; habit loops make starting cheap."),
    );
    const results = await manager.related("thinking about motivation and habit loops", {
      deprioritize: looksPeriodic,
    });
    const paths = results.map((r) => r.path);
    expect(paths).toContain("2026-07-20.md"); // demoted, not hidden
    expect(paths.indexOf("Motivation.md")).toBeLessThan(paths.indexOf("2026-07-20.md"));
  });
});
