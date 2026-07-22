import type { ActionProposal } from "./framework";

export interface WeaveInput {
  /** The note being written (link inserted at the cursor). */
  sourcePath: string;
  sourceContent: string;
  cursor: { line: number; ch: number };
  /** Link text pointing at the target (shortest unambiguous form). */
  targetLinktext: string;
  /** The surfaced neighbor (gets the backlink). */
  targetPath: string;
  targetContent: string;
  targetTitle: string;
  /** Link text pointing back at the source. */
  sourceLinktext: string;
  sourceTitle: string;
  /** Optional connective fragment from the reasoning model. */
  phrase?: string;
}

const RELATED_HEADING = /^##\s+Related\s*$/m;

/** Insert text at a line/ch position (clamped) in a document string. */
export function insertAt(content: string, cursor: { line: number; ch: number }, text: string): string {
  const lines = content.split("\n");
  const line = Math.max(0, Math.min(cursor.line, lines.length - 1));
  const lineText = lines[line] ?? "";
  const ch = Math.max(0, Math.min(cursor.ch, lineText.length));
  // Spacing: keep a word boundary on both sides of the inserted link.
  const before = lineText.slice(0, ch);
  const after = lineText.slice(ch);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^[\s.,;:!?]/.test(after) ? " " : "";
  lines[line] = before + lead + text + trail + after;
  return lines.join("\n");
}

/** Append a backlink bullet under "## Related", creating the section at the end if absent. */
export function appendBacklink(content: string, bullet: string): string {
  const match = RELATED_HEADING.exec(content);
  if (match && match.index !== undefined) {
    // Insert at the end of the Related section: scan forward to the next
    // heading (or EOF) and place the bullet before it.
    const sectionStart = match.index + match[0].length;
    const rest = content.slice(sectionStart);
    const nextHeading = rest.search(/^#{1,6}\s/m);
    const insertPos = sectionStart + (nextHeading === -1 ? rest.length : nextHeading);
    const head = content.slice(0, insertPos).replace(/\n*$/, "\n");
    const tail = content.slice(insertPos);
    return head + bullet + "\n" + (tail ? (tail.startsWith("\n") ? tail.slice(1) : tail) + "" : "");
  }
  const trimmed = content.replace(/\n*$/, "");
  return `${trimmed}${trimmed ? "\n\n" : ""}## Related\n\n${bullet}\n`;
}

/**
 * Build the bidirectional weave proposal: [[link]] at the cursor in the note
 * being written, and a backlink bullet (with optional connective phrase)
 * under the target's Related section. Pure — both files' expected contents
 * ride along for the executor's conflict check.
 */
export function buildWeaveProposal(input: WeaveInput): ActionProposal {
  const sourceAfter = insertAt(
    input.sourceContent,
    input.cursor,
    `[[${input.targetLinktext}]]`,
  );
  const bullet = `- [[${input.sourceLinktext}]]${input.phrase ? ` — ${input.phrase}` : ""}`;
  const targetAfter = appendBacklink(input.targetContent, bullet);

  return {
    title: `Weave link: ${input.sourceTitle} ↔ ${input.targetTitle}`,
    description: input.phrase ? `“${input.phrase}”` : undefined,
    changes: [
      {
        type: "modify",
        path: input.sourcePath,
        before: input.sourceContent,
        after: sourceAfter,
      },
      {
        type: "modify",
        path: input.targetPath,
        before: input.targetContent,
        after: targetAfter,
      },
    ],
  };
}
