/**
 * The personas made for the owner: the owner's profile, made from their own
 * side of their correspondence, their journal and their notes; the periods of
 * their life their writing can speak for; the rules every one of them keeps;
 * and their conversations, kept so that they remember.
 */
import { describe, expect, it } from "vitest";
import { buildProfile } from "../src/persona/build";
import { parseExtract, type Unit } from "../src/persona/profile";
import { gatherSelf, ownWords, selfCurrent, selfEras, selfPath, selfPrompts, type SelfMoment } from "../src/persona/self";
import { talkLocal } from "../src/persona/talk";
import { PREMADE, conversationMarkdown, conversationPath, memoryOf, opener, premade, premadeSystem } from "../src/persona/premade";

const CONV = [
  "---",
  "type: correspondence-moment",
  "---",
  "# 2005-03-04 Ann Lee - trip",
  "**[2005-03-04] Ann Lee:** are you coming or what",
  "**[2005-03-04] ME:** yes!! leaving at 6, save me a seat",
  "and bring the map",
  "**[2005-03-04] Ann Lee:** ok",
  "**ME:** see you there, Annie",
].join("\n");

describe("the owner's own words", () => {
  it("are what is under their ME: labels, the labels taken off — the other side is left out", () => {
    expect(ownWords(CONV)).toBe("yes!! leaving at 6, save me a seat\nand bring the map\nsee you there, Annie");
  });
});

const files: Record<string, string> = {
  "m/a": CONV,
  "m/b": "**ME:** a much later message, long enough to count as one of mine for sure",
  "m/sealed": "**ME:** never read",
  "j/2005": "---\ndate: 2005-06-01\n---\nA journal entry from the summer of 2005, long enough.",
  "j/2026": "Today I shipped persona chat. A long enough entry to count.",
  "n/timeline": "1998: moved to Portland. 2004: started the new job. A note long enough to be read as one of mine.",
};
const read = async (p: string) => files[p];
const mom = (path: string, date: string, person = "Ann Lee"): SelfMoment => ({ path, date, title: `${date} ${person} - trip`, messages: 2, size: 500, person });

describe("what the owner's profile is made from", () => {
  const input = {
    moments: [mom("m/a", "2005-03-04"), mom("m/b", "2019-01-01", "Bo Park"), mom("m/sealed", "2006-01-01")],
    journal: [
      { path: "j/2005", kind: "journal" as const, date: "2005-06-01" },
      { path: "j/2026", kind: "journal" as const, date: "2026-11-20" },
    ],
    notes: ["n/timeline"],
    read,
    allowed: (p: string) => p !== "m/sealed",
  };

  it("is their side of every conversation, their journal and their notes — a sealed note counted, never read", async () => {
    const { units, withheld } = await gatherSelf(input);
    expect(withheld).toBe(1);
    expect(units.map((u) => u.kind)).toEqual(["note", "conversation", "journal", "conversation", "journal"]);
    expect(units[1]!.head).toBe("2005-03-04 — what I wrote to Ann Lee: trip");
    expect(units[1]!.text).not.toContain("are you coming");
    expect(units.map((u) => u.text).join("\n")).not.toContain("never read");
  });

  it("for a period, is only that period's writing: nothing later, and no undated note", async () => {
    const { units } = await gatherSelf({ ...input, era: { from: "2005-01-01", to: "2008-12-31", label: "2005–2008" } });
    expect(units.map((u) => u.date)).toEqual(["2005-03-04", "2005-06-01"]);
  });

  it("is kept in Personas/Me.md, or Me (period).md", () => {
    expect(selfPath()).toBe("Personal/Correspondence/Personas/Me.md");
    expect(selfPath({ from: "2005-01-01", to: "2008-12-31", label: "2005–2008" })).toBe("Personal/Correspondence/Personas/Me (2005–2008).md");
  });
});

