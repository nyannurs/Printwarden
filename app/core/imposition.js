// Which folio goes where on the press sheets. Pure arithmetic, no geometry.
//
// Sheets are 2-up (two folios per side, folded at the centre: the back-left position sits
// behind the front-right, a short-edge turn on a landscape sheet), or, by a folding scheme,
// 8 or 16 pages a sheet (see folding.js): the sheet is folded into a signature, or into
// part of one, nested with the signature's other sheets.

import { Binding, foldedPages } from "./binding.js";
import { scheme as foldingScheme } from "./folding.js";

/**
 * @typedef {{page: number, turned: boolean, depth: number}} SheetCell a folio on a scheme
 *   sheet: upside down (turned), and its leaf's depth in the signature (0 = outermost: creep)
 * @typedef {{
 *   sheet: number, side: "front" | "back", left: number, right: number,
 *   signature: number, depth: number,   // depth 0 = outermost sheet; creep grows with depth
 *   cover?: boolean,                     // the cover's own sheet
 *   cells?: SheetCell[][], rows?: number, cols?: number,   // a scheme sheet: rows of cells, row 0 at the top
 * }} SheetSide
 *   left, right: the folios of a 2-up side; on a scheme side, the lowest and highest.
 * @typedef {{sides: SheetSide[], signaturePages: number, sheetCount: number, sheetPages: number,
 *            coverSheet?: boolean}} SheetLayout
 */

/**
 * Stacked folded signatures. 2-up: each signature a nested saddle-stitch booklet. Within a
 * signature of S pages starting after o pages, sheet k (1 = outermost):
 *   front: o + S - 2(k-1)  |  o + 2(k-1) + 1
 *   back:  o + 2(k-1) + 2  |  o + S - 2(k-1) - 1
 * A scheme of P pages a sheet: each signature is S / P such sheets nested, the outer one
 * holding the signature's first and last P / 2 pages; a sheet's cells are the scheme's,
 * its booklet's page q being the signature's q-th from the front (q <= P / 2) or from the
 * back.
 * @returns {SheetLayout}
 */
export function signatureLayout(pageCount, signaturePages, sheetPages = 2) {
  const S = signaturePages;
  if (S < 4 || S % 4) throw new Error(`Signature size must be a multiple of 4, got ${S}`);
  if (pageCount <= 0 || pageCount % S) {
    throw new Error(`${pageCount} pages cannot be split into ${S}-page signatures`);
  }
  const sides = [];
  if (sheetPages === 2) {
    const perSig = S / 4;
    for (let sig = 0; sig < pageCount / S; sig++) {
      const o = sig * S;
      for (let k = 1; k <= perSig; k++) {
        const sheet = sig * perSig + k;
        const d = 2 * (k - 1);
        const common = { sheet, signature: sig + 1, depth: k - 1 };
        sides.push({ ...common, side: "front", left: o + S - d, right: o + d + 1 });
        sides.push({ ...common, side: "back", left: o + d + 2, right: o + S - d - 1 });
      }
    }
    return { sides, signaturePages: S, sheetCount: sides.length / 2, sheetPages };
  }
  const P = sheetPages;
  if (S % P) throw new Error(`${S}-page signatures cannot be folded from ${P}-page sheets`);
  const sc = foldingScheme(P);
  const perSig = S / P;
  for (let sig = 0; sig < pageCount / S; sig++) {
    const o = sig * S;
    for (let j = 0; j < perSig; j++) {
      const sheet = sig * perSig + j + 1;
      const local = (q) => (q <= P / 2 ? j * (P / 2) + q : S - (j + 1) * (P / 2) + (q - P / 2));
      const cellsOf = (grid) => grid.map((row) => row.map((c) => {
        const l = local(c.page);
        return { page: o + l, turned: c.turned, depth: Math.floor(Math.min(l - 1, S - l) / 2) };
      }));
      const common = { sheet, signature: sig + 1, depth: j, rows: sc.rows, cols: sc.cols };
      for (const [side, grid] of /** @type {const} */ ([["front", sc.front], ["back", sc.back]])) {
        const cells = cellsOf(grid);
        const pages = cells.flat().map((c) => c.page);
        sides.push({ ...common, side, cells, left: Math.min(...pages), right: Math.max(...pages) });
      }
    }
  }
  return { sides, signaturePages: S, sheetCount: sides.length / 2, sheetPages };
}

/** Saddle stitch: one signature of every page. (Exported for its tests, tests/core.test.js and v2.test.js.) */
export const saddleStitchLayout = (pageCount, sheetPages = 2) => signatureLayout(pageCount, pageCount, sheetPages);

/** Whether a scheme of `sheetPages` a sheet folds `signaturePages` signatures (2: always). */
const schemeFits = (sheetPages, signaturePages) => sheetPages === 2 || (signaturePages > 0 && signaturePages % sheetPages === 0);

/**
 * The sheet layout, or null when the binding is not imposed, the count is invalid, or the
 * scheme doesn't fold the signatures.
 */
export function layoutFor(rule, pageCount, sheetPages = 2) {
  if (rule.coverPages) return withSeparateCover(rule, pageCount, sheetPages);
  if (pageCount <= 0 || pageCount % rule.pageMultiple) return null;
  if (rule.binding === Binding.SADDLE) return schemeFits(sheetPages, pageCount) ? saddleStitchLayout(pageCount, sheetPages) : null;
  if (rule.signaturePages) return schemeFits(sheetPages, rule.signaturePages) ? signatureLayout(pageCount, rule.signaturePages, sheetPages) : null;
  return null;
}

/**
 * Perfect, sewn and hardcover books: the pages between the covers fold into signatures;
 * the cover comes after them on a sheet of its own (outside: back | front; inside: inside
 * front | inside back), as the separate part it is when made.
 */
function withSeparateCover(rule, pageCount, sheetPages) {
  const inner = foldedPages(rule, pageCount);
  if (inner <= 0 || inner % rule.pageMultiple) return null;
  if (!schemeFits(sheetPages, rule.signaturePages)) return null;
  const block = signatureLayout(inner, rule.signaturePages, sheetPages);
  const sides = block.sides.map((s) => ({
    ...s, left: s.left + 2, right: s.right + 2,
    ...(s.cells ? { cells: s.cells.map((row) => row.map((c) => ({ ...c, page: c.page + 2 }))) } : {}),
  }));
  const sheet = block.sheetCount + 1;
  const common = { sheet, signature: 0, depth: 0, cover: true };
  sides.push({ ...common, side: "front", left: pageCount, right: 1 });
  sides.push({ ...common, side: "back", left: 2, right: pageCount - 1 });
  return { sides, signaturePages: rule.signaturePages, sheetCount: sheet, coverSheet: true, sheetPages };
}

/** Creep for a sheet at `depth` within its signature. Zero on the outermost sheet. */
export const creepMm = (depth, paperThicknessMm) => depth * paperThicknessMm;
