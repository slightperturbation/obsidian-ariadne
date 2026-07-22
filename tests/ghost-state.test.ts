import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ghostField, setGhost, type GhostSuggestion } from "../src/margin/ghost/state";

const SUGGESTION: GhostSuggestion = {
  pos: 5,
  insertText: " [[Atomic notes]]",
  targetPath: "zettel/Atomic notes.md",
};

function stateWithGhost(doc = "Hello world") {
  const state = EditorState.create({ doc, extensions: [ghostField] });
  return state.update({
    effects: setGhost.of(SUGGESTION),
    selection: { anchor: 5 },
  }).state;
}

describe("ghostField", () => {
  it("stores a suggestion via the effect and clears via null", () => {
    const s = stateWithGhost();
    expect(s.field(ghostField)).toEqual(SUGGESTION);
    const cleared = s.update({ effects: setGhost.of(null) }).state;
    expect(cleared.field(ghostField)).toBeNull();
  });

  it("clears on any document change not carrying a setGhost effect", () => {
    const s = stateWithGhost();
    const typed = s.update({ changes: { from: 5, insert: "x" } }).state;
    expect(typed.field(ghostField)).toBeNull();
  });

  it("clears when the cursor moves off the anchor", () => {
    const s = stateWithGhost();
    const moved = s.update({ selection: { anchor: 0 } }).state;
    expect(moved.field(ghostField)).toBeNull();
  });

  it("survives an accept-style transaction (change + effect together)", () => {
    const s = stateWithGhost();
    const accepted = s.update({
      changes: { from: 5, insert: SUGGESTION.insertText },
      effects: setGhost.of(null),
    }).state;
    expect(accepted.field(ghostField)).toBeNull();
    expect(accepted.doc.toString()).toBe("Hello [[Atomic notes]] world");
  });
});
