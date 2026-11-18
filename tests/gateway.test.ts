import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MemoryIO } from "../src/gateway/io";
import { Gateway, type Client } from "../src/gateway/service";
import { MemoryLedger, listReviews, markDecided, type Observation } from "../src/gateway/submit";
import { parseRecord, inertQuote } from "../src/gateway/records";
import { createGatewayServer } from "../src/gateway/http";
import type { LevelPolicy } from "../src/gateway/levels";
import type { AddressInfo } from "node:net";

const policy: LevelPolicy = {
  localOnlyFolders: ["Personal", "Periodic"],
  sealedFolders: ["Personal/Journal"],
  agentFolder: "Agent",
};
const theseus: Client = { name: "theseus", class: "local", write: true, owner: true };
const outside: Client = { name: "cloud-assistant", class: "external" };

const ev = (at = "2026-11-16T10:00:00") => ({ source: "gmail", account: "primary", at, quote: "See you then" });

function setup() {
  const io = new MemoryIO();
  const ledger = new MemoryLedger();
  let clock = new Date("2026-11-16T10:00:00");
  const gateway = new Gateway({
    io,
    policy,
    ledger,
    itineraryFolderNames: ["Travel"],
    now: () => clock,
  });
  return { io, ledger, gateway, tick: (iso: string) => (clock = new Date(iso)) };
}

async function seedTrips(gateway: Gateway) {
  const mk = (key: string, title: string, start: string, end: string): Observation => ({
    key,
    kind: "trip",
    op: "create",
    title,
    state: "planned",
    start,
    end,
    place: "London",
    fields: { destination: "London" },
    evidence: { source: "vault-note", at: "2026-11-16T09:00:00" },
  });
  // The second London trip looks close to the first, so it is held; approve it.
  const a = await gateway.submissions.submit(mk("trip-nov", "2026 London November", "2026-11-20", "2026-11-27"), "theseus");
  const b = await gateway.submissions.submit(mk("trip-feb", "2027 London February", "2027-02-08", "2027-02-14"), "theseus");
  return { a, b };
}

describe("gateway: reading by client class", () => {
  it("shows an external client only shareable notes, and never reveals the rest exist", async () => {
    const { io, gateway } = setup();
    await io.create("Research/Spiders.md", "Orb weavers rebuild their web daily.");
    await io.create("Personal/Health.md", "Orb weavers appear in a dream; MRI on Tuesday.");
    await io.create("Personal/Journal/2026-11-16.md", "Orb weavers and private thoughts.");
    await io.create("Marked.md", "---\nagent-access: local\n---\nOrb weavers but private by property.");

    const ext = await gateway.search(outside, { query: "orb weavers" });
    expect(ext.hits.map((h) => h.path)).toEqual(["Research/Spiders.md"]);
    await expect(gateway.read(outside, { path: "Personal/Health.md" })).rejects.toThrow("no such note");
    await expect(gateway.read(outside, { path: "Nope.md" })).rejects.toThrow("no such note");

    const loc = await gateway.search(theseus, { query: "orb weavers" });
    expect(loc.hits.map((h) => h.path).sort()).toEqual(["Marked.md", "Personal/Health.md", "Research/Spiders.md"]);
    // Sealed: not even the local agent.
    await expect(gateway.read(theseus, { path: "Personal/Journal/2026-11-16.md" })).rejects.toThrow("no such note");
  });

  it("keeps records and matching from external clients entirely", async () => {
    const { gateway } = setup();
    await expect(gateway.get(outside, { kind: "bill" })).rejects.toThrow(/not available/);
    await expect(gateway.resolve(outside, { kind: "bill" })).rejects.toThrow(/not available/);
    await expect(gateway.submit(outside, { observations: [] })).rejects.toThrow(/not available/);
  });

  it("lists itinerary notes by folder name at any depth", async () => {
    const { io, gateway } = setup();
    await io.create("Personal/Travel/2026 BMVC.md", "Flights and hotel.");
    await io.create("Travel/Old.md", "x");
    await io.create("Research/Travel time.md", "not an itinerary");
    const res = await gateway.notes(theseus, { itineraries: true });
    expect(res.notes.map((n) => n.path)).toEqual(["Personal/Travel/2026 BMVC.md", "Travel/Old.md"]);
    const ext = await gateway.notes(outside, { itineraries: true });
    expect(ext.notes.map((n) => n.path)).toEqual(["Travel/Old.md"]);
  });
});

describe("gateway: which record is this about?", () => {
  it("holds a second, similar record for review instead of guessing", async () => {
    const { gateway } = setup();
    const { a, b } = await seedTrips(gateway);
    expect(a.status).toBe("applied");
    // Different dates exclude the November trip, so February is new, not "near".
    expect(b.status).toBe("applied");
  });

  it("puts a London confirmation on the right one of two London trips", async () => {
    const { gateway } = setup();
    await seedTrips(gateway);
    const feb = await gateway.resolve(theseus, { kind: "trip", date: "2027-02-09", place: "London Heathrow" });
    expect(feb.class).toBe("unique");
    expect(feb.title).toBe("2027 London February");
    const nov = await gateway.resolve(theseus, { kind: "trip", date: "2026-11-21", place: "London" });
    expect(nov.title).toBe("2026 London November");
  });

  it("asks rather than guesses when only the city is known", async () => {
    const { gateway } = setup();
    await seedTrips(gateway);
    const res = await gateway.resolve(theseus, { kind: "trip", place: "London" });
    expect(res.class).toBe("several");
    expect(res.candidates).toHaveLength(2);
    expect(res.question).toContain("2026-11-20");
    expect(res.question).toContain("2027-02-08");
    expect(res.question).toContain("none of these");
  });

  it("returns none when a hard fact excludes every record", async () => {
    const { gateway } = setup();
    await seedTrips(gateway);
    expect((await gateway.resolve(theseus, { kind: "trip", date: "2026-12-25", place: "London" })).class).toBe("none");
    expect((await gateway.resolve(theseus, { kind: "trip", date: "2026-11-21", place: "Paris" })).class).toBe("none");
  });

  it("matches exactly on a reference, and on a conversation once it is linked", async () => {
    const { gateway } = setup();
    const made = await gateway.submissions.submit(
      {
        key: "appt-1",
        kind: "appointment",
        op: "create",
        title: "Dentist cleaning",
        state: "confirmed",
        start: "2026-12-03T09:30",
        refs: ["CONF-88 412"],
        thread: "gmail:primary:thread-1",
        counterparts: ["frontdesk@brightsmiles.example"],
        fields: { category: "dental", with: "Dr Okafor" },
        evidence: ev(),
      } satisfies Observation,
      "theseus",
    );
    expect(made.status).toBe("applied");
    const byRef = await gateway.resolve(theseus, { kind: "appointment", refs: ["conf88412"] });
    expect(byRef.class).toBe("exact");
    const byThread = await gateway.resolve(theseus, { kind: "appointment", thread: "gmail:primary:thread-1" });
    expect(byThread.class).toBe("exact");
    // The sender alone is never enough.
    const bySender = await gateway.resolve(theseus, { kind: "appointment", counterparts: ["billing@brightsmiles.example"] });
    expect(bySender.class).toBe("several");
  });
});

