import { describe, expect, it } from "vitest";
import {
  parseConnective,
  parseScaffold,
  fallbackScaffold,
  renderScaffold,
  sanitizeTitle,
} from "../src/model/tasks";
import { buildNewNoteProposal } from "../src/actions/new-note";

describe("connective parsing", () => {
  it("extracts and de-dots the phrase", () => {
    expect(parseConnective('{"phrase": "extends the argument."}')).toBe(
      "extends the argument",
    );
  });
  it("returns null on garbage or empty", () => {
    expect(parseConnective("not json")).toBeNull();
    expect(parseConnective('{"phrase": "  "}')).toBeNull();
  });
});

describe("scaffold parse + render", () => {
  it("parses a well-formed scaffold and fills defaults", () => {
    const s = parseScaffold(
      JSON.stringify({
        title: "Atomic notes",
        noteType: "note",
        home: "1 Zettelkasten",
        sections: ["Idea", "Evidence"],
        keyIdeas: ["one idea per note", "self-contained"],
        links: ["Zettelkasten"],
      }),
    );
    const md = renderScaffold(s, "2026-07-22");
    expect(md).toContain("type: note");
    expect(md).toContain("created: 2026-07-22");
    expect(md).toContain("- one idea per note");
    expect(md).toContain("## Idea");
    expect(md).toContain("## Related");
    expect(md).toContain("- [[Zettelkasten]]");
    // Structure only — no prose paragraph.
    expect(md).not.toMatch(/\n[A-Z][a-z]+ [a-z]+ [a-z]+ [a-z]+ [a-z]+\./);
  });

  it("fallbackScaffold builds a typed skeleton from the seed's first line", () => {
    const s = fallbackScaffold("Environmental complexity drives morphology\nmore detail");
    expect(s.title).toBe("Environmental complexity drives morphology");
    expect(s.noteType).toBe("note");
    expect(s.sections.length).toBeGreaterThan(0);
  });
});

describe("sanitizeTitle", () => {
  it("strips characters illegal in filenames", () => {
    expect(sanitizeTitle('a/b:c*?"<>|#^[]')).toBe("a b c");
    expect(sanitizeTitle("   ")).toBe("Untitled");
  });
});

describe("buildNewNoteProposal", () => {
  it("places the note in the ladder-decided home", () => {
    const proposal = buildNewNoteProposal({
      scaffold: fallbackScaffold("Test note"),
      home: "EOW Wiki",
      isoDate: "2026-07-22",
    });
    expect(proposal.changes[0].path).toBe("EOW Wiki/Test note.md");
    expect(proposal.changes[0].type).toBe("create");
    expect(proposal.description).toBe("in EOW Wiki");
  });

  it("an empty home lands in the vault root", () => {
    const proposal = buildNewNoteProposal({
      scaffold: fallbackScaffold("Test note"),
      home: "",
      isoDate: "2026-07-22",
    });
    expect(proposal.changes[0].path).toBe("Test note.md");
    expect(proposal.description).toBe("in the vault root");
  });
});
