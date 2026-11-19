import { SPECS, type AgentRecord } from "../gateway/records";

/**
 * A trip added up by plain arithmetic — nights, journeys, what it cost and
 * what is still to pay — so that sums in an answer are computed, not guessed
 * by a model. Only what the records state: a record with no price adds
 * nothing, and is counted as such.
 */
export interface TripSummary {
  title: string;
  lines: string[];
  /** The records it was made from. */
  paths: string[];
}

const day = (iso: string | undefined): string => (iso ?? "").slice(0, 10);
const nightsBetween = (a: string, b: string): number => Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000));
const round = (n: number): number => Math.round(n * 100) / 100;

function money(byCurrency: Map<string, number>): string {
  const parts = [...byCurrency].filter(([, v]) => v !== 0).map(([c, v]) => `${round(v)} ${c || "(no currency stated)"}`);
  return parts.length ? parts.join(" + ") : "nothing stated";
}

export function summarizeTrip(records: AgentRecord[], trip: AgentRecord): TripSummary {
  const start = day(trip.start);
  const end = day(trip.end) || start;
  // What belongs to the trip: what names it, or — naming no trip — falls within its days on the itinerary.
  const mine = records.filter((r) => {
    if (r === trip || r.kind === "trip") return false;
    const named = typeof r.fields.trip === "string" ? r.fields.trip : "";
    if (named) return named === trip.title;
    return ["transport", "stay", "activity", "conference"].includes(r.kind) && !!r.start && day(r.start) >= start && day(r.start) <= end;
  });
  const closed = (r: AgentRecord) => r.state === "cancelled";
  const offered = (r: AgentRecord) => r.state === "offered";
  const live = mine.filter((r) => !closed(r) && !offered(r)).sort((a, b) => String(a.start ?? "").localeCompare(String(b.start ?? "")));
  const lines: string[] = [];
  lines.push(`Trip "${trip.title}": ${start}${end !== start ? ` to ${end} (${nightsBetween(start, end)} nights)` : ""}${trip.place ? `, ${trip.place}` : ""} — state ${trip.state}.`);

  const stays = live.filter((r) => r.kind === "stay");
  if (stays.length) {
    lines.push(`Stays (${stays.length}):`);
    for (const s of stays) lines.push(`  ${day(s.start)} to ${day(s.end) || "?"} · ${s.title}${s.end ? ` · ${nightsBetween(day(s.start), day(s.end))} nights` : ""}${typeof s.fields.price === "number" ? ` · ${s.fields.price} ${String(s.fields.currency ?? "")}${s.fields.paid === true ? " paid" : ""}` : ""}`);
    const covered = stays.reduce((n, s) => n + (s.end ? nightsBetween(day(s.start), day(s.end)) : 0), 0);
    const total = nightsBetween(start, end);
    if (total > 0 && covered !== total) lines.push(`  The stays cover ${covered} of the trip's ${total} nights.`);
  }
  const journeys = live.filter((r) => r.kind === "transport");
  if (journeys.length) {
    lines.push(`Journeys (${journeys.length}):`);
    for (const j of journeys) lines.push(`  ${j.start ?? "?"} · ${j.title}${j.fields.from || j.fields.to ? ` · ${String(j.fields.from ?? "?")} → ${String(j.fields.to ?? "?")}` : ""}${typeof j.fields.price === "number" ? ` · ${j.fields.price} ${String(j.fields.currency ?? "")}` : ""}`);
  }
  const things = live.filter((r) => r.kind === "activity" || r.kind === "conference" || r.kind === "appointment");
  if (things.length) {
    const byDay = new Map<string, number>();
    for (const t of things) byDay.set(day(t.start) || "no date", (byDay.get(day(t.start) || "no date") ?? 0) + 1);
    lines.push(`Activities and events (${things.length}): ${[...byDay].sort().map(([d, n]) => `${d}: ${n}`).join(", ")}`);
    const unsettled = things.filter((t) => ["to-confirm", "asked", "requested"].includes(t.state));
    if (unsettled.length) lines.push(`  Not yet confirmed: ${unsettled.map((t) => `${t.title} (${day(t.start)})`).join("; ")}`);
  }

  // Money, by kind and in all — each currency on its own, never converted.
  const priced = live.filter((r) => typeof r.fields.price === "number");
  const sumOf = (list: AgentRecord[]) => {
    const m = new Map<string, number>();
    for (const r of list) m.set(String(r.fields.currency ?? ""), (m.get(String(r.fields.currency ?? "")) ?? 0) + (r.fields.price as number));
    return m;
  };
  lines.push("Cost, from the prices on record (each currency on its own):");
  for (const kind of ["stay", "transport", "activity", "appointment", "conference"] as const) {
    const of = priced.filter((r) => r.kind === kind);
    if (of.length) lines.push(`  ${kind}: ${money(sumOf(of))} (${of.length} with a price)`);
  }
  lines.push(`  In all: ${money(sumOf(priced))}.`);
  const paid = priced.filter((r) => r.fields.paid === true);
  const cash = priced.filter((r) => r.fields.paid !== true && r.fields.payment === "cash");
  const other = priced.filter((r) => r.fields.paid !== true && r.fields.payment !== "cash");
  lines.push(`  Paid: ${money(sumOf(paid))}. Still to pay in cash: ${money(sumOf(cash))}. Not marked paid: ${money(sumOf(other))}.`);
  const unpriced = live.filter((r) => typeof r.fields.price !== "number" && r.kind !== "conference");
  if (unpriced.length) lines.push(`  ${unpriced.length} record${unpriced.length === 1 ? " has" : "s have"} no price, so the total is at least this: ${unpriced.slice(0, 12).map((r) => r.title).join("; ")}${unpriced.length > 12 ? "; …" : ""}`);
  const offers = mine.filter(offered);
  const off = mine.filter(closed);
  if (offers.length) lines.push(`Only offered, not counted: ${offers.map((r) => r.title).join("; ")}`);
  if (off.length) lines.push(`Cancelled, not counted: ${off.map((r) => r.title).join("; ")}`);
  const stillOpen = live.filter((r) => !SPECS[r.kind].terminal.includes(r.state)).length;
  lines.push(`${live.length} records counted (${stillOpen} still open).`);
  return { title: trip.title, lines, paths: [trip.path, ...live.map((r) => r.path)] };
}