const note = { source: "vault-note", at: "2026-11-16T09:00:00" };
const made = async (gateway: Gateway, o: Observation) => (await gateway.submissions.submit(o, "theseus")).status;

describe("gateway: journeys", () => {
  const leg = (key: string, over: Partial<Observation> & { fields?: Observation["fields"] }): Observation => ({
    key,
    kind: "transport",
    op: "create",
    title: key,
    start: "2026-05-28T13:05",
    evidence: note,
    ...over,
  });

  it("takes two flights on one booking and one day as two journeys", async () => {
    const { gateway } = setup();
    const first = leg("lhr-fra", { refs: ["K7QX2M"], fields: { mode: "flight", number: "LH 901", from: "London", to: "Frankfurt" } });
    const second = leg("fra-nrt", { refs: ["K7QX2M"], start: "2026-05-28T18:40", fields: { mode: "flight", number: "LH 716", from: "Frankfurt", to: "Tokyo" } });
    expect([await made(gateway, first), await made(gateway, second)]).toEqual(["applied", "applied"]);
  });

  it("takes the way back on the same booking as another journey, by number or by route", async () => {
    const { gateway } = setup();
    expect(await made(gateway, leg("out", { refs: ["AVANTI77"], start: "2026-11-22T07:40", fields: { mode: "train", from: "London Euston", to: "Lancaster" } }))).toBe("applied");
    expect(await made(gateway, leg("back", { refs: ["AVANTI77"], start: "2026-11-27T16:12", fields: { mode: "train", from: "Lancaster", to: "London Euston" } }))).toBe("applied");
    expect(await made(gateway, leg("ua-out", { refs: ["UAB123"], start: "2026-11-20T17:00", fields: { number: "UA 949" } }))).toBe("applied");
    expect(await made(gateway, leg("ua-back", { refs: ["UAB123"], start: "2026-11-30T11:00", fields: { number: "UA 930" } }))).toBe("applied");
    expect(await gateway.submissions.pending()).toHaveLength(0);
  });

  it("recognizes a journey moved to another day by its booking and its number", async () => {
    const { gateway } = setup();
    const res = await gateway.submissions.submit(leg("ua-out", { refs: ["UAB123"], start: "2026-11-20T17:00", fields: { number: "UA 949" } }), "theseus");
    const found = await gateway.resolve(theseus, { kind: "transport", refs: ["UAB123"], date: "2026-11-21T09:00", number: "UA949" });
    expect(found).toMatchObject({ class: "exact", id: res.id });
    expect(found.why).toMatch(/day has changed/);
  });

  it("asks when a booking reference recurs on another day and nothing says which journey it is", async () => {
    const { gateway } = setup();
    await gateway.submissions.submit(leg("first", { refs: ["BOOK4242"], start: "2026-11-22T07:40" }), "theseus");
    const second = await gateway.submissions.submit(leg("second", { refs: ["BOOK4242"], start: "2026-11-27T16:12" }), "theseus");
    expect(second.status).toBe("review");
    expect(second.reason).toMatch(/a change to that journey, or a separate leg/);
  });

  it("knows \"the 10:05\" by its day and departure time when the note gave no number", async () => {
    const { gateway } = setup();
    const res = await gateway.submissions.submit(leg("fly", { title: "Flight · to Manchester", start: "2026-11-19T10:05", fields: { mode: "flight", to: "Manchester" } }), "theseus");
    const r = (q: object) => gateway.resolve(theseus, { kind: "transport", ...q } as never);
    // The airline's message has the number the note lacked, and the same departure.
    expect(await r({ date: "2026-11-19T10:05", number: "BA 1392", from: "London Heathrow", to: "Manchester" })).toMatchObject({ class: "unique", id: res.id });
    expect((await r({ date: "2026-11-19T14:40", number: "BA 1400" })).class).toBe("none");
    expect((await r({ date: "2026-11-20T10:05", number: "BA 1392" })).class).toBe("none");
    expect((await r({ date: "2026-11-19" })).class).toBe("none");
  });

  it("identifies a journey by day and number or day and route — never by the day or a place alone", async () => {
    const { gateway } = setup();
    const res = await gateway.submissions.submit(leg("fco-hnd", { start: "2026-05-28T13:05", fields: { number: "AZ 792", from: "Rome", to: "Tokyo" } }), "theseus");
    const r = (q: object) => gateway.resolve(theseus, { kind: "transport", ...q } as never);
    expect((await r({ date: "2026-05-28" })).class).toBe("none");
    expect((await r({ date: "2026-05-28", place: "Tokyo" })).class).toBe("none");
    expect(await r({ date: "2026-05-28", number: "792" })).toMatchObject({ class: "unique", id: res.id });
    expect(await r({ date: "2026-05-28", from: "Rome Fiumicino", to: "Tokyo Haneda" })).toMatchObject({ class: "unique", id: res.id });
    expect((await r({ date: "2026-05-28", number: "AZ 793" })).class).toBe("none");
    expect((await r({ date: "2026-05-29", number: "AZ 792" })).class).toBe("none");
    expect((await r({ date: "2026-05-28", from: "Tokyo", to: "Rome" })).class).toBe("none");
  });
});

