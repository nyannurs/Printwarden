// Spread vs single-page detection. Auto-detection is a suggestion: the result records
// how it was reached so the UI can present it as such, and the user can override it.

import { mediaSize, trimSize } from "./document.js";
import { ratio } from "./units.js";

// Relative tolerance on aspect ratio. Wider than a naive 2%: without a TrimBox, bleed
// pulls a spread's ratio ~2% below twice the single ratio.
const RATIO_TOLERANCE = 0.03;

export const SpreadMode = { AUTO: "auto", SINGLE: "single", SPREADS: "spreads" };

export const SpreadPattern = {
  ALL_SINGLE: "all-single",
  ALL_SPREADS: "all-spreads",
  // InDesign "export as spreads": single first page, spreads, usually a single last page.
  SPREADS_WITH_SINGLE_COVERS: "spreads-with-single-covers",
  MIXED: "mixed",
  IMPOSED: "imposed", // set by analysis for imposed files, never by detection
};

/**
 * @param {import("./document.js").SourcePage[]} pages
 * @param {string} mode  SpreadMode
 * @param {import("./setup.js").PageSetup | null} manual  a manual setup: its bleed and slug come
 *   off each PDF page before the shapes are compared (its page size is the page wanted, which
 *   may differ from the PDF's: see resizePage in setup.js)
 */
export function detectSpreads(pages, mode = SpreadMode.AUTO, manual = null) {
  const n = pages.length;
  if (n === 0) return result([], mode, "");
  if (mode === SpreadMode.SINGLE) return result(pages.map(() => false), mode, "forced single pages");

  let flags;
  let note = "";
  const size = manual ? (p) => withoutMargins(mediaSize(p), manual) : trimSize;
  const ratios = pages.map((p) => ratio(size(p)));
  const min = Math.min(...ratios);
  const max = Math.max(...ratios);
  if (max / min <= 1 + RATIO_TOLERANCE) {
    // Uniform shape: can't tell without more information.
    flags = pages.map(() => mode === SpreadMode.SPREADS);
    if (mode === SpreadMode.AUTO) {
      note = "all pages are the same shape, so they were taken as single pages";
      if (size(pages[0]).width > size(pages[0]).height) {
        note += " (they are landscape: if these are spreads, choose Spreads)";
      }
    }
  } else {
    // The narrowest pages are singles; pages ~twice as wide are spreads.
    flags = ratios.map((r) => Math.abs(r / (2 * min) - 1) < RATIO_TOLERANCE);
  }

  if (mode === SpreadMode.SPREADS) {
    // Forced: everything is a spread except a first/last page that is clearly single.
    flags = flags.map((f, i) => f || !(i === 0 || i === n - 1) || n === 1);
    if (!flags.some(Boolean)) flags = pages.map(() => true);
    note = "forced spreads";
  }
  return result(flags, mode, note);
}

function result(isSpread, mode, note) {
  return { isSpread, mode, pattern: patternOf(isSpread), note, spreadCount: isSpread.filter(Boolean).length };
}

function patternOf(flags) {
  if (!flags.some(Boolean)) return SpreadPattern.ALL_SINGLE;
  if (flags.every(Boolean)) return SpreadPattern.ALL_SPREADS;
  if (!flags[0] && flags.slice(1, -1).every(Boolean)) return SpreadPattern.SPREADS_WITH_SINGLE_COVERS;
  return SpreadPattern.MIXED;
}

/** A PDF page's size less the bleed and slug of a manual setup (each side's, as on a single page). */
function withoutMargins(size, setup) {
  const m = (k) => setup.bleed[k] + setup.slug[k];
  return { width: size.width - m("inside") - m("outside"), height: size.height - m("top") - m("bottom") };
}
