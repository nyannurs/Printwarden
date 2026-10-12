// Skipping drawing operations outside a sharp strip (app/pdf/cull.js).

import { blockTree, skippable } from "../app/pdf/cull.js";
import * as pdfjs from "../vendor/pdf.mjs";
import { openForRendering } from "../app/pdf/load.js";
import { createRenderer } from "../app/pdf/render.js";
import { eq, ok, test } from "./harness.js";

const OPS = pdfjs.OPS;

/** An operator list from [name, args] pairs. */
function list(ops) {
  return { fnArray: ops.map(([name]) => OPS[name]), argsArray: ops.map(([, args = null]) => args) };
}
const box = (x0, y0, x1, y1) => ["constructPath", [OPS.fill, [], [x0, y0, x1, y1]]];
const skipped = (ops, area) => {
  const l = list(ops);
  const s = skippable(blockTree(l, OPS), l.fnArray.length, area, OPS);
  return s ? [...s].map((v, i) => (v ? i : -1)).filter((i) => i >= 0) : [];
};

test("cull: a block drawn entirely outside the area is skipped whole, one inside is kept", () => {
  const ops = [
    ["save"], box(0, 0, 10, 10), ["restore"], // 0-2: far away
    ["save"], box(100, 100, 120, 120), ["restore"], // 3-5: inside
  ];
  eq(skipped(ops, [90, 90, 200, 200]), [0, 1, 2]);
});

test("cull: text, shadings and images make a block unskippable, but not its outside sub-blocks", () => {
  const ops = [
    ["save"], // 0
    ["showText", [[]]], // 1: could be anywhere
    ["save"], box(0, 0, 5, 5), ["restore"], // 2-4: skippable inside the kept block
    ["save"], ["paintImageXObject", ["img"]], ["restore"], // 5-7: images always drawn
    ["restore"], // 8
  ];
  eq(skipped(ops, [100, 100, 200, 200]), [2, 3, 4]);
});

test("cull: strokes count their line width", () => {
  const ops = [["save"], ["setLineWidth", [20]], ["constructPath", [OPS.stroke, [], [0, 0, 10, 10]]], ["restore"]];
  eq(skipped(ops, [40, 40, 60, 60]), [], "a 20 pt stroke reaches the area");
  eq(skipped(ops, [400, 400, 600, 600]), [0, 1, 2, 3]);
});

test("cull: a form's bounding box bounds what it paints, through its matrix", () => {
  const ops = [
    ["paintFormXObjectBegin", [[1, 0, 0, 1, 500, 0], [0, 0, 10, 10]]], // at x 500-510
    ["showText", [[]]], // unknown extent, but clipped to the form
    ["paintFormXObjectEnd"],
  ];
  eq(skipped(ops, [0, 0, 100, 100]), [0, 1, 2]);
  eq(skipped(ops, [495, 0, 505, 20]), []);
});

test("cull: a soft mask is only skipped with the block that uses it", () => {
  const ops = [
    ["save"], // 0
    ["beginGroup", [{ smask: { subtype: "Luminosity" }, bbox: [0, 0, 1000, 1000] }]], // 1: mask definition, page-wide
    ["showText", [[]]], // 2: mask content: doesn't paint
    ["endGroup"], // 3
    ["setGState", [[["SMask", true]]]], // 4
    box(0, 0, 10, 10), // 5: what the mask applies to
    ["restore"], // 6
  ];
  eq(skipped(ops, [100, 100, 200, 200]), [0, 1, 2, 3, 4, 5, 6], "whole block skipped, mask included");
  eq(skipped(ops, [0, 0, 5, 5]), [], "block kept: the mask stays");
});

test("cull: resource loading and marked content are never skipped", () => {
  const ops = [["save"], ["beginMarkedContent", ["Artifact"]], ["dependency", ["img"]], box(0, 0, 5, 5), ["endMarkedContent"], ["restore"]];
  eq(skipped(ops, [100, 100, 200, 200]), [0, 3, 5]);
});

test("cull: an unbalanced list skips nothing", () => {
  eq(blockTree(list([["save"], box(0, 0, 1, 1)]), OPS), null);
  eq(blockTree(list([["save"], ["endGroup"]]), OPS), null);
});

test("cull: in the render workers, a strip skips what lies outside and draws the same", async () => {
  // Four squares, one per corner, each its own block (q ... Q), one with transparency.
  const { PDFDocument, rgb } = await import("../vendor/pdf-lib.esm.js");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  page.drawRectangle({ x: 20, y: 20, width: 100, height: 100, color: rgb(0.9, 0.1, 0.1) });
  page.drawRectangle({ x: 280, y: 20, width: 100, height: 100, color: rgb(0.1, 0.6, 0.2), opacity: 0.5 });
  page.drawRectangle({ x: 20, y: 280, width: 100, height: 100, color: rgb(0.1, 0.2, 0.9) });
  page.drawRectangle({ x: 280, y: 280, width: 100, height: 100, color: rgb(0.2, 0.2, 0.2) });
  const bytes = await pdf.save();
  const renderer = await createRenderer(bytes, () => openForRendering(bytes));
  try {
    const mm = 25.4 / 72;
    const quarter = { x0: 0, y0: 200 * mm, x1: 200 * mm, y1: 400 * mm }; // top left
    const pixels = async (img) => {
      const c = new OffscreenCanvas(img.width, img.height);
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    // The first render interprets the page and draws everything; the next one skips.
    const first = await renderer.render(0, quarter, 300, 0, { cache: false });
    const second = await renderer.render(0, quarter, 300, 0, { cache: false });
    ok(second.skippedOps > 0, "pdf.js keeps the operator list where cull.js expects it, and three squares are skipped");
    eq(first.skippedOps, 0);
    const [a, b] = [await pixels(first), await pixels(second)];
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 2) diff++;
    eq(diff, 0);
    const at = (100 * first.width + 100) * 4; // inside the blue square (1.5 px per pt)
    ok(a[at] < 100 && a[at + 2] > 150, "the blue square is drawn");
  } finally {
    renderer.destroy();
  }
});
