// Document setup, modelled on InDesign's New Document dialog: page size, then bleed
// and slug per side as top / bottom / inside / outside.
//
// "Inside" is the spine side. On a recto (odd folio) that is the left edge, on a verso
// the right edge. PDF boxes are absolute (left/right), so conversion depends on the page.

import { margins, rect, rectSize, size } from "./units.js";

/**
 * @typedef {{top: number, bottom: number, inside: number, outside: number}} Sides
 * @typedef {{
 *   mode: "auto" | "manual",
 *   width: number, height: number,
 *   bleed: Sides, slug: Sides,
 *   fromBoxes?: boolean,
 * }} PageSetup
 */

export const sides = (all = 0) => ({ top: all, bottom: all, inside: all, outside: all });

/** Convert inside/outside to left/right for a page on the given side of the spine. */
function toLeftRight(s, isRecto) {
  return isRecto
    ? { left: s.inside, right: s.outside, top: s.top, bottom: s.bottom }
    : { left: s.outside, right: s.inside, top: s.top, bottom: s.bottom };
}

/** Left/right edges of a whole spread (or imposed sheet): both outer edges are "outside". */
function spreadLeftRight(s) {
  return { left: s.outside, right: s.outside, top: s.top, bottom: s.bottom };
}

const addSides = (a, b) => ({
  top: a.top + b.top,
  bottom: a.bottom + b.bottom,
  inside: a.inside + b.inside,
  outside: a.outside + b.outside,
});

/** The media size a page exported with these settings should have. */
export function expectedMediaSize(setup, isSpread) {
  const m = addSides(setup.bleed, setup.slug);
  const height = setup.height + m.top + m.bottom;
  const width = isSpread ? 2 * setup.width + 2 * m.outside : setup.width + m.inside + m.outside;
  return size(width, height);
}

/**
 * Derive the setup from the PDF's own boxes, the way InDesign wrote them.
 *
 * Robust to odd files: every value is the median over all pages, so a cover exported
 * differently doesn't skew the result; values are snapped to clean numbers (InDesign's
 * pt conversions give 147.99993 for 148); inside/outside are measured on the pages
 * where they can be told apart (single pages), and any size is accepted, DIN or not.
 *
 * Note: the area outside the BleedBox may be slug *or* printer marks; a PDF doesn't
 * say which. It is reported as slug either way, since both are trimmed off.
 *
 * @param {import("./document.js").SourcePage[]} pages
 * @param {boolean[]} isSpread   true for spreads, and for every sheet of an imposed file
 * @returns {PageSetup}
 */
export function setupFromPdf(pages, isSpread) {
  if (!pages.length) return { mode: "auto", width: 0, height: 0, bleed: sides(0), slug: sides(0), fromBoxes: false };
  const halve = (w, i) => (isSpread[i] ? w / 2 : w);
  const withTrim = pages.map((p, i) => ({ p, i })).filter(({ p }) => p.trimBox);

  if (!withTrim.length) {
    return {
      mode: "auto",
      width: snap(median(pages.map((p, i) => halve(rectSize(p.mediaBox).width, i)))),
      height: snap(median(pages.map((p) => rectSize(p.mediaBox).height))),
      bleed: sides(0),
      slug: sides(0),
      fromBoxes: false,
    };
  }

  const bleedM = [];
  const slugM = [];
  for (const { p, i } of withTrim) {
    const bleedBox = p.bleedBox ?? p.mediaBox;
    const b = margins(p.trimBox, bleedBox);
    const s = p.bleedBox ? margins(bleedBox, p.mediaBox) : { left: 0, right: 0, top: 0, bottom: 0 };
    // Page i of a single-page export is folio i+1: recto when i is even.
    const recto = isSpread[i] ? null : i % 2 === 0;
    bleedM.push(toSides(b, recto));
    slugM.push(toSides(s, recto));
  }
  return {
    mode: "auto",
    width: snap(median(withTrim.map(({ p, i }) => halve(rectSize(p.trimBox).width, i)))),
    height: snap(median(withTrim.map(({ p }) => rectSize(p.trimBox).height))),
    bleed: medianSides(bleedM),
    slug: medianSides(slugM),
    fromBoxes: true,
  };
}

/** Margins as sides; `inside` is null where it can't be measured (spreads). */
function toSides(m, recto) {
  if (recto === null) return { top: m.top, bottom: m.bottom, inside: null, outside: (m.left + m.right) / 2 };
  return {
    top: m.top,
    bottom: m.bottom,
    inside: recto ? m.left : m.right,
    outside: recto ? m.right : m.left,
  };
}

