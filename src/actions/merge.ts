import type { ActionProposal, FileChange } from "./framework";

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

/**
 * Strip the duplicate's frontmatter and leading `# Title` — both are
 * structural (the merged note keeps its own), not content to carry across.
 */
function stripFrontmatterAndTitle(content: string): string {
  return content
    .replace(FRONTMATTER, "")
    .replace(/^\s*#\s+[^\n]+\n?/, "")
    .trim();
}

/** Blank-line-delimited blocks, trimmed and non-empty. */
function blocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/** Whitespace-normalized key for comparing two blocks as "the same content". */
function norm(block: string): string {
  return block.replace(/\s+/g, " ").trim();
}

export interface MergeInput {
  /** The note to keep and merge into (usually the one the writer is on). */
  keepPath: string;
  keepContent: string;
  keepTitle: string;
  /** The near-duplicate to fold in and remove. */
  otherPath: string;
  otherContent: string;
  otherTitle: string;
}

/**
 * Merge a near-duplicate into the kept note, appending only the paragraphs the
 * kept note doesn't already contain — identical shared content is never
 * duplicated — under a "Merged from [[…]]" heading, then removing the other
 * note (to trash via the executor). Content-preserving: it unions the two
 * notes' distinct blocks rather than rewriting either. If the duplicate is
 * fully contained already, the kept note is untouched and the merge is just a
 * trash of the redundant copy.
 */
export function buildMergeProposal(input: MergeInput): ActionProposal {
  const keepKeys = new Set(blocks(input.keepContent).map(norm));
  const uniqueBlocks: string[] = [];
  const seen = new Set(keepKeys);
  for (const block of blocks(stripFrontmatterAndTitle(input.otherContent))) {
    const key = norm(block);
    if (seen.has(key)) continue; // already in keep, or an intra-other repeat
    seen.add(key);
    uniqueBlocks.push(block);
  }

  const changes: FileChange[] = [];
  if (uniqueBlocks.length > 0) {
    const merged =
      `${input.keepContent.trimEnd()}\n\n## Merged from [[${input.otherTitle}]]\n\n` +
      `${uniqueBlocks.join("\n\n")}\n`;
    changes.push({ type: "modify", path: input.keepPath, before: input.keepContent, after: merged });
  }
  changes.push({ type: "delete", path: input.otherPath, before: input.otherContent });

  return {
    title: `Merge "${input.otherTitle}" into "${input.keepTitle}"`,
    description:
      uniqueBlocks.length > 0
        ? `appends ${uniqueBlocks.length} unique block(s), then trashes the duplicate`
        : "the duplicate is already fully contained — just trashes it",
    changes,
  };
}
