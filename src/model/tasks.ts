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
  /** Folder the note lands in — decided by the deterministic placement
   * ladder (referrer vote → neighbor vote → inbox), never by the model.
   * Always "" straight out of parse/fallback; the controller fills it in. */
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
    sections: { type: "array", items: { type: "string" }, description: "2-4 H2 section headings" },
    keyIdeas: {
      type: "array",
      items: { type: "string" },
      description: "2-5 telegraphic bullet fragments capturing the seed's key ideas — never full prose sentences in the writer's voice",
    },
    links: { type: "array", items: { type: "string" }, description: "Existing note titles worth linking, from the provided list only" },
  },
  required: ["title", "noteType", "sections", "keyIdeas", "links"],
  additionalProperties: false,
} as const;

export function scaffoldPrompt(input: {
  seed: string;
  relatedTitles: string[];
}): string {
  return [
    `Scaffold a new Zettelkasten note. The scaffold is structure the writer fills in — you provide the skeleton and telegraphic key-idea bullets, never finished prose in their voice.`,
    ``,
    `Seed (what the writer wants to capture):`,
    input.seed,
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
    home: "", // placement comes from the graph vote, not the model
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

/* ── Theme naming (recurring journal themes) ──────────────────────────── */

export const THEME_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        "A permanent-note title for the recurring theme, in the writer's own vocabulary (≤8 words, no ending period) — the ONE idea, not the topic area",
    },
    gist: {
      type: "string",
      description:
        "One terse fragment (≤15 words, lowercase start) saying what the permanent note would claim",
    },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

export function themePrompt(snippets: string[]): string {
  return [
    `A writer's journal keeps returning to one theme. These excerpts are from separate dated entries. Name the recurring idea as a Zettelkasten note title, using the writer's own vocabulary where possible — the specific claim they keep circling, not the general topic.`,
    ``,
    ...snippets.map((s, i) => `Entry ${i + 1}: ${s}`),
  ].join("\n");
}

export function parseTheme(text: string): { title: string; gist?: string } | null {
  try {
    const parsed = JSON.parse(text) as { title?: unknown; gist?: unknown };
    if (typeof parsed.title === "string" && parsed.title.trim()) {
      return {
        title: sanitizeTitle(parsed.title.trim().replace(/\.$/, "")),
        gist:
          typeof parsed.gist === "string" && parsed.gist.trim()
            ? parsed.gist.trim().replace(/\.$/, "")
            : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/* ── Weekly synthesis: questions, never prose ─────────────────────────── */

export const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: {
        type: "string",
        description:
          "One elaboration question (≤20 words) naming a SPECIFIC claim or tension from the week's entries — the kind that starts a permanent note",
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

export function synthesisPrompt(entries: Array<{ date: string; excerpt: string }>): string {
  return [
    `A writer reviews their week of journal entries. Produce elaboration questions — the questions a good thinking partner asks to turn circling thoughts into permanent notes. Name the specific claims and tensions in THEIR words; never summarize, never answer, never write prose for them. "You kept returning to X — what's the actual claim?" is the register.`,
    ``,
    ...entries.map((e) => `${e.date}:\n${e.excerpt}`),
  ].join("\n\n");
}

export function parseSynthesis(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { questions?: unknown };
    if (Array.isArray(parsed.questions)) {
      return parsed.questions
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim())
        .slice(0, 5);
    }
  } catch {
    /* fall through */
  }
  return [];
}

/* ── Publish screening: hold or clear, failing toward hold ────────────── */

export const PUBLISH_SCREEN_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["hold", "clear"],
      description:
        "hold = anything personal, emotional, intimate, health- or finance-related, venting, confidential, or about identifiable private individuals; clear = impersonal ideas, concepts, references — the kind of note written for a public digital garden",
    },
    reason: {
      type: "string",
      description:
        "For hold: one terse fragment (≤12 words, lowercase start) naming what makes it private. Omit for clear.",
    },
  },
  required: ["verdict"],
  additionalProperties: false,
} as const;

export function publishScreenPrompt(input: {
  title: string;
  content: string;
  localFlags: string[];
  /** The writer's own nearest prior decisions — dynamic few-shot. */
  precedents?: Array<{ title: string; decision: "cleared" | "held"; reason?: string }>;
}): string {
  const precedents =
    input.precedents && input.precedents.length > 0
      ? [
          `The writer's own decisions on the most similar notes:`,
          ...input.precedents.map(
            (p) =>
              `- "${p.title}" → ${p.decision === "cleared" ? "published" : "held"}${
                p.reason ? ` (${p.reason})` : ""
              }`,
          ),
          ``,
        ]
      : [];
  return [
    `A writer keeps a public digital garden ("working with the garage door open") and a private journal in one vault. Judge whether this note is safe to publish to the PUBLIC web.`,
    ``,
    `HOLD anything with: personal or emotional disclosure; the writer's relationships, family, or named private individuals; health, therapy, or intimacy; personal finances; venting or unprocessed feelings; confidential work details.`,
    `CLEAR only notes that are confidently impersonal: ideas, concepts, book notes, techniques — things written about the world rather than about the writer's life.`,
    `When uncertain, HOLD. A wrongly-held note costs one click; a wrongly-cleared note is on the internet.`,
    ``,
    ...precedents,
    ...(input.localFlags.length > 0
      ? [`Local scanners flagged: ${input.localFlags.join("; ")}.`, ``]
      : []),
    `Note "${input.title}" (complete):`,
    input.content,
  ].join("\n");
}

export function parsePublishScreen(text: string): { verdict: "hold" | "clear"; reason?: string } {
  try {
    const parsed = JSON.parse(text) as { verdict?: unknown; reason?: unknown };
    if (parsed.verdict === "clear") return { verdict: "clear" };
    if (parsed.verdict === "hold") {
      return {
        verdict: "hold",
        reason:
          typeof parsed.reason === "string" && parsed.reason.trim()
            ? parsed.reason.trim().replace(/\.$/, "")
            : undefined,
      };
    }
  } catch {
    /* fall through */
  }
  // The inverse of every other parser here: malformed output must HOLD.
  // Failing open on a privacy gate is not a degradation, it's a breach.
  return { verdict: "hold", reason: "screening answer was unreadable" };
}

/* ── Journal thread pages ─────────────────────────────────────────────── */
/*
 * Voice contract for ALL thread-related generation (a user decision, not a
 * style whim): neutral and fact-oriented. Text about the journal describes
 * what the writing DISCUSSES, never what the writer feels. The one hard
 * rule every prompt below repeats: Ariadne may echo emotion words the
 * writer used, but must never introduce emotion words of its own.
 */

export const THREAD_JUDGE_SCHEMA = {
  type: "object",
  properties: {
    isThread: {
      type: "boolean",
      description: "true only if the excerpts clearly trace ONE topic the writer keeps returning to",
    },
    name: {
      type: "string",
      description: "2-6 word thread name in the writer's own vocabulary; empty when isThread is false",
    },
  },
  required: ["isThread", "name"],
  additionalProperties: false,
} as const;

export function threadJudgePrompt(evidence: string[]): string {
  return [
    `Excerpts from SEPARATE dated journal entries that sit close in meaning. Judge whether they trace ONE topic the writer keeps returning to over time (a thread), or are merely similar-sounding moments. Be skeptical — a falsely suggested thread costs trust. When uncertain, answer false.`,
    ``,
    `If true, name the thread in 2-6 words drawn from the writer's own vocabulary in the excerpts. The name states the topic, never a diagnosis. Never introduce emotion words that do not appear in the excerpts.`,
    ``,
    ...evidence.map((s, i) => `Excerpt ${i + 1}: ${s}`),
  ].join("\n");
}

export function parseThreadJudge(text: string): { isThread: boolean; name: string } {
  try {
    const parsed = JSON.parse(text) as { isThread?: unknown; name?: unknown };
    if (parsed.isThread === true && typeof parsed.name === "string" && parsed.name.trim()) {
      return { isThread: true, name: sanitizeTitle(parsed.name.trim().replace(/\.$/, "")) };
    }
  } catch {
    /* fall through */
  }
  // Malformed → not a thread: this feature's fail-bias is silence.
  return { isThread: false, name: "" };
}

export const THREAD_GATHER_SCHEMA = {
  type: "object",
  properties: {
    spans: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "the entry's path, copied from the input" },
          quote: {
            type: "string",
            description:
              "EXACT contiguous verbatim quote copied character-for-character from that entry — the 1-3 sentences that carry the thread; never paraphrase, trim words, or fix anything",
          },
        },
        required: ["path", "quote"],
        additionalProperties: false,
      },
    },
    questions: {
      type: "array",
      items: { type: "string" },
      description: "2-3 reflection questions for the thread page (see voice rules in the prompt)",
    },
  },
  required: ["spans", "questions"],
  additionalProperties: false,
} as const;

