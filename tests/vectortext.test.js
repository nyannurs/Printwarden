// Vector text: glyph outlines drawn on the 3D page by the Slug method (app/viewer/vectortext.js),
// and the render workers' choice of which glyphs (app/pdf/render-worker.js).

import { coverageAt, packVectorText, quadsFromPath } from "../app/viewer/vectortext.js";
import { openForRendering } from "../app/pdf/load.js";
import { createRenderer } from "../app/pdf/render.js";
import { eq, near, ok, test } from "./harness.js";

/** A circle of four cubic arcs, counterclockwise (or clockwise: a hole). */
function circle(cx, cy, r, hole = false) {
  const k = 0.5523;
  const p = [[cx + r, cy], [cx, cy + r], [cx - r, cy], [cx, cy - r]];
  if (hole) p.reverse();
  const ops = [0, p[0][0], p[0][1]];
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    const s = hole ? -k : k;
    const ta = [-(a[1] - cy), a[0] - cx];
    const tb = [-(b[1] - cy), b[0] - cx];
    ops.push(2, a[0] + ta[0] * s, a[1] + ta[1] * s, b[0] - tb[0] * s, b[1] - tb[1] * s, b[0], b[1]);
  }
  ops.push(4);
  return ops;
}

const glyphs = new Map([
  ["square", [0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 4]],
  ["circle", circle(0.5, 0.5, 0.4)],
  ["ring", [...circle(0.5, 0.5, 0.4), ...circle(0.5, 0.5, 0.2, true)]],
]);
// Each glyph 0.1 of the page wide, side by side.
const packed = packVectorText({
  glyphs,
  instances: [["square", 0.1], ["circle", 0.4], ["ring", 0.7]].map(([glyph, u]) => ({ glyph, m: [0.1, 0, 0, 0.1, u, 0.4], color: [0, 0, 0] })),
});
const PX = 1 / 2000; // a pixel: 1/2000 of the page
const cover = (i, u, v) => coverageAt(packed, i, u, v, [PX, 0], [0, PX]);
const area = (i, u0) => {
  let sum = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) sum += cover(i, u0 + (x + 0.5) * PX, 0.4 + (y + 0.5) * PX);
  return (sum * PX * PX) / 0.01; // in glyph units
};

test("vector text: a square is covered inside, not outside, half on its edge", () => {
  near(cover(0, 0.15, 0.45), 1, 1e-3);
  near(cover(0, 0.25, 0.45), 0, 1e-3);
  near(cover(0, 0.2, 0.45), 0.5, 0.02);
});

test("vector text: curves cover their exact area, holes stay empty", () => {
  near(area(1, 0.4), Math.PI * 0.16, 0.002, "circle");
  near(area(2, 0.7), Math.PI * 0.12, 0.002, "ring");
  near(cover(2, 0.75, 0.45), 0, 1e-3, "the ring's hole");
});

test("vector text: a crowded spot keeps every glyph (the page's image leaves them out)", () => {
  const stack = packVectorText({
    glyphs,
    instances: Array.from({ length: 60 }, () => ({ glyph: "square", m: [0.001, 0, 0, 0.001, 0.5, 0.5], color: [0, 0, 0] })),
  });
  const [, gw, gh, gridStart] = stack.info;
  const cell = Math.floor(0.5005 * gh) * gw + Math.floor(0.5005 * gw);
  eq(stack.ints[2 * (gridStart + cell)], 60);
});

test("vector text: cubic curves become quadratics within the tolerance", () => {
  // (0, 0) (0, 1) (1, 1) (1, 0), then closed by a line.
  const quads = quadsFromPath([0, 0, 0, 2, 0, 1, 1, 1, 1, 0], 0.001);
  const curves = [];
  for (let i = 0; i < quads.length; i += 6) if (quads[i + 2] !== quads[i + 4] || quads[i + 3] !== quads[i + 5]) curves.push(quads.slice(i, i + 6));
  ok(curves.length >= 2, "split");
  eq(quads.slice(-6), [1, 0, 0, 0, 0, 0], "closed");
  // Every quadratic's midpoint lies on the cubic (within the tolerance, and a little).
  const cubic = (t) => [3 * (1 - t) * t * t + t ** 3, 3 * (1 - t) ** 2 * t + 3 * (1 - t) * t * t];
  let worst = 0;
  for (const [x0, y0, x1, y1, x2, y2] of curves) {
    const mx = 0.25 * x0 + 0.5 * x1 + 0.25 * x2;
    const my = 0.25 * y0 + 0.5 * y1 + 0.25 * y2;
    let best = Infinity;
    for (let s = 0; s <= 2000; s++) {
      const [cx, cy] = cubic(s / 2000);
      best = Math.min(best, Math.hypot(cx - mx, cy - my));
    }
    worst = Math.max(worst, best);
  }
  ok(worst < 0.002, `off the curve by ${worst}`);
});

test("vector text: the render workers hand over plain text, and leave what covers it in the image", async () => {
  const { PDFDocument, StandardFonts, rgb } = await import("../vendor/pdf-lib.esm.js");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 400]);
  page.drawText("Open it", { x: 20, y: 300, size: 40, font, color: rgb(0.8, 0.1, 0.1) }); // a space has no outline
  page.drawText("Hidden", { x: 20, y: 100, size: 40, font, color: rgb(0, 0, 0) });
  page.drawRectangle({ x: 10, y: 90, width: 200, height: 20, color: rgb(0.2, 0.4, 0.9) }); // over "Hidden"
  const bytes = await pdf.save();
  const renderer = await createRenderer(bytes, () => openForRendering(bytes));
  try {
    const text = await renderer.vectorText(0);
    ok(text, "worker threads answer");
    eq(text.instances.length, 6, "the six letters of Open it: Hidden lies under the rectangle");
    eq(text.instances.map((g) => g.color.map((c) => Math.round(c * 255))), Array(6).fill([204, 26, 26]));
    ok(text.instances.every((g) => text.glyphs.has(g.glyph)), "every letter's outline");
    // Placed in PDF points: the O starts at x 20, its baseline at y 300.
    const [a, , , d, e, f] = text.instances[0].m;
    near(e, 20, 0.5);
    near(f, 300, 0.5);
    near(a, 40, 0.5, "the font size");
    near(d, 40, 0.5);
  } finally {
    renderer.destroy();
  }
});
