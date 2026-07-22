import type { SparkValues } from "../core/types";

const SVG_NS = "http://www.w3.org/2000/svg";

const BAR_W = 3;
const BAR_GAP = 2;
const HEIGHT = 10;
const MIN_BAR = 1; // always leave a visible tick so the shape reads as three bars

/**
 * Tiny inline-SVG sparkline: three bars — linkedness, recency, atomicity.
 * Data-ink only (no axes, no frame), sized to sit inside a result row's
 * baseline without adding height. Colors come from the theme via CSS.
 */
export function sparklineEl(values: SparkValues, doc: Document = document): SVGSVGElement {
  const bars = [values.linked, values.recency, values.atomicity];
  const width = bars.length * BAR_W + (bars.length - 1) * BAR_GAP;

  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.classList.add("ariadne-sparkline");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(HEIGHT));
  svg.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
  svg.setAttribute("aria-hidden", "true");

  bars.forEach((raw, i) => {
    const v = Math.max(0, Math.min(1, raw));
    const h = Math.max(MIN_BAR, Math.round(v * HEIGHT));
    const rect = doc.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(i * (BAR_W + BAR_GAP)));
    rect.setAttribute("y", String(HEIGHT - h));
    rect.setAttribute("width", String(BAR_W));
    rect.setAttribute("height", String(h));
    svg.appendChild(rect);
  });

  const title = doc.createElementNS(SVG_NS, "title");
  title.textContent =
    `linked ${Math.round(values.linked * 100)}% · ` +
    `recent ${Math.round(values.recency * 100)}% · ` +
    `atomic ${Math.round(values.atomicity * 100)}%`;
  svg.insertBefore(title, svg.firstChild);

  return svg;
}
