/**
 * Organizing from the vault chat: moving notes and managing tags, always as
 * a proposal for the owner, never touching a note's text beyond its tags,
 * and never leaving a note less private than it was.
 */
import { describe, expect, it } from "vitest";
import type { ChatTool } from "../src/chat/engine";
import { folderPath, vaultTools, type VaultAccess } from "../src/chat/tools";
import type { PrivacyLevel } from "../src/privacy/levels";

const notes: Record<string, string> = {
  "Inbox/Atomic habits.md": "---\ntags: [reading]\n---\n# Atomic habits\n\nNotes on the book. #later\n",
  "Inbox/Garden plan.md": "# Garden plan\n\nTomatoes by the fence.\n",
  "Inbox/Clinic letter.md": "---\nagent-access: local\n---\n# Clinic letter\n",
  "Private/Health log.md": "---\ntags:\n  - health\n  - reading\n---\nPrivate.\n",
  "Projects/Ariadne/Ideas.md": "---\ntags: [Reading, project/ariadne]\n---\nIdeas.\n",
  "Personal/Journal/2026-11-01.md": "A private day.",
};
const TAGS: Record<string, string[]> = {
  "Inbox/Atomic habits.md": ["reading", "later"],
  "Private/Health log.md": ["health", "reading"],
  "Projects/Ariadne/Ideas.md": ["Reading", "project/ariadne"],
  "Personal/Journal/2026-11-01.md": ["journal", "reading"],
};

/** Private/ is local-only; the journal is not shown; a note's agent-access property counts as in Ariadne. */
function levelAt(note: string, at: string): PrivacyLevel {
  const own = /agent-access: local/.test(notes[note] ?? "") ? "local" : undefined;
  if (at.startsWith("Personal/Journal/")) return "sealed";
  return at.startsWith("Private/") ? "local" : (own ?? "shareable");
}

function vault(): VaultAccess {
  return {
    notes: () => Object.keys(notes).map((path) => ({ path, mtime: 0, tags: TAGS[path] ?? [] })),
    open: async () => {},
    exists: (path) => path in notes,
    writable: (path) => (path.startsWith("Personal/Journal/") ? { ok: false, why: "that is where your journal lives" } : { ok: true }),
    levelAt,
    modelName: () => "gemma4:31b",
    search: async () => [],
    read: async (p) => notes[p],
    readable: (p) => (p.startsWith("Personal/Journal/") ? { ok: false, why: "the journal is not read" } : { ok: true }),
    resolve: (name) => [name, `${name}.md`].find((p) => p in notes),
    today: () => "2026-11-22",
  };
}

const tool = (name: string): ChatTool => vaultTools(vault()).find((t) => t.name === name)!;

describe("folderPath", () => {
  it("takes a folder as written, and refuses one that climbs out, hides, or has characters a path may not", () => {
    expect(folderPath(" /Projects/Ariadne/ ")).toBe("Projects/Ariadne");
    expect(folderPath("")).toBe("");
    expect(folderPath("/")).toBe("");
    for (const bad of ["../Elsewhere", "A/./B", "A//B", ".obsidian", "A/.trash", "What?", "A:B"]) expect(folderPath(bad)).toBeNull();
  });
});

describe("tags", () => {
  it("lists the tags in use with their counts, leaving out notes this chat may not be shown", async () => {
    const r = await tool("tags").run({});
    expect(r.text).toBe("#reading (2), #health (1), #later (1), #project/ariadne (1), #Reading (1)");
    expect((await tool("tags").run({ prefix: "#project/" })).text).toBe("#project/ariadne (1)");
  });
});

describe("propose_moves", () => {
  it("proposes moves as one batch, changing no text, and applies nothing itself", async () => {
    const r = await tool("propose_moves").run({
      moves: [{ path: "Inbox/Atomic habits.md", folder: "Resources/Books" }, { path: "Inbox/Garden plan", folder: "/Projects/" }],
      reason: "Books under Resources, live plans under Projects.",
    });
    expect(r.proposal).toEqual({
      title: "Move 2 notes",
      description: "Books under Resources, live plans under Projects.",
      changes: [
        { type: "move", path: "Inbox/Atomic habits.md", to: "Resources/Books/Atomic habits.md" },
        { type: "move", path: "Inbox/Garden plan.md", to: "Projects/Garden plan.md" },
      ],
    });
    expect(r.text).toMatch(/^Proposed, not applied: 2 moves/);
    expect(notes["Inbox/Atomic habits.md"]).toContain("Atomic habits");
  });

  it("never leaves a note less private, never moves journal entries or into the journal, and never onto a note", async () => {
    const r = await tool("propose_moves").run({
      moves: [
        { path: "Private/Health log.md", folder: "Resources" },
        { path: "Personal/Journal/2026-11-01.md", folder: "Archive" },
        { path: "Inbox/Garden plan.md", folder: "Personal/Journal" },
        { path: "Inbox/Atomic habits.md", folder: "Projects/Ariadne/../.." },
        { path: "Inbox/Garden plan.md", folder: "Inbox" },
        { path: "Inbox/Clinic letter.md", folder: "Private" },
      ],
    });
    // Its own agent-access property keeps the letter local-only wherever it goes; into Private it stays local.
    expect(r.proposal?.changes).toEqual([{ type: "move", path: "Inbox/Clinic letter.md", to: "Private/Clinic letter.md" }]);
    expect(r.text).toContain("Private/Health log.md: it is local-only and would be shareable in Resources");
    expect(r.text).toContain('"Personal/Journal/2026-11-01.md" is not shown to this chat');
    expect(r.text).toContain("Inbox/Garden plan.md: cannot go to Personal/Journal — that is where your journal lives");
    expect(r.text).toContain('"Projects/Ariadne/../.." is not a usable folder');
  });

  it("refuses a move onto an existing note, or two notes onto one path", async () => {
    notes["Projects/Garden plan.md"] = "taken";
    try {
      const r = await tool("propose_moves").run({ moves: [{ path: "Inbox/Garden plan.md", folder: "Projects" }] });
      expect(r.proposal).toBeUndefined();
      expect(r.text).toContain("there is already a note at Projects/Garden plan.md");
    } finally {
      delete notes["Projects/Garden plan.md"];
    }
  });
});

