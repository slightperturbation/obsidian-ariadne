import type { ActionProposal, FileChange } from "./framework";

/** A top-level section of a note (heading + its body, or the pre-heading intro). */
export interface Segment {
  index: number;
  heading: string;
  text: string;
}

export interface SegmentedNote {
  /** Frontmatter + any content before the first split-heading — stays in the parent. */
  intro: string;
  segments: Segment[];
}

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

function headingLevel(line: string): number {
  const m = /^(#{1,6})\s/.exec(line);
  return m ? m[1].length : 0;
}

/**
 * Segment a note at its shallowest heading level (so a note titled with `#`
 * and sectioned with `##` splits on the `##`s, and a flat `##` note splits on
 * those). Text before the first such heading — frontmatter, a title line, an
 * intro paragraph — is the `intro` and always stays with the parent. A note
 * with no headings yields a single segment (nothing to split).
 */
export function segmentNote(content: string): SegmentedNote {
  const lines = content.split("\n");

  // Split at the shallowest heading level that appears more than once — a lone
  // top-level `#` title above `##` sections is a title, not a section boundary,
  // so it's skipped and we split on the `##`s.
  const counts = new Map<number, number>();
  for (const l of lines) {
    const lv = headingLevel(l);
    if (lv) counts.set(lv, (counts.get(lv) ?? 0) + 1);
  }
  let splitLevel = 0;
  for (let lv = 1; lv <= 6; lv++) {
    if ((counts.get(lv) ?? 0) >= 2) {
      splitLevel = lv;
      break;
    }
  }

  if (splitLevel === 0) {
    // No repeated heading — nothing to split on; the whole body is one segment.
    const fm = FRONTMATTER.exec(content)?.[0] ?? "";
    const body = content.slice(fm.length).trimEnd();
    return {
      intro: fm.trimEnd(),
      segments: body.trim() ? [{ index: 0, heading: "", text: body }] : [],
    };
  }

  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (headingLevel(l) === splitLevel) starts.push(i);
  });

  const intro = lines.slice(0, starts[0]).join("\n").trimEnd();
  const segments: Segment[] = [];
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1] : lines.length;
    segments.push({
      index: s,
      heading: lines[start].replace(/^#{1,6}\s+/, "").trim(),
      text: lines.slice(start, end).join("\n").trimEnd(),
    });
  }
  return { intro, segments };
}

/** A grouping the model (or fallback) produced: one atomic child note. */
export interface SplitGroup {
  title: string;
  description: string;
  segmentIndices: number[];
}

/** As above, with the vault path resolved by the controller (unique, in-folder). */
export interface SplitChild extends SplitGroup {
  path: string;
}

export interface SplitInput {
  originalPath: string;
  originalContent: string;
  /** The original note's basename — children link back to it, it becomes the MoC. */
  parentTitle: string;
  children: SplitChild[];
  isoDate: string;
}

const basename = (path: string): string =>
  (path.split("/").pop() ?? path).replace(/\.md$/i, "");

/**
 * Build the split as one atomic multi-file change: the original note becomes a
 * Map-of-Content stub (its intro + a Contents list of `[[child]]` links), and
 * each group's segments move into a new child note that links back to the
 * parent. Content-preserving by construction: every segment is assigned to
 * exactly one child, and any segment no child claimed stays in the parent — so
 * a split never drops text, which the executor's diff preview then confirms.
 */
export function buildSplitProposal(input: SplitInput): ActionProposal {
  const { intro, segments } = segmentNote(input.originalContent);
  const byIndex = new Map(segments.map((s) => [s.index, s]));
  const assigned = new Set<number>();
  const changes: FileChange[] = [];
  const contents: string[] = [];

  for (const child of input.children) {
    const texts: string[] = [];
    for (const idx of child.segmentIndices) {
      const seg = byIndex.get(idx);
      if (seg && !assigned.has(idx)) {
        assigned.add(idx);
        texts.push(seg.text);
      }
    }
    if (texts.length === 0) continue;
    const body = [
      "---",
      "type: note",
      `created: ${input.isoDate}`,
      "---",
      "",
      `Part of [[${input.parentTitle}]].`,
      "",
      texts.join("\n\n"),
      "",
    ].join("\n");
    changes.push({ type: "create", path: child.path, after: body });
    const link = basename(child.path);
    contents.push(`- [[${link}]]${child.description ? ` — ${child.description}` : ""}`);
  }

  // Any unclaimed segments remain in the parent — never silently lost.
  const leftover = segments.filter((s) => !assigned.has(s.index)).map((s) => s.text);

  const parentParts: string[] = [];
  if (intro.trim()) parentParts.push(intro.trimEnd());
  if (leftover.length) parentParts.push(leftover.join("\n\n"));
  parentParts.push(["## Contents", "", ...contents, ""].join("\n"));
  const parentAfter = parentParts.join("\n\n").replace(/^\n+/, "");

  changes.unshift({
    type: "modify",
    path: input.originalPath,
    before: input.originalContent,
    after: parentAfter,
  });

  return {
    title: `Split "${input.parentTitle}" into ${contents.length} notes`,
    description: `${contents.length} atomic notes + a Map of Content`,
    changes,
  };
}

