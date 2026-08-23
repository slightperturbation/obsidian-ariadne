import { describe, expect, it } from "vitest";
import {
  appendWeave,
  blockIdFor,
  clusterKeyOf,
  clusterThreadCandidates,
  ensureBlockId,
  fallbackLabel,
  renderThreadPage,
  upsertThreadProperty,
  weaveCandidates,
  REFLECTION_NOTE,
} from "../src/margin/thread-weave";
import {
  parseThreadGather,
  parseThreadJudge,
  parseThreadMovement,
  threadGatherPrompt,
  threadJudgePrompt,
  threadMovementPrompt,
} from "../src/model/tasks";
import type { EntryNeighbors } from "../src/actions/themes";

const ENTRY = [
  "---",
  "type: journal",
  "---",
  "Slept badly again.",
  "",
  "The Denver offer sits there. I keep circling the same question about schools",
  "and whether the move is really about the job at all.",
  "",
  "Made bread in the afternoon.",
].join("\n");

describe("ensureBlockId", () => {
  const quote =
    "The Denver offer sits there. I keep circling the same question about schools\nand whether the move is really about the job at all.";

  it("anchors an ID at the end of the quote's last line", () => {
    const r = ensureBlockId(ENTRY, quote, "J/2026-08-10.md")!;
    expect(r.text).toContain(`really about the job at all. ^${r.id}`);
    // Prose untouched apart from the anchor.
    expect(r.text.replace(` ^${r.id}`, "")).toBe(ENTRY);
  });

  it("reuses an existing block ID instead of stacking a second one", () => {
    const first = ensureBlockId(ENTRY, quote, "J/e.md")!;
    const second = ensureBlockId(first.text, quote, "J/e.md")!;
    expect(second.text).toBe(first.text);
    expect(second.id).toBe(first.id);
  });

  it("returns null for a non-verbatim quote (caller falls back to whole entry)", () => {
    expect(ensureBlockId(ENTRY, "The Denver offer sits there, and", "J/e.md")).toBeNull();
    expect(ensureBlockId(ENTRY, "  ", "J/e.md")).toBeNull();
  });

  it("ids are stable per (path, quote) and distinct across paths", () => {
    expect(blockIdFor("a.md", "x")).toBe(blockIdFor("a.md", "x"));
    expect(blockIdFor("a.md", "x")).not.toBe(blockIdFor("b.md", "x"));
  });
});

describe("upsertThreadProperty", () => {
  it("creates frontmatter when the entry has none", () => {
    const out = upsertThreadProperty("Just prose.", "The Denver decision");
    expect(out).toBe('---\nthreads:\n  - "[[The Denver decision]]"\n---\n\nJust prose.');
  });

  it("adds the key to existing frontmatter without touching other keys", () => {
    const out = upsertThreadProperty(ENTRY, "The Denver decision");
    expect(out).toContain("type: journal");
    expect(out).toContain('threads:\n  - "[[The Denver decision]]"');
    expect(out.endsWith("Made bread in the afternoon.")).toBe(true);
  });

  it("appends to an existing block list and is idempotent", () => {
    const once = upsertThreadProperty(ENTRY, "A");
    const twice = upsertThreadProperty(upsertThreadProperty(once, "B"), "A");
    expect(twice).toContain('  - "[[A]]"\n  - "[[B]]"');
    expect(twice.match(/\[\[A\]\]/g)).toHaveLength(1);
  });

  it("appends inside an inline list", () => {
    const text = '---\nthreads: ["[[A]]"]\n---\nbody';
    expect(upsertThreadProperty(text, "B")).toContain('threads: ["[[A]]", "[[B]]"]');
  });
});

