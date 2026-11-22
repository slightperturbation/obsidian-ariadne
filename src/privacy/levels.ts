/**
 * Privacy levels, by audience. The line is the edge of the user's own
 * machines: "shareable" may be shown to a model someone else runs;
 * "local" stays on the user's machines (only local models may read it);
 * "sealed" is for the user alone — Ariadne's own features may use it on a
 * local model, and the vault chat is never shown it.
 */
export type PrivacyLevel = "shareable" | "local" | "sealed";

export interface LevelPolicy {
  /** Folders whose notes never reach an external model. */
  localOnlyFolders: readonly string[];
  /** Folders for the user alone (the journal). */
  sealedFolders: readonly string[];
}

const RANK: Record<PrivacyLevel, number> = { shareable: 0, local: 1, sealed: 2 };

function norm(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "");
}

export function underFolder(path: string, folder: string): boolean {
  const f = norm(folder);
  return f !== "" && (path === f || path.startsWith(`${f}/`));
}

/** The stricter of two levels. */
export function stricter(a: PrivacyLevel, b: PrivacyLevel): PrivacyLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

export function parseLevel(value: unknown): PrivacyLevel | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "shareable") return "shareable";
  if (v === "local" || v === "local-only") return "local";
  if (v === "sealed") return "sealed";
  return undefined;
}

/**
 * A note's level: its folder decides, and an `agent-access:` property may
 * override — freely toward stricter, and toward "shareable" only out of a
 * local-only folder the user lists (their call to make). A sealed folder
 * never loosens.
 */
export function levelOf(path: string, policy: LevelPolicy, override?: unknown): PrivacyLevel {
  const sealed = policy.sealedFolders.some((f) => underFolder(path, f));
  if (sealed) return "sealed";
  const folderLevel: PrivacyLevel = policy.localOnlyFolders.some((f) => underFolder(path, f)) ? "local" : "shareable";
  return parseLevel(override) ?? folderLevel;
}

/** May content at this level be put in a prompt for an external model? */
export function cloudAllowed(level: PrivacyLevel): boolean {
  return level === "shareable";
}

/** The level of something derived from several sources: the strictest. */
export function combinedLevel(levels: Iterable<PrivacyLevel>): PrivacyLevel {
  let out: PrivacyLevel = "shareable";
  for (const l of levels) out = stricter(out, l);
  return out;
}
