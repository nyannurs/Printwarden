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

  const content = { width: 2 * w + 2 * margin, height: h + 2 * margin };
  let sheet;
  if (opts.sheet === "auto") {
    sheet = content;
  } else {
    sheet = opts.sheet.width >= opts.sheet.height ? opts.sheet : rotated(opts.sheet);
    const minimum = { width: 2 * w + 2 * b.outside, height: h + b.top + b.bottom };
    if (sheet.width + 0.01 < minimum.width || sheet.height + 0.01 < minimum.height) {
      errors.push(`The sheet is too small: pages and bleed need at least ${formatMm(minimum.width)} × ${formatMm(minimum.height)} mm.`);
    } else if (anyMarks && (sheet.width + 0.01 < content.width || sheet.height + 0.01 < content.height)) {
      errors.push(`Printer marks don't fit: they need ${formatMm(content.width)} × ${formatMm(content.height)} mm. Use a larger sheet or turn marks off.`);
    }
  }

  const cx = sheet.width / 2;
  const area = { x0: cx - w, y0: (sheet.height - h) / 2, x1: cx + w, y1: (sheet.height + h) / 2 };
  const t = setup.paperThicknessMm;
  let maxCreep = 0;

  const sides = (layout?.sides ?? []).map((s) => {
    const c = opts.creep ? creepMm(s.depth, t) : 0; // shift toward the spine
    maxCreep = Math.max(maxCreep, c);
    const place = (folio, onLeft) => {
      const trim = onLeft
        ? { x0: cx - w + c, x1: cx + c, y0: area.y0, y1: area.y1 }
        : { x0: cx - c, x1: cx + w - c, y0: area.y0, y1: area.y1 };
      // Visible region: bleed on the three outer sides, cut at the fold on the spine side.
      const clip = onLeft
        ? { x0: trim.x0 - b.outside, x1: cx, y0: trim.y0 - b.bottom, y1: trim.y1 + b.top }
        : { x0: cx, x1: trim.x1 + b.outside, y0: trim.y0 - b.bottom, y1: trim.y1 + b.top };
      return { folio, trim, clip, creepMm: c };
    };
    return { sheet: s.sheet, side: s.side, signature: s.signature, cover: !!s.cover, placements: [place(s.left, true), place(s.right, false)] };
  });

  return {
    errors,
    sheetSize: sheet,
    area,
    sides,
    maxCreepMm: maxCreep,
    marks: { ...opts.marks, start: markStart, end: markEnd, bleed: b },
    sheetCount: layout?.sheetCount ?? 0,
  };
}
