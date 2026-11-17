import { joinNote, splitNote } from "./frontmatter";
import { hashText, type GatewayIO } from "./io";
import { LEGACY_ITINERARY_KIND, cleanString, parseRecord, serializeRecord, type RecordKind } from "./records";
import { REVIEW_DIR } from "./store";
import { parseReview, serializeReview, type Ledger, type Observation } from "./submit";

/**
 * The itinerary used to be one flat kind, "itinerary-item", which could not
 * tell a journey from a night's stay from a dinner. This moves what exists to
 * the structured kinds, once, when the gateway starts.
 *
 *   - Items mirrored from the user's own itinerary notes are removed: the
 *     harness reads those notes again and mirrors them under the new kinds
 *     (a stay becomes one record with both its days, which no single old
 *     item held). This holds for everything in the old items folder, which
 *     nothing writes to any more — including items an earlier run of this
 *     migration converted in place.
 *   - An item the user wrote in, or one that came from a message, is
 *     converted in place and keeps its history.
 */
export interface MigrationResult {
  removed: number;
  converted: number;
  reviewsRemoved: number;
  reviewsConverted: number;
}

const TRANSPORT_ITEMS = new Set(["flight", "train", "transfer", "rental", "bus", "ferry"]);

/** Where the flat items lived. The structured kinds have folders of their own. */
const LEGACY_FOLDER = "Trips/Items";

/**
 * Is the body just what the agent wrote — its banner and its history? A
 * property stamped on by another tool does not count as the user's hand; a
 * line of their own in the body does.
 */
export function bodyUntouched(body: string): boolean {
  return body
    .split("\n")
    .every((l) => l === "" || l.startsWith("> ") || l === ">" || l.startsWith("## History") || l.startsWith("- ") || l.startsWith("  > "));
}

export function kindForLegacyItem(item: unknown): RecordKind {
  const i = cleanString(item, 20).toLowerCase();
  if (TRANSPORT_ITEMS.has(i)) return "transport";
  if (i === "stay") return "stay";
  return "activity";
}

/** The old properties, renamed for the kind the item becomes. */
export function convertLegacyFields(
  kind: RecordKind,
  title: string,
  state: string | undefined,
  raw: Record<string, unknown>,
): { fields: Record<string, unknown>; state: string | undefined; dropPlace: boolean } {
  const { item, carrier, number, from, to, trip } = raw;
  if (kind === "transport") {
    const mode = cleanString(item, 20).toLowerCase();
    return {
      fields: { mode: mode === "rental" ? "car" : mode, carrier, number, from, to, trip },
      state,
      // The old "place" was the destination, which a journey does not have.
      dropPlace: true,
    };
  }
  if (kind === "stay") return { fields: { lodging: title, trip }, state, dropPlace: false };
  const activityState = state === "booked" || state === "changed" ? "confirmed" : state;
  return { fields: { category: "other", trip }, state: activityState, dropPlace: false };
}

function convertObservation(o: Observation): Observation {
  const raw = (o.fields ?? {}) as Record<string, unknown>;
  const kind = kindForLegacyItem(raw.item);
  const { fields, state, dropPlace } = convertLegacyFields(kind, cleanString(o.title), o.state, raw);
  const clean: Observation["fields"] = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") clean[k] = v;
  }
  const next: Observation = { ...o, kind, fields: clean, state, query: undefined };
  if (dropPlace) next.place = undefined;
  return next;
}

export async function migrateLegacyItinerary(
  io: GatewayIO,
  agentFolder: string,
  ledger: Ledger,
  now: () => Date = () => new Date(),
): Promise<MigrationResult> {
  const result: MigrationResult = { removed: 0, converted: 0, reviewsRemoved: 0, reviewsConverted: 0 };
  const reviewDir = `${agentFolder}/${REVIEW_DIR}/`;
  for (const path of await io.list(agentFolder)) {
    let text: string;
    try {
      text = await io.read(path);
    } catch {
      continue;
    }
    const legacyPlace = path.startsWith(`${agentFolder}/${LEGACY_FOLDER}/`);
    if (!legacyPlace && !text.includes(LEGACY_ITINERARY_KIND)) continue;

    if (path.startsWith(reviewDir)) {
      const item = parseReview(path, text);
      if (!item || (item.observation.kind as string) !== LEGACY_ITINERARY_KIND) continue;
      if (item.observation.evidence?.source === "vault-note") {
        await io.delete(path);
        await ledger.set(item.key, {
          status: "dismissed",
          reason: "superseded: the itinerary is read again under the structured kinds",
          summary: item.summary,
          at: now().toISOString(),
          client: item.client,
        });
        result.reviewsRemoved++;
      } else {
        const observation = convertObservation(item.observation);
        const { path: _p, ...rest } = item;
        void _p;
        await io.modify(path, serializeReview({
          ...rest,
          observation,
          summary: item.summary.replace(LEGACY_ITINERARY_KIND, observation.kind),
        }));
        result.reviewsConverted++;
      }
      continue;
    }

    const { data, body } = splitNote(text);
    const legacyKind = data.type === LEGACY_ITINERARY_KIND;
    const inLegacyFolder = path.startsWith(`${agentFolder}/${LEGACY_FOLDER}/`);
    if (!legacyKind && !(inLegacyFolder && typeof data["agent-id"] === "string")) continue;
    // A mirror of the user's note, with nothing of theirs written into it: read the note again instead.
    if (data.source === "vault-note" && bodyUntouched(body)) {
      await io.delete(path);
      result.removed++;
      continue;
    }
    if (!legacyKind) continue;
    const stamped = cleanString(data["agent-hash"], 40);
    const { "agent-hash": _hash, ...unstamped } = data;
    void _hash;
    const edited = stamped !== "" && hashText(joinNote(unstamped, body)) !== stamped;
    const title = cleanString(data.title) || path.split("/").pop()!.replace(/\.md$/, "");
    const kind = kindForLegacyItem(data.item);
    const { fields, state, dropPlace } = convertLegacyFields(kind, title, cleanString(data.state, 40) || undefined, data);
    const { item: _i, carrier: _c, number: _n, from: _f, to: _t, trip: _tr, ...kept } = unstamped;
    void _i; void _c; void _n; void _f; void _t; void _tr;
    const next: Record<string, unknown> = { ...kept, ...fields, type: kind, state: state ?? kept.state };
    if (dropPlace) delete next.place;
    if (edited) {
      // Keep the old stamp, so the record still reads as edited by the user.
      await io.modify(path, joinNote({ ...next, "agent-hash": stamped }, body));
    } else {
      const record = parseRecord(path, joinNote(next, body));
      await io.modify(path, record ? serializeRecord(record) : joinNote(next, body));
    }
    result.converted++;
  }
  return result;
}
