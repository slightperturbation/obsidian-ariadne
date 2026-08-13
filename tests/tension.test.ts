import { describe, expect, it, vi } from "vitest";
import {
  TENSION_PROFILES,
  echoConfidence,
  keySimilarity,
  selectCandidates,
} from "../src/margin/tension/detect";
import { parseRelation, relationPrompt } from "../src/model/tasks";
import { TensionEngine } from "../src/margin/tension/engine";
import type { ModelRouter } from "../src/model/router";
import { BudgetExceededError } from "../src/model/router";
import type { IndexManager } from "../src/index/manager";
import type { ScoredResult } from "../src/core/types";
import type { DraftContext } from "../src/margin/draft-watcher";
import { Logger } from "../src/util/logger";

const result = (path: string, cosine: number | undefined, title = path): ScoredResult => ({
  path,
  title,
  snippet: `snippet of ${path}`,
  score: 1,
  confidence: 0.5,
  cosine,
});

describe("selectCandidates", () => {
  const profile = TENSION_PROFILES.quiet;

  it("splits neighbors into echoes, candidates, and silence", () => {
    const { echoes, candidates } = selectCandidates({
      results: [
        result("verbatim.md", 0.96),
        result("ambiguous.md", 0.87),
        result("merely-related.md", 0.7),
        result("lexical-only.md", undefined),
      ],
      linkedTitles: new Set(),
      profile,
    });
    expect(echoes.map((r) => r.path)).toEqual(["verbatim.md"]);
    expect(candidates.map((r) => r.path)).toEqual(["ambiguous.md"]);
  });

  it("drops echoes of already-linked notes but keeps them as tension candidates", () => {
    const { echoes, candidates } = selectCandidates({
      results: [result("linked-echo.md", 0.95), result("linked-cand.md", 0.86)],
      linkedTitles: new Set(["linked-echo.md", "linked-cand.md"]),
      profile,
    });
    // The connection is made — re-announcing the echo is nagging…
    expect(echoes).toHaveLength(0);
    // …but contradicting a note you cite is precisely when you want to know.
    expect(candidates.map((r) => r.path)).toEqual(["linked-cand.md"]);
  });

  it("orders both lists best-first", () => {
    const { candidates } = selectCandidates({
      results: [result("b.md", 0.85), result("a.md", 0.9)],
      linkedTitles: new Set(),
      profile,
    });
    expect(candidates.map((r) => r.path)).toEqual(["a.md", "b.md"]);
  });
});

describe("echoConfidence", () => {
  it("maps the echo band onto [0.5, 0.9] — never full certainty", () => {
    const floor = TENSION_PROFILES.quiet.echoFloor;
    expect(echoConfidence(floor, floor)).toBeCloseTo(0.5);
    expect(echoConfidence(1, floor)).toBeCloseTo(0.9);
    expect(echoConfidence(0.5, floor)).toBeCloseTo(0.5); // clamped below
  });
});

describe("keySimilarity", () => {
  it("treats a paragraph with one added word as the same paragraph", () => {
    const a = "note.md::alpha,beta,gamma,delta";
    const b = "note.md::alpha,beta,delta,epsilon,gamma";
    expect(keySimilarity(a, b)).toBeGreaterThan(0.6);
  });

  it("treats a rewritten paragraph as new", () => {
    const a = "note.md::alpha,beta,gamma";
    const b = "note.md::omega,sigma,theta";
    expect(keySimilarity(a, b)).toBe(0);
  });
});

describe("parseRelation", () => {
  it("parses a valid verdict and strips the trailing period", () => {
    const v = parseRelation('{"relation":"contradicts","explanation":"disagrees on X."}');
    expect(v).toEqual({ relation: "contradicts", explanation: "disagrees on X" });
  });

  it("degrades malformed output to silence, not to a wrong card", () => {
    expect(parseRelation("not json").relation).toBe("neither");
    expect(parseRelation('{"relation":"maybe"}').relation).toBe("neither");
    expect(parseRelation('{"relation":"restates","explanation":""}').explanation).toBeUndefined();
  });

  it("prompt biases toward neither when unsure", () => {
    const p = relationPrompt({ paragraph: "a", noteTitle: "T", noteExcerpt: "b" });
    expect(p).toContain('When unsure, answer "neither"');
  });
});