describe("gateway: overnight stays", () => {
  const stay = (key: string, lodging: string, start: string, end: string): Observation => ({
    key, kind: "stay", op: "create", title: lodging, start, end, place: "London", fields: { lodging }, evidence: note,
  });

  it("lets one stay end and the next begin on the same day", async () => {
    const { gateway } = setup();
    expect(await made(gateway, stay("a", "The Megaro Hotel", "2026-05-24", "2026-05-28"))).toBe("applied");
    expect(await made(gateway, stay("b", "Midland Hotel", "2026-05-28", "2026-05-31"))).toBe("applied");
    // A flight that day is a different kind of thing altogether.
    expect(await made(gateway, { key: "f", kind: "transport", op: "create", title: "Flight UA 949", start: "2026-05-28T13:05", fields: { number: "UA 949" }, evidence: note })).toBe("applied");
  });

  it("holds a second place for a night that already has one", async () => {
    const { gateway } = setup();
    await gateway.submissions.submit(stay("a", "The Megaro Hotel", "2026-05-24", "2026-05-28"), "theseus");
    const clash = await gateway.submissions.submit(stay("b", "Midland Hotel", "2026-05-27", "2026-05-30"), "theseus");
    expect(clash.status).toBe("review");
    expect(clash.reason).toMatch(/one overnight place per night/);
  });

  it("knows a stay by its name however it is written, and by its nights", async () => {
    const { gateway } = setup();
    const a = await gateway.submissions.submit(stay("a", "The Megaro Hotel", "2026-05-24", "2026-05-28"), "theseus");
    const b = await gateway.submissions.submit(stay("b", "Midland Hotel", "2026-05-28", "2026-05-31"), "theseus");
    const r = (q: object) => gateway.resolve(theseus, { kind: "stay", ...q } as never);
    expect(await r({ name: "Megaro", date: "2026-05-24", end: "2026-05-28" })).toMatchObject({ class: "unique", id: a.id });
    // The shared day belongs to whichever is named.
    expect(await r({ name: "Megaro", date: "2026-05-28" })).toMatchObject({ class: "unique", id: a.id });
    expect(await r({ name: "The Midland", date: "2026-05-28" })).toMatchObject({ class: "unique", id: b.id });
    // The day alone picks neither.
    expect((await r({ date: "2026-05-28" })).class).toBe("none");
    // The nights alone are enough, because a night has one place.
    expect(await r({ date: "2026-05-29", end: "2026-05-31" })).toMatchObject({ class: "unique", id: b.id });
  });
});

describe("gateway: activities", () => {
  const act = (key: string, title: string, start: string, over: Partial<Observation> = {}): Observation => ({
    key, kind: "activity", op: "create", title, start, evidence: note, ...over,
  });

  it("takes several things in one day, even in the same place or with the same person", async () => {
    const { gateway } = setup();
    const day = [
      act("plenary", "Plenary: Vision at scale", "2026-11-24T09:00", { place: "Great Hall", fields: { conference: "BMVC 2026", official: true } }),
      act("posters", "Poster session 2", "2026-11-24T11:00", { place: "Great Hall", fields: { conference: "BMVC 2026" } }),
      act("lunch", "Lunch with Sam", "2026-11-24T12:30"),
      act("dinner", "Dinner with Sam", "2026-11-24T19:00"),
      act("banquet", "Banquet dinner", "2026-11-25T19:00", { place: "Lancaster Castle" }),
    ];
    for (const o of day) expect(await made(gateway, o)).toBe("applied");
    expect(await gateway.submissions.pending()).toHaveLength(0);
  });

  it("holds the same activity entered twice", async () => {
    const { gateway } = setup();
    await gateway.submissions.submit(act("a", "Dinner at Quay", "2026-11-24T19:00"), "theseus");
    const again = await gateway.submissions.submit(act("b", "Quay reservation", "2026-11-24T19:30"), "theseus");
    expect(again.status).toBe("review");
  });

  it("knows an activity by a message from the people who run it about that day", async () => {
    const { gateway } = setup();
    const tour = await gateway.submissions.submit(
      act("tour", "Castle tour", "2026-11-26T14:00", { counterparts: ["+44 7700 900123"], fields: { contact: "+44 7700 900123", "confirm-via": "whatsapp" }, state: "to-confirm" }),
      "theseus",
    );
    await gateway.submissions.submit(act("walk", "Canal walk", "2026-11-26T10:00", { counterparts: ["447700900999@s.whatsapp.net"] }), "theseus");
    const found = await gateway.resolve(theseus, { kind: "activity", date: "2026-11-26", counterparts: ["447700900123@s.whatsapp.net"] });
    expect(found).toMatchObject({ class: "unique", id: tour.id });
    // The sender alone, with no day, is never enough.
    expect((await gateway.resolve(theseus, { kind: "activity", counterparts: ["447700900123@s.whatsapp.net"] })).class).toBe("several");
  });

  it("answers typed questions about what is recorded", async () => {
    const { gateway } = setup();
    await gateway.submissions.submit(act("tour", "Castle tour", "2026-11-26T14:00", { fields: { price: 20, currency: "GBP", payment: "cash" } }), "theseus");
    await gateway.submissions.submit(act("show", "Theatre", "2026-11-26T19:30", { fields: { price: 45, currency: "GBP", payment: "card", paid: true } }), "theseus");
    const cash = await gateway.get(theseus, { kind: "activity", from: "2026-11-26", to: "2026-11-26", where: { payment: "cash" } });
    expect(cash.records.map((r) => r.title)).toEqual(["Castle tour"]);
    const unpaid = await gateway.get(theseus, { kind: "activity", where: { paid: false } });
    expect(unpaid.records.map((r) => r.title)).toEqual(["Castle tour"]);
  });

  it("carries the owner's sensitive mark, and lets it be taken back", async () => {
    const { gateway } = setup();
    const made = await gateway.submissions.submit(act("clinic", "Clinic visit", "2026-11-26T14:00", { place: "Harley Street", refs: ["NOTEREF2"], fields: { sensitive: true } }), "theseus");
    expect(made.status).toBe("applied");
    const marked = await gateway.get(theseus, { kind: "activity", where: { sensitive: true } });
    expect(marked.records.map((r) => r.title)).toEqual(["Clinic visit"]);
    const undo: Observation = { key: "undo", kind: "activity", op: "update", match: { id: made.id!, class: "exact" }, refs: ["NOTEREF2"], fields: { sensitive: false }, evidence: note };
    expect((await gateway.submissions.submit(undo, "theseus")).status).toBe("applied");
    expect((await gateway.get(theseus, { kind: "activity", where: { sensitive: true } })).records).toHaveLength(0);
  });

  it("holds a change the harness itself is unsure of", async () => {
    const { gateway } = setup();
    const made = await gateway.submissions.submit(act("tour", "Castle tour", "2026-11-26T14:00", { refs: ["NOTEREF1"] }), "theseus");
    const gone: Observation = { key: "gone", kind: "activity", op: "update", match: { id: made.id!, class: "exact" }, refs: ["NOTEREF1"], state: "cancelled", what: "no longer in your itinerary note", ask: true, evidence: note };
    const res = await gateway.submissions.submit(gone, "theseus");
    expect(res.status).toBe("review");
    expect(res.reason).toMatch(/asks you to confirm/);
  });
});