/** No-model heuristic: one child per top-level section, titled by its heading. */
export function fallbackSplitGroups(seg: SegmentedNote): SplitGroup[] {
  return seg.segments
    .filter((s) => s.heading)
    .map((s) => ({ title: s.heading, description: "", segmentIndices: [s.index] }));
}

/* ── Pass 1: in-place structuring of an unstructured note ─────────────── */

export interface Paragraph {
  index: number;
  text: string;
}

export interface ParagraphedNote {
  /** Frontmatter + a leading `# Title`, kept out of clustering. */
  intro: string;
  paragraphs: Paragraph[];
}

/**
 * Break a note's body into blank-line-delimited paragraph blocks, numbered for
 * the model to reference. Frontmatter and a leading H1 title are pulled into
 * `intro` so they're never clustered into a proposed section.
 */
export function paragraphize(content: string): ParagraphedNote {
  const fm = FRONTMATTER.exec(content)?.[0] ?? "";
  let rest = content.slice(fm.length);
  let intro = fm.trimEnd();
  const title = /^\s*(#\s+[^\n]+)\n?/.exec(rest);
  if (title) {
    intro = (intro ? `${intro}\n\n` : "") + title[1].trim();
    rest = rest.slice(title[0].length);
  }
  const blocks = rest
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  return { intro, paragraphs: blocks.map((text, index) => ({ index, text })) };
}

/** One proposed atomic note, as a grouping of the note's own paragraphs. */
export interface StructureCluster {
  title: string;
  description: string;
  paragraphIndices: number[];
}

export interface StructureInput {
  path: string;
  content: string;
  parentTitle: string;
  clusters: StructureCluster[];
}

const PROPOSAL_CALLOUT =
  '> [!note] Proposed split — edit these sections (rename, move text between them, delete any you don\'t want), then run "Split this note into atomic notes" again to extract each `##` section as its own note.';

/**
 * Pass 1 result: the same note rewritten in place with a `##` section per
 * proposed atomic note, holding that cluster's paragraphs. Content-preserving
 * by construction — every paragraph is assigned to one section or kept as
 * parent/framing text — so structuring never loses text, and the user edits
 * the proposal before a second run extracts it into files.
 */
export function buildStructureProposal(input: StructureInput): ActionProposal {
  const { intro, paragraphs } = paragraphize(input.content);
  const byIndex = new Map(paragraphs.map((p) => [p.index, p]));
  const assigned = new Set<number>();
  const sections: string[] = [];

  for (const cluster of input.clusters) {
    const texts: string[] = [];
    for (const idx of [...cluster.paragraphIndices].sort((a, b) => a - b)) {
      const p = byIndex.get(idx);
      if (p && !assigned.has(idx)) {
        assigned.add(idx);
        texts.push(p.text);
      }
    }
    if (texts.length === 0) continue;
    const parts = [`## ${cluster.title}`];
    if (cluster.description) parts.push(`*${cluster.description}*`);
    parts.push(texts.join("\n\n"));
    sections.push(parts.join("\n\n"));
  }

  // Paragraphs no cluster claimed stay in the note as framing/connective text.
  const leftover = paragraphs.filter((p) => !assigned.has(p.index)).map((p) => p.text);

  const parts: string[] = [];
  if (intro.trim()) parts.push(intro.trimEnd());
  parts.push(PROPOSAL_CALLOUT);
  if (leftover.length) parts.push(leftover.join("\n\n"));
  parts.push(...sections);
  const after = `${parts.join("\n\n").replace(/^\n+/, "")}\n`;

  return {
    title: `Structure "${input.parentTitle}" into ${sections.length} proposed sections`,
    description: "adds editable sections in place — run Split again to extract them",
    changes: [{ type: "modify", path: input.path, before: input.content, after }],
  };
}

/** Remove the stale "Proposed split" callout once the note is actually extracted. */
export function stripProposedSplitCallout(content: string): string {
  return content
    .replace(/^> \[!note\] Proposed split[^\n]*\n?/m, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
}
