import { SPECS, type AgentRecord } from "../gateway/records";

/**
 * Things about the agent's records that cannot all be right, found by plain
 * rules — no model. Each is a place to look, not a verdict: the owner (with
 * the chat's help) decides what is wrong.
 */
export interface Issue {
  /** Short name of the rule ("ends before it starts"). */
  rule: string;
  detail: string;
  paths: string[];
}

const day = (iso: string | undefined): string => (iso ?? "").slice(0, 10);
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const DATED = new Set(["appointment", "transport", "stay", "activity", "conference", "trip"]);

export function auditRecords(records: AgentRecord[], today: string): Issue[] {
  const out: Issue[] = [];
  const open = (r: AgentRecord) => !SPECS[r.kind].terminal.includes(r.state);
  const trips = records.filter((r) => r.kind === "trip");

  for (const r of records) {
    if (r.start && r.end && r.end < r.start) {
      out.push({ rule: "ends before it starts", detail: `${r.title}: starts ${r.start}, ends ${r.end}`, paths: [r.path] });
    }
    if (DATED.has(r.kind) && !r.start && open(r)) {
      out.push({ rule: "no date", detail: `${r.kind} "${r.title}" has no start`, paths: [r.path] });
    }
    const last = day(r.end) || day(r.start);
    if (DATED.has(r.kind) && open(r) && last && last < today && r.state !== "changed") {
      out.push({ rule: "still open after its date", detail: `${r.kind} "${r.title}" was on ${last} and is still "${r.state}"`, paths: [r.path] });
    }
    const tripName = typeof r.fields.trip === "string" ? r.fields.trip : "";
    if (tripName) {
      const trip = trips.find((t) => t.title === tripName);
      if (!trip) out.push({ rule: "trip not found", detail: `"${r.title}" names the trip "${tripName}", which is not on record`, paths: [r.path] });
      else if (r.start && trip.start && (day(r.start) < day(trip.start) || day(r.start) > (day(trip.end) || day(trip.start)))) {
        out.push({ rule: "outside its trip", detail: `"${r.title}" (${day(r.start)}) is outside "${tripName}" (${day(trip.start)} to ${day(trip.end) || day(trip.start)})`, paths: [r.path, trip.path] });
      }
    }
  }

  // The same thing twice: one kind, one day, and names that are the same or one inside the other.
  const live = records.filter((r) => open(r) && r.start && r.kind !== "trip");
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      if (a.kind !== b.kind || day(a.start) !== day(b.start)) continue;
      const na = norm(a.title);
      const nb = norm(b.title);
      if (!na || !nb) continue;
      const sameName = na === nb || (na.length >= 5 && nb.includes(na)) || (nb.length >= 5 && na.includes(nb));
      const sameTime = a.start === b.start && a.start!.length > 10;
      if (sameName || (sameTime && a.kind !== "activity")) {
        out.push({ rule: "possibly the same thing twice", detail: `${a.kind} on ${day(a.start)}: "${a.title}" and "${b.title}"`, paths: [a.path, b.path] });
      }
    }
  }

  // Two places to sleep on one night.
  const stays = records.filter((r) => r.kind === "stay" && open(r) && r.state !== "offered" && r.start && r.end);
  for (let i = 0; i < stays.length; i++) {
    for (let j = i + 1; j < stays.length; j++) {
      const a = stays[i]!;
      const b = stays[j]!;
      if (day(a.start) < day(b.end) && day(b.start) < day(a.end)) {
        out.push({ rule: "two stays on one night", detail: `"${a.title}" (${day(a.start)} to ${day(a.end)}) and "${b.title}" (${day(b.start)} to ${day(b.end)})`, paths: [a.path, b.path] });
      }
    }
  }
  return out;
}
