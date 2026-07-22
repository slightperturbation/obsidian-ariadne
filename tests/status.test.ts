import { describe, it, expect } from "vitest";
import { StatusStore } from "../src/core/status";

describe("StatusStore", () => {
  it("emits current state on subscribe and again on each set", () => {
    const store = new StatusStore();
    const seen: number[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s.indexedNotes));

    store.set({ indexedNotes: 5 });
    store.set({ indexedNotes: 10 });
    unsubscribe();
    store.set({ indexedNotes: 20 }); // ignored after unsubscribe

    expect(seen).toEqual([0, 5, 10]);
  });

  it("merges partial patches", () => {
    const store = new StatusStore();
    store.set({ index: "indexing" });
    store.set({ brain: "cloud" });
    expect(store.get()).toMatchObject({ index: "indexing", brain: "cloud" });
  });

  it("returns copies, not the internal state object", () => {
    const store = new StatusStore();
    const a = store.get();
    a.indexedNotes = 999;
    expect(store.get().indexedNotes).toBe(0);
  });
});