/* ── engine, with a fake manager + router ─────────────────────────────── */

const PARAGRAPH =
  "Spaced repetition primarily improves retention of isolated facts, and its benefits for transfer to novel problems are much weaker than commonly claimed by its advocates.";

const ctx = (over: Partial<DraftContext> = {}): DraftContext => ({
  path: "draft.md",
  title: "draft",
  text: PARAGRAPH,
  noteText: PARAGRAPH,
  cursorLine: 0,
  cursorCh: 0,
  charBefore: "",
  charAfter: "",
  lineBefore: "",
  key: "draft.md::facts,novel,problems,repetition,retention,spaced,transfer",
  ...over,
});

function makeEngine(over: {
  results?: ScoredResult[];
  runImpl?: (task: string, prompt: string) => Promise<string>;
  mode?: "off" | "quiet" | "eager";
}) {
  const run = vi.fn(
    over.runImpl ?? (() => Promise.resolve('{"relation":"contradicts","explanation":"disagrees on transfer"}')),
  );
  const manager = {
    canEmbedText: () => true,
    related: vi.fn(() => Promise.resolve(over.results ?? [])),
  } as unknown as IndexManager;
  const router = { available: () => true, run } as unknown as ModelRouter;
  const engine = new TensionEngine({
    manager: () => manager,
    router,
    mode: () => over.mode ?? "quiet",
    log: new Logger("test", false),
  });
  return { engine, run };
}

/** Verdicts land on a microtask; the repaint notification is coalesced (150ms). */
const flush = () => new Promise((r) => setTimeout(r, 250));

