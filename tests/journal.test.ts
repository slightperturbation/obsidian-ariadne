import { describe, expect, it } from "vitest";
import {
  inFolders,
  isLogLine,
  isReflectiveProse,
  parseFolderList,
} from "../src/margin/journal";

describe("isReflectiveProse", () => {
  it("recognizes reflective prose: sentences with real length", () => {
    expect(
      isReflectiveProse(
        "I keep noticing that the notes I actually revisit are the ones I wrote " +
          "in my own words, not the clippings. Maybe collection is the enemy of thought.",
      ),
    ).toBe(true);
  });

  it("a short line never qualifies — quiet is the default", () => {
    expect(isReflectiveProse("Called the dentist.")).toBe(false);
    expect(isReflectiveProse("")).toBe(false);
  });

  it("log-shaped paragraphs are not reflection, whatever their length", () => {
    const log = [
      "- [ ] email Sam about the review process for the quarterly report",
      "- [x] standup notes uploaded to the shared drive for the whole team",
      "- 9:30 sync with the platform group about migration timelines",
    ].join("\n");
    expect(isReflectiveProse(log)).toBe(false);
  });

  it("prose with an embedded bullet still counts when prose dominates", () => {
    const mixed = [
      "The migration conversation keeps circling the same fear: that we are " +
        "optimizing the part of the system nobody complains about.",
      "- one bullet of evidence",
      "That fear seems more informative than the plan itself, honestly.",
    ].join("\n");
    expect(isReflectiveProse(mixed)).toBe(true);
  });
});

describe("isLogLine", () => {
  it("matches bullets, tasks, numbered items, and headings", () => {
    for (const line of ["- call dentist", "* item", "3. step", "## Meetings", "- [ ] todo"]) {
      expect(isLogLine(line), line).toBe(true);
    }
  });

  it("leaves prose alone", () => {
    expect(isLogLine("I keep noticing that")).toBe(false);
  });
});

describe("folder helpers", () => {
  it("inFolders matches the folder itself and its descendants, nothing else", () => {
    expect(inFolders("Journal/2026 spring.md", ["Journal"])).toBe(true);
    expect(inFolders("Journal/deep/entry.md", ["Journal"])).toBe(true);
    expect(inFolders("Journaling/entry.md", ["Journal"])).toBe(false);
    expect(inFolders("entry.md", ["Journal"])).toBe(false);
    expect(inFolders("entry.md", [])).toBe(false);
  });

  it("parseFolderList trims, strips slashes, and drops empties", () => {
    expect(parseFolderList(" Journal , /Daily/ ,, Morning pages ")).toEqual([
      "Journal",
      "Daily",
      "Morning pages",
    ]);
    expect(parseFolderList("")).toEqual([]);
  });
});
