import { describe, expect, it } from "vitest";

/**
 * The obsidian mock deliberately does not export `BasesView` — it stands in
 * for every Obsidian before 1.10, where the Bases API doesn't exist.
 */
describe("Bases view registration is safe on Obsidian without Bases", () => {
  it("imports without throwing when BasesView is undefined", async () => {
    const mod = await import("../src/bases/related-view");
    expect(mod.ARIADNE_BASES_VIEW).toBe("ariadne-related");
    expect(mod.makeAriadneRelatedView).toBeTypeOf("function");
  });

  it("only touches BasesView when the factory is actually called", async () => {
    const { makeAriadneRelatedView } = await import("../src/bases/related-view");
    // Proof that the laziness is what saves the import: building the class
    // here is precisely what a top-level `class X extends BasesView` would
    // have done at module load, and it throws.
    expect(() => makeAriadneRelatedView({ manager: () => undefined, openPath: () => {} })).toThrow();
  });
});
