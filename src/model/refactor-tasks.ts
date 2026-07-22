import type { SplitGroup, StructureCluster } from "../actions/split";
import type { MocSection } from "../actions/moc";

/* ── Pass-1 analysis: atomic, or cluster an unstructured note ──────────── */

export const ANALYZE_SCHEMA = {
  type: "object",
  properties: {
    atomic: {
      type: "boolean",
      description: "true if the note already expresses a single atomic idea and should not be split",
    },
    reason: { type: "string", description: "one-line explanation (why atomic, or a note on the proposed clustering)" },
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "title of the proposed atomic note" },
          description: { type: "string", description: "one-line description (≤12 words)" },
          paragraphIndices: {
            type: "array",
            items: { type: "integer" },
            description: "indices of the paragraphs whose text belongs in this note",
          },
        },
        required: ["title", "description", "paragraphIndices"],
        additionalProperties: false,
      },
    },
  },
  required: ["atomic", "reason", "clusters"],
  additionalProperties: false,
} as const;

export function analyzePrompt(input: {
  title: string;
  paragraphs: Array<{ index: number; text: string }>;
}): string {
  return [
    `Analyze the note "${input.title}" for splitting into atomic Zettelkasten notes (one idea per note).`,
    ``,
    `You are ONLY grouping the note's existing paragraphs by their index numbers. The paragraph text is preserved exactly and merely moved — you must NOT rewrite, rephrase, summarize, condense, translate, re-punctuate, or otherwise edit any of the note's words. Never reproduce the paragraph text back to me; reference paragraphs only by index.`,
    ``,
    `First: does this note already express a SINGLE atomic idea? If so, set atomic=true with a one-line reason — it should not be split, and return an empty clusters array.`,
    ``,
    `Otherwise it holds several separable ideas: set atomic=false and propose 2–6 clusters, each becoming one suggested atomic note. For each, give the indices of the paragraphs that belong in it plus two short pieces of generated text:`,
    `- title: terse, in the note's own voice and terminology (reuse the words the note already uses); a label, not a sentence.`,
    `- description: ≤10 words, a plain topical label of what the cluster is about. It must NOT paraphrase, summarize, or quote the note's content — no phrases lifted or reworded from the text, and never anything in quotation marks from the note.`,
    ``,
    `Group only paragraphs that genuinely form one self-contained idea. You do NOT need to assign every paragraph — leave framing, connective, or introductory paragraphs out of all clusters so they stay in the original note.`,
    ``,
    `Treat any quoted passage in the note as immutable: it stays exactly as written, inside whatever paragraph it's in. Do not alter, re-punctuate, or echo quotes anywhere in your output.`,
    ``,
    `Paragraphs:`,
    ...input.paragraphs.map((p) => `[${p.index}] ${p.text.replace(/\s+/g, " ").slice(0, 240)}`),
  ].join("\n");
}

export interface AnalysisResult {
  atomic: boolean;
  reason: string;
  clusters: StructureCluster[];
}

/** Parse a `[{title, description, paragraphIndices}]` array, dropping malformed entries. */
export function parseClusters(value: unknown): StructureCluster[] {
  if (!Array.isArray(value)) return [];
  const clusters: StructureCluster[] = [];
  for (const c of value) {
    if (typeof c !== "object" || c === null) continue;
    const obj = c as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const indices = Array.isArray(obj.paragraphIndices)
      ? obj.paragraphIndices.filter((n): n is number => Number.isInteger(n))
      : [];
    if (!title || indices.length === 0) continue;
    clusters.push({
      title,
      description: typeof obj.description === "string" ? obj.description.trim() : "",
      paragraphIndices: indices,
    });
  }
  return clusters;
}

export function parseAnalysis(text: string): AnalysisResult | null {
  let parsed: { atomic?: unknown; reason?: unknown; clusters?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  return {
    atomic: parsed.atomic === true,
    reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    clusters: parseClusters(parsed.clusters),
  };
}

/* ── Pass-1b critique: review and refine the proposed clustering ──────── */

export const CRITIQUE_SCHEMA = {
  type: "object",
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "improved atomic-note title" },
          description: { type: "string", description: "≤12-word topical label" },
          paragraphIndices: { type: "array", items: { type: "integer" } },
        },
        required: ["title", "description", "paragraphIndices"],
        additionalProperties: false,
      },
    },
  },
  required: ["clusters"],
  additionalProperties: false,
} as const;

export function critiquePrompt(input: {
  title: string;
  paragraphs: Array<{ index: number; text: string }>;
  proposal: StructureCluster[];
}): string {
  return [
    `Review a proposed split of the note "${input.title}" into atomic Zettelkasten notes, and return an improved version.`,
    ``,
    `You are ONLY regrouping the note's existing paragraphs by index — never rewrite, rephrase, condense, or edit the note's words, and never alter quoted text. Only the section titles and descriptions are yours to write.`,
    ``,
    `Critique each proposed section and fix what's weak:`,
    `- Coherence: each section must hold exactly ONE self-contained idea. Split a section that mixes two ideas; merge two sections that are really one; drop a section that's just framing/connective (its paragraphs return to the original note).`,
    `- Paragraph fit: every paragraph in a section must actually be about that idea — move any that belong elsewhere.`,
    `- Title: must be a good atomic-note title — a specific concept or claim, terse, a noun phrase in the note's own terminology; not vague ("Misc", "Notes", "Other"), not a full sentence. Rewrite weak titles.`,
    `- Description: ≤10 words, a plain topical label; never a paraphrase or quotation of the content.`,
    ``,
    `Keep what's already good; change only what needs it. Aim for 2–6 coherent notes; you need not assign every paragraph. Return the improved proposal as clusters (title, description, paragraphIndices).`,
    ``,
    `Current proposal:`,
    ...input.proposal.map(
      (c, i) =>
        `${i + 1}. "${c.title}" — paragraphs [${c.paragraphIndices.join(", ")}]${c.description ? ` — ${c.description}` : ""}`,
    ),
    ``,
    `Paragraphs:`,
    ...input.paragraphs.map((p) => `[${p.index}] ${p.text.replace(/\s+/g, " ").slice(0, 240)}`),
  ].join("\n");
}

export function parseCritique(text: string): StructureCluster[] {
  let parsed: { clusters?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return [];
  }
  return parseClusters(parsed.clusters);
}

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
    `You are only grouping existing segments by index — the segment text is preserved exactly and moved unchanged; do not rewrite, rephrase, or edit any of it, and never alter quoted passages. Every segment should be assigned to exactly one note. Prefer keeping tightly-related segments together; don't over-fragment. Titles name the single idea in the note's own words; descriptions are telegraphic topical labels (≤10 words), never a paraphrase or quote of the content.`,
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
