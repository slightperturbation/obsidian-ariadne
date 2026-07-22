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