function medianSides(list) {
  const pick = (key) => {
    const values = list.map((s) => s[key]).filter((v) => v !== null);
    return values.length ? Math.max(0, snap(median(values))) : null;
  };
  const out = { top: pick("top"), bottom: pick("bottom"), inside: pick("inside"), outside: pick("outside") };
  if (out.inside === null) out.inside = out.outside; // spreads only: assume symmetric bleed
  return out;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Round to 0.01 mm, and to a whole or half millimetre when within 0.02 mm of one. */
export function snap(v) {
  const half = Math.round(v * 2) / 2;
  if (Math.abs(v - half) < 0.02) return half;
  return Math.round(v * 100) / 100;
}

/**
 * The two-page area on an imposed sheet (PDF user space, mm).
 * With a TrimBox (auto mode) it is the TrimBox. Otherwise the page size from the setup,
 * two pages wide, centred on the media box: robust to any marks margin around it.
 * (Exported for its tests, tests/v2.test.js: the app uses it only here.)
 */
export function sheetAreaFor(source, setup) {
  if (setup.mode === "auto" && source.trimBox) return source.trimBox;
  const mb = source.mediaBox;
  const cx = (mb.x0 + mb.x1) / 2;
  const cy = (mb.y0 + mb.y1) / 2;
  const w = setup.mode === "auto" ? rectSize(mb).width / 2 : setup.width;
  const h = setup.mode === "auto" ? rectSize(mb).height : setup.height;
  return rect(cx - w, cy - h / 2, cx + w, cy + h / 2);
}

/**
 * Where the finished page sits on its source page, in PDF user space (mm).
 *
 * Auto mode trusts the PDF's TrimBox when present. Manual mode (or a PDF without a
 * TrimBox) insets the MediaBox by bleed + slug on each side; manual mode then makes that
 * page the size set (resizePage): the content keeps its size, the page grows or shrinks
 * round it. Imposed sheets use sheetAreaFor and are split in half.
 *
 * @param {import("./document.js").SourcePage} source
 * @param {"full" | "left" | "right"} half
 * @param {boolean} isRecto  side of the spine the finished page lands on
 * @param {PageSetup} setup
 * @param {boolean} imposed
 */
export function trimRectFor(source, half, isRecto, setup, imposed = false) {
  if (source.file === "cover") return source.trimBox; // its region of the cover file's page (coverPages, analysis.js)
  let whole;
  if (imposed) {
    whole = sheetAreaFor(source, setup);
  } else if (setup.mode === "auto" && source.trimBox) {
    whole = source.trimBox;
  } else {
    const m = addSides(setup.bleed, setup.slug);
    const lr = half === "full" ? toLeftRight(m, isRecto) : spreadLeftRight(m);
    const mb = source.mediaBox;
    whole = rect(mb.x0 + lr.left, mb.y0 + lr.bottom, mb.x1 - lr.right, mb.y1 - lr.top);
    if (setup.mode === "manual") whole = resizePage(whole, half, isRecto, setup);
  }
  if (half === "full") return whole;
  const mid = (whole.x0 + whole.x1) / 2; // split at the trim centre, never the media centre
  return half === "left" ? { ...whole, x1: mid } : { ...whole, x0: mid };
}

/**
 * The page as the setup's size, round the page the PDF has (`whole`): the content is never
 * scaled. Across, the page grows or shrinks away from the spine, as on a bound book (a
 * right-hand page at its right edge, a left-hand one at its left, a spread at both outer
 * edges, so it stays whole across the fold); up and down, evenly. Beyond the PDF's page:
 * blank paper; inside it: trimmed off.
 */
function resizePage(whole, half, isRecto, setup) {
  const w = half === "full" ? setup.width : 2 * setup.width;
  const h = setup.height;
  const cy = (whole.y0 + whole.y1) / 2;
  let x0;
  if (half !== "full") x0 = (whole.x0 + whole.x1) / 2 - w / 2; // a spread: about its fold
  else x0 = isRecto ? whole.x0 : whole.x1 - w; // a page: from its spine edge
  return rect(x0, cy - h / 2, x0 + w, cy + h / 2);
}

/**
 * Trim rect grown by the bleed on the three outer sides, clipped to the media box (but never
 * inside the trim: a page made larger than the PDF's has blank paper there, not less page).
 * The spine side stays at the trim: on a 2-up sheet the two pages butt against each
 * other at the fold, and inner bleed would overlap the neighbouring page. (This is
 * what InDesign's Print Booklet gets wrong.) Split spread halves are clipped the same
 * way, which makes them meet exactly at the fold.
 *
 * For imposed sheets the outer edge is wherever the page sits on the sheet (a page on
 * the left of a sheet has its outer edge on the left), not its recto/verso side.
 */
export function bleedRectFor(source, half, isRecto, setup, trimRect, imposed = false) {
  const b = setup.bleed;
  let lr;
  if (imposed) {
    lr = half === "left"
      ? { left: b.outside, right: 0, top: b.top, bottom: b.bottom }
      : { left: 0, right: b.outside, top: b.top, bottom: b.bottom };
  } else {
    lr = toLeftRight({ ...b, inside: 0 }, isRecto);
  }
  const mb = source.mediaBox;
  return {
    x0: Math.min(trimRect.x0, Math.max(mb.x0, trimRect.x0 - lr.left)),
    y0: Math.min(trimRect.y0, Math.max(mb.y0, trimRect.y0 - lr.bottom)),
    x1: Math.max(trimRect.x1, Math.min(mb.x1, trimRect.x1 + lr.right)),
    y1: Math.max(trimRect.y1, Math.min(mb.y1, trimRect.y1 + lr.top)),
  };
}