export function threadGatherPrompt(
  name: string,
  entries: Array<{ path: string; date: string; text: string }>,
): string {
  return [
    `A writer's journal returns to one thread: "${name}". For each dated entry below, select the passage that carries this thread — an EXACT, contiguous, verbatim quote copied character-for-character from that entry (start and end at sentence boundaries; typically 1-3 sentences). Skip an entry rather than paraphrasing.`,
    ``,
    `Then write 2-3 reflection questions for the thread page. Question voice — all rules are hard rules:`,
    `- Reference concrete specifics the entries actually mention.`,
    `- Ask about change, comparison, or absence between the earliest and latest entries ("The first entry frames X as a deadline — is it still one?").`,
    `- Describe what the writing discusses, never what the writer feels.`,
    `- Never introduce emotion words the writer did not use; echoing the writer's own words is fine.`,
    `- Never presume a feeling, diagnose, or evaluate.`,
    ``,
    ...entries.flatMap((e) => [`=== Entry ${e.date} (path: ${e.path}) ===`, e.text, ``]),
  ].join("\n");
}

export interface ThreadGatherResult {
  spans: Array<{ path: string; quote: string }>;
  questions: string[];
}

export function parseThreadGather(text: string): ThreadGatherResult {
  try {
    const parsed = JSON.parse(text) as Partial<ThreadGatherResult>;
    const spans = Array.isArray(parsed.spans)
      ? parsed.spans.filter(
          (s): s is { path: string; quote: string } =>
            !!s &&
            typeof (s as { path?: unknown }).path === "string" &&
            typeof (s as { quote?: unknown }).quote === "string" &&
            !!(s as { quote: string }).quote.trim(),
        )
      : [];
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.filter((q): q is string => typeof q === "string" && !!q.trim()).slice(0, 3)
      : [];
    return { spans, questions };
  } catch {
    return { spans: [], questions: [] };
  }
}

