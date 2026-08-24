// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { rowEl } from "../src/line/render";
import type { ScoredResult } from "../src/core/types";

const RESULT: ScoredResult = {
  path: "a.md",
  title: "A",
  snippet: "s",
  score: 1,
  confidence: 0.9,
};

function makeRow(touch = false) {
  const onActivate = vi.fn();
  const row = rowEl(document, RESULT, 0, false, { onActivate, onHoverSelect: () => {} }, { touch });
  document.body.appendChild(row);
  return { row, onActivate };
}

/** An event that carries pointerType even where PointerEvent is missing. */
function pointerish(type: string, pointerType: string): MouseEvent {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "pointerType", { value: pointerType });
  return ev;
}

describe("row activation across engines", () => {
  it("WebKit tap: click reports pointerType 'mouse' — must still activate", () => {
    // The iOS bug: pointerdown is touch (row correctly defers to allow
    // scrolling), then WebKit synthesizes the click AS pointerType "mouse".
    const { row, onActivate } = makeRow(true);
    row.dispatchEvent(pointerish("pointerdown", "touch"));
    row.dispatchEvent(pointerish("click", "mouse"));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("Chromium tap: click reports 'touch' — one activation", () => {
    const { row, onActivate } = makeRow(true);
    row.dispatchEvent(pointerish("pointerdown", "touch"));
    row.dispatchEvent(pointerish("click", "touch"));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("desktop mouse: pointerdown acts, the following click is deduped", () => {
    const { row, onActivate } = makeRow(false);
    row.dispatchEvent(pointerish("pointerdown", "mouse"));
    row.dispatchEvent(pointerish("click", "mouse"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    // The NEXT interaction (e.g. keyboard/AT synthesized click) still works.
    row.dispatchEvent(pointerish("click", ""));
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("a tap on the Link button acts once, with insertLink — not as an open", () => {
    const { row, onActivate } = makeRow(true);
    const link = row.querySelector("button.ariadne-row-action") as HTMLButtonElement;
    link.dispatchEvent(pointerish("pointerdown", "touch"));
    link.dispatchEvent(pointerish("click", "mouse"));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][1]).toMatchObject({ insertLink: true });
  });
});
