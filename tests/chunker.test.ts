import { describe, it, expect } from "vitest";
import { chunkNote, stripFrontmatter, DEFAULT_CHUNK_OPTIONS } from "../src/index/chunker";

describe("stripFrontmatter", () => {
  it("removes a leading YAML block", () => {
    const md = "---\ntype: note\n---\nBody text";
    expect(stripFrontmatter(md)).toBe("Body text");
  });
  it("leaves content without frontmatter untouched", () => {
    expect(stripFrontmatter("# Title\n\nBody")).toBe("# Title\n\nBody");
  });
});

describe("chunkNote", () => {
  it("splits by heading and carries heading context", () => {
    const md = "# Alpha\n\nFirst para.\n\n# Beta\n\nSecond para.";
    const chunks = chunkNote("n.md", md);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ heading: "Alpha", ordinal: 0, path: "n.md" });
    expect(chunks[1]).toMatchObject({ heading: "Beta", ordinal: 1 });
    expect(chunks[0].id).toBe("n.md#0");
  });

  it("ignores frontmatter and empty sections", () => {
    const md = "---\nk: v\n---\n\n# H\n\nContent here.";
    const chunks = chunkNote("n.md", md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Content here.");
  });

  it("packs multiple small paragraphs under the size cap into one chunk", () => {
    const md = "# H\n\nP1.\n\nP2.\n\nP3.";
    const chunks = chunkNote("n.md", md, { maxChars: 1000, minChars: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("P1.");
    expect(chunks[0].text).toContain("P3.");
  });

  it("hard-splits a paragraph longer than maxChars", () => {
    const long = "word ".repeat(300).trim(); // ~1500 chars
    const chunks = chunkNote("n.md", `# H\n\n${long}`, { maxChars: 400, minChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400);
  });

  it("assigns monotonically increasing ordinals and stable ids", () => {
    const md = "# A\n\nx\n\n# B\n\ny\n\n# C\n\nz";
    const chunks = chunkNote("p.md", md, DEFAULT_CHUNK_OPTIONS);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.id)).toEqual(["p.md#0", "p.md#1", "p.md#2"]);
  });
});

describe("code fences", () => {
  it("does not treat comments inside a fenced block as headings", () => {
    const md = [
      "Intro paragraph.",
      "",
      "```bash",
      "# install the deps",
      "npm install",
      "# run it",
      "npm start",
      "```",
      "",
      "Outro paragraph.",
    ].join("\n");
    const chunks = chunkNote("code.md", md);

    // The comment lines must survive as indexed text, not vanish into headings.
    const all = chunks.map((c) => c.text).join("\n");
    expect(all).toContain("# install the deps");
    expect(all).toContain("npm start");
    expect(chunks.every((c) => c.heading === undefined)).toBe(true);
  });

  it("still detects real headings after a fence closes", () => {
    const md = "```\ncode\n```\n\n## Real heading\n\nBody text here.";
    const chunks = chunkNote("c.md", md);
    expect(chunks.some((c) => c.heading === "Real heading")).toBe(true);
  });
});

describe("stub notes", () => {
  it("emits a title chunk for a heading-only note so it is findable by name", () => {
    const chunks = chunkNote("Zettel/Ariadne's Thread.md", "# Ariadne's Thread");
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain("Ariadne's Thread");
  });

  it("emits a title chunk for an empty note", () => {
    const chunks = chunkNote("Untitled.md", "");
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain("Untitled");
  });

  it("includes headings in the fallback chunk", () => {
    const chunks = chunkNote("Map.md", "# Map\n\n## Alpha\n\n## Beta");
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain("Alpha");
    expect(chunks[0].text).toContain("Beta");
  });
});

describe("frontmatter vs thematic break", () => {
  it("does not eat a leading pull quote fenced by ---", () => {
    const md = "---\nA pull quote worth keeping\n---\nThe real body.";
    expect(stripFrontmatter(md)).toContain("A pull quote worth keeping");
    const all = chunkNote("q.md", md).map((c) => c.text).join("\n");
    expect(all).toContain("A pull quote worth keeping");
    expect(all).toContain("The real body.");
  });

  it("still strips genuine YAML frontmatter", () => {
    const md = "---\ntype: note\ntags: [a]\n---\n\nBody text.";
    expect(stripFrontmatter(md)).not.toContain("type: note");
    expect(stripFrontmatter(md).trim()).toBe("Body text.");
  });
});

describe("tables are atomic", () => {
  it("never hard-splits a table mid-row", () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| metric ${i} | value ${i} | note about measurement ${i} |`);
    const table = ["| name | value | note |", "| --- | --- | --- |", ...rows].join("\n");
    const md = `Intro paragraph.\n\n${table}\n\nOutro paragraph.`;
    const chunks = chunkNote("t.md", md);
    const tableChunk = chunks.find((c) => c.text.includes("metric 0"));
    expect(tableChunk).toBeDefined();
    // The whole table is one chunk: first and last rows travel together.
    expect(tableChunk!.text).toContain("metric 39");
    // And every line of it is still a well-formed row.
    for (const line of tableChunk!.text.split("\n")) {
      expect(line.trimStart().startsWith("|")).toBe(true);
    }
  });

  it("still hard-splits oversized prose", () => {
    const long = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkNote("p.md", long);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