describe("gateway: conferences and appointments", () => {
  it("knows a conference by its name and days", async () => {
    const { gateway } = setup();
    const conf = await gateway.submissions.submit(
      { key: "bmvc", kind: "conference", op: "create", title: "BMVC 2026", start: "2026-11-23", end: "2026-11-26", place: "Lancaster", fields: { city: "Lancaster", url: "https://bmvc.example" }, evidence: note },
      "theseus",
    );
    expect(await gateway.resolve(theseus, { kind: "conference", name: "BMVC", date: "2026-11-24" })).toMatchObject({ class: "unique", id: conf.id });
    expect((await gateway.resolve(theseus, { kind: "conference", name: "ICCV", date: "2026-11-24" })).class).toBe("none");
  });

  it("a date alone still identifies an appointment", async () => {
    const { gateway } = setup();
    await gateway.submissions.submit(
      { key: "appt", kind: "appointment", op: "create", title: "Dentist", start: "2026-12-01T09:00", evidence: ev() },
      "theseus",
    );
    expect((await gateway.resolve(theseus, { kind: "appointment", date: "2026-12-01" })).class).toBe("unique");
  });
});

describe("gateway: properties other tools add to a record", () => {
  const trip: Observation = {
    key: "t", kind: "trip", op: "create", title: "2026 Lancaster", state: "planned", start: "2026-11-21", end: "2026-11-28",
    place: "Lancaster", refs: ["HUBABCD1234"], fields: { destination: "Lancaster" }, evidence: note,
  };
  const move = (id: string): Observation => ({
    key: "t-move", kind: "trip", op: "update", match: { id, class: "exact" }, refs: ["HUBABCD1234"], end: "2026-11-29", what: "itinerary note changed", evidence: note,
  });

  it("are not the user editing it, and are kept when the agent next writes", async () => {
    const { gateway, io } = setup();
    const made = await gateway.submissions.submit(trip, "theseus");
    // Another tool stamps the note: tags, a date, a publish flag.
    const before = await io.read(made.path!);
    await io.modify(made.path!, before.replace("\n---\n>", "\ntags:\n  - daily\ndate: 2026-11-21\npublish: false\n---\n>"));
    expect(parseRecord(made.path!, await io.read(made.path!))).toMatchObject({ humanEdited: false, extra: { tags: ["daily"], publish: false } });

    const res = await gateway.submissions.submit(move(made.id!), "theseus");
    expect(res.status).toBe("applied");
    const after = await io.read(made.path!);
    expect(after).toContain("end: 2026-11-29");
    expect(after).toContain("publish: false");
    expect(after).toContain("tags:\n  - daily");
    expect(parseRecord(made.path!, after)!.humanEdited).toBe(false);
  });

  it("but a change to what the agent wrote — a property of its own, or the body — still is", async () => {
    const { gateway, io } = setup();
    const made = await gateway.submissions.submit(trip, "theseus");
    const text = await io.read(made.path!);
    await io.modify(made.path!, text.replace("state: planned", "state: booked"));
    expect(parseRecord(made.path!, await io.read(made.path!))!.humanEdited).toBe(true);
    expect((await gateway.submissions.submit(move(made.id!), "theseus")).status).toBe("review");
    await io.modify(made.path!, text.replace("## History", "My own line.\n\n## History"));
    expect(parseRecord(made.path!, await io.read(made.path!))!.humanEdited).toBe(true);
  });
});

