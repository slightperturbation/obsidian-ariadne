/**
 * Privacy levels, by audience. The line is the edge of the user's own
 * machines: "shareable" may be shown to a model someone else runs;
 * "local" stays on the user's machines (local models and local agent
 * clients may read it); "sealed" is for the user alone — Ariadne's own
 * features may use it on a local model, no agent client ever sees it.
 */
export type PrivacyLevel = "shareable" | "local" | "sealed";

export interface LevelPolicy {
  /** Folders whose notes never reach an external model. */
  localOnlyFolders: readonly string[];
  /** Folders no agent client may read at all (the journal). */
  sealedFolders: readonly string[];
  /** Where agent-written records live. Always local-only. */
  agentFolder: string;
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
 * local-only folder the user lists (their call to make). Two things never
 * loosen: a sealed folder, and the agent's own tree — text that arrived
 * from a mailbox must not be re-labelled by a property that same text
 * could have carried.
 */
export function levelOf(path: string, policy: LevelPolicy, override?: unknown): PrivacyLevel {
  const sealed = policy.sealedFolders.some((f) => underFolder(path, f));
  if (sealed) return "sealed";
  const agent = underFolder(path, policy.agentFolder);
  const folderLevel: PrivacyLevel =
    agent || policy.localOnlyFolders.some((f) => underFolder(path, f)) ? "local" : "shareable";
  const wanted = parseLevel(override);
  if (!wanted) return folderLevel;
  if (agent) return stricter(folderLevel, wanted);
  return wanted;
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