describe("thread page rendering + weaving", () => {
  const page = renderThreadPage({
    name: "The Denver decision",
    started: "2026-08-10",
    questions: ["The first entry frames the move as a deadline — is it still one?"],
    entries: [{ label: "2026-08-10", embed: "J/2026-08-10#^tabc12" }],
  });

  it("renders frontmatter, reflection note, questions, and entries", () => {
    expect(page).toContain("type: thread");
    expect(page).toContain(REFLECTION_NOTE);
    expect(page).toContain("> ⟲ The first entry frames");
    expect(page).toContain("- 2026-08-10 — ![[J/2026-08-10#^tabc12]]");
  });

  it("appendWeave adds under Entries without touching the reflection", () => {
    const edited = page.replace(REFLECTION_NOTE, "My own hard-won reflection paragraph.");
    const out = appendWeave(edited, { label: "2026-08-14", embed: "J/2026-08-14#^t9" });
    expect(out).toContain("My own hard-won reflection paragraph.");
    const entriesAt = out.indexOf("## Entries");
    expect(out.indexOf("![[J/2026-08-14#^t9]]")).toBeGreaterThan(entriesAt);
    // Order preserved: new entry after the old one.
    expect(out.indexOf("![[J/2026-08-14")).toBeGreaterThan(out.indexOf("![[J/2026-08-10"));
  });

  it("appendWeave recreates a deleted Entries section and dedupes embeds", () => {
    const stripped = page.slice(0, page.indexOf("## Entries"));
    const out = appendWeave(stripped, { label: "2026-08-14", embed: "J/2026-08-14" });
    expect(out).toContain("## Entries");
    expect(appendWeave(out, { label: "2026-08-14", embed: "J/2026-08-14" })).toBe(out);
  });
});

describe("clustering + weave candidates", () => {
  const hit = (path: string, cosine: number) => ({
    path,
    title: path,
    snippet: `snippet of ${path}`,
    cosine,
    periodic: true,
  });

  it("clusters recurring entries even when a permanent note is nearby", () => {
    const entries: EntryNeighbors[] = [
      { path: "a.md", hits: [hit("b.md", 0.82), { ...hit("Zettel.md", 0.9), periodic: false }] },
      { path: "b.md", hits: [hit("c.md", 0.8)] },
      { path: "c.md", hits: [hit("a.md", 0.79)] },
      { path: "lone.md", hits: [hit("a.md", 0.5)] },
    ];
    const clusters = clusterThreadCandidates(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].entries.sort()).toEqual(["a.md", "b.md", "c.md"]);
    expect(clusters[0].evidence.length).toBeGreaterThan(0);
  });

  it("weaveCandidates finds unwoven entries reaching into a thread", () => {
    const neighborhoods: EntryNeighbors[] = [
      { path: "new.md", hits: [hit("old1.md", 0.81)] },
      { path: "old1.md", hits: [hit("new.md", 0.81)] },
      { path: "far.md", hits: [hit("old1.md", 0.4)] },
    ];
    const woven = { "J/Threads/T.md": { "old1.md": "tabc", "old2.md": "" } };
    expect(weaveCandidates(neighborhoods, woven)).toEqual([
      { threadPath: "J/Threads/T.md", entryPath: "new.md" },
    ]);
  });

  it("cluster keys are order-independent; fallback labels are snippet-derived", () => {
    expect(clusterKeyOf(["b", "a"])).toBe(clusterKeyOf(["a", "b"]));
    expect(fallbackLabel({ entries: [], evidence: ["A ".repeat(60)] }).length).toBeLessThanOrEqual(48);
    expect(fallbackLabel({ entries: [], evidence: [] })).toBe("recurring topic");
  });
});

describe("thread prompts: the voice contract is in the text", () => {
  it("every generation prompt carries the no-new-emotion-words rule", () => {
    for (const prompt of [
      threadJudgePrompt(["x"]),
      threadGatherPrompt("T", [{ path: "a.md", date: "2026-08-10", text: "x" }]),
      threadMovementPrompt("T", ["x"], "y"),
    ]) {
      expect(prompt.toLowerCase()).toContain("emotion words");
    }
  });

  it("parsers fail toward silence", () => {
    expect(parseThreadJudge("not json")).toEqual({ isThread: false, name: "" });
    expect(parseThreadJudge('{"isThread": true, "name": "  "}')).toEqual({
      isThread: false,
      name: "",
    });
    expect(parseThreadGather("garbage")).toEqual({ spans: [], questions: [] });
    expect(parseThreadMovement('{"clause": "' + "x".repeat(120) + '"}')).toBe("");
    expect(parseThreadMovement('{"clause": "now weighs schools, not the offer."}')).toBe(
      "now weighs schools, not the offer",
    );
  });

  it("parseThreadGather keeps only well-formed spans and caps questions", () => {
    const r = parseThreadGather(
      JSON.stringify({
        spans: [{ path: "a.md", quote: "real quote" }, { path: "b.md" }, null],
        questions: ["q1", "q2", "q3", "q4", 7],
      }),
    );
    expect(r.spans).toEqual([{ path: "a.md", quote: "real quote" }]);
    expect(r.questions).toEqual(["q1", "q2", "q3"]);
  });
});
