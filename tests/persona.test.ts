/**
 * Persona chat: the people found in the owner's correspondence, the periods of
 * their life together that have enough to go on, the persona note made from
 * their notes — their own words checked word for word, every fact dated by a
 * source — and the rules a persona is held to.
 */
import { describe, expect, it } from "vitest";
import { findPeople, mentionPattern, type Moment, type NoteInfo, type Person } from "../src/persona/people";
import { enoughEras, gapEras, inEra, parseEras } from "../src/persona/eras";
import { excerpts, gatherUnits, passages, personaSystem } from "../src/persona/context";
import { batches, isCurrent, mergeExtracts, parseExtract, profilePath, type Unit } from "../src/persona/profile";
import { buildProfile, plan } from "../src/persona/build";
import { cloudEstimate, contextFor } from "../src/persona/talk";

const moment = (date: string, person: string, title = "chat", messages = 3, size = 2000): NoteInfo => ({
  path: `Personal/Correspondence/Moments/${date} ${person} - ${title}.md`,
  mtime: 0,
  size,
  frontmatter: { type: "correspondence-moment", person, date, messages },
});
const personNote = (name: string, fm: Record<string, unknown> = {}, size = 500): NoteInfo => ({
  path: `Personal/Correspondence/People/${name}.md`,
  mtime: 0,
  size,
  frontmatter: { type: "reference", name, ...fm },
});
const ms = (dates: string[], size = 2000): Moment[] => dates.map((date) => ({ path: date, date, title: "", messages: 1, size }));

describe("the people in the owner's correspondence", () => {
  it("joins each person's note to their conversations, by name or another name — the one there is most to know them by first", () => {
    const people = findPeople([
      personNote("Ann Lee", { aka: ["Annie"], messages: 40, first_contact: "2010-01-01", last_contact: "2012-01-01" }),
      personNote("Bo Park", { messages: 300 }),
      moment("2011-03-04", "Annie", "a", 3, 30_000),
      moment("2010-05-06", "Ann Lee", "b", 3, 30_000),
      moment("2019-01-01", "Bo Park"),
      moment("2015-01-01", "[[Ann Lee]]", "c", 3, 30_000),
      moment("2016-01-01", "Cy Ward", "a", 5),
      moment("2016-02-01", "Cy Ward", "b", 7),
      moment("2016-03-01", "Dee Once"),
    ]);
    // Ann has fewer messages than Bo, but far more written: more to know her by.
    expect(people.map((p) => p.name)).toEqual(["Ann Lee", "Bo Park", "Cy Ward"]);
    const ann = people[0]!;
    expect(ann.moments.map((m) => m.date)).toEqual(["2010-05-06", "2011-03-04", "2015-01-01"]);
    expect([ann.first, ann.last]).toEqual(["2010-01-01", "2015-01-01"]);
    expect(ann.aliases).toContain("Annie");
    expect([people[2]!.note, people[2]!.messages]).toEqual([undefined, 12]);
  });

  it("finds a person mentioned by name, another name or first name — as whole words", () => {
    const re = mentionPattern({ name: "Ann Lee", aliases: ["Annie"] });
    for (const t of ["Lunch with Ann Lee.", "annie called", "Ann and I walked"]) expect(re.test(t)).toBe(true);
    for (const t of ["Anne called", "the annual review", "Annabel"]) expect(re.test(t)).toBe(false);
  });
});

describe("the periods of a relationship", () => {
  it("splits at a long silence, folding a period too small to choose into its neighbour", () => {
    const eras = gapEras(ms(["2005-01-01", "2005-02-01", "2005-06-01", "2010-01-01", "2010-03-01", "2010-04-01", "2010-05-01", "2014-01-01"]));
    expect(eras.map((e) => [e.from, e.to])).toEqual([["2005-01-01", "2005-06-01"], ["2010-01-01", "2014-01-01"]]);
    expect(gapEras(ms(["2005-01-01", "2005-02-01"]))).toHaveLength(1);
  });

  it("takes a model's periods only when they are dated, in order and labelled", () => {
    const p = { first: "2004-06-01", last: "2020-01-01" };
    expect(parseEras('{"eras":[{"from":"2004","to":"2009-08","label":"dating"},{"from":"2009-09-01","to":"2030","label":"married"}]}', p)).toEqual([
      { from: "2004-06-01", to: "2009-08-31", label: "dating · 2004–2009" },
      { from: "2009-09-01", to: "2020-01-01", label: "married · 2009–2020" },
    ]);
    expect(parseEras('{"eras":[{"from":"2010","to":"2011","label":"b"},{"from":"2005","to":"2006","label":"a"}]}', p)).toBeUndefined();
    expect(parseEras("no json", p)).toBeUndefined();
    expect(inEra(ms(["2004-01-01", "2006-01-01"]), { from: "2005-01-01", to: "2007-01-01" }).map((m) => m.date)).toEqual(["2006-01-01"]);
  });

  it("offers periods only when every one has enough to go on — a known change with too little is joined to its neighbour", () => {
    const dating = Array.from({ length: 10 }, (_, i) => `2005-0${(i % 9) + 1}-1${i % 9}`);
    const married = Array.from({ length: 12 }, (_, i) => `2012-0${(i % 9) + 1}-0${(i % 9) + 1}`);
    const divorced = ["2019-01-01", "2019-02-01"];
    const moments = ms([...dating, ...married, ...divorced]);
    const eras = [
      { from: "2005-01-01", to: "2009-12-31", label: "dating · 2005–2009" },
      { from: "2010-01-01", to: "2018-12-31", label: "married · 2010–2018" },
      { from: "2019-01-01", to: "2019-12-31", label: "after the divorce · 2019" },
    ];
    expect(enoughEras(eras, moments).map((e) => e.label)).toEqual(["dating · 2005–2009", "married, then after the divorce · 2010–2019"]);
    // Enough conversations, but too little written in them: no choice of period at all.
    expect(enoughEras(eras.slice(0, 2), ms([...dating, ...married], 200))).toEqual([]);
  });
});