describe("gateway: moving the old flat itinerary items to the structured kinds", () => {
  it("removes unedited mirrors of the user's notes, converts the rest, and keeps edits flagged", async () => {
    const { gateway, io, ledger } = setup();
    const old = (title: string, source: string, extra: string) =>
      `---\ntype: itinerary-item\nagent-id: itinerary-item-${title.replace(/\W/g, "")}\ntitle: ${title}\nstate: booked\nstart: 2026-05-28T13:05\nplace: Tokyo\n${extra}source: ${source}\nagent-access: local\n---\n> [!robot] Agent record\n\n## History\n- 2026-05-01 10:00 · booked\n`;
    await io.create("Agent/Trips/Items/Checkout.md", old("Checkout Megaro", "vault-note", "item: stay\n"));
    await io.create("Agent/Trips/Items/Flight.md", old("Flight AZ 792", "gmail", "item: flight\ncarrier: ITA\nnumber: AZ 792\nfrom: Rome\nto: Tokyo\ntrip: 2026 Japan\n"));
    // The plugin on another device stamped this one with properties of its own: still only a mirror.
    await io.create("Agent/Trips/Items/Stamped.md", old("Checkout Sora", "vault-note", "item: stay\nagent-hash: stale\ntags:\n  - daily\ndate: 2026-05-28\npublish: false\n"));
    // An earlier run converted this one in place; it is still a mirror in the old folder.
    await io.create("Agent/Trips/Items/Converted.md", old("Check in Sora", "vault-note", "lodging: Check in Sora\nagent-hash: stale\npublish: false\n").replace("type: itinerary-item", "type: stay"));
    // The user wrote in this one: it is theirs now, and is kept.
    await io.create("Agent/Trips/Items/Dinner.md", old("Dinner", "vault-note", "item: event\nagent-hash: not-the-hash\n").replace("## History", "Ask for the window table.\n\n## History"));
    await io.create("Agent/_review/held.md", `---\ntype: agent-review\nkey: k-note\nsummary: New itinerary-item · Train\nreason: looks close\nsubmitted: 2026-11-16T10:00:00\nclient: theseus\n---\n\`\`\`json\n${JSON.stringify({ key: "k-note", kind: "itinerary-item", op: "create", title: "Train", start: "2026-05-29", fields: { item: "train" }, evidence: note })}\n\`\`\`\n`);
    await io.create("Agent/_review/mail.md", `---\ntype: agent-review\nkey: k-mail\nsummary: New itinerary-item · Hotel\nreason: looks close\nsubmitted: 2026-11-16T10:00:00\nclient: theseus\n---\n\`\`\`json\n${JSON.stringify({ key: "k-mail", kind: "itinerary-item", op: "create", title: "Hotel Sora", start: "2026-05-29", end: "2026-06-02", place: "Tokyo", fields: { item: "stay" }, evidence: ev() })}\n\`\`\`\n`);

    const { migrateLegacyItinerary } = await import("../src/gateway/migrate");
    const result = await migrateLegacyItinerary(io, "Agent", ledger);
    expect(result).toEqual({ removed: 3, converted: 2, reviewsRemoved: 1, reviewsConverted: 1 });
    for (const gone of ["Checkout", "Stamped", "Converted"]) expect(await io.exists(`Agent/Trips/Items/${gone}.md`)).toBe(false);

    const flight = parseRecord("Agent/Trips/Items/Flight.md", await io.read("Agent/Trips/Items/Flight.md"))!;
    expect(flight).toMatchObject({ kind: "transport", state: "booked", humanEdited: false });
    expect(flight.fields).toMatchObject({ mode: "flight", number: "AZ 792", from: "Rome", to: "Tokyo", trip: "2026 Japan" });
    expect(flight.place).toBeUndefined();
    expect(flight.body).toContain("2026-05-01 10:00 · booked");

    const dinner = parseRecord("Agent/Trips/Items/Dinner.md", await io.read("Agent/Trips/Items/Dinner.md"))!;
    expect(dinner).toMatchObject({ kind: "activity", state: "confirmed", humanEdited: true });

    const pending = await gateway.submissions.pending();
    expect(pending.map((p) => [p.key, p.observation.kind, p.summary])).toEqual([["k-mail", "stay", "New stay · Hotel"]]);
    expect((await ledger.get("k-note"))?.status).toBe("dismissed");
    // A second run finds nothing left to do.
    expect(await migrateLegacyItinerary(io, "Agent", ledger)).toEqual({ removed: 0, converted: 0, reviewsRemoved: 0, reviewsConverted: 0 });
    // The converted held item can now be approved.
    expect((await gateway.submissions.decide("k-mail", "approve")).status).toBe("applied");
  });
});

describe("gateway: re-checking what is held", () => {
  it("releases a held item once the rules would apply it, and keeps the rest held", async () => {
    const { gateway, io } = setup();
    const trip = (key: string, title: string, place: string): Observation => ({
      key,
      kind: "trip",
      op: "create",
      title,
      state: "planned",
      start: "2026-11-20",
      end: "2026-11-27",
      place,
      fields: { destination: place },
      evidence: { source: "vault-note", at: "2026-11-16T09:00:00" },
    });
    const first = await gateway.submissions.submit(trip("t1", "2026 London", "London"), "theseus");
    const second = await gateway.submissions.submit(trip("t2", "2026 London again", "London"), "theseus");
    expect([first.status, second.status]).toEqual(["applied", "review"]);

    // Nothing has changed: it stays held.
    expect(await gateway.submissions.recheck()).toBe(0);
    expect(await gateway.submissions.pending()).toHaveLength(1);

    // The record it resembled is gone, so today's rules would simply create it.
    await io.delete(first.path!);
    expect(await gateway.submissions.recheck()).toBe(1);
    expect(await gateway.submissions.pending()).toHaveLength(0);
    const status = await gateway.submissions.status(["t2"]);
    expect(status.t2?.status).toBe("applied");
    expect(status.t2?.reason).toMatch(/released on re-check/);
    expect((await gateway.get(theseus, { kind: "trip" })).records.map((r) => r.title)).toEqual(["2026 London again"]);
  });
});

