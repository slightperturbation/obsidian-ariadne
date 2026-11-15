import { describe, expect, it } from "vitest";
import {
  calibrationFor,
  contextualize,
  recipeId,
  titleContext,
} from "../src/index/embed-recipe";
import { IndexManager } from "../src/index/manager";
import type { EmbeddingProvider } from "../src/index/embeddings/provider";
import type { SourceNote } from "../src/core/types";

function note(path: string, content: string): SourceNote {
  const title = (path.split("/").pop() ?? path).replace(/\.md$/, "");
  return { path, title, content, mtime: 1, folder: "" };
}

/** Records every text it is asked to embed; vectors are deterministic noise. */
function spyEmbedder(id = "spy:model"): EmbeddingProvider & { seen: string[] } {
  const seen: string[] = [];
  const vec = (text: string) => {
    const v = new Float32Array(8);
    for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) % 7;
    let n = 0;
    for (const x of v) n += x * x;
    return v.map((x) => x / Math.sqrt(n || 1));
  };
  return {
    id,
    dim: 8,
    floor: -1,
    seen,
    ready: async () => {},
    embed: async (texts: string[]) => {
      seen.push(...texts);
      return texts.map(vec);
    },
  };
}

describe("titleContext", () => {
  it("gives topical notes their title and dated/untitled notes none", () => {
    expect(titleContext("Research/Morphogenesis.md", "Morphogenesis")).toBe("Morphogenesis");
    expect(titleContext("Personal/Journal/2026-08-22.md", "2026-08-22")).toBeUndefined();
    expect(titleContext("Periodic/Weekly/2026-W34.md", "2026-W34")).toBeUndefined();
    expect(titleContext("Inbox/Untitled 3.md", "Untitled 3")).toBeUndefined();
    expect(contextualize("body", "Title")).toBe("Title\n\nbody");
    expect(contextualize("body", undefined)).toBe("body");
  });
});

describe("calibration", () => {
  const cal = calibrationFor("transformers:Xenova/bge-small-en-v1.5+title1");

  it("maps raw cosines onto the scale the thresholds were tuned in", () => {
    expect(cal.toThresholdScale(0.666)).toBeCloseTo(0.688, 3);
    expect(cal.toThresholdScale(0.741)).toBeCloseTo(0.761, 3);
    // Above the last knot the offset is constant, and never exceeds 1.
    expect(cal.toThresholdScale(0.9)).toBeCloseTo(0.92, 3);
    expect(cal.toThresholdScale(0.995)).toBe(1);
  });

  it("is monotonic and round-trips, so a threshold cuts where it used to", () => {
    let prev = -Infinity;
    for (let x = 0.3; x <= 0.97; x += 0.01) {
      const y = cal.toThresholdScale(x);
      expect(y).toBeGreaterThan(prev);
      prev = y;
      expect(cal.toRaw(y)).toBeCloseTo(x, 6);
    }
    // The relatedness floor (0.6 on the tuned scale) cuts lower on the raw one.
    expect(cal.toRaw(0.6)).toBeLessThan(0.6);
  });

  it("is the identity for recipes nobody has measured", () => {
    const id = calibrationFor("hash:64+title1");
    expect(id.toThresholdScale(0.7)).toBe(0.7);
    expect(id.toRaw(0.7)).toBe(0.7);
    expect(calibrationFor(undefined).toRaw(0.42)).toBe(0.42);
  });
});

describe("IndexManager × recipe", () => {
  it("embeds chunks with their note title — but stores and searches the bare text", async () => {
    const embedder = spyEmbedder();
    const manager = new IndexManager(embedder);
    await manager.indexNote(note("Research/Morphogenesis.md", "Cells self-organize into form."));
    await manager.indexNote(note("Personal/Journal/2026-08-22.md", "Slept badly and thought about work."));
    expect(embedder.seen).toContain("Morphogenesis\n\nCells self-organize into form.");
    expect(embedder.seen).toContain("Slept badly and thought about work.");
    // Lexical search still sees the note's own words, not a title-stuffed body.
    const hits = await manager.query("self-organize", { semantic: false });
    expect(hits[0].snippet).not.toContain("Morphogenesis\n\n");
  });

  it("records model+recipe as the vector identity", async () => {
    const manager = new IndexManager(spyEmbedder("spy:model"));
    await manager.indexNote(note("A.md", "alpha beta gamma"));
    expect(manager.embedderRecipeId).toBe(recipeId("spy:model"));
    expect((await manager.snapshot()).embedderId).toBe("spy:model+title1");
  });

  it("re-embeds everything restored from a pre-recipe snapshot of the same model", async () => {
    const owner = new IndexManager(spyEmbedder("spy:model"));
    await owner.indexNote(note("A.md", "alpha beta gamma"));
    await owner.indexNote(note("B.md", "delta epsilon"));
    // What an older Ariadne would have written: same model, no recipe suffix.
    const legacy = { ...(await owner.snapshot()), embedderId: "spy:model" };

    const fresh = new IndexManager();
    fresh.restore(legacy);
    const backfill = fresh.setEmbedder(spyEmbedder("spy:model"));
    expect(backfill.sort()).toEqual(["A.md", "B.md"]);

    // And a snapshot already on the current recipe needs nothing.
    const current = new IndexManager();
    current.restore(await owner.snapshot());
    expect(current.setEmbedder(spyEmbedder("spy:model"))).toEqual([]);
  });

  it("embeds a draft paragraph with its own note's title when given context", async () => {
    const embedder = spyEmbedder();
    const manager = new IndexManager(embedder);
    await manager.indexNote(note("Other.md", "Unrelated stored text about gardens."));
    embedder.seen.length = 0;
    await manager.related("A paragraph being written.", {
      context: { path: "Research/Growth.md", title: "Growth" },
    });
    expect(embedder.seen).toEqual(["Growth\n\nA paragraph being written."]);
    embedder.seen.length = 0;
    await manager.related("A journal paragraph.", {
      context: { path: "Personal/Journal/2026-08-22.md", title: "2026-08-22" },
    });
    expect(embedder.seen).toEqual(["A journal paragraph."]);
  });
});