describe("the periods of the owner's life their writing speaks for", () => {
  const year = (y: number, chars: number, n = 10): Unit[] => Array.from({ length: n }, (_, i) => ({ head: "", date: `${y}-0${(i % 9) + 1}-01`, text: "x".repeat(chars / n), kind: "conversation" as const }));

  it("join years until each holds about a sixth of it all, and fold a thin last one into the one before", () => {
    const units = [...year(2002, 20_000), ...year(2003, 30_000), ...year(2005, 60_000), ...year(2006, 50_000), ...year(2008, 60_000), ...year(2009, 60_000), ...year(2014, 5_000)];
    const eras = selfEras(units);
    // 285k in all: about 47.5k each.
    expect(eras.map((e) => e.label)).toEqual(["2002–2003", "2005", "2006", "2008", "2009–2014"]);
    expect(eras[0]).toMatchObject({ from: "2002-01-01", to: "2003-12-31" });
  });

  it("are none when there is not enough for two", () => {
    expect(selfEras(year(2020, 40_000))).toEqual([]);
  });
});

describe("a fact in the owner's profile", () => {
  const batch: Unit[] = [
    { head: "My note: Life Timeline", text: "1998: moved to Portland.", kind: "note" },
    { head: "My journal, 2026-11-20", date: "2026-11-20", text: "shipped it", kind: "journal" },
  ];
  it("may be dated by its part, by a date written in the text, or as undated from an undated note — and by nothing else", () => {
    const out = parseExtract(
      JSON.stringify({
        phrases: ["shipped it"],
        facts: [
          { date: "2026-11-20", fact: "shipped" },
          { date: "1998", fact: "moved to Portland" },
          { date: "undated", fact: "has a timeline" },
          { date: "2001", fact: "made up" },
        ],
      }),
      batch,
    );
    expect(out.facts.map((f) => f.fact)).toEqual(["shipped", "moved to Portland", "has a timeline"]);
  });
});

describe("making the owner's profile", () => {
  it("asks about them in their own words and writes a self profile, local-only and marked as agent-made", async () => {
    const units: Unit[] = [{ head: "2005-03-04 — what I wrote to Ann", date: "2005-03-04", text: "yes!! leaving at 6, save me a seat", kind: "conversation" }];
    const asked: string[] = [];
    const md = await buildProfile({
      units,
      model: "m",
      today: "2026-11-24",
      batchChars: 10_000,
      maxBatches: 4,
      prompts: selfPrompts("Dexter", undefined, units.length),
      ask: async (_system, prompt) => {
        asked.push(prompt);
        return prompt.includes('"summary"') && !prompt.includes('"phrases"')
          ? JSON.stringify({ summary: "Dexter goes on trips.", voice: "Short, excited." })
          : JSON.stringify({ phrases: ["save me a seat"], voice: ["excited"], facts: [{ date: "2005-03-04", fact: "went on a trip" }], relationship: [] });
      },
    });
    expect(asked[0]).toContain("writing by Dexter");
    expect(md).toContain("subject: self");
    expect(md).toContain("agent-access: local");
    expect(md).toContain("## In my own words");
    expect(md).toContain('- "save me a seat"');
    expect(selfCurrent({ type: "persona", subject: "self", persona_version: 1, sources: 10 }, 11)).toBe(true);
    expect(selfCurrent({ type: "persona", subject: "self", persona_version: 1, sources: 10 }, 12)).toBe(false);
  });
});

