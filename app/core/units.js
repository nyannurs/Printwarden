// Units, sizes and rectangles. Everything inside core/ is millimetres.

const MM_PER_PT = 25.4 / 72;
export const ptToMm = (pt) => pt * MM_PER_PT;
export const mmToPt = (mm) => mm / MM_PER_PT;

/** Two dimensions closer than this are the same for print purposes. */
const SIZE_TOLERANCE_MM = 0.5;

/** @typedef {{width: number, height: number}} Size */
/** @typedef {{x0: number, y0: number, x1: number, y1: number}} Rect */

export const size = (width, height) => ({ width, height });
export const ratio = (s) => s.width / s.height;
export const rotated = (s) => size(s.height, s.width);
export const isLandscape = (s) => s.width > s.height + SIZE_TOLERANCE_MM;
export const isPortrait = (s) => s.height > s.width + SIZE_TOLERANCE_MM;

export function approxEqual(a, b, tol = SIZE_TOLERANCE_MM) {
  return Math.abs(a.width - b.width) <= tol && Math.abs(a.height - b.height) <= tol;
}

export function formatMm(value) {
  return String(Math.round(value * 10) / 10);
}

export function formatSize(s) {
  return `${formatMm(s.width)} × ${formatMm(s.height)} mm`;
}

/** @returns {Rect} normalised so x0 <= x1, y0 <= y1 */
export function rect(ax, ay, bx, by) {
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

export const rectSize = (r) => size(r.x1 - r.x0, r.y1 - r.y0);

/** Distance from each edge of `inner` out to `outer`. */
export function margins(inner, outer) {
  return {
    left: inner.x0 - outer.x0,
    bottom: inner.y0 - outer.y0,
    right: outer.x1 - inner.x1,
    top: outer.y1 - inner.y1,
  };
}

// Portrait orientation.
export const PAPER_SIZES = {
  A3: size(297, 420),
  A4: size(210, 297),
  A5: size(148, 210),
  A6: size(105, 148),
  B5: size(176, 250),
  SRA3: size(320, 450),
  Letter: size(215.9, 279.4),
  Legal: size(215.9, 355.6),
  Tabloid: size(279.4, 431.8),
};

/** Name of the standard size matching `s` in either orientation, or null. */
export function paperName(s) {
  for (const [name, p] of Object.entries(PAPER_SIZES)) {
    if (approxEqual(s, p, 1)) return name;
    if (approxEqual(s, rotated(p), 1)) return `${name} landscape`;
  }
  return null;
}
