/**
 * Recurring journal themes — the generalization of the echo card, and the
 * bridge from journaling to a Zettelkasten.
 *
 * The signal: several *dated* entries sit close together in embedding space
 * (the writer keeps having this thought) while no *permanent* note sits near
 * the cluster (they never kept it). Per Ahrens, that is precisely the moment
 * a fleeting idea has earned a permanent note — it has demonstrated, by
 * recurring, that it matters.
 *
 * Pure graph logic over retrieval results the caller supplies: dated entries
 * are vertices, a strong stored-vector similarity between two of them is an
 * edge, and connected components of size ≥ MIN_ENTRIES whose members have no
 * sufficiently-close permanent neighbor are themes. Everything tunable is a
 * named constant; nothing here talks to Obsidian or a model.
 */

export interface NeighborHit {
  path: string;
  title: string;
  snippet: string;
  cosine?: number;
  /** Is this hit itself a dated entry? */
  periodic: boolean;
}

export interface EntryNeighbors {
  /** A dated entry's path. */
  path: string;
  /** Its top related notes, from stored vectors. */
  hits: NeighborHit[];
}

export interface ThemeCluster {
  /** The dated entries circling the theme (input order preserved). */
  entries: string[];
  /** Representative snippets, strongest first — the theme's evidence. */
  evidence: string[];
  /** The closest any permanent note comes to this cluster. */
  bestPermanentCosine: number;
}

/** Dated↔dated similarity that counts as "the same thought again". */
export const THEME_COSINE = 0.78;
/** A permanent note this close means the theme already has a home. */
export const COVERED_COSINE = 0.75;
/** Fewer recurrences than this is a coincidence, not a theme. */
export const MIN_ENTRIES = 3;
const MAX_EVIDENCE = 4;

export function clusterThemes(entries: EntryNeighbors[]): ThemeCluster[] {
  const index = new Map(entries.map((e, i) => [e.path, i] as const));
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // Evidence and coverage are gathered per entry, then aggregated per component.
  const evidenceOf = new Map<number, Array<{ snippet: string; cosine: number }>>();
  const permanentOf = entries.map(() => 0);

  entries.forEach((entry, i) => {
    for (const hit of entry.hits) {
      if (hit.cosine === undefined) continue;
      if (hit.periodic) {
        const j = index.get(hit.path);
        if (j !== undefined && hit.cosine >= THEME_COSINE) {
          union(i, j);
          const list = evidenceOf.get(i) ?? [];
          list.push({ snippet: hit.snippet, cosine: hit.cosine });
          evidenceOf.set(i, list);
        }
      } else if (hit.cosine > permanentOf[i]) {
        permanentOf[i] = hit.cosine;
      }
    }
  });

  const components = new Map<number, number[]>();
  entries.forEach((_, i) => {
    const root = find(i);
    const members = components.get(root) ?? [];
    members.push(i);
    components.set(root, members);
  });

  const themes: ThemeCluster[] = [];
  for (const members of components.values()) {
    if (members.length < MIN_ENTRIES) continue;
    // Covered if ANY member already sits near a permanent note: the note
    // exists — the right move there is linking, not another creation.
    const bestPermanent = Math.max(...members.map((i) => permanentOf[i]));
    if (bestPermanent >= COVERED_COSINE) continue;

    const evidence = members
      .flatMap((i) => evidenceOf.get(i) ?? [])
      .sort((a, b) => b.cosine - a.cosine);
    const unique: string[] = [];
    for (const e of evidence) {
      if (!unique.includes(e.snippet)) unique.push(e.snippet);
      if (unique.length >= MAX_EVIDENCE) break;
    }
    themes.push({
      entries: members.map((i) => entries[i].path),
      evidence: unique,
      bestPermanentCosine: bestPermanent,
    });
  }
  // Most-recurrent first: the theme the writer circles most is the one to name.
  return themes.sort((a, b) => b.entries.length - a.entries.length);
}
