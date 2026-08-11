import { describe, expect, it } from "vitest";
import {
  decideLocally,
  isUntitledName,
  titleFromContent,
  TRIAGE_MERGE_COSINE,
} from "../src/actions/triage";
import { parseTitle, parseTriage } from "../src/model/tasks";

describe("isUntitledName", () => {
  it("matches Obsidian's default names and nothing else", () => {
    expect(isUntitledName("Untitled")).toBe(true);
    expect(isUntitledName("Untitled 3")).toBe(true);
    expect(isUntitledName("untitled 12")).toBe(true);
    expect(isUntitledName("Untitled thoughts on X")).toBe(false);
    expect(isUntitledName("My Untitled")).toBe(false);
  });
});

describe("titleFromContent", () => {
  it("prefers the first heading", () => {
    expect(titleFromContent("# Spaced repetition and transfer\n\nBody.")).toBe(
      "Spaced repetition and transfer",
    );
  });

  it("falls back to the first substantive line, unwrapping links and markup", () => {
    expect(titleFromContent("*[[Open-endedness|open-ended]]* systems resist metrics")).toBe(
      "open-ended systems resist metrics",
    );
  });

  it("skips frontmatter and blank lines", () => {
    expect(titleFromContent("---\ntype: note\n---\n\n\nThe actual idea")).toBe("The actual idea");
  });

  it("cuts long lines at a word boundary", () => {
    const long = "word ".repeat(40).trim();
    const title = titleFromContent(long)!;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("word")).toBe(true);
  });

  it("returns null when nothing is usable — only then is a model asked", () => {
    expect(titleFromContent("")).toBeNull();
    expect(titleFromContent("---\ntype: note\n---\n")).toBeNull();
    expect(titleFromContent("##\n> \n")).toBeNull();
  });
});

describe("decideLocally", () => {
  it("archives dead stubs without a model call", () => {
    const p = decideLocally("- [ ]\n\n> \n", undefined)!;
    expect(p.disposition).toBe("archive");
  });

  it("proposes merge for a stored-vector near-duplicate", () => {
    const content = "A real paragraph of thinking about morphogenesis and its constraints.";
    const p = decideLocally(content, {
      path: "morpho.md",
      title: "Morphogenesis",
      cosine: TRIAGE_MERGE_COSINE + 0.01,
    })!;
    expect(p.disposition).toBe("merge");
    expect(p.mergeTarget?.path).toBe("morpho.md");
  });

  it("defers the interesting middle to the model", () => {
    const content = "A real paragraph of thinking about morphogenesis and its constraints.";
    expect(decideLocally(content, { path: "x.md", title: "X", cosine: 0.7 })).toBeNull();
    expect(decideLocally(content, undefined)).toBeNull();
  });
});

describe("triage/title parsers", () => {
  it("parses valid verdicts", () => {
    expect(parseTriage('{"disposition":"archive","reason":"expired logistics."}')).toEqual({
      disposition: "archive",
      reason: "expired logistics",
    });
    expect(parseTitle('{"title":"Morphogenesis as computation."}')).toBe(
      "Morphogenesis as computation",
    );
  });

  it("malformed triage degrades to elaborate — archiving a live idea is the costly mistake", () => {
    expect(parseTriage("garbage").disposition).toBe("elaborate");
    expect(parseTriage('{"disposition":"delete"}').disposition).toBe("elaborate");
  });

  it("malformed title degrades to null (skip, not a junk rename)", () => {
    expect(parseTitle("garbage")).toBeNull();
    expect(parseTitle('{"title":""}')).toBeNull();
  });
});
