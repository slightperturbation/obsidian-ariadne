import type { ActionProposal, FileChange } from "./framework";

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;

const ATTACHMENT_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic",
  "pdf",
  "mp4", "mov", "webm", "mkv", "m4v",
  "mp3", "wav", "m4a", "ogg", "flac", "aac",
]);

export function isAttachmentExt(ext: string): boolean {
  return ATTACHMENT_EXTS.has(ext.toLowerCase());
}

export interface AttachmentFile {
  path: string;
  name: string;
  extension: string;
  /** Parent folder path; Obsidian's vault root is "/". */
  parentPath: string;
}

export interface AttachmentMove {
  fromPath: string;
  toPath: string;
  name: string;
}

/**
 * Plan the moves for a root-attachments sweep: every attachment file sitting in
 * the vault root goes into `folder`, with collision-safe target names (both
 * against the vault, via `isTaken`, and against other moves in this batch).
 * Pure so the naming/dedup logic is unit-tested; the controller performs the
 * actual moves through Obsidian's fileManager (which rewrites embeds).
 */
export function planAttachmentSweep(
  files: AttachmentFile[],
  folder: string,
  isTaken: (path: string) => boolean,
): AttachmentMove[] {
  const claimed = new Set<string>();
  const free = (p: string) => !isTaken(p) && !claimed.has(p);
  const moves: AttachmentMove[] = [];

  for (const f of files) {
    if (!isAttachmentExt(f.extension)) continue;
    // Root-dumped only (vault root is "/", or "" defensively).
    if (f.parentPath !== "/" && f.parentPath !== "") continue;

    const dot = f.name.lastIndexOf(".");
    const base = dot === -1 ? f.name : f.name.slice(0, dot);
    const ext = dot === -1 ? "" : f.name.slice(dot);
    let target = `${folder}/${f.name}`;
    for (let i = 2; !free(target); i++) target = `${folder}/${base} ${i}${ext}`;

    claimed.add(target);
    moves.push({ fromPath: f.path, toPath: target, name: f.name });
  }
  return moves;
}

/** A note whose body (excluding frontmatter) is empty or whitespace-only. */
export function isEmptyNote(content: string): boolean {
  return content.replace(FRONTMATTER, "").trim().length === 0;
}

/** A delete-only proposal (goes through the executor → trash + one-step undo). */
export function buildDeleteProposal(
  title: string,
  files: Array<{ path: string; content: string }>,
): ActionProposal {
  return {
    title,
    description: `${files.length} note${files.length === 1 ? "" : "s"} → trash`,
    changes: files.map((f): FileChange => ({ type: "delete", path: f.path, before: f.content })),
  };
}