export const THREAD_MOVEMENT_SCHEMA = {
  type: "object",
  properties: {
    clause: {
      type: "string",
      description: "one clause, at most 90 characters, or empty when nothing factual can be said",
    },
  },
  required: ["clause"],
  additionalProperties: false,
} as const;

export function threadMovementPrompt(name: string, earlier: string[], latest: string): string {
  return [
    `A journal thread ("${name}") continues in a new entry. In ONE clause (max 90 characters), state how the new entry's treatment of the topic differs from the earlier ones — as observable fact about what the writing discusses (subjects, framing, specifics), in plain neutral wording.`,
    `Hard rules: no emotion words beyond ones the writer used; no evaluation, praise, or diagnosis; no advice. If nothing factual distinguishes them, return an empty clause.`,
    ``,
    ...earlier.map((s, i) => `Earlier ${i + 1}: ${s}`),
    ``,
    `New entry excerpt: ${latest}`,
  ].join("\n");
}

export function parseThreadMovement(text: string): string {
  try {
    const parsed = JSON.parse(text) as { clause?: unknown };
    if (typeof parsed.clause === "string") {
      const clause = parsed.clause.trim().replace(/\.$/, "");
      return clause.length <= 90 ? clause : "";
    }
  } catch {
    /* fall through */
  }
  return "";
}

/**
 * Title for an extracted selection. Differs from titlePrompt in that the
 * caller has real context — the source note and the prose around the
 * selection — which is exactly what distinguishes "what this passage is
 * about" from "what these words say". Routed as a quality task: a title is
 * the note's permanent name.
 */
export function extractTitlePrompt(input: {
  selection: string;
  sourceTitle: string;
  /** Prose immediately before/after the selection in the source (may be ""). */
  before: string;
  after: string;
}): string {
  return [
    `A writer is extracting the SELECTED passage below out of a note into its own Zettelkasten note. Propose the new note's title: the passage's one idea, named specifically, in the writer's own words where possible ("Spaced repetition trades transfer for retention", not "Notes on learning"). The surrounding context tells you what the passage is about when the passage alone is ambiguous — but title the passage, not the source note.`,
    ``,
    `Source note: "${input.sourceTitle}"`,
    ...(input.before.trim() ? [``, `Context before:`, input.before] : []),
    ``,
    `SELECTED passage:`,
    input.selection,
    ...(input.after.trim() ? [``, `Context after:`, input.after] : []),
  ].join("\n");
}
