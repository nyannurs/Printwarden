// Press-sheet geometry for export: where every folio lands on every sheet side, what is
// visible of it, and where marks go. Pure numbers (mm, sheet origin bottom-left); the
// writer in app/impose/ executes this plan against real PDFs, and the same plan could
// drive an on-screen sheet preview.

import { creepMm } from "./imposition.js";
import { formatMm, PAPER_SIZES, rotated } from "./units.js";

/**
 * @typedef {{
 *   sheet: "auto" | {width: number, height: number},
 *   bleed: boolean,
 *   marks: {crop: boolean, fold: boolean, info: boolean},
 *   markOffsetMm: number,     // gap between trim and the start of a mark
 *   markLengthMm: number,
 *   creep: boolean,
 * }} ExportOptions
 */

/** @returns {ExportOptions} */
export const defaultExportOptions = () => ({
  sheet: "auto",
  bleed: true,
  marks: { crop: true, fold: true, info: true },
  markOffsetMm: 3,
  markLengthMm: 5,
  creep: false,
});

export const SHEET_PRESETS = ["A4", "A3", "SRA3", "Letter", "Tabloid"].map((name) => ({ name, size: PAPER_SIZES[name] }));

const INFO_SPACE_MM = 4; // room for the one-line page information

/**
 * @param {ReturnType<typeof import("./analysis.js").analyse>} analysis
 * @param {ExportOptions} opts
 */
export function planSheets(analysis, opts) {
  const errors = [];
  const { layout, setup } = analysis;
  if (analysis.imposed) errors.push("This file is already imposed. Import the unimposed pages to export.");
  if (!layout) errors.push("There is no sheet layout: fix the page count or choose a binding that folds.");
  if (analysis.hasErrors) errors.push("Resolve the errors in Preflight first.");

  const { width: w, height: h } = setup.page;
  const bleedIn = setup.page.bleed;
  const b = opts.bleed
    ? { top: bleedIn.top, bottom: bleedIn.bottom, outside: bleedIn.outside }
    : { top: 0, bottom: 0, outside: 0 };
  const anyMarks = opts.marks.crop || opts.marks.fold || opts.marks.info;
  // Marks start outside the bleed, never inside it.
  const markStart = Math.max(opts.markOffsetMm, b.top, b.bottom, b.outside);
  const markEnd = markStart + opts.markLengthMm;
  const margin = anyMarks
    ? markEnd + (opts.marks.info ? INFO_SPACE_MM : 1)
    : Math.max(b.top, b.bottom, b.outside);

  // The sheet's cells: one spread (a row of two) or a scheme's rows and columns. Pairs of
  // columns meet at a spine fold; between pairs the fore-edges face each other with their
  // bleed between; two rows meet head to head at the top fold, their head bleed between.
  const rows = layout?.sides[0]?.rows ?? 1;
  const cols = layout?.sides[0]?.cols ?? 2;
  const gapX = 2 * b.outside; // between pairs
  const gapY = 2 * b.top; // between rows
  const inner = { width: cols * w + (cols / 2 - 1) * gapX, height: rows * h + (rows - 1) * gapY };
  const content = { width: inner.width + 2 * margin, height: inner.height + 2 * margin };
  let sheet;
  if (opts.sheet === "auto") {
    sheet = content;
  } else {
    sheet = opts.sheet.width >= opts.sheet.height ? opts.sheet : rotated(opts.sheet);
    const minimum = { width: inner.width + 2 * b.outside, height: inner.height + b.top + b.bottom };
    if (sheet.width + 0.01 < minimum.width || sheet.height + 0.01 < minimum.height) {
      errors.push(`The sheet is too small: pages and bleed need at least ${formatMm(minimum.width)} × ${formatMm(minimum.height)} mm.`);
    } else if (anyMarks && (sheet.width + 0.01 < content.width || sheet.height + 0.01 < content.height)) {
      errors.push(`Printer marks don't fit: they need ${formatMm(content.width)} × ${formatMm(content.height)} mm. Use a larger sheet or turn marks off.`);
    }
  }

  const cx = sheet.width / 2;
  const area = { x0: cx - inner.width / 2, y0: (sheet.height - inner.height) / 2, x1: cx + inner.width / 2, y1: (sheet.height + inner.height) / 2 };
  const t = setup.paperThicknessMm;
  let maxCreep = 0;
  // Where a cell's trim lies: column c (its pair c >> 1), row r (0 at the top).
  const cellX0 = (c) => area.x0 + c * w + (c >> 1) * gapX;
  const cellY0 = (r) => area.y1 - (r + 1) * h - r * gapY;
  // Fold lines (the spine fold of each pair; between pairs and rows, where the sheet folds
  // first) and the cut lines inside the area (the fore-edges between pairs, the heads
  // between rows), for the marks.
  const folds = { x: [], y: [] };
  const cuts = { x: [], y: [] };
  for (let c = 0; c < cols; c += 2) {
    folds.x.push(cellX0(c) + w); // the pair's spine
    if (c > 0) {
      folds.x.push(cellX0(c) - gapX / 2);
      cuts.x.push(cellX0(c) - gapX, cellX0(c));
    }
  }
  if (rows === 2) {
    folds.y.push(cellY0(0) - gapY / 2);
    cuts.y.push(cellY0(0) - gapY, cellY0(0));
  }

  const sides = (layout?.sides ?? []).map((s) => {
    // A side's cells: the scheme's, or the spread's two (left, right).
    const cells = s.cells ?? [[{ page: s.left, turned: false, depth: s.depth }, { page: s.right, turned: false, depth: s.depth }]];
    const placements = cells.flatMap((row, r) => row.map((cell, c) => {
      const creep = opts.creep ? creepMm(cell.depth, t) : 0; // shift toward the spine
      maxCreep = Math.max(maxCreep, creep);
      // Its spine is at the pair's fold: to the right of an even column, the left of an
      // odd one (turned or not: the fold is the same).
      const spineRight = c % 2 === 0;
      const shift = spineRight ? creep : -creep;
      const x0 = cellX0(c) + shift;
      const y0 = cellY0(r);
      const trim = { x0, x1: x0 + w, y0, y1: y0 + h };
      const foldX = spineRight ? cellX0(c) + w : cellX0(c);
      // Visible region: bleed on the three outer sides, cut at the fold on the spine side.
      // A turned cell's head is at its bottom.
      const headUp = !cell.turned;
      const clip = {
        x0: spineRight ? trim.x0 - b.outside : foldX,
        x1: spineRight ? foldX : trim.x1 + b.outside,
        y0: trim.y0 - (headUp ? b.bottom : b.top),
        y1: trim.y1 + (headUp ? b.top : b.bottom),
      };
      return { folio: cell.page, trim, clip, creepMm: creep, turned: cell.turned };
    }));
    return { sheet: s.sheet, side: s.side, signature: s.signature, cover: !!s.cover, rows: cells.length, cols: cells[0].length, placements };
  });

  return {
    errors,
    sheetSize: sheet,
    area,
    sides,
    folds,
    cuts,
    maxCreepMm: maxCreep,
    marks: { ...opts.marks, start: markStart, end: markEnd, bleed: b },
    sheetCount: layout?.sheetCount ?? 0,
  };
}
