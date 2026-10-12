// Which drawing operations a render of part of a page can skip. Pure: works on pdf.js's
// operator list (fnArray, argsArray) and its OPS table, no pdf.js import.
//
// A sharp strip covers a small part of a page, but pdf.js executes the whole page's
// operators for every render, clipped to the canvas. Most are cheap to clip; soft masks
// (InDesign drop shadows) are not: each costs a pass over a canvas-sized buffer. A page
// with 200 shadows took seconds per strip.
//
// Only whole self-contained blocks are skipped: a save…restore pair, a form or a
// transparency group. When such a block ends, pdf.js restores all graphics state, so
// skipping it can't change anything drawn after it. A block is skipped only if what it
// can paint is proven to lie outside the strip, from geometry the PDF declares:
//  - forms and groups: their bounding box (their content is clipped to it)
//  - paths: their own bounds, widened for strokes
//  - anything else that paints (text, shadings, and images, see below): could be
//    anywhere, so the block is always drawn (its sub-blocks may still be skipped)
// Soft-mask definitions are never skipped on their own, only with the block that uses them.
//
// Images are always drawn: Chromium's image drawing depends on which images were drawn
// earlier on the same canvas (measured: skipping four images outside a strip changed a
// few hundred pixels of other images inside it). Everything else was verified pixel for
// pixel against unskipped renders on every page of a 44-page InDesign document.
//
// pdf.js's own recorded operation bounds (recordOperations) were tried first and
// rejected: they skip single state operations and are wrong inside transparency groups.

const ALL = Object.freeze([-Infinity, -Infinity, Infinity, Infinity]); // could paint anywhere

const IDENTITY = [1, 0, 0, 1, 0, 0];

/** m1 × m2: apply m2, then m1 (PDF matrices [a b c d e f]). */
function mul(p, m) {
  return [
    p[0] * m[0] + p[2] * m[1], p[1] * m[0] + p[3] * m[1],
    p[0] * m[2] + p[2] * m[3], p[1] * m[2] + p[3] * m[3],
    p[0] * m[4] + p[2] * m[5] + p[4], p[1] * m[4] + p[3] * m[5] + p[5],
  ];
}

function boxOf(m, x0, y0, x1, y1, pad) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    const px = m[0] * x + m[2] * y + m[4];
    const py = m[1] * x + m[3] * y + m[5];
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

function union(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a === ALL || b === ALL) return ALL;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function meet(content, declared) {
  if (!content) return null;
  if (content === ALL) return declared;
  const r = [Math.max(content[0], declared[0]), Math.max(content[1], declared[1]),
    Math.min(content[2], declared[2]), Math.min(content[3], declared[3])];
  return r[0] > r[2] || r[1] > r[3] ? null : r;
}

const scaleOf = (m) => Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]));

/**
 * The page's blocks and the area (PDF user space, pt) each can paint. null if the list
 * isn't balanced (then nothing is skipped).
 * @param {{fnArray: number[], argsArray: any[]}} operatorList
 * @param {Record<string, number>} OPS  pdf.js's operator codes
 */
