import { bodyOf } from "../chat/frontmatter";

/**
 * The dates a note's name stands for, worked out exactly — so the model that
 * works on the note is told them rather than left to count days itself
 * (a small model gets the last day of a week wrong more often than right).
 */

const DAY = 86_400_000;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
/** 0 = Monday … 6 = Sunday. */
const weekday = (t: number): number => (new Date(t).getUTCDay() + 6) % 7;

/** The Monday of ISO week `week` of `year`, or undefined when that year has no such week. */
function mondayOf(year: number, week: number): number | undefined {
  if (week < 1 || week > 53) return undefined;
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - weekday(jan4) * DAY + (week - 1) * 7 * DAY;
  // The week belongs to the year its Thursday is in: week 53 only exists in some years.
  return new Date(monday + 3 * DAY).getUTCFullYear() === year ? monday : undefined;
}

/** The ISO week a day is in, as "2025-W18". */
function weekOf(t: number): string {
  const thursday = t + (3 - weekday(t)) * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function weekLine(label: string, monday: number): string {
  const days = WEEKDAYS.map((d, i) => `${d} ${iso(monday + i * DAY)}`).join(", ");
  return `${label} is ISO week ${Number(label.slice(6))} of ${label.slice(0, 4)}, Monday to Sunday: ${days}.`;
}

/** The days a note's name stands for — a week (Monday to Sunday) or one day — or undefined. */
export function nameRange(path: string): { label: string; from: string; to: string } | undefined {
  const name = path.split("/").pop()!.replace(/\.md$/i, "");
  const week = /(?<!\d)(\d{4})-W(\d{1,2})(?!\d)/i.exec(name);
  if (week) {
    const monday = mondayOf(Number(week[1]), Number(week[2]));
    if (monday === undefined) return undefined;
    return { label: `${week[1]}-W${week[2]!.padStart(2, "0")}`, from: iso(monday), to: iso(monday + 6 * DAY) };
  }
  const day = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(name);
  if (day && iso(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))) === day[0]) return { label: day[0], from: day[0], to: day[0] };
  return undefined;
}

/**
 * A step that would put a dated note's text into a note for another day: the
 * week or day the note's name stands for does not hold the day of the note it
 * goes into — "2024-W03" into today's journal entry. Says so, or undefined.
 */
export function wrongDay(main: string, changes: Array<{ type: string; path: string; to?: string; before?: string; after?: string }>): string | undefined {
  const own = nameRange(main);
  if (!own) return undefined;
  // The note's text goes where it is moved, or into the note that grows by most of it when it is merged and trashed
  // (not a note whose link to it is only pointed elsewhere).
  const gone = changes.find((c) => c.type === "delete" && c.path === main)?.before;
  // Merged word for word: the note it went into now holds the start of its text, which it did not before.
  const piece = gone === undefined ? "" : bodyOf(gone).trim().slice(0, 200);
  for (const c of changes) {
    const merged = !!piece && c.type === "modify" && c.path !== main && (c.after ?? "").includes(piece) && !(c.before ?? "").includes(piece);
    const into = c.type === "move" && c.path === main ? c.to : merged ? c.path : undefined;
    const theirs = into ? nameRange(into) : undefined;
    if (!theirs || theirs.from !== theirs.to) continue;
    if (theirs.from < own.from || theirs.from > own.to) {
      const span = own.from === own.to ? own.from : `${own.from} to ${own.to}`;
      return `it would go into ${into}, but this note's name dates it to ${own.label}${own.from === own.to ? "" : ` (${span})`}`;
    }
  }
  return undefined;
}

/** What a note's name says about dates, in exact words — or undefined when its name holds no date or week. */
export function nameDates(path: string): string | undefined {
  const name = path.split("/").pop()!.replace(/\.md$/i, "");
  const lines: string[] = [];
  const week = /(?<!\d)(\d{4})-W(\d{1,2})(?!\d)/i.exec(name);
  if (week) {
    const label = `${week[1]}-W${week[2]!.padStart(2, "0")}`;
    const monday = mondayOf(Number(week[1]), Number(week[2]));
    lines.push(monday === undefined ? `${label}: the year ${week[1]} has no such ISO week.` : weekLine(label, monday));
  }
  const day = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(name);
  if (day) {
    const t = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (iso(t) === day[0]) {
      const w = weekOf(t);
      lines.push(`${day[0]} is a ${WEEKDAYS[weekday(t)]}, in ISO week ${w} (Monday ${iso(t - weekday(t) * DAY)} to Sunday ${iso(t + (6 - weekday(t)) * DAY)}).`);
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}
