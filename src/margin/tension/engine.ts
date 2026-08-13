import type { IndexManager } from "../../index/manager";
import type { ModelRouter } from "../../model/router";
import { BudgetExceededError } from "../../model/router";
import { RELATION_SCHEMA, parseRelation, relationPrompt } from "../../model/tasks";
import type { DraftContext } from "../draft-watcher";
import { isReflectiveProse } from "../journal";
import type { Logger } from "../../util/logger";
import {
  TENSION_CONFIDENCE,
  TENSION_PROFILES,
  echoConfidence,
  keySimilarity,
  selectCandidates,
  type RelationVerdict,
  type TensionFinding,
  type TensionMode,
} from "./detect";

export interface TensionEngineDeps {
  manager: () => IndexManager | undefined;
  router: ModelRouter;
  mode: () => TensionMode;
  /**
   * A real excerpt of a note (frontmatter stripped, bounded). The display
   * snippet is 160 characters — enough to recognize a note, far too little
   * for a model to judge whether it CONTRADICTS a paragraph. A verdict that
   * interrupts writing deserves to have read more than a teaser.
   */
  excerptOf?: (path: string) => Promise<string | null>;
  /** Journal/dated-note detection — log content there has no stance to check. */
  isJournal?: (path: string) => boolean;
  log: Logger;
}

/** Don't classify half-formed thoughts; a sentence fragment has no stance. */
const MIN_PARAGRAPH_CHARS = 80;
/** A cached verdict is reused while the paragraph stays this similar. */
const REUSE_SIMILARITY = 0.6;
/** Bounded caches (Map insertion order ≈ oldest-first eviction). */
const CACHE_MAX = 200;
/**
 * Hard per-session ceiling on ambient classification calls. This exists
 * because tension checks are the one reasoning path NOT initiated by an
 * explicit user gesture — the general cost cap protects the wallet, but the
 * *actions* budget shouldn't be silently drained by marginalia. ~60 Haiku
 * calls is a few cents.
 */
const SESSION_CLASSIFY_MAX = 60;
/** Consecutive API failures before going quiet for the session. */
const FAILURE_MAX = 3;

interface CacheEntry {
  paragraphKey: string;
  verdict: RelationVerdict;
}

/**
 * The ambient half of tension/echo surfacing.
 *
 * Free detection happens on every analyze(): retrieval cosines split
 * neighbors into certain echoes and an ambiguous band (see detect.ts). The
 * paid half — asking a small model whether an ambiguous neighbor contradicts
 * or restates the paragraph — runs in the background, cached per
 * (note, neighbor) and reused across small edits, hard-capped per session,
 * and silenced entirely by budget exhaustion or repeated API failure.
 * analyze() itself never waits on the network: it returns what is known now,
 * and onUpdate fires when a background verdict lands so the caller can
 * re-render.
 */
export class TensionEngine {
  /** `${notePath}::${targetPath}` → latest verdict for that pair. */
  private cache = new Map<string, CacheEntry>();
  /** `${notePath}::${targetPath}` the writer dismissed — session-wide. */
  private dismissed = new Set<string>();
  /** Pairs with a classification currently in flight. */
  private inFlight = new Set<string>();
  private classifyCount = 0;
  private failures = 0;
  private budgetExhausted = false;
  private listeners = new Set<() => void>();

  constructor(private deps: TensionEngineDeps) {}

  /** Notified when a background verdict lands (re-run analyze and re-render). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The writer said no to this pair; honor it for the whole session. */
  dismiss(notePath: string, targetPath: string): void {
    this.dismissed.add(`${notePath}::${targetPath}`);
  }

