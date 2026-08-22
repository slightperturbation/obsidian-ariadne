import { describe, expect, it } from "vitest";
import { dayKeyOf, dateOf, formatDateName, inferDateNameFormat, looksPeriodic } from "../src/core/periodic";
import { onThisDay, openingLine, resurfacePick } from "../src/margin/resurface";
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

describe("dayKeyOf / dateOf", () => {
  it("extracts the month-day and full date from both name conventions", () => {
    expect(dayKeyOf("Daily/2026-07-25.md")).toBe("07-25");
    expect(dayKeyOf("June 28, 2026.md")).toBe("06-28");
    expect(dayKeyOf("8 June 2025.md")).toBe("06-08");
    expect(dateOf("2026-07-25 Friday.md")).toBe("2026-07-25");
    expect(dateOf("June 28, 2026.md")).toBe("2026-06-28");
  });

  it("returns null for weeklies, monthlies, and ordinary notes", () => {
    for (const name of ["2026-W31.md", "2026-07.md", "Open-endedness.md"]) {
      expect(dayKeyOf(name)).toBeNull();
      expect(dateOf(name)).toBeNull();
    }
  });
});

describe("resurfacing", () => {
  it("onThisDay finds past entries sharing the month-day, newest first", () => {
    const paths = [
      "2026-07-25.md",
      "2025-07-25.md",
      "June 28, 2026.md",
      "2024-07-25.md",
      "Open-endedness.md",
    ];
    expect(onThisDay("2026-07-25.md", paths)).toEqual(["2025-07-25.md", "2024-07-25.md"]);
    // Works for a synthetic today-path that has no file behind it.
    expect(onThisDay("2027-07-25.md", paths)).toEqual([
      "2026-07-25.md",
      "2025-07-25.md",
      "2024-07-25.md",
    ]);
  });

  it("resurfacePick is stable within a day, different across days, and honest about eligibility", () => {
    const now = Date.now();
    const old = now - 60 * 24 * 60 * 60 * 1000;
    const meta = (path: string, linkCount: number, mtime: number) => ({
      path,
      title: path.replace(/\.md$/, ""),
      mtime,
      folder: "",
      linkCount,
      chunkCount: 1,
    });
    const metas = [
      meta("Agents.md", 0, old),
      meta("Morphogenesis.md", 1, old),
      meta("Well-linked.md", 8, old), // the graph already returns this one
      meta("Fresh.md", 0, now), // recently touched — not dormant
      meta("2025-01-01.md", 0, old), // dated entries are not "still true?" material
    ];
    const a = resurfacePick(metas, "2026-08-11", now);
    const b = resurfacePick(metas, "2026-08-11", now);
    expect(a).toEqual(b); // same pick all day
    expect(["Agents.md", "Morphogenesis.md"]).toContain(a!.path);
    // Ineligible notes never surface.
    for (const iso of ["2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"]) {
      const pick = resurfacePick(metas, iso, now)!;
      expect(["Agents.md", "Morphogenesis.md"]).toContain(pick.path);
    }
    expect(resurfacePick([meta("Fresh.md", 0, now)], "2026-08-11", now)).toBeNull();
  });
});

describe("openingLine (the daily reading)", () => {
  it("finds the first substantive sentence, unwrapping markup", () => {
    const md = "---\ntype: note\n---\n\n# Agents\n\n*[[Agency|Agency]]* is the capacity to set one's own goals. More text follows.";
    expect(openingLine(md)).toBe("Agency is the capacity to set one's own goals.");
  });

  it("bounds long lines at a word break with an ellipsis", () => {
    const long = "word ".repeat(40).trim() + ".";
    const line = openingLine(long)!;
    expect(line.length).toBeLessThanOrEqual(91);
    expect(line.endsWith("…")).toBe(true);
  });

  it("skips headings-only and trivial content", () => {
    expect(openingLine("# Title\n## Sub\n")).toBeNull();
    expect(openingLine("---\ntags: [x]\n---\n")).toBeNull();
  });

  it("strips list markers so a bullet note still reads", () => {
    expect(openingLine("- [ ] Fleeting thought about morphogenesis and constraint.")).toBe(
      "Fleeting thought about morphogenesis and constraint.",
    );
  });
});

describe("date-name format inference", () => {
  it("infers the journal's own convention, dominant style wins", () => {
    expect(inferDateNameFormat(["2025-04-20", "2026-06-28", "Adventures"])).toBe("iso");
    expect(inferDateNameFormat(["April 20, 2025", "June 28, 2026", "2026-01-01"])).toBe("written");
    expect(inferDateNameFormat(["2024-05-19 Sunday.md", "2024-05-20 Monday.md"])).toBe(
      "iso-weekday",
    );
    expect(inferDateNameFormat(["8 June 2025", "9 June 2025"])).toBe("day-first");
  });

  it("empty or undated folders fall back to ISO — natural sort order", () => {
    expect(inferDateNameFormat([])).toBe("iso");
    expect(inferDateNameFormat(["Adventures", "Workplaces"])).toBe("iso");
  });

  it("formatDateName renders each style for a local date", () => {
    const d = new Date(2026, 7, 13); // Aug 13 2026, a Thursday
    expect(formatDateName(d, "iso")).toBe("2026-08-13");
    expect(formatDateName(d, "iso-weekday")).toBe("2026-08-13 Thursday");
    expect(formatDateName(d, "written")).toBe("August 13, 2026");
    expect(formatDateName(d, "day-first")).toBe("13 August 2026");
  });
});

describe("hybrid weekly names", () => {
  it("looksPeriodic accepts week-prefixed names like 2025-W18-May01", () => {
    expect(looksPeriodic("Periodic/Weekly/2025-W18-May01.md")).toBe(true);
    expect(looksPeriodic("2026-W34-Aug16.md")).toBe(true);
    expect(looksPeriodic("2025-W20.md")).toBe(true);
    // But a W mid-word is not a week note.
    expect(looksPeriodic("2025-Windmills.md")).toBe(false);
  });
});
