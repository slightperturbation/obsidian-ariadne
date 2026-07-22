import type { ActionProposal } from "./framework";

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

/** Strip a leading YAML frontmatter block (the merged note keeps only one). */
function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER, "").trim();
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
 * Merge a near-duplicate into the kept note by appending the other's body
 * under a "Merged from [[…]]" heading, then removing the other note (to trash
 * via the executor). Deliberately content-preserving — it unions rather than
 * rewrites, so nothing is lost and the diff preview shows exactly what moved.
 * A cleaner model-authored union can come later; safety first.
 */
export function buildMergeProposal(input: MergeInput): ActionProposal {
  const otherBody = stripFrontmatter(input.otherContent);
  const merged =
    `${input.keepContent.trimEnd()}\n\n## Merged from [[${input.otherTitle}]]\n\n${otherBody}\n`;

  return {
    title: `Merge "${input.otherTitle}" into "${input.keepTitle}"`,
    description: "appends the duplicate's content, then trashes it",
    changes: [
      { type: "modify", path: input.keepPath, before: input.keepContent, after: merged },
      { type: "delete", path: input.otherPath, before: input.otherContent },
    ],
  };
}