  async analyze(ctx: DraftContext): Promise<TensionFinding[]> {
    const mode = this.deps.mode();
    if (mode === "off") return [];
    const manager = this.deps.manager();
    // Needs to embed the draft text — a reader device can't, and that's fine:
    // this is a writing-desk feature and readers are reading surfaces.
    if (!manager?.canEmbedText()) return [];
    const paragraph = ctx.text.trim();
    if (paragraph.length < MIN_PARAGRAPH_CHARS) return [];
    // In a dated note, length alone isn't enough: a meeting-notes bullet
    // block clears any character bar yet holds no stance to contradict or
    // restate. Only reflective prose gets examined there; in permanent
    // notes, structured writing IS the thinking and stays eligible.
    if (this.deps.isJournal?.(ctx.path) && !isReflectiveProse(paragraph)) return [];

    const profile = TENSION_PROFILES[mode];
    const results = await manager.related(paragraph, {
      excludePath: ctx.path,
      limit: 12,
    });
    const linkedTitles = new Set(
      [...ctx.noteText.matchAll(/\[\[([^\]|#^]+)/g)].map((m) => m[1].trim()),
    );
    const { echoes, candidates } = selectCandidates({ results, linkedTitles, profile });
    // Visible with the Debug logging setting: the raw numbers behind why a
    // card did or didn't appear, for tuning the floors against a real vault.
    this.deps.log.debug(
      `tension: top cosines ${results
        .slice(0, 5)
        .map((r) => `${r.title}=${r.cosine?.toFixed(3) ?? "lex"}`)
        .join(", ")} (echo≥${profile.echoFloor}, band≥${profile.candidateFloor}, ` +
        `echoes=${echoes.length}, candidates=${candidates.length})`,
    );

    const findings: TensionFinding[] = [];

    for (const echo of echoes) {
      if (this.dismissed.has(`${ctx.path}::${echo.path}`)) continue;
      findings.push({
        kind: "echo",
        path: echo.path,
        title: echo.title,
        snippet: echo.snippet,
        cosine: echo.cosine!,
        confidence: echoConfidence(echo.cosine!, profile.echoFloor),
      });
    }

    for (const candidate of candidates.slice(0, profile.maxClassify)) {
      const pairKey = `${ctx.path}::${candidate.path}`;
      if (this.dismissed.has(pairKey)) continue;

      const cached = this.cache.get(pairKey);
      if (cached && keySimilarity(cached.paragraphKey, ctx.key) >= REUSE_SIMILARITY) {
        const v = cached.verdict;
        if (v.relation === "contradicts") {
          findings.push({
            kind: "tension",
            path: candidate.path,
            title: candidate.title,
            snippet: v.explanation ?? candidate.snippet,
            cosine: candidate.cosine!,
            confidence: TENSION_CONFIDENCE,
          });
        } else if (v.relation === "restates") {
          findings.push({
            kind: "echo",
            path: candidate.path,
            title: candidate.title,
            snippet: v.explanation ?? candidate.snippet,
            cosine: candidate.cosine!,
            confidence: echoConfidence(candidate.cosine!, profile.candidateFloor),
          });
        }
        continue; // "neither" stays silent — the Margin already shows it as related
      }

      this.scheduleClassify(pairKey, ctx, candidate.title, candidate.snippet);
    }

    // Tensions before echoes — a contradiction is the rarer, sharper signal —
    // then by closeness; capped because this is marginalia, not a report.
    findings.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "tension" ? -1 : 1) : b.cosine - a.cosine,
    );
    return findings.slice(0, profile.maxFindings);
  }

  /** Fire-and-forget classification; the result lands in the cache. */
  private scheduleClassify(
    pairKey: string,
    ctx: DraftContext,
    noteTitle: string,
    noteExcerpt: string,
  ): void {
    if (this.inFlight.has(pairKey)) return;
    if (this.budgetExhausted || this.failures >= FAILURE_MAX) return;
    if (this.classifyCount >= SESSION_CLASSIFY_MAX) return;
    if (!this.deps.router.available()) return;

    this.inFlight.add(pairKey);
    this.classifyCount++;
    const paragraphKey = ctx.key;
    const targetPath = pairKey.slice(pairKey.indexOf("::") + 2);
    void (async () => {
      const excerpt = (await this.deps.excerptOf?.(targetPath)) ?? noteExcerpt;
      return this.deps.router.run(
        "relation",
        relationPrompt({ paragraph: ctx.text.trim(), noteTitle, noteExcerpt: excerpt }),
        { schema: RELATION_SCHEMA as unknown as Record<string, unknown>, maxTokens: 200 },
      );
    })()
      .then((text) => {
        this.failures = 0;
        this.setCache(pairKey, { paragraphKey, verdict: parseRelation(text) });
        for (const l of this.listeners) l();
      })
      .catch((err: unknown) => {
        if (err instanceof BudgetExceededError) {
          // The user's cap is a wall, not a hint: no more ambient calls this
          // session, and no error surface — the Margin just stays ordinary.
          this.budgetExhausted = true;
          this.deps.log.info("tension checks stopped: session cost limit reached");
          return;
        }
        this.failures++;
        this.deps.log.warn(`tension classification failed: ${String(err)}`);
      })
      .finally(() => this.inFlight.delete(pairKey));
  }

  private setCache(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
