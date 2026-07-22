import { describe, expect, it } from "vitest";
import { diffLines, compactDiff } from "../src/ui/diff";

describe("diffLines", () => {
  it("reports identical content as all-same", () => {
    const ops = diffLines("a\nb", "a\nb");
    expect(ops).toEqual([
      { type: "same", text: "a" },
      { type: "same", text: "b" },
    ]);
  });

  it("detects insertions, deletions, and edits", () => {
    const ops = diffLines("a\nb\nc", "a\nB\nc\nd");
    expect(ops).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "same", text: "c" },
      { type: "add", text: "d" },
    ]);
  });

  it("handles creation (empty before) and deletion (empty after)", () => {
    expect(diffLines("", "x\ny")).toEqual([
      { type: "add", text: "x" },
      { type: "add", text: "y" },
    ]);
    expect(diffLines("x", "")).toEqual([{ type: "del", text: "x" }]);
  });
});

describe("compactDiff", () => {
  it("collapses long unchanged runs, keeping context around edits", () => {
    const same = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ type: "same" as const, text: `l${i}` }));
    const ops = [...same(10), { type: "add" as const, text: "new" }, ...same(10)];
    const compact = compactDiff(ops, 2);

    const skips = compact.filter((o) => o.type === "skip");
    expect(skips).toHaveLength(2);
    // Leading run keeps its tail (2 context lines), trailing run its head.
    expect(compact[0]).toEqual({ type: "skip", count: 8 });
    expect(compact[compact.length - 1]).toEqual({ type: "skip", count: 8 });
    expect(compact.some((o) => o.type === "add")).toBe(true);
  });

  it("keeps short runs whole", () => {
    const ops = diffLines("a\nb\nc", "a\nb\nX");
    const compact = compactDiff(ops, 2);
    expect(compact.every((o) => o.type !== "skip")).toBe(true);
  });
});