describe("propose_moves with tags", () => {
  it("retags each note where it is, then moves it — one batch, so the tags never point at a path that is not there yet", async () => {
    const r = await tool("propose_moves").run({
      moves: [{ path: "Inbox/Atomic habits.md", folder: "Resources/Books" }, { path: "Inbox/Garden plan.md", folder: "Resources/Books" }],
      add: ["book"],
      remove: ["later"],
    });
    expect(r.proposal?.title).toBe("Move 2 notes to Resources/Books; add #book; remove #later");
    expect(r.proposal?.changes.map((c) => [c.type, c.path, c.to])).toEqual([
      ["modify", "Inbox/Atomic habits.md", undefined],
      ["move", "Inbox/Atomic habits.md", "Resources/Books/Atomic habits.md"],
      ["modify", "Inbox/Garden plan.md", undefined],
      ["move", "Inbox/Garden plan.md", "Resources/Books/Garden plan.md"],
    ]);
    expect(r.proposal?.changes[0]?.after).toBe("---\ntags: [reading, book]\n---\n# Atomic habits\n\nNotes on the book. #later\n");
    expect(r.text).toContain("Inbox/Atomic habits.md: moved, but #later is written in its text");
  });
});

describe("propose_tags", () => {
  it("adds and removes tags in the properties only, reporting a tag that is written in the text", async () => {
    const r = await tool("propose_tags").run({ notes: ["Inbox/Atomic habits.md", "Inbox/Garden plan.md"], add: "inbox", remove: ["later"] });
    expect(r.proposal?.changes).toEqual([
      { type: "modify", path: "Inbox/Atomic habits.md", before: notes["Inbox/Atomic habits.md"], after: "---\ntags: [reading, inbox]\n---\n# Atomic habits\n\nNotes on the book. #later\n" },
      { type: "modify", path: "Inbox/Garden plan.md", before: notes["Inbox/Garden plan.md"], after: "---\ntags:\n  - inbox\n---\n# Garden plan\n\nTomatoes by the fence.\n" },
    ]);
    expect(r.text).toContain("Inbox/Atomic habits.md: #later is written in the note's text and is left for the owner to change.");
    expect(r.proposal?.title).toBe("Tags: add #inbox; remove #later in 2 notes");
  });

  it("renames a tag everywhere it may: notes left out means every note that carries it", async () => {
    const r = await tool("propose_tags").run({ remove: ["reading"], add: ["books"] });
    expect(r.proposal?.changes.map((c) => [c.path, c.after])).toEqual([
      ["Inbox/Atomic habits.md", "---\ntags: [books]\n---\n# Atomic habits\n\nNotes on the book. #later\n"],
      ["Private/Health log.md", "---\ntags:\n  - health\n  - books\n---\nPrivate.\n"],
      ["Projects/Ariadne/Ideas.md", "---\ntags: [project/ariadne, books]\n---\nIdeas.\n"],
    ]);
    // The journal entry carries the tag too, but this chat is not shown it: it is not touched.
    expect(r.proposal?.changes.some((c) => c.path.startsWith("Personal/"))).toBe(false);
  });

  it("proposes nothing when nothing would change, and refuses what is not a tag", async () => {
    expect((await tool("propose_tags").run({ notes: ["Inbox/Atomic habits.md"], add: ["reading"] })).proposal).toBeUndefined();
    expect((await tool("propose_tags").run({ notes: ["Inbox/Atomic habits.md"], add: ["not a tag"] })).text).toContain("is not a tag");
    expect((await tool("propose_tags").run({ add: ["x"] })).text).toContain('Give "notes"');
  });
});
