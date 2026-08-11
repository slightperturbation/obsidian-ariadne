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

/* ── Relation classification (tension/echo) ───────────────────────────── */

export const RELATION_SCHEMA = {
  type: "object",
  properties: {
    relation: {
      type: "string",
      enum: ["contradicts", "restates", "neither"],
      description:
        "contradicts = the two texts take incompatible positions on the same question; restates = the paragraph re-says what the note already says; neither = same territory, no stance overlap",
    },
    explanation: {
      type: "string",
      description:
        "Only for contradicts/restates: one terse fragment (≤12 words, lowercase start, no ending period) naming the SPECIFIC point of disagreement or repetition",
    },
  },
  required: ["relation"],
  additionalProperties: false,
} as const;

export function relationPrompt(input: {
  paragraph: string;
  noteTitle: string;
  noteExcerpt: string;
}): string {
  return [
    `A writer is drafting a paragraph. An existing note in their Zettelkasten covers similar ground. Judge the relation between what the PARAGRAPH claims and what the NOTE claims.`,
    ``,
    `PARAGRAPH (being written now):`,
    input.paragraph,
    ``,
    `NOTE "${input.noteTitle}":`,
    input.noteExcerpt,
    ``,
    `Rules:`,
    `- "contradicts" only for genuine incompatibility: the paragraph asserts what the note denies, or vice versa. Different emphasis, scope, or examples is NOT contradiction.`,
    `- "restates" only when the paragraph substantially re-says the note's point — a reader would call it the same idea again.`,
    `- Everything else — related topic, complementary angle, shared vocabulary — is "neither". When unsure, answer "neither"; a wrong interruption costs the writer more than a missed one.`,
    `- The explanation names the specific point at issue, not the topic. "disagrees on whether spaced repetition helps transfer", not "both discuss learning".`,
  ].join("\n");
}

export function parseRelation(text: string): { relation: "contradicts" | "restates" | "neither"; explanation?: string } {
  try {
    const parsed = JSON.parse(text) as { relation?: unknown; explanation?: unknown };
    if (
      parsed.relation === "contradicts" ||
      parsed.relation === "restates" ||
      parsed.relation === "neither"
    ) {
      const explanation =
        typeof parsed.explanation === "string" && parsed.explanation.trim()
          ? parsed.explanation.trim().replace(/\.$/, "")
          : undefined;
      return { relation: parsed.relation, explanation };
    }
  } catch {
    /* fall through */
  }
  // A malformed answer must degrade to silence, not to a wrong card.
  return { relation: "neither" };
}

/* ── Untitled rename: title from content ──────────────────────────────── */

export const TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        "A terse note title in the writer's own vocabulary (≤8 words, no ending period). Name the note's ONE idea, not its topic area.",
    },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

export function titlePrompt(content: string): string {
  return [
    `Propose a title for this untitled Zettelkasten note. Use the writer's own words where possible; name the note's one idea specifically ("Spaced repetition trades transfer for retention", not "Notes on learning").`,
    ``,
    content,
  ].join("\n");
}

export function parseTitle(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { title?: unknown };
    if (typeof parsed.title === "string" && parsed.title.trim()) {
      return sanitizeTitle(parsed.title.trim().replace(/\.$/, ""));
    }
  } catch {
    /* fall through */
  }
  return null;
}

/* ── Inbox triage: disposition for the ambiguous middle ───────────────── */

export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    disposition: {
      type: "string",
      enum: ["elaborate", "archive"],
      description:
        "elaborate = this contains a live idea worth developing into a permanent note; archive = inert (a stale clipping, an expired to-do, a thought that resolved itself)",
    },
    reason: {
      type: "string",
      description: "One terse fragment (≤12 words, lowercase start) saying why",
    },
  },
  required: ["disposition", "reason"],
  additionalProperties: false,
} as const;

export function triagePrompt(input: { name: string; content: string }): string {
  return [
    `An Inbox note in a Zettelkasten awaits triage. The Ahrens rule: an Inbox item either becomes (part of) a permanent note or leaves the system — it must not simply sit. Merging with duplicates is handled elsewhere; your call is only: is there a live idea here worth elaborating, or is this inert?`,
    ``,
    `Note "${input.name}":`,
    input.content,
    ``,
    `Lean toward "elaborate" when there is any genuine thought — a question, a claim, a connection. "archive" is for content with no idea to develop: raw clippings never engaged with, logistics that expired, duplicated fragments.`,
  ].join("\n");
}

export function parseTriage(text: string): { disposition: "elaborate" | "archive"; reason: string } {
  try {
    const parsed = JSON.parse(text) as { disposition?: unknown; reason?: unknown };
    if (parsed.disposition === "elaborate" || parsed.disposition === "archive") {
      return {
        disposition: parsed.disposition,
        reason:
          typeof parsed.reason === "string" && parsed.reason.trim()
            ? parsed.reason.trim().replace(/\.$/, "")
            : "",
      };
    }
  } catch {
    /* fall through */
  }
  // Unparseable → elaborate: the costly mistake is archiving a live idea.
  return { disposition: "elaborate", reason: "" };
}
