import type { Chunk } from "../core/types";

export interface ChunkOptions {
  /** Soft upper bound on chunk length in characters. */
  maxChars: number;
  /** Trailing fragments shorter than this are merged into the previous chunk. */
  minChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChars: 1000, minChars: 120 };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const ATX_HEADING = /^(#{1,6})\s+(.*)$/;
/** A YAML-ish `key:` line — what distinguishes frontmatter from a `---` rule. */
const YAML_KEY = /^[A-Za-z0-9_-]+\s*:/m;

interface Section {
  heading?: string;
  text: string;
}

/**
 * Strip a leading YAML frontmatter block, if present.
 *
 * The block must actually contain a `key:` line — otherwise a note that opens
 * with a thematic break around a pull quote looks identical to frontmatter,
 * and the quote gets silently deleted from the index.
 */
export function stripFrontmatter(markdown: string): string {
  const m = FRONTMATTER.exec(markdown);
  if (!m || !YAML_KEY.test(m[1])) return markdown;
  return markdown.slice(m[0].length);
}

const FENCE = /^\s*(```|~~~)/;

/**
 * Group a note's lines into sections keyed by their nearest preceding heading.
 *
 * Fenced code blocks are tracked so a shell/Python comment (`# install deps`)
 * isn't mistaken for a heading — which used to shred code blocks apart, drop
 * the comment lines from the indexed text entirely, and boost the fragments in
 * BM25 as if they were real headings.
 */
function toSections(markdown: string): Section[] {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const sections: Section[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text.length > 0) sections.push({ heading, text });
    buffer = [];
  };

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      // Opening or closing a fence; either way the line is content.
      if (fence && line.trim().startsWith(fence)) fence = null;
      else if (!fence) fence = fenceMatch[1];
      buffer.push(line);
      continue;
    }

    const m = fence ? null : ATX_HEADING.exec(line);
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
  const sections = toSections(markdown);
  for (const section of sections) {
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

  // A note whose body is only headings (a fresh stub, a heading-only MoC)
  // otherwise yields no chunks at all — and since titles are indexed as a
  // field OF a chunk, that made such notes unfindable by their own name.
  // Emit one chunk carrying the title and any headings.
  if (chunks.length === 0) {
    const title = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
    const headings = headingsOf(markdown);
    const text = [title, ...headings].filter(Boolean).join("\n").trim();
    if (text) {
      chunks.push({ id: `${path}#0`, path, ordinal: 0, heading: headings[0], text });
    }
  }
  return chunks;
}

/** Heading texts in document order (used for the title-only fallback chunk). */
function headingsOf(markdown: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of stripFrontmatter(markdown).split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence && line.trim().startsWith(fence)) fence = null;
      else if (!fence) fence = fenceMatch[1];
      continue;
    }
    if (fence) continue;
    const m = ATX_HEADING.exec(line);
    if (m) out.push(m[2].trim());
  }
  return out;
}