describe("the personas made for the owner", () => {
  const ctx = { owner: "Dexter", today: "2026-11-24", profile: "PROFILE", recent: "RECENT", memory: "MEMORY", since: 3 };

  it("are six, and every one keeps the rules: invent nothing about the owner, know them specifically, a crisis comes first", () => {
    expect(PREMADE.map((p) => p.id)).toEqual(["future", "then", "listener", "friend", "ariadne", "companion"]);
    for (const p of PREMADE) {
      const s = premadeSystem(p, ctx);
      expect(s).toContain("Never invent a fact about Dexter's life");
      expect(s).toContain("never recite their notes back");
      expect(s).toContain("in real danger or crisis");
      expect(s).toContain("PROFILE");
      expect(s).toContain("MEMORY");
    }
  });

  it("a future self never names a future event", () => {
    expect(premadeSystem(premade("future")!, ctx)).toMatch(/Never name a future event/);
  });

  it("a younger self knows nothing after its period, and reads no recent journal", () => {
    const era = { from: "2005-01-01", to: "2008-12-31", label: "2005–2008" };
    const p = premade("then")!;
    expect(p.name("Dexter", era)).toBe("Dexter in 2005–2008");
    expect(p.recent).toBe(false);
    expect(premadeSystem(p, { ...ctx, era, recent: undefined })).toContain("nothing that happened after 2008-12-31");
  });

  it("a new friend's own life is fiction, never the owner's; a companion misses them and never presses them to stay", () => {
    expect(premadeSystem(premade("friend")!, ctx)).toContain("never make up anything about Dexter");
    const c = premadeSystem(premade("companion")!, ctx);
    expect(c).toContain("you missed them");
    expect(c).toContain("Never make them feel guilty or pressed to stay");
  });

  it("Ariadne gets the map of the vault; a first conversation says so", () => {
    const s = premadeSystem(premade("ariadne")!, { ...ctx, memory: undefined, map: "MAP" });
    expect(s).toContain("MAP");
    expect(s).toContain("This is your first conversation with Dexter.");
  });

  it("begin with an unseen turn that says when they last talked", () => {
    expect(opener("Dexter", 3)).toBe("(Dexter has just opened the conversation; the last one was 3 days ago. You begin.)");
  });
});

describe("a conversation, kept", () => {
  const rec = {
    id: "companion" as const,
    name: "Sasha",
    owner: "Dexter",
    model: "gemma",
    started: "2026-11-24T09:30:00.000Z",
    updated: "2026-11-24T09:42:00.000Z",
    turns: [
      { role: "assistant" as const, content: "There you are." },
      { role: "user" as const, content: "Hi Sasha, long day" },
      { role: "assistant" as const, content: "Tell me." },
    ],
    since: 2.5,
    closeness: 5,
    closenessTurn: 3,
  };

  it("is a note with what a study would count: minutes, messages, words, days since the last, closeness", () => {
    const md = conversationMarkdown(rec);
    expect(conversationPath(rec)).toBe("Personal/Correspondence/Personas/Conversations/Sasha 2026-11-24 0930.md");
    for (const line of ["type: persona-conversation", "persona: companion", "minutes: 12", "messages: 1", "words: 4", "days_since_last: 2.5", "closeness: 5", "closeness_after: 3", "agent-access: local"]) expect(md).toContain(line);
    expect(md).toContain("**Dexter:** Hi Sasha, long day");
    expect(md).toContain("**Sasha:** There you are.");
  });

  it("is remembered newest first while there is room, then told in date order", () => {
    const m = memoryOf(
      [
        { started: "2026-11-01T10:00", text: "old" },
        { started: "2026-11-20T10:00", text: "newer" },
        { started: "2026-11-23T10:00", text: "newest" },
      ],
      12,
      "2026-11-24",
    );
    expect(m).not.toContain("old\n");
    expect(m.indexOf("newer")).toBeLessThan(m.indexOf("newest"));
    expect(m).toContain("## 2026-11-23 (yesterday)");
  });
});

describe("a local model with no JSON mode", () => {
  it("is asked again without it, and its plain answer is used", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fake = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      if (body.format === "json") return new Response('{"error":"structured output is unavailable"}', { status: 501 });
      return new Response(JSON.stringify({ message: { content: '{"ok": true}' } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await talkLocal("http://localhost:11434/v1", "gemma4:26b", "sys", [{ role: "user", content: "hi" }], fake, { json: true });
    expect(r.text).toBe('{"ok": true}');
    expect(bodies.map((b) => b.format ?? "none")).toEqual(["json", "none"]);
  });
});