export function blockTree({ fnArray, argsArray }, OPS) {
  const name = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));
  const pairs = new Map([[OPS.save, OPS.restore], [OPS.beginGroup, OPS.endGroup],
    [OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd]]);
  const closers = new Set(pairs.values());
  // Operators that change state or clip but never paint.
  const quiet = new Set(["dependency", "transform", "clip", "eoClip", "beginText", "endText", "moveText",
    "nextLine", "beginMarkedContent", "beginMarkedContentProps", "endMarkedContent", "beginCompat",
    "endCompat", "markPoint", "markPointProps"].map((k) => OPS[k]));
  const isQuiet = (f) => quiet.has(f) || /^set/.test(name[f] ?? "");

  const root = { start: -1, end: fnArray.length, children: [], content: null, box: ALL, mask: false };
  /** @type {any[]} */
  const stack = [root];
  let masks = 0; // open soft-mask definitions
  let ctm = IDENTITY;
  let lineWidth = 1;
  const add = (node, box) => {
    if (box) node.content = union(node.content, box);
  };

  for (let i = 0; i < fnArray.length; i++) {
    const f = fnArray[i];
    const args = argsArray[i];
    if (pairs.has(f)) {
      const node = { start: i, end: -1, close: pairs.get(f), children: [], content: null, declared: null,
        mask: false, ctm, lineWidth };
      if (f === OPS.beginGroup) {
        const g = args[0];
        node.mask = !!g.smask;
        if (g.bbox) node.declared = boxOf(g.matrix ? mul(ctm, g.matrix) : ctm, g.bbox[0], g.bbox[1], g.bbox[2], g.bbox[3], 1);
      } else if (f === OPS.paintFormXObjectBegin) {
        if (args[0]) ctm = mul(ctm, args[0]);
        if (args[1]) node.declared = boxOf(ctm, args[1][0], args[1][1], args[1][2], args[1][3], 1);
      }
      if (node.mask) masks++;
      stack.at(-1).children.push(node);
      stack.push(node);
      continue;
    }
    if (closers.has(f)) {
      const node = stack.pop();
      if (node === root || node.close !== f) return null;
      node.end = i;
      ctm = node.ctm;
      lineWidth = node.lineWidth;
      node.box = node.declared ? meet(node.content, node.declared) : node.content;
      if (node.mask) masks--;
      // A mask's content paints nothing itself: what it masks does, and counts for itself.
      else add(stack.at(-1), node.box);
      continue;
    }
    if (f === OPS.transform) {
      ctm = mul(ctm, args);
      continue;
    }
    if (f === OPS.setLineWidth) {
      lineWidth = args[0];
      continue;
    }
    if (f === OPS.setGState) {
      for (const [key, value] of args[0]) if (key === "LW") lineWidth = value;
      continue;
    }
    let box;
    if (f === OPS.constructPath) {
      const [paint, , minMax] = args;
      if (paint === OPS.endPath) continue; // a clipping path: paints nothing
      // Strokes reach out half the line width (more at mitred corners); a hairline is a
      // device pixel. Generous on purpose.
      box = minMax
        ? boxOf(ctm, minMax[0], minMax[1], minMax[2], minMax[3], Math.max(lineWidth, 0) * 5 * scaleOf(ctm) + 2)
        : ALL;
    } else if (isQuiet(f)) {
      continue;
    } else {
      // Text, shadings, images and anything unforeseen. Inside a mask definition this
      // doesn't count (see above), so drop shadows stay skippable.
      box = ALL;
    }
    if (!masks) add(stack.at(-1), box);
  }
  if (stack.length !== 1) return null;
  root.fnArray = fnArray;
  return root;
}

/**
 * Operators a render of `area` (PDF user space, pt: [x0, y0, x1, y1]) can skip: a
 * Uint8Array with 1 for each, or null if nothing can be skipped.
 */
export function skippable(tree, count, area, OPS) {
  if (!tree) return null;
  const [x0, y0, x1, y1] = area;
  const skip = new Uint8Array(count);
  let any = false;
  const visit = (node) => {
    for (const c of node.children) {
      if (c.mask) continue; // only ever skipped together with the block that uses it
      const b = c.box;
      if (!b || (b !== ALL && (b[0] > x1 || b[2] < x0 || b[1] > y1 || b[3] < y0))) {
        skip.fill(1, c.start, c.end + 1);
        any = true;
      } else {
        visit(c);
      }
    }
  };
  visit(tree);
  if (!any) return null;
  // Harmless and cheap, and they must stay balanced: resource loading, marked content.
  const keep = new Set([OPS.dependency, OPS.beginMarkedContent, OPS.beginMarkedContentProps, OPS.endMarkedContent]);
  for (let i = 0; i < count; i++) if (skip[i] && keep.has(tree.fnArray[i])) skip[i] = 0;
  return skip;
}
