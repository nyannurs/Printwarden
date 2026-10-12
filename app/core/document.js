// Source pages as the PDF describes them. Loading happens in app/pdf/; this module is
// plain data so core/ never depends on a PDF library.

import { rectSize, rotated } from "./units.js";

/**
 * @typedef {{
 *   index: number,                 // 0-based position in the PDF
 *   mediaBox: import("./units.js").Rect,
 *   trimBox: import("./units.js").Rect | null,
 *   bleedBox: import("./units.js").Rect | null,
 *   rotation: number,              // /Rotate: 0, 90, 180, 270
 *   label?: string | null,         // the PDF's page label (InDesign: section numbering)
 * }} SourcePage
 */

/** Displayed size of the media box, after /Rotate. */
export function mediaSize(page) {
  const s = rectSize(page.mediaBox);
  return page.rotation % 180 ? rotated(s) : s;
}

/** Displayed size of the trim box (media box if none), after /Rotate. */
export function trimSize(page) {
  const s = rectSize(page.trimBox ?? page.mediaBox);
  return page.rotation % 180 ? rotated(s) : s;
}
