import { describe, expect, it } from "vitest";
import {
  continuityLabel,
  isBlankPage,
  lastReflectiveGist,
  pickForDay,
  previousDated,
  synthesisQuestions,
  threadQuote,
} from "../src/margin/threads";

const REFLECTION =
  "I keep coming back to the idea that collection is the enemy of thought. " +
  "The notes I revisit are the ones written in my own words.";

describe("lastReflectiveGist", () => {
  it("returns the first sentence of the LAST reflective paragraph", () => {
    const entry = [
      "Opening reflection about the morning and what it held for me overall.",
      "- [ ] a task line",
      REFLECTION,
    ].join("\n\n");
    expect(lastReflectiveGist(entry)).toBe(
      "I keep coming back to the idea that collection is the enemy of thought.",
    );
  });

  it("returns null for log-only entries — a task list has no thread to pull", () => {
    expect(lastReflectiveGist("- [ ] email Sam\n\n- [ ] book flights")).toBeNull();
    expect(lastReflectiveGist("")).toBeNull();
  });
});

describe("synthesisQuestions + pickForDay", () => {
  const NOTE = [
    "# Weekly synthesis 2026-W33",
    "",
    "Entries: [[2026-08-10]] · [[2026-08-12]]",
    "",
    "## Questions to elaborate",
    "",
    "- You kept circling X — what's the actual claim?",
    "- Is the migration fear about the system or the team?",
    "",
  ].join("\n");

  it("parses the questions section", () => {
    expect(synthesisQuestions(NOTE)).toEqual([
      "You kept circling X — what's the actual claim?",
      "Is the migration fear about the system or the team?",
    ]);
    expect(synthesisQuestions("no questions here")).toEqual([]);
  });

  it("picks deterministically per day", () => {
    const qs = synthesisQuestions(NOTE);
    expect(pickForDay(qs, "2026-08-22")).toBe(pickForDay(qs, "2026-08-22"));
    expect(pickForDay([], "2026-08-22")).toBeNull();
  });
});

describe("previousDated + continuityLabel", () => {
  it("finds the nearest strictly-earlier entry across name formats", () => {
    const paths = [
      "Personal/Journal/2026-08-13.md",
      "Personal/Journal/2026-06-28.md",
      "Periodic/Daily/2024-05-19 Sunday.md",
      "Ideas.md",
    ];
    expect(previousDated(paths, "2026-08-22")).toBe("Personal/Journal/2026-08-13.md");
    expect(previousDated(paths, "2026-08-13")).toBe("Personal/Journal/2026-06-28.md");
    expect(previousDated(paths, "2024-01-01")).toBeNull();
  });

  it("labels continuity as information, never a streak", () => {
    expect(continuityLabel("2026-08-21", "2026-08-22")).toBe("yesterday");
    expect(continuityLabel("2026-08-18", "2026-08-22")).toBe("Tuesday");
    expect(continuityLabel("2026-08-01", "2026-08-22")).toBe("21 days ago");
  });
});

describe("thread mechanics", () => {
  it("blank page: short bodies count, frontmatter doesn't", () => {
    expect(isBlankPage("---\ntags: [x]\n---\n\nA line.")).toBe(true);
    expect(isBlankPage(REFLECTION.repeat(3))).toBe(false);
  });

  it("threadQuote is the writer's words, quoted and attributed", () => {
    expect(
      threadQuote({ label: "yesterday", quote: "The claim is X.", sourcePath: "p.md" }),
    ).toBe("> yesterday: “The claim is X.”\n\n");
  });
});
