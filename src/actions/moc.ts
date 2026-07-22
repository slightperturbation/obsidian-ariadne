import type { ActionProposal } from "./framework";

export interface MocItem {
  /** Existing note title (its basename) — linked as [[title]]. */
  title: string;
  description: string;
}

export interface MocSection {
  theme: string;
  items: MocItem[];
}

export interface MocInput {
  title: string;
  path: string;
  sections: MocSection[];
  isoDate: string;
}

/**
 * Build a Map-of-Content note: a themed, annotated index over existing notes.
 * Pure creation (no edits to the member notes — Obsidian surfaces the MoC as a
 * backlink on each automatically), so it's non-destructive and the controller
 * creates it directly rather than through the preview gate.
 */
export function buildMocProposal(input: MocInput): ActionProposal {
  const lines = ["---", "type: moc", `created: ${input.isoDate}`, "---", "", `# ${input.title}`, ""];
  for (const section of input.sections) {
    if (section.items.length === 0) continue;
    if (section.theme) lines.push(`## ${section.theme}`, "");
    for (const item of section.items) {
      lines.push(`- [[${item.title}]]${item.description ? ` — ${item.description}` : ""}`);
    }
    lines.push("");
  }
  return {
    title: `Create Map of Content "${input.title}"`,
    changes: [{ type: "create", path: input.path, after: lines.join("\n") }],
  };
}
