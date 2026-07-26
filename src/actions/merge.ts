import type { ActionProposal, FileChange } from "./framework";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Split a note into its raw frontmatter body (if any) and the rest. */
function splitFrontmatter(content: string): { fm: string; body: string } {
  const m = FRONTMATTER.exec(content);
  return m ? { fm: m[1], body: content.slice(m[0].length).trim() } : { fm: "", body: content.trim() };
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

/** Strip a leading `# Title` heading (structure, not content, when merging). */
function stripTitle(body: string): string {
  return body.replace(/^#\s+[^\n]*\n?/, "").trim();
}

/**
 * Union two frontmatter blocks: the kept note's values win on conflict, and
 * list-valued keys (tags, aliases) merge. Deliberately conservative — a
 * duplicate's `aliases` are exactly the sort of thing that silently
 * disappeared when merge just dropped its frontmatter.
 */
export function mergeFrontmatter(keep: string, other: string): string {
  if (!other.trim()) return keep;

  const parse = (raw: string): Array<[string, string]> =>
    raw
      .split("\n")
      .map((line) => /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => [m[1], m[2].trim()]);

  const asList = (value: string): string[] | null => {
    const inline = /^\[(.*)\]$/.exec(value);
    if (inline) {
      return inline[1]
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    return null;
  };

  const keptEntries = parse(keep);
  const keptKeys = new Map(keptEntries.map(([k, v]) => [k.toLowerCase(), v]));
  const lines = keep.split("\n");

  for (const [key, value] of parse(other)) {
    const existing = keptKeys.get(key.toLowerCase());
    if (existing === undefined) {
      lines.push(`${key}: ${value}`);
      continue;
    }
    // Merge list values; otherwise the kept note's value stands.
    const a = asList(existing);
    const b = asList(value);
    if (a && b) {
      const merged = [...new Set([...a, ...b])];
      const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*:`).test(l));
      if (idx >= 0) lines[idx] = `${key}: [${merged.join(", ")}]`;
    }
  }
  return lines.filter((l) => l.trim().length > 0).join("\n");
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
  /**
   * Notes linking to the duplicate: `{path, content}`. Their `[[links]]` are
   * repointed at the kept note, because deleting a file does NOT rewrite links
   * to it (Obsidian only auto-updates on rename) — so without this the merge
   * silently breaks every reference.
   */
  inbound?: Array<{ path: string; content: string }>;
  /** Link text that resolves to the kept note (usually its basename). */
  keepLinktext?: string;
}

/** Repoint `[[Other]]`, `[[Other|alias]]`, `[[Other#heading]]` at the kept note. */
export function repointLinks(content: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`\\[\\[${escaped}((?:[|#^][^\\]]*)?)\\]\\]`, "g"),
    (_full, suffix: string) => `[[${to}${suffix}]]`,
  );
}

/**
 * Merge a near-duplicate into the kept note: append only the paragraphs the
 * kept note doesn't already have (identical shared content is never
 * duplicated), union the frontmatter, repoint inbound links, and remove the
 * duplicate (to trash via the executor).
 *
 * Content-preserving: it unions the two notes' distinct blocks rather than
 * rewriting either. If the duplicate is fully contained already, the body is
 * untouched and the merge is just a trash of the redundant copy.
 */
export function buildMergeProposal(input: MergeInput): ActionProposal {
  const keep = splitFrontmatter(input.keepContent);
  const other = splitFrontmatter(input.otherContent);

  const keepKeys = new Set(blocks(keep.body).map(norm));
  const uniqueBlocks: string[] = [];
  const seen = new Set(keepKeys);
  for (const block of blocks(stripTitle(other.body))) {
    const key = norm(block);
    if (seen.has(key)) continue; // already in keep, or an intra-other repeat
    seen.add(key);
    uniqueBlocks.push(block);
  }

  const mergedFm = mergeFrontmatter(keep.fm, other.fm);
  const fmChanged = mergedFm.trim() !== keep.fm.trim();

  const changes: FileChange[] = [];
  if (uniqueBlocks.length > 0 || fmChanged) {
    const body =
      uniqueBlocks.length > 0
        ? `${keep.body}\n\n## Merged from [[${input.otherTitle}]]\n\n${uniqueBlocks.join("\n\n")}`
        : keep.body;
    const after = mergedFm.trim() ? `---\n${mergedFm}\n---\n\n${body}\n` : `${body}\n`;
    changes.push({ type: "modify", path: input.keepPath, before: input.keepContent, after });
  }

  // Repoint links before the delete, so no revision of the vault has dangling
  // references to the removed note.
  const linkTo = input.keepLinktext ?? input.keepTitle;
  for (const source of input.inbound ?? []) {
    if (source.path === input.keepPath || source.path === input.otherPath) continue;
    const after = repointLinks(source.content, input.otherTitle, linkTo);
    if (after !== source.content) {
      changes.push({ type: "modify", path: source.path, before: source.content, after });
    }
  }

  changes.push({ type: "delete", path: input.otherPath, before: input.otherContent });

  const inboundCount = changes.filter(
    (c) => c.type === "modify" && c.path !== input.keepPath,
  ).length;
  const parts = [
    uniqueBlocks.length > 0
      ? `appends ${uniqueBlocks.length} unique block(s)`
      : "the duplicate is already fully contained",
  ];
  if (inboundCount > 0) parts.push(`repoints ${inboundCount} inbound link(s)`);
  parts.push("then trashes it");

  return {
    title: `Merge "${input.otherTitle}" into "${input.keepTitle}"`,
    description: parts.join(", "),
    changes,
  };
}