describe("TensionEngine", () => {
  it("surfaces a certain echo immediately, with no model call", async () => {
    const { engine, run } = makeEngine({ results: [result("dup.md", 0.95)] });
    const findings = await engine.analyze(ctx());
    expect(findings).toEqual([
      expect.objectContaining({ kind: "echo", path: "dup.md" }),
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it("classifies the ambiguous band in the background, then surfaces the tension", async () => {
    const { engine, run } = makeEngine({ results: [result("rival.md", 0.87)] });
    const updated = vi.fn();
    engine.subscribe(updated);

    // First pass: nothing to show yet, one classification scheduled.
    expect(await engine.analyze(ctx())).toEqual([]);
    expect(run).toHaveBeenCalledOnce();
    await flush();
    expect(updated).toHaveBeenCalled();

    // Second pass: the cached verdict surfaces as a tension card.
    const findings = await engine.analyze(ctx());
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "tension",
        path: "rival.md",
        snippet: "disagrees on transfer",
      }),
    ]);
    expect(run).toHaveBeenCalledOnce(); // cache hit — no second call
  });

  it("reuses a verdict across small paragraph edits, reclassifies a rewrite", async () => {
    const { engine, run } = makeEngine({ results: [result("rival.md", 0.87)] });
    await engine.analyze(ctx());
    await flush();

    // One more word: same paragraph, cache holds.
    await engine.analyze(
      ctx({ key: "draft.md::facts,novel,probably,problems,repetition,retention,spaced,transfer" }),
    );
    expect(run).toHaveBeenCalledOnce();

    // A rewritten paragraph: new question, new call.
    await engine.analyze(ctx({ key: "draft.md::completely,different,words,entirely" }));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps "neither" silent — the Margin already shows it as related', async () => {
    const { engine } = makeEngine({
      results: [result("nearby.md", 0.87)],
      runImpl: () => Promise.resolve('{"relation":"neither"}'),
    });
    await engine.analyze(ctx());
    await flush();
    expect(await engine.analyze(ctx())).toEqual([]);
  });

  it("a restates verdict surfaces as an echo with the model's explanation", async () => {
    const { engine } = makeEngine({
      results: [result("same-idea.md", 0.87)],
      runImpl: () => Promise.resolve('{"relation":"restates","explanation":"same point about retention"}'),
    });
    await engine.analyze(ctx());
    await flush();
    const findings = await engine.analyze(ctx());
    expect(findings).toEqual([
      expect.objectContaining({ kind: "echo", snippet: "same point about retention" }),
    ]);
  });

  it("dismissal silences a pair for the session", async () => {
    const { engine } = makeEngine({ results: [result("dup.md", 0.95)] });
    expect(await engine.analyze(ctx())).toHaveLength(1);
    engine.dismiss("draft.md", "dup.md");
    expect(await engine.analyze(ctx())).toHaveLength(0);
  });

  it("stops all ambient calls once the budget is exhausted", async () => {
    const { engine, run } = makeEngine({
      results: [result("rival.md", 0.87)],
      runImpl: () => Promise.reject(new BudgetExceededError(2)),
    });
    await engine.analyze(ctx());
    await flush();
    // New paragraph, would normally reclassify — but the wall is up.
    await engine.analyze(ctx({ key: "draft.md::fresh,words,here,now" }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("does nothing when off, for short fragments, or without embeddings", async () => {
    const off = makeEngine({ results: [result("dup.md", 0.95)], mode: "off" });
    expect(await off.engine.analyze(ctx())).toEqual([]);

    const { engine } = makeEngine({ results: [result("dup.md", 0.95)] });
    expect(await engine.analyze(ctx({ text: "too short to have a stance" }))).toEqual([]);
  });

  it("caps findings at the profile maximum, tensions first", async () => {
    const { engine } = makeEngine({
      results: [result("e1.md", 0.99), result("e2.md", 0.96), result("t1.md", 0.87)],
    });
    await engine.analyze(ctx());
    await flush();
    const findings = await engine.analyze(ctx());
    expect(findings).toHaveLength(TENSION_PROFILES.quiet.maxFindings);
    expect(findings[0]).toMatchObject({ kind: "tension", path: "t1.md" });
    expect(findings[1]).toMatchObject({ kind: "echo", path: "e1.md" });
  });
});

describe("entry-kind gating in dated notes", () => {
  const LOG_BLOCK = [
    "- 9:30 platform sync, migration timelines discussed at length again",
    "- [ ] email Sam about the review process for the quarterly report",
    "- [ ] book flights for the offsite before prices go up next week",
  ].join("\n");

  it("a long log block in a dated note is never examined — no stance to check", async () => {
    const { engine, run } = makeEngine({ results: [result("dup.md", 0.95)] });
    const fakeManager = { canEmbedText: () => true, related: vi.fn() } as unknown as IndexManager;
    const withJournal = new TensionEngine({
      manager: () => fakeManager,
      router: { available: () => true, run: vi.fn() } as unknown as ModelRouter,
      mode: () => "quiet",
      isJournal: () => true,
      log: new Logger("test", false),
    });
    expect(await withJournal.analyze(ctx({ path: "2026-08-12.md", text: LOG_BLOCK }))).toEqual([]);
    // The same block in a permanent note stays eligible (length is enough there).
    expect((await engine.analyze(ctx({ text: LOG_BLOCK }))).length).toBeGreaterThan(0);
    expect(run).not.toHaveBeenCalled(); // 0.95 is a free echo, no model call
  });

  it("reflective prose in a dated note keeps the full apparatus", async () => {
    const reflectiveCtx = ctx({ path: "2026-08-12.md" }); // PARAGRAPH is prose
    const manager = {
      canEmbedText: () => true,
      related: vi.fn(() => Promise.resolve([result("dup.md", 0.95)])),
    } as unknown as IndexManager;
    const engine = new TensionEngine({
      manager: () => manager,
      router: { available: () => true, run: vi.fn() } as unknown as ModelRouter,
      mode: () => "quiet",
      isJournal: () => true,
      log: new Logger("test", false),
    });
    expect(await engine.analyze(reflectiveCtx)).toHaveLength(1);
  });
});
