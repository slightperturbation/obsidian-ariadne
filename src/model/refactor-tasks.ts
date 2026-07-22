import type { SplitGroup } from "../actions/split";
import type { MocSection } from "../actions/moc";

/* ── Semantic split: group segments into atomic notes ─────────────────── */

export const SPLIT_SCHEMA = {
  type: "object",
  properties: {
    children: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Atomic note title — one idea, no trailing punctuation" },
          description: { type: "string", description: "One-line description for the Contents entry (≤12 words)" },
          segmentIndices: {
            type: "array",
            items: { type: "integer" },
            description: "Indices of the source segments that belong in this note",
          },
        },
        required: ["title", "description", "segmentIndices"],
        additionalProperties: false,
      },
    },
  },
  required: ["children"],
  additionalProperties: false,
} as const;

export function splitPrompt(input: {
  title: string;
  segments: Array<{ index: number; heading: string; preview: string }>;
}): string {
  return [
    `The note "${input.title}" holds several ideas and should be split into atomic Zettelkasten notes (one idea per note). Group its numbered segments into 2–6 atomic notes, give each a specific title and a one-line description, and list which segment indices belong to each.`,
    ``,
    `Segments:`,
    ...input.segments.map((s) => `[${s.index}] ${s.heading || "(no heading)"} — ${s.preview}`),
    ``,
    `Every segment should be assigned to exactly one note. Prefer keeping tightly-related segments together; don't over-fragment. Titles name the single idea; descriptions are telegraphic.`,
  ].join("\n");
}

export function parseSplitGroups(text: string): SplitGroup[] {
  let parsed: { children?: unknown };
  try {
    parsed = JSON.parse(text) as { children?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.children)) return [];
  const groups: SplitGroup[] = [];
  for (const c of parsed.children) {
    if (typeof c !== "object" || c === null) continue;
    const obj = c as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const indices = Array.isArray(obj.segmentIndices)
      ? obj.segmentIndices.filter((n): n is number => Number.isInteger(n))
      : [];
    if (!title || indices.length === 0) continue;
    groups.push({
      title,
      description: typeof obj.description === "string" ? obj.description.trim() : "",
      segmentIndices: indices,
    });
  }
  return groups;
}

/* ── MoC: themed sections over a neighborhood ─────────────────────────── */

export const MOC_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Map-of-Content title naming the theme of the cluster" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          theme: { type: "string", description: "Sub-theme heading (may be empty for a flat list)" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "EXACT title of a note from the provided list" },
                description: { type: "string", description: "One-line note of why it belongs (≤12 words)" },
              },
              required: ["title", "description"],
              additionalProperties: false,
            },
          },
        },
        required: ["theme", "items"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "sections"],
  additionalProperties: false,
} as const;

export function mocPrompt(input: {
  seedTitle: string;
  neighborhood: Array<{ title: string; excerpt: string }>;
}): string {
  return [
    `Build a Map-of-Content (MoC) note organizing this cluster of related notes around "${input.seedTitle}". Give the MoC a title naming the theme, then group the notes into a few sub-themes, each with a heading and its notes annotated with a one-line reason for inclusion.`,
    ``,
    `Notes in the cluster (use these EXACT titles, and only these):`,
    ...input.neighborhood.map((n) => `- ${n.title} — ${n.excerpt}`),
    ``,
    `Every item's title must match one of the titles above exactly. Omit any note that doesn't fit rather than inventing a link. A single flat section (empty theme) is fine for a small cluster.`,
  ].join("\n");
}

export interface MocResult {
  title: string;
  sections: MocSection[];
}

/** Parse the MoC response, keeping only items whose title is a real neighborhood note. */
export function parseMoc(text: string, allowedTitles: Set<string>): MocResult | null {
  let parsed: { title?: unknown; sections?: unknown };
  try {
    parsed = JSON.parse(text) as { title?: unknown; sections?: unknown };
  } catch {
    return null;
  }
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "";
  if (!title || !Array.isArray(parsed.sections)) return null;
  const sections: MocSection[] = [];
  for (const s of parsed.sections) {
    if (typeof s !== "object" || s === null) continue;
    const obj = s as Record<string, unknown>;
    const items = Array.isArray(obj.items) ? obj.items : [];
    const kept = items
      .map((it) => (typeof it === "object" && it ? (it as Record<string, unknown>) : null))
      .filter((it): it is Record<string, unknown> => !!it && typeof it.title === "string")
      .filter((it) => allowedTitles.has((it.title as string).trim()))
      .map((it) => ({
        title: (it.title as string).trim(),
        description: typeof it.description === "string" ? it.description.trim() : "",
      }));
    if (kept.length > 0) {
      sections.push({ theme: typeof obj.theme === "string" ? obj.theme.trim() : "", items: kept });
    }
  }
  return sections.length > 0 ? { title, sections } : null;
}

/** No-model MoC: one flat section listing the whole neighborhood. */
export function fallbackMoc(seedTitle: string, titles: string[]): MocResult {
  return {
    title: `${seedTitle} — Map`,
    sections: [{ theme: "", items: titles.map((t) => ({ title: t, description: "" })) }],
  };
}
