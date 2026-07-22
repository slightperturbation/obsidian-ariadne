import type { Chunk } from "../core/types";

export interface ChunkOptions {
  /** Soft upper bound on chunk length in characters. */
  maxChars: number;
  /** Trailing fragments shorter than this are merged into the previous chunk. */
  minChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChars: 1000, minChars: 120 };

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;

interface Section {
  heading?: string;
  text: string;
}

/** Strip a leading YAML frontmatter block, if present. */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(FRONTMATTER, "");
}

/** Group a note's lines into sections keyed by their nearest preceding heading. */
function toSections(markdown: string): Section[] {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const sections: Section[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text.length > 0) sections.push({ heading, text });
    buffer = [];
  };

  for (const line of lines) {
    const m = ATX_HEADING.exec(line);
    if (m) {
      flush();
      heading = m[2].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/** Split a paragraph that exceeds maxChars into length-bounded pieces at word boundaries. */
function hardSplit(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf(" ", maxChars);
    if (cut <= 0) cut = maxChars;
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) pieces.push(remaining);
  return pieces;
}

/** Greedily pack a section's paragraphs into chunk-sized text blocks. */
function packSection(text: string, opts: ChunkOptions): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const blocks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (para.length > opts.maxChars) {
      if (current) {
        blocks.push(current);
        current = "";
      }
      blocks.push(...hardSplit(para, opts.maxChars));
      continue;
    }
    if (current.length === 0) {
      current = para;
    } else if (current.length + para.length + 2 <= opts.maxChars) {
      current += "\n\n" + para;
    } else {
      blocks.push(current);
      current = para;
    }
  }
  if (current) blocks.push(current);

  // Merge a too-small trailing block into its predecessor.
  if (
    blocks.length >= 2 &&
    blocks[blocks.length - 1].length < opts.minChars &&
    blocks[blocks.length - 2].length + blocks[blocks.length - 1].length + 2 <= opts.maxChars * 1.5
  ) {
    const last = blocks.pop() as string;
    blocks[blocks.length - 1] += "\n\n" + last;
  }
  return blocks;
}

/**
 * Split markdown into atomic, order-preserving chunks with heading context.
 * Pure: no Obsidian dependency, so it is fully unit-testable.
 */
export function chunkNote(
  path: string,
  markdown: string,
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Chunk[] {
  const chunks: Chunk[] = [];
  let ordinal = 0;
  for (const section of toSections(markdown)) {
    for (const text of packSection(section.text, opts)) {
      chunks.push({
        id: `${path}#${ordinal}`,
        path,
        ordinal,
        heading: section.heading,
        text,
      });
      ordinal += 1;
    }
  }
  return chunks;
}
