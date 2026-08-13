import { describe, expect, it } from "vitest";
import {
  inFolders,
  isLogLine,
  isReflectiveProse,
  parseFolderList,
} from "../src/margin/journal";
import {
  classifyEntry,
  entryTag,
  isManagedEntryTag,
  suggestTags,
} from "../src/margin/tags";

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

describe("classifyEntry", () => {
  const NARRATIVE =
    "Today I finally understood why the migration keeps stalling: we are optimizing " +
    "the part of the system nobody complains about. Writing it down made it obvious.";

  it("a log-shaped entry is a daily note", () => {
    const entry = [
      "- [ ] email Sam about the review",
      "- 9:30 standup",
      "## Meetings",
      "- platform sync, migration timelines discussed at length again",
    ].join("\n\n");
    expect(classifyEntry(entry)).toBe("daily");
  });

  it("narrative-dominated entries are journal entries", () => {
    expect(classifyEntry(`${NARRATIVE}\n\n${NARRATIVE}`)).toBe("journal");
  });

  it("a to-do list with one thoughtful sentence is still a daily note", () => {
    const entry = ["- [ ] email Sam", "- [ ] book flights", NARRATIVE].join("\n\n");
    expect(classifyEntry(entry)).toBe("daily");
  });

  it("ignores frontmatter and defaults empty to daily", () => {
    expect(classifyEntry("---\ntags: [x]\n---\n")).toBe("daily");
  });
});

describe("entry tags + suggestions", () => {
  it("entryTag builds kind/ISO-date and isManagedEntryTag recognizes it", () => {
    expect(entryTag("journal", "2026-08-12", "daily", "journal")).toBe("journal/2026-08-12");
    expect(entryTag("daily", "2026-08-12", "log", "reflect")).toBe("log/2026-08-12");
    expect(isManagedEntryTag("journal/2026-08-12")).toBe(true);
    expect(isManagedEntryTag("evolution")).toBe(false);
    expect(isManagedEntryTag("project/atlas")).toBe(false);
  });

  it("suggests only corroborated neighbor tags, never the note's own", () => {
    const suggested = suggestTags(
      [
        { cosine: 0.7, tags: ["#evolution", "biology"] },
        { cosine: 0.65, tags: ["evolution", "complexity"] },
        { cosine: 0.6, tags: ["already-mine"] },
      ],
      new Set(["already-mine"]),
    );
    expect(suggested).toEqual(["evolution"]); // two sources; biology/complexity have one weak source
  });

  it("one nearly-identical neighbor is evidence enough on its own", () => {
    expect(suggestTags([{ cosine: 0.9, tags: ["morphogenesis"] }], new Set())).toEqual([
      "morphogenesis",
    ]);
    expect(suggestTags([{ cosine: 0.6, tags: ["morphogenesis"] }], new Set())).toEqual([]);
  });

  it("never proposes managed entry tags — dated tags are per-entry, not topical", () => {
    expect(
      suggestTags(
        [
          { cosine: 0.9, tags: ["journal/2026-08-11"] },
          { cosine: 0.9, tags: ["daily/2026-08-10"] },
        ],
        new Set(),
      ),
    ).toEqual([]);
  });
});