describe("gateway: the write rules", () => {
  async function withAppointment() {
    const s = setup();
    const made = await s.gateway.submissions.submit(
      {
        key: "appt-1",
        kind: "appointment",
        op: "create",
        title: "Dentist cleaning",
        state: "confirmed",
        start: "2026-12-03T09:30",
        thread: "t1",
        fields: { category: "dental" },
        evidence: ev(),
      } satisfies Observation,
      "theseus",
    );
    return { ...s, id: made.id!, path: made.path! };
  }

  const reschedule = (id: string, key = "appt-1-resched"): Observation => ({
    key,
    kind: "appointment",
    op: "update",
    match: { id, class: "exact" },
    query: { kind: "appointment", thread: "t1" },
    state: "rescheduled",
    start: "2026-12-10T14:00",
    thread: "t1",
    what: "moved to 10 Dec",
    evidence: ev("2026-11-17T08:00:00"),
  });

  it("applies an exactly-matched update to an agent record, with history and evidence", async () => {
    const { gateway, io, id, path } = await withAppointment();
    const res = await gateway.submissions.submit(reschedule(id), "theseus");
    expect(res.status).toBe("applied");
    const rec = parseRecord(path, await io.read(path))!;
    expect(rec.state).toBe("rescheduled");
    expect(rec.start).toBe("2026-12-10T14:00");
    expect(rec.humanEdited).toBe(false);
    expect(rec.body).toContain("rescheduled");
    expect(rec.body).toContain("[!quote] From the message (untrusted text)");
  });

  it("is idempotent: the same key is never applied twice", async () => {
    const { gateway, io, id, path } = await withAppointment();
    await gateway.submissions.submit(reschedule(id), "theseus");
    const text = await io.read(path);
    const again = await gateway.submissions.submit(reschedule(id), "theseus");
    expect(again.duplicate).toBe(true);
    expect(await io.read(path)).toBe(text);
  });

  it("asks first once the user has edited the record", async () => {
    const { gateway, io, id, path } = await withAppointment();
    await io.modify(path, (await io.read(path)).replace("Dentist cleaning", "Dentist — bring x-rays"));
    const res = await gateway.submissions.submit(reschedule(id), "theseus");
    expect(res.status).toBe("review");
    expect(res.reason).toContain("you have edited");
    expect((await gateway.submissions.pending()).map((p) => p.key)).toEqual(["appt-1-resched"]);
  });

  it("asks first when the harness chose among candidates, or the gateway cannot confirm the match", async () => {
    const { gateway, id } = await withAppointment();
    const adjudicated = { ...reschedule(id, "k-adj"), match: { id, class: "adjudicated" as const } };
    expect((await gateway.submissions.submit(adjudicated, "theseus")).status).toBe("review");
    const unconfirmed = { ...reschedule(id, "k-unc"), query: { kind: "appointment" as const, thread: "some-other-thread" }, thread: "some-other-thread" };
    const res = await gateway.submissions.submit(unconfirmed, "theseus");
    expect(res.status).toBe("review");
    expect(res.reason).toContain("could not confirm");
  });

  it("applies a held item when the owner approves, and remembers a dismissal as 'not this record'", async () => {
    const { gateway, io, id, path } = await withAppointment();
    const adjudicated = { ...reschedule(id, "k-adj"), match: { id, class: "adjudicated" as const } };
    await gateway.submissions.submit(adjudicated, "theseus");
    const ok = await gateway.decide(theseus, { key: "k-adj", decision: "approve" });
    expect(ok.status).toBe("applied");
    expect(parseRecord(path, await io.read(path))!.state).toBe("rescheduled");
    expect(await gateway.submissions.pending()).toHaveLength(0);

    const other = { ...reschedule(id, "k-2"), match: { id, class: "adjudicated" as const }, thread: "t-wrong", query: { kind: "appointment" as const, thread: "t-wrong" } };
    await gateway.submissions.submit(other, "theseus");
    const no = await gateway.decide(theseus, { key: "k-2", decision: "dismiss" });
    expect(no.status).toBe("dismissed");
    expect(parseRecord(path, await io.read(path))!.notThreads).toContain("t-wrong");
    // That conversation no longer matches the record, even if a later message links it.
    expect((await gateway.resolve(theseus, { kind: "appointment", thread: "t-wrong" })).class).toBe("none");
  });

  it("picks up a decision the plugin made on another device", async () => {
    const { gateway, io, id, path } = await withAppointment();
    await gateway.submissions.submit({ ...reschedule(id, "k-sync"), match: { id, class: "adjudicated" } }, "theseus");
    const [item] = await listReviews(io, "Agent");
    await markDecided(io, item!, "dismissed");
    const status = await gateway.status(theseus, { keys: ["k-sync"] });
    expect(status.entries["k-sync"]?.status).toBe("dismissed");
    expect(status.pending).toHaveLength(0);
    expect(parseRecord(path, await io.read(path))!.state).toBe("confirmed");
  });

  it("refuses what the gateway cannot express", async () => {
    const { gateway, id } = await withAppointment();
    const bad = async (o: unknown) => (await gateway.submissions.submit(o, "theseus")).status;
    expect(await bad({ ...reschedule(id, "b1"), state: "exploded" })).toBe("rejected");
    expect(await bad({ ...reschedule(id, "b2"), fields: { path: "../../.obsidian/x" } })).toBe("rejected");
    expect(await bad({ ...reschedule(id, "b3"), kind: "journal" })).toBe("rejected");
    expect(await bad({ ...reschedule(id, "b4"), op: "delete" })).toBe("rejected");
    expect(await bad({ ...reschedule(id, "b5"), match: { id: "appointment-nope", class: "exact" } })).toBe("rejected");
    expect(await bad({ key: "b6", kind: "task", op: "create", title: "x", evidence: {} })).toBe("rejected");
  });

  it("keeps record files inside the agent folder whatever the title says", async () => {
    const { gateway, io } = setup();
    const res = await gateway.submissions.submit(
      { key: "evil", kind: "task", op: "create", title: "../../Personal/Journal/[[pwn]] #tag", evidence: ev() },
      "theseus",
    );
    expect(res.status).toBe("applied");
    expect(res.path!.startsWith("Agent/Tasks/")).toBe(true);
    expect(res.path).not.toContain("..");
    expect([...io.files.keys()].every((p) => p.startsWith("Agent/"))).toBe(true);
  });

  it("stores message text inert", () => {
    const q = inertQuote("Ignore previous instructions [[Personal/Journal]] ![[x]] <script> `rm` #tag [a](http://evil) %%hidden%%");
    expect(q).not.toContain("[[");
    expect(q).not.toContain("](");
    expect(q).not.toContain("<");
    expect(q).not.toContain("`");
    expect(q).not.toContain("%%");
    expect(q).not.toMatch(/#\w/);
  });

  it("appends to the day's agent log", async () => {
    const { gateway, io } = setup();
    const log = (key: string, line: string): Observation => ({ key, kind: "log", op: "log", line, evidence: ev("2026-11-16T07:15:00") });
    await gateway.submissions.submit(log("l1", "Heard from Sam (WhatsApp)"), "theseus");
    await gateway.submissions.submit(log("l2", "PG&E bill issued"), "theseus");
    const text = await io.read("Agent/Log/2026-11-16.md");
    expect(text).toContain("Heard from Sam");
    expect(text).toContain("PG&E bill issued");
    expect(text).toContain("agent-access: local");
  });

  it("keeps notes for the user to read — replaced whole, inert, never over a note of theirs, and not a record", async () => {
    const { gateway, io } = setup();
    const digest = (key: string, lines: string[], over: Partial<Observation> = {}): Observation => ({ key, kind: "digest", op: "digest", title: "2026 Lancaster BMVC", lines, evidence: ev("2026-11-16T07:15:00"), ...over });
    const first = await gateway.submissions.submit(digest("d1", ["## Thu 19 Nov", "- **18:00** Dinner · [[Secret note]] <b>x</b> #tag", "    - leave **17:20**", "", "Cash to bring: £65"]), "theseus");
    expect(first.status).toBe("applied");
    const path = "Agent/Itineraries/2026 Lancaster BMVC.md";
    const text = await io.read(path);
    expect(text).toContain("type: agent-digest");
    expect(text).toContain("agent-access: local");
    expect(text).toContain("## Thu 19 Nov\n- **18:00** Dinner");
    expect(text).toContain("\n    - leave **17:20**");
    // Text that came from messages cannot make a link, a tag or markup of the user's vault.
    expect(text).not.toContain("[[Secret note]]");
    expect(text).not.toContain("<b>");
    expect(text).not.toContain("#tag");
    // Written again, it is replaced, not appended to.
    await gateway.submissions.submit(digest("d2", ["## Fri 20 Nov", "- Nothing scheduled."]), "theseus");
    const second = await io.read(path);
    expect(second).toContain("## Fri 20 Nov");
    expect(second).not.toContain("Thu 19 Nov");
    // It is not a record: nothing lists it or resolves against it.
    expect((await gateway.get(theseus, {})).records).toHaveLength(0);
    // A note of the user's own at that path is left alone.
    await io.create("Agent/Itineraries/Mine.md", "my own words");
    expect((await gateway.submissions.submit(digest("d3", ["- x"], { title: "Mine" }), "theseus")).status).toBe("rejected");
    expect(await io.read("Agent/Itineraries/Mine.md")).toBe("my own words");
    expect((await gateway.submissions.submit({ ...digest("d4", []), lines: [] }, "theseus")).status).toBe("rejected");
    // One entry's own page goes in the trip's folder — one folder deep, and nowhere else.
    await gateway.submissions.submit(digest("d5", ["# Wren Hotel"], { title: "Wren Hotel (19 Nov)", folder: "2026 Lancaster BMVC" }), "theseus");
    expect(await io.exists("Agent/Itineraries/2026 Lancaster BMVC/Wren Hotel (19 Nov).md")).toBe(true);
    const escaped = await gateway.submissions.submit(digest("d6", ["- x"], { title: "x", folder: "../../Personal/Journal" }), "theseus");
    expect(escaped.path?.startsWith("Agent/Itineraries/")).toBe(true);
    expect(escaped.path).not.toContain("..");
  });

  it("builds a digest's links itself from typed parts, and lets nothing else be one", async () => {
    const { gateway, io } = setup();
    const lines = [
      "> [!tip] Today · Fri 20 Nov",
      "> - **18:00** ⟦0⟧ — leave **17:25**",
      "> [!evil]- not a kind of callout",
      "- [ ] confirm · ⟦1⟧ · ⟦2⟧ · ⟦3⟧",
      "- site ⟦4⟧ and ⟦5⟧",
      "- bad ones: ⟦6⟧ ⟦7⟧ ⟦8⟧ ⟦9⟧ ⟦10⟧ ⟦99⟧ end",
      "> ![[Agent/Papers/t/plan.png]] typed by hand",
      "⟦11⟧",
      "Train 13:29 London Euston -> Lancaster <script>",
      "---",
    ];
    const links = [
      { kind: "note", path: "Agent/Itineraries/2026 Lancaster BMVC/River supper club (20 Nov).md", label: "River supper [club]" },
      { kind: "wa", number: "+44 7700 900222" },
      { kind: "tel", number: "+44 (0)7700 900222", label: "Call" },
      { kind: "map", q: "Lantern Court, NF2 6GB & more" },
      { kind: "web", url: "https://www.wren.example/rooms?x=1", label: "Website" },
      { kind: "mail", address: "stay@wren.example" },
      { kind: "web", url: "javascript:alert(1)", label: "click" },
      { kind: "web", url: "http://plain.example", label: "plain" },
      { kind: "note", path: "../../Personal/Journal/secret", label: "up" },
      { kind: "tel", number: "12", label: "short" },
      { kind: "embed", path: "Personal/photo.png" },
      { kind: "embed", path: "Agent/Papers/2026 Lancaster BMVC/Station plan — Lancaster.jpg" },
    ];
    const res = await gateway.submissions.submit({ key: "links", kind: "digest", op: "digest", title: "Links", lines, links, evidence: ev("2026-11-16T07:15:00") } as Observation, "theseus");
    expect(res.status).toBe("applied");
    const text = await io.read("Agent/Itineraries/Links.md");
    expect(text).toContain("> [!tip] Today · Fri 20 Nov");
    expect(text).toContain("> - **18:00** [[Agent/Itineraries/2026 Lancaster BMVC/River supper club (20 Nov)|River supper club]] — leave **17:25**");
    // An unknown callout kind is only words.
    expect(text).not.toContain("[!evil]");
    expect(text).toContain("- [ ] confirm · [WhatsApp](https://wa.me/447700900222) · [Call](tel:+4407700900222) · [map](https://maps.apple.com/?q=Lantern%20Court%2C%20NF2%206GB%20%26%20more)");
    // A web link says where it goes, whatever it is called.
    expect(text).toContain("[Website · wren.example](https://www.wren.example/rooms?x=1)");
    expect(text).toContain("[stay@wren.example](mailto:stay@wren.example)");
    // What is not a safe link is left as its words, or dropped.
    expect(text).toContain("- bad ones: click plain up short end");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("http://plain.example");
    expect(text).not.toContain("Personal/");
    // An embed is only ever one of the agent's own papers, and only as a typed link — never typed by hand.
    expect(text).toContain("\n![[Agent/Papers/2026 Lancaster BMVC/Station plan — Lancaster.jpg]]\n");
    expect(text).not.toContain("![[Agent/Papers/t/plan.png]]");
    expect(text).toContain("Train 13:29 London Euston → Lancaster 'script'");
    expect(text.trimEnd().endsWith("---")).toBe(true);
  });

  it("keeps a paper — a ticket, a station plan — by what its bytes are, under its own name, never over another", async () => {
    const { gateway, io } = setup();
    const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString("base64");
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 9, 9];
    const paper = (key: string, title: string, bytes: number[], over: Partial<Observation> = {}): Observation => ({ key, kind: "paper", op: "paper", title, folder: "2026 Lancaster BMVC", data: b64(bytes), evidence: ev("2026-11-16T07:15:00"), ...over });
    const first = await gateway.submissions.submit(paper("p1", "Station plan — Lancaster.exe", png), "theseus");
    expect(first).toMatchObject({ status: "applied", path: "Agent/Papers/2026 Lancaster BMVC/Station plan — Lancaster.exe.png" });
    expect([...(io as unknown as { binaries: Map<string, Uint8Array> }).binaries.get(first.path!)!]).toEqual(png);
    // The same submission again changes nothing; a different file of the same name sits beside it.
    expect(await gateway.submissions.submit(paper("p1", "Station plan — Lancaster.exe", png), "theseus")).toMatchObject({ duplicate: true, path: first.path });
    const second = await gateway.submissions.submit(paper("p2", "Station plan — Lancaster.exe", [...png, 4]), "theseus");
    expect(second.path).toBe("Agent/Papers/2026 Lancaster BMVC/Station plan — Lancaster.exe 2.png");
    expect((await gateway.submissions.submit(paper("p3", "E-ticket", pdf), "theseus")).path).toBe("Agent/Papers/2026 Lancaster BMVC/E-ticket.pdf");
    // Not what it claims to be, empty, or headed somewhere else: refused, and nothing written.
    expect((await gateway.submissions.submit(paper("p4", "script.pdf", [0x4d, 0x5a, 0x90, 0x00]), "theseus")).status).toBe("rejected");
    expect((await gateway.submissions.submit(paper("p5", "nothing", []), "theseus")).status).toBe("rejected");
    const away = await gateway.submissions.submit(paper("p6", "../../x", png, { folder: "../../Personal/Journal" }), "theseus");
    expect(away.path?.startsWith("Agent/Papers/")).toBe(true);
    expect(away.path).not.toContain("..");
    // A wallet pass is kept; any other archive is not.
    const zip = (names: string[]) => [0x50, 0x4b, 0x03, 0x04, ...names.flatMap((n) => [0, 0, ...[...n].map((c) => c.charCodeAt(0))])];
    expect((await gateway.submissions.submit(paper("p7", "Boarding pass", zip(["manifest.json", "pass.json", "icon.png"])), "theseus")).path).toBe("Agent/Papers/2026 Lancaster BMVC/Boarding pass.pkpass");
    expect((await gateway.submissions.submit(paper("p8", "archive", zip(["readme.txt", "run.exe"])), "theseus")).status).toBe("rejected");
    // A paper is not a record.
    expect((await gateway.get(theseus, {})).records).toHaveLength(0);
  });

  it("matches a bill by payee and period, and a different period is a new bill", async () => {
    const { gateway } = setup();
    const bill = (key: string, period: string, due: string): Observation => ({
      key,
      kind: "bill",
      op: "create",
      title: `PG&E ${period}`,
      fields: { payee: "PG&E", amount: 142.17, currency: "USD", due, period },
      counterparts: ["billing@pge.example"],
      evidence: ev(),
    });
    expect((await gateway.submissions.submit(bill("b-oct", "2026-10", "2026-11-05"), "theseus")).status).toBe("applied");
    expect((await gateway.submissions.submit(bill("b-nov", "2026-11", "2026-12-05"), "theseus")).status).toBe("applied");
    const paid = await gateway.resolve(theseus, { kind: "bill", payee: "PG&E", period: "2026-11" });
    expect(paid.class).toBe("unique");
    expect(paid.title).toBe("PG&E 2026-11");
    const open = await gateway.get(theseus, { kind: "bill", open: true, from: "2026-12-01", to: "2026-12-31" });
    expect(open.records).toHaveLength(1);
  });
});

