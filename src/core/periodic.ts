/**
 * Recognizing daily/weekly/monthly notes by name.
 *
 * Why this matters for the Margin: while journaling, the semantically nearest
 * neighbors of today's entry are *other dated entries* — last Tuesday also
 * mentioned motivation. If those fill the Margin, the permanent note on
 * motivation (the thing the Zettelkasten method says the writer should be
 * elaborating) is buried under a mirror of their own journal. File by
 * lifecycle, connect by topic: a dated entry is lifecycle, so topic surfaces
 * should prefer permanent notes and only then dated ones.
 *
 * Demotion, never exclusion — "you wrote about this on June 28" is real
 * information; it just shouldn't outrank the idea's actual note.
 *
 * Name-based heuristics rather than a folder setting: daily notes travel
 * (root, Daily/, Journal/…) but their names are rigidly conventional.
 */

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december";

const PERIODIC_PATTERNS: RegExp[] = [
  // 2026-07-25, 2026-07-25 Friday, 2026-07-25 anything
  /^\d{4}-\d{2}-\d{2}(\b|_)/,
  // 25-07-2026 / 07-25-2026 style
  /^\d{2}[-.]\d{2}[-.]\d{4}$/,
  // June 28, 2026  (the convention in this vault)
  new RegExp(`^(${MONTHS}) \\d{1,2}, \\d{4}$`, "i"),
  // 28 June 2026
  new RegExp(`^\\d{1,2} (${MONTHS}) \\d{4}$`, "i"),
  // 2026-W31 weekly, 2026-07 monthly, 2026-Q3 quarterly, 2026 yearly
  /^\d{4}-W\d{1,2}(\b|_|$)/i,
  /^\d{4}-\d{2}$/,
  /^\d{4}-Q[1-4]$/i,
  /^\d{4}$/,
];

/** Whether a note path names a periodic (daily/weekly/…) note. */
export function looksPeriodic(path: string): boolean {
  const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "").trim();
  return PERIODIC_PATTERNS.some((p) => p.test(base));
}

const MONTH_INDEX: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/**
 * The month-day of a dated note ("07-25"), or null for non-daily periodic
 * notes (weeklies, monthlies) and ordinary notes. This is the key for
 * "on this day" — the classic journaling loop-closer: what was I thinking on
 * this date, a month or a year ago?
 */
export function dayKeyOf(path: string): string | null {
  const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "").trim();
  const iso = /^\d{4}-(\d{2})-(\d{2})(\b|_|$)/.exec(base);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const written = new RegExp(`^(${MONTHS}) (\\d{1,2}), \\d{4}$`, "i").exec(base);
  if (written) {
    const month = MONTH_INDEX[written[1].toLowerCase()];
    return `${month}-${written[2].padStart(2, "0")}`;
  }
  const dayFirst = new RegExp(`^(\\d{1,2}) (${MONTHS}) \\d{4}$`, "i").exec(base);
  if (dayFirst) {
    const month = MONTH_INDEX[dayFirst[2].toLowerCase()];
    return `${month}-${dayFirst[1].padStart(2, "0")}`;
  }
  return null;
}

/** Full ISO date ("2026-07-25") of a daily note, from either name format. */
export function dateOf(path: string): string | null {
  const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(\b|_|$)/.exec(base);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const written = new RegExp(`^(${MONTHS}) (\\d{1,2}), (\\d{4})$`, "i").exec(base);
  if (written) {
    return `${written[3]}-${MONTH_INDEX[written[1].toLowerCase()]}-${written[2].padStart(2, "0")}`;
  }
  const dayFirst = new RegExp(`^(\\d{1,2}) (${MONTHS}) (\\d{4})$`, "i").exec(base);
  if (dayFirst) {
    return `${dayFirst[3]}-${MONTH_INDEX[dayFirst[2].toLowerCase()]}-${dayFirst[1].padStart(2, "0")}`;
  }
  return null;
}

/**
 * The LOCAL calendar date as YYYY-MM-DD. Daily notes are named in local
 * time; `toISOString()` is UTC and put every evening (west of UTC) or early
 * morning (east) on the wrong day — "begin today's entry" offered tomorrow.
 */
export function localISODate(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * ISO-8601 week label ("2026-W33") for a local date — including the ISO
 * week-year, which differs from the calendar year around New Year (2027-01-01
 * is 2026-W53). The previous ad-hoc formula was off by one for every date in
 * a year whose Jan 4 falls on Sunday, and produced W00 in early January.
 */
export function isoWeekLabel(at: Date = new Date()): string {
  const date = new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()));
  const day = date.getUTCDay() || 7; // ISO: Monday=1 … Sunday=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // the week's Thursday fixes the week-year
  const year = date.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((date.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/* ── Entry-name format inference ─────────────────────────────────────── */

export type DateNameStyle = "iso" | "iso-weekday" | "written" | "day-first";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Which date-name convention a journal folder actually uses, inferred from
 * its existing entries. A vault's journal is defined by the writer's habit,
 * not by the plugin's preference — creating "2026-08-13.md" into a folder of
 * "August 13, 2026.md" files would fork the convention mid-shelf. Dominant
 * style wins; ties and empty folders fall back to ISO (natural sort order).
 */
export function inferDateNameFormat(basenames: string[]): DateNameStyle {
  const counts: Record<DateNameStyle, number> = {
    iso: 0,
    "iso-weekday": 0,
    written: 0,
    "day-first": 0,
  };
  for (const raw of basenames) {
    const base = raw.replace(/\.md$/i, "").trim();
    if (/^\d{4}-\d{2}-\d{2} \S/.test(base)) counts["iso-weekday"]++;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(base)) counts.iso++;
    else if (new RegExp(`^(${MONTHS}) \\d{1,2}, \\d{4}$`, "i").test(base)) counts.written++;
    else if (new RegExp(`^\\d{1,2} (${MONTHS}) \\d{4}$`, "i").test(base)) counts["day-first"]++;
  }
  let best: DateNameStyle = "iso";
  let bestCount = 0;
  for (const style of ["iso", "iso-weekday", "written", "day-first"] as const) {
    if (counts[style] > bestCount) {
      best = style;
      bestCount = counts[style];
    }
  }
  return best;
}

/** Today's entry basename in the folder's own convention. */
export function formatDateName(at: Date, style: DateNameStyle): string {
  const iso = localISODate(at);
  switch (style) {
    case "iso":
      return iso;
    case "iso-weekday":
      return `${iso} ${WEEKDAYS[at.getDay()]}`;
    case "written":
      return `${MONTH_NAMES[at.getMonth()]} ${at.getDate()}, ${at.getFullYear()}`;
    case "day-first":
      return `${at.getDate()} ${MONTH_NAMES[at.getMonth()]} ${at.getFullYear()}`;
  }
}
