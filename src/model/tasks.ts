/**
 * Task prompts + schemas + renderers for the reasoning model. Prompts state
 * goals and constraints, not step lists; outputs are structured JSON so
 * nothing depends on parsing prose. The renderers own the rule that scaffolds
 * are STRUCTURE ONLY — headings, links, bullet fragments — never prose in the
 * writer's voice.
 */

/* ── Connective phrasing (link weaving) ───────────────────────────────── */

export const CONNECTIVE_SCHEMA = {
  type: "object",
  properties: {
    phrase: {
      type: "string",
      description:
        "One short fragment (≤10 words, no ending period) naming the relationship between the two notes, e.g. 'applies this tradeoff to robot morphology'",
    },
  },
  required: ["phrase"],
  additionalProperties: false,
} as const;

export function connectivePrompt(input: {
  sourceTitle: string;
  sourceExcerpt: string;
  targetTitle: string;
  targetExcerpt: string;
}): string {
  return [
    `Two Zettelkasten notes are being linked. Produce one short connective fragment describing how the target relates to the source — the kind of annotation a careful note-taker writes after a link.`,
    ``,
    `Source note "${input.sourceTitle}":`,
    input.sourceExcerpt,
    ``,
    `Target note "${input.targetTitle}":`,
    input.targetExcerpt,
    ``,
    `The fragment completes the sentence "[[${input.targetTitle}]] — …". Lowercase start, no ending period, at most 10 words. Name the specific relationship (extends, contradicts, applies, exemplifies, grounds…), not a vague "is related to".`,
  ].join("\n");
}

export function parseConnective(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { phrase?: unknown };
    if (typeof parsed.phrase === "string" && parsed.phrase.trim()) {
      return parsed.phrase.trim().replace(/\.$/, "");
    }
  } catch {
    /* fall through */
  }
  return null;
}

/* ── New-note scaffolding ─────────────────────────────────────────────── */

export interface ScaffoldResult {
  title: string;
  /** Frontmatter type, e.g. "note", "reference", "project", "daily". */
  noteType: string;
  /** Folder the note belongs in, chosen from the vault's real folders. */
  home: string;
  /** H2 section headings, in order. Structure only. */
  sections: string[];
  /** Key ideas as telegraphic bullet fragments — NOT prose. */
  keyIdeas: string[];
  /** Titles of existing notes to link under Related. */
  links: string[];
}

export const SCAFFOLD_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Note title — specific, atomic, no trailing punctuation" },
    noteType: { type: "string", description: "One of the vault's note types, e.g. note, reference, project" },
    home: { type: "string", description: "EXACT folder path chosen from the provided folder list" },
    sections: { type: "array", items: { type: "string" }, description: "2-4 H2 section headings" },
    keyIdeas: {
      type: "array",
      items: { type: "string" },
      description: "2-5 telegraphic bullet fragments capturing the seed's key ideas — never full prose sentences in the writer's voice",
    },
    links: { type: "array", items: { type: "string" }, description: "Existing note titles worth linking, from the provided list only" },
  },
  required: ["title", "noteType", "home", "sections", "keyIdeas", "links"],
  additionalProperties: false,
} as const;

export function scaffoldPrompt(input: {
  seed: string;
  folders: string[];
  relatedTitles: string[];
}): string {
  return [
    `Scaffold a new Zettelkasten note. The scaffold is structure the writer fills in — you provide the skeleton and telegraphic key-idea bullets, never finished prose in their voice.`,
    ``,
    `Seed (what the writer wants to capture):`,
    input.seed,
    ``,
    `Vault folders (choose "home" EXACTLY from this list):`,
    ...input.folders.map((f) => `- ${f || "(vault root)"}`),
    ``,
    `Existing notes that may be related (choose "links" only from this list):`,
    ...(input.relatedTitles.length ? input.relatedTitles.map((t) => `- ${t}`) : ["- (none found)"]),
    ``,
    `One idea per note: if the seed contains several ideas, scaffold the central one and name the others as key ideas the writer might split out later.`,
  ].join("\n");
}

export function parseScaffold(text: string): ScaffoldResult {
  const parsed = JSON.parse(text) as Partial<ScaffoldResult>;
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" && v.trim() ? v.trim() : fallback;
  const arr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
  return {
    title: str(parsed.title, "Untitled"),
    noteType: str(parsed.noteType, "note"),
    home: typeof parsed.home === "string" ? parsed.home.trim() : "",
    sections: arr(parsed.sections),
    keyIdeas: arr(parsed.keyIdeas),
    links: arr(parsed.links),
  };
}

/** Model-free fallback: a plain typed skeleton from the seed text alone. */
export function fallbackScaffold(seed: string): ScaffoldResult {
  const firstLine = seed.split("\n")[0].replace(/\s+/g, " ").trim();
  const title = firstLine.length > 80 ? firstLine.slice(0, 79).trimEnd() + "…" : firstLine;
  return {
    title: title || "Untitled",
    noteType: "note",
    home: "",
    sections: ["Idea", "Evidence", "Implications"],
    keyIdeas: [],
    links: [],
  };
}

/** Render a scaffold to markdown. Structure + fragments only — never prose. */
export function renderScaffold(s: ScaffoldResult, isoDate: string): string {
  const lines: string[] = [
    "---",
    `type: ${s.noteType}`,
    `created: ${isoDate}`,
    "---",
    "",
  ];
  if (s.keyIdeas.length > 0) {
    lines.push(...s.keyIdeas.map((idea) => `- ${idea}`), "");
  }
  for (const section of s.sections) {
    lines.push(`## ${section}`, "");
  }
  if (s.links.length > 0) {
    lines.push("## Related", "", ...s.links.map((t) => `- [[${t}]]`), "");
  }
  return lines.join("\n");
}

/** A filesystem-safe filename from a note title. */
export function sanitizeTitle(title: string): string {
  return (
    title
      .replace(/[\\/:*?"<>|#^[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Untitled"
  );
}