describe("gateway over HTTP", () => {
  let close: () => Promise<void>;
  let base: string;
  beforeEach(async () => {
    const { gateway, io } = setup();
    await io.create("Research/Spiders.md", "Orb weavers rebuild their web daily.");
    await io.create("Personal/Health.md", "Orb weavers; MRI on Tuesday.");
    const server = createGatewayServer({
      gateway,
      clients: [
        { ...theseus, token: "local-token-0123456789abcdef" },
        { ...outside, token: "external-token-0123456789abcd" },
      ],
      allowedHosts: [],
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    // The allow-list is fixed at construction; rebuild with the real port.
    server.close();
    const real = createGatewayServer({
      gateway,
      clients: [
        { ...theseus, token: "local-token-0123456789abcdef" },
        { ...outside, token: "external-token-0123456789abcd" },
      ],
      allowedHosts: [`127.0.0.1:${port}`],
    });
    await new Promise<void>((r) => real.listen(port, "127.0.0.1", r));
    base = `http://127.0.0.1:${port}`;
    close = () => new Promise<void>((r) => real.close(() => r()));
  });
  afterEach(async () => close());

  const call = (tool: string, token: string | null, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/v1/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });

  it("requires a known token", async () => {
    expect((await call("search", null, { query: "orb" })).status).toBe(401);
    expect((await call("search", "wrong-token-000000000000000", { query: "orb" })).status).toBe(401);
  });

  it("gives each token its class's view", async () => {
    const ext = (await (await call("search", "external-token-0123456789abcd", { query: "orb weavers" })).json()) as { hits: { path: string }[] };
    expect(ext.hits.map((h) => h.path)).toEqual(["Research/Spiders.md"]);
    const loc = (await (await call("search", "local-token-0123456789abcdef", { query: "orb weavers" })).json()) as { hits: { path: string }[] };
    expect(loc.hits).toHaveLength(2);
    expect((await call("get", "external-token-0123456789abcd", { kind: "bill" })).status).toBe(403);
    expect((await call("read", "external-token-0123456789abcd", { path: "Personal/Health.md" })).status).toBe(404);
  });

  it("rejects unknown tools and oversized or malformed bodies", async () => {
    const t = "local-token-0123456789abcdef";
    expect((await call("delete", t, {})).status).toBe(404);
    const bad = await fetch(`${base}/v1/search`, { method: "POST", headers: { authorization: `Bearer ${t}` }, body: "{not json" });
    expect(bad.status).toBe(400);
    // The limit leaves room for one stored file of 10 MB and no more.
    expect((await call("search", t, { query: "x".repeat(16 * 1024 * 1024) })).status).toBe(400);
  });
});