describe("what a persona is made of", () => {
  const files = new Map<string, string>([
    ["Personal/Correspondence/People/Ann Lee.md", "---\ntype: reference\n---\n# Ann Lee\nMy oldest friend; we met at school."],
    ["Personal/Correspondence/Moments/2010-05-06 Ann Lee - hi.md", "---\nperson: Ann Lee\n---\n**Ann:** heyyy you!! x\n**Me:** hi Ann"],
    ["Personal/Correspondence/Moments/2011-03-04 Ann Lee - trip.md", "---\nperson: Ann Lee\n---\n**Ann:** booked it :) see you in Lisbon xx"],
    ["Personal/Correspondence/Moments/2016-01-01 Ann Lee - later.md", "---\nperson: Ann Lee\n---\n**Ann:** long time!"],
    ["Personal/Journal/2011-03-05.md", "Slept badly. Ann called about the trip and we laughed for an hour."],
    ["Personal/Journal/2011-04-01.md", "Nothing about her today."],
    ["Personal/Sealed/Ann.md", "Ann Lee — sealed."],
  ]);
  const ann = (): Person =>
    findPeople(
      [...files.keys()].map((path) => ({
        path,
        mtime: 0,
        size: files.get(path)!.length,
        frontmatter: path.includes("/Moments/") ? { type: "correspondence-moment", person: "Ann Lee", date: path.split("/").pop()!.slice(0, 10) } : path.includes("/People/") ? { type: "reference", name: "Ann Lee" } : {},
      })),
    )[0]!;
  const gather = (era?: { from: string; to: string; label: string }) =>
    gatherUnits({
      person: ann(),
      era,
      read: async (p: string) => files.get(p),
      candidates: [
        { path: "Personal/Journal/2011-03-05.md", kind: "journal", date: "2011-03-05" },
        { path: "Personal/Journal/2011-04-01.md", kind: "journal", date: "2011-04-01" },
        { path: "Personal/Sealed/Ann.md", kind: "note" },
      ],
      allowed: (p: string) => !p.includes("/Sealed/"),
    });

  it("gathers their note, their conversations in the period and what the journal says of them, in date order — never a sealed note", async () => {
    const { units, withheld } = await gather({ from: "2010-01-01", to: "2012-12-31", label: "school · 2010–2012" });
    expect(units.map((u) => [u.kind, u.date])).toEqual([
      ["person note", undefined],
      ["conversation", "2010-05-06"],
      ["conversation", "2011-03-04"],
      ["journal", "2011-03-05"],
    ]);
    expect(units.map((u) => u.text).join()).not.toContain("long time!");
    expect(withheld).toBe(0);
    expect((await gather()).withheld).toBe(1);
  });

  it("keeps only their own words, word for word, and only facts dated by a part that was read", async () => {
    const { units } = await gather();
    const batch = units.filter((u) => u.kind === "conversation");
    const e = parseExtract(
      JSON.stringify({
        phrases: ["heyyy you!! x", "booked it :) see you in Lisbon xx", "Can't wait, darling!", "  long   time! "],
        voice: ["lowercase, lots of exclamation marks"],
        facts: [{ date: "2011-03-04", fact: "Ann booked a trip to Lisbon." }, { date: "2013-01-01", fact: "Ann moved to Paris." }, { fact: "undated" }],
        relationship: ["close friends"],
      }),
      batch,
    );
    // "Can't wait, darling!" is nowhere in what was read: not theirs.
    expect(e.phrases).toEqual(["heyyy you!! x", "booked it :) see you in Lisbon xx", "long time!"]);
    // The Paris fact names a date no part has: dropped, like the undated one.
    expect(e.facts).toEqual([{ date: "2011-03-04", fact: "Ann booked a trip to Lisbon." }]);
    expect(parseExtract("not json", batch)).toEqual({ facts: [], phrases: [], voice: [], relationship: [] });
  });

  it("makes the persona note in batches, then sums it up — marked agent-made and local-only, their words in quotes", async () => {
    const { units } = await gather();
    const prompts: string[] = [];
    let calls = 0;
    const md = await buildProfile({
      person: ann(),
      units,
      model: "gemma",
      today: "2026-11-23",
      batchChars: 200,
      maxBatches: 10,
      ask: async (_system, prompt) => {
        prompts.push(prompt);
        calls++;
        if (prompt.includes('"summary"')) return JSON.stringify({ summary: "Ann is my oldest friend.", voice: "Short, warm, lots of x's." });
        return JSON.stringify({ phrases: ["heyyy you!! x", "long time!"], voice: ["warm"], facts: [{ date: "2010-05-06", fact: "Ann said hello." }], relationship: ["friends"] });
      },
    });
    expect(calls).toBe(plan(units, 200, 10).batches + 1);
    expect(md).toMatch(/^---\ntype: persona\nauthorship: ai-generated\nmodel: "gemma"\nagent-access: local\npublish: false\nperson: "\[\[Ann Lee\]\]"/);
    expect(md).toContain("conversations: 3\nlast_conversation: 2016-01-01");
    expect(md).toContain('## In their own words\n\n- "heyyy you!! x"\n- "long time!"');
    expect(md).toContain("## What happened, by date\n\n- 2010-05-06: Ann said hello.");
    expect(md).toContain("## Whole exchanges");
    expect(isCurrent({ type: "persona", persona_version: 1, conversations: 3, last_conversation: "2016-01-01" }, 3, "2016-01-01")).toBe(true);
    expect(isCurrent({ type: "persona", persona_version: 1, conversations: 3, last_conversation: "2016-01-01" }, 4, "2017-01-01")).toBe(false);
  });

  it("does not make a persona that would not sound like them, or from too little read", async () => {
    const { units } = await gather();
    const base = { person: ann(), units, model: "m", today: "2026-11-23", batchChars: 200, maxBatches: 10 };
    await expect(buildProfile({ ...base, ask: async () => JSON.stringify({ phrases: ["not their words at all"], facts: [], voice: [], relationship: [] }) })).rejects.toThrow(/no words of Ann Lee's own/);
    await expect(buildProfile({ ...base, ask: async () => Promise.reject(new Error("down")) })).rejects.toThrow(/could not read/);
  });

  it("puts the persona note under Personas, a period's in its own note", () => {
    expect(profilePath({ name: "Ann Lee" })).toBe("Personal/Correspondence/Personas/Ann Lee.md");
    expect(profilePath({ name: "Ann Lee" }, { from: "2010-01-01", to: "2012-12-31", label: "school · 2010–2012" })).toBe("Personal/Correspondence/Personas/Ann Lee (school, 2010–2012).md");
  });

  it("cuts the notes into batches of a size, a long one cut to fit", () => {
    const u: Unit[] = [1, 2, 3].map((i) => ({ head: `h${i}`, text: "x".repeat(100), kind: "conversation" }));
    expect(batches(u, 250).map((b) => b.length)).toEqual([2, 1]);
    expect(batches([{ head: "h", text: "y".repeat(1000), kind: "conversation" }], 300)[0]![0]!.text.length).toBeLessThan(300);
    expect(mergeExtracts([{ facts: [{ date: "2", fact: "b" }], phrases: ["Hi"], voice: [], relationship: [] }, { facts: [{ date: "1", fact: "a" }], phrases: ["hi", "yo"], voice: [], relationship: [] }])).toMatchObject({ phrases: ["Hi", "yo"], facts: [{ date: "1", fact: "a" }, { date: "2", fact: "b" }] });
  });

  it("holds the persona to its two rules — their voice, and no invented facts — and adds their conversations word for word", async () => {
    const { units } = await gather();
    const conv = excerpts(units, 10_000);
    expect(conv).toContain("heyyy you!! x");
    const system = personaSystem({ name: "Ann Lee", today: "2026-11-23", cutoff: "2016-01-01", profile: "## How they write\nwarm", conversations: conv });
    expect(system).toContain("Your voice is Ann Lee's.");
    expect(system).toContain("Never invent a fact about Ann Lee's life or about the owner");
    expect(system).toContain("You know nothing of what happened after 2016-01-01.");
    expect(system).toContain("# Your conversations with the owner, word for word");
    expect(excerpts(units, 50)).toBe("");
    expect(passages(`${"x".repeat(50)} Ann ${"y".repeat(10)} Ann ${"z".repeat(50)}`, /Ann/, 20)).toHaveLength(1);
  });
});

describe("the model's side", () => {
  it("asks a local model for enough context, and estimates what Claude costs, the sources cached after the first turn", () => {
    expect(contextFor(1000)).toBe(16384);
    expect(contextFor(60_000)).toBe(32768);
    expect(contextFor(10_000_000)).toBe(131072);
    const e = cloudEstimate("claude-sonnet-5-5", 140_000);
    expect(e.first).toBeGreaterThan(e.next * 5);
  });
});
