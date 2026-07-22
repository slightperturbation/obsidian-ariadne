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
