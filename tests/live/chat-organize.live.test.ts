/**
 * Organizing with a real local model: does it look first, and propose moves
 * and tags that fit the vault it was shown? Invented notes only.
 *   LIVE_OLLAMA=http://host:11434 LIVE_MODEL=gemma4:26b npx vitest run tests/live/chat-organize.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { ChatEngine, type Complete } from "../../src/chat/engine";
import { vaultTools, type VaultAccess } from "../../src/chat/tools";

const base = process.env.LIVE_OLLAMA;
const modelName = process.env.LIVE_MODEL ?? "gemma4:26b";
const run = base ? describe : describe.skip;

const notes: Record<string, string> = {
  "Inbox/Thinking Fast and Slow.md": "# Thinking, Fast and Slow\n\nKahneman's two systems. Notes from chapter 3.\n",
  "Inbox/The Overstory.md": "# The Overstory\n\nRichard Powers. A novel about trees and the people who notice them.\n",
  "Inbox/Fix the gutter.md": "# Fix the gutter\n\nThe back gutter leaks over the door. Ladder is in the shed.\n",
  "Inbox/Standup 2026-11-20.md": "# Standup\n\nShipped the release. Next: review the migration.\n",
  "Resources/Books/Deep Work.md": "---\ntags: [book]\n---\n# Deep Work\n\nCal Newport.\n",
  "Resources/Books/Atomic Habits.md": "---\ntags: [book]\n---\n# Atomic Habits\n\nJames Clear.\n",
  "Areas/Home/Boiler.md": "---\ntags: [home]\n---\n# Boiler\n\nServiced in October.\n",
  "Projects/Release 0.11.md": "# Release 0.11\n",
  "Personal/Journal/2026-11-21.md": "A private day.",
};
const tagsOf = (text: string): string[] => /tags: \[(.*)\]/.exec(text)?.[1]?.split(",").map((t) => t.trim()) ?? [];

const vault: VaultAccess = {
  notes: () => Object.entries(notes).map(([path, text]) => ({ path, mtime: 0, tags: tagsOf(text) })),
  open: async () => {},
  exists: (path) => path in notes,
  writable: (path) => (path.startsWith("Personal/Journal/") ? { ok: false, why: "that is where your journal lives" } : { ok: true }),
  levelAt: (_note, at) => (at.startsWith("Personal/") ? "sealed" : "shareable"),
  modelName: () => modelName,
  search: async (q) =>
    Object.entries(notes)
      .filter(([p, t]) => q.toLowerCase().split(/\s+/).some((w) => `${p} ${t}`.toLowerCase().includes(w)))
      .map(([path, text]) => ({ path, title: path, snippet: text.slice(0, 120) })),
  read: async (p) => notes[p],
  readable: (p) => (p.startsWith("Personal/Journal/") ? { ok: false, why: "the journal is not read" } : { ok: true }),
  resolve: (name) => [name, `${name}.md`].find((p) => p in notes),
  today: () => "2026-11-22",
};

const complete: Complete = async (prompt, opts) => {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model: modelName,
      stream: false,
      think: false,
      format: opts.schema,
      options: { temperature: 0, num_predict: opts.maxTokens },
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: prompt },
      ],
    }),
  });
  const body = (await res.json()) as { message?: { content?: string } };
  return body.message?.content ?? "";
};

run("vault chat organizing, live model", () => {
  it("files the book notes with the other books and tags them the same way, touching nothing else", async () => {
    const engine = new ChatEngine({ complete, tools: vaultTools(vault), today: () => "2026-11-22 (Sunday)" });
    const steps: string[] = [];
    const reply = await engine.send([], "Tidy my Inbox: put the book notes with my other book notes, and tag them the way those are tagged.", (s) => steps.push(s));
    const changes = (reply.proposals ?? []).flatMap((p) => p.changes);
    console.log(JSON.stringify({ steps, answer: reply.text, changes: changes.map((c) => [c.type, c.path, c.to ?? (c.after ?? "").slice(0, 60)]) }, null, 1));
    const moved = Object.fromEntries(changes.filter((c) => c.type === "move").map((c) => [c.path, c.to]));
    expect(moved["Inbox/Thinking Fast and Slow.md"]).toBe("Resources/Books/Thinking Fast and Slow.md");
    expect(moved["Inbox/The Overstory.md"]).toBe("Resources/Books/The Overstory.md");
    // Only the books: the gutter and the standup stay where they are.
    expect(Object.keys(moved).sort()).toEqual(["Inbox/The Overstory.md", "Inbox/Thinking Fast and Slow.md"]);
    const tagged = changes.filter((c) => c.type === "modify");
    expect(tagged.length).toBeGreaterThan(0);
    for (const c of tagged) {
      expect(c.after).toMatch(/tags:\s*(\[book\]|\n\s+- book)/);
      // The note's own text is all still there, below the properties.
      expect(c.after).toContain(c.before!.replace(/^---[\s\S]*?---\n/, ""));
    }
  }, 600_000);
});
