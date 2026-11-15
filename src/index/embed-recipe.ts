import { looksPeriodic } from "../core/periodic";

/**
 * The embedding RECIPE — what text is handed to the embedder, as distinct
 * from which model embeds it.
 *
 * Measured on a real vault with `scripts/eval-embeddings.mjs` (the writer's
 * own wikilinks as ground truth): no candidate model robustly beat
 * bge-small, but embedding each chunk together with its note's TITLE lifted
 * link-prediction recall@5 from 49 → 58 (30 → 40 with the link text masked)
 * and title-as-query hit rate from 44% → 85% — for every model tried. A
 * chunk alone often doesn't say what it is about; its note's title does.
 *
 * Dated notes are the exception: "2026-08-22" names no topic, and stamping
 * every journal chunk with a date string would pull journal entries toward
 * each other for no semantic reason — distorting exactly the journal
 * cosines that thread detection and publish screening rely on. They are
 * embedded bare, exactly as before.
 *
 * The recipe is part of a vector's identity: the suffix below is appended
 * to the embedder id that snapshots record, so vectors made under another
 * recipe are re-embedded rather than compared across recipes.
 */
export const RECIPE_SUFFIX = "+title1";

export const recipeId = (embedderId: string): string => `${embedderId}${RECIPE_SUFFIX}`;

/** The title to embed a note's text with — undefined when it carries no topic. */
export function titleContext(path: string, title: string): string | undefined {
  const t = title.trim();
  if (!t || /^untitled( \d+)?$/i.test(t) || looksPeriodic(path)) return undefined;
  return t;
}

export const contextualize = (text: string, title: string | undefined): string =>
  title ? `${title}\n\n${text}` : text;

/* ── Calibration ──────────────────────────────────────────────────────── */

/**
 * Every cosine threshold in Ariadne (relatedness floor, ghost/tension bands,
 * theme and thread clustering, echo, journal affinity) was tuned against
 * bare bge-small vectors. Title context makes different notes' chunks a
 * little less alike — about 0.02 lower at any given rarity — and in the
 * tail a 0.02 shift roughly halves how many pairs clear a threshold.
 *
 * Rather than re-tune a dozen constants (and silently change the meaning of
 * the user's own slider), raw cosines are mapped back onto the scale the
 * thresholds were tuned on, at the single point where they enter the
 * system. Knots are matched quantiles of cross-note chunk-pair cosines
 * (same pairs, both recipes); above the last knot the offset is held
 * constant, because the legacy tail there was dominated by boilerplate
 * duplicates that title context correctly separates.
 *
 * Regenerate: node scripts/eval-embeddings.mjs --vault <vault> \
 *   --models "snapshot,tjs:Xenova/bge-small-en-v1.5+ctx"
 */
type Knots = ReadonlyArray<readonly [raw: number, legacy: number]>;

const CALIBRATIONS: Record<string, Knots> = {
  "transformers:Xenova/bge-small-en-v1.5+title1": [
    [0.458, 0.463],
    [0.513, 0.521],
    [0.571, 0.585],
    [0.605, 0.624],
    [0.633, 0.654],
    [0.666, 0.688],
    [0.692, 0.713],
    [0.741, 0.761],
  ],
};

function interpolate(x: number, knots: Knots, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (x <= first[from]) return x + (first[to] - first[from]);
  if (x >= last[from]) return Math.min(1, Math.max(-1, x + (last[to] - last[from])));
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1];
    const b = knots[i];
    if (x <= b[from]) {
      const t = (x - a[from]) / (b[from] - a[from]);
      return a[to] + t * (b[to] - a[to]);
    }
  }
  return x;
}

export interface Calibration {
  /** Raw cosine under this recipe → the scale thresholds are written in. */
  toThresholdScale(raw: number): number;
  /** A threshold → the raw cosine the vector store should cut at. */
  toRaw(threshold: number): number;
}

const IDENTITY: Calibration = { toThresholdScale: (x) => x, toRaw: (x) => x };

/** Calibration for a snapshot/embedder recipe id; identity when unmeasured. */
export function calibrationFor(recipe: string | undefined): Calibration {
  const knots = recipe ? CALIBRATIONS[recipe] : undefined;
  if (!knots) return IDENTITY;
  return {
    toThresholdScale: (raw) => interpolate(raw, knots, 0),
    toRaw: (threshold) => interpolate(threshold, knots, 1),
  };
}
