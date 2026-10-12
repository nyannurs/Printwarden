// Which folio goes where on the press sheets. Pure arithmetic, no geometry.
//
// Every sheet is 2-up: two folios per side, folded at the centre. The back-left
// position sits behind the front-right (short-edge flip on a landscape sheet).

import { Binding, foldedPages } from "./binding.js";

/**
 * @typedef {{
 *   sheet: number, side: "front" | "back", left: number, right: number,
 *   signature: number, depth: number,   // depth 0 = outermost sheet; creep grows with depth
 *   cover?: boolean,                     // the cover's own sheet
 * }} SheetSide
 * @typedef {{sides: SheetSide[], signaturePages: number, sheetCount: number}} SheetLayout
 */

/**
 * Stacked folded signatures, each a nested saddle-stitch booklet. Within a signature
 * of S pages starting after o pages, sheet k (1 = outermost):
 *   front: o + S - 2(k-1)  |  o + 2(k-1) + 1
 *   back:  o + 2(k-1) + 2  |  o + S - 2(k-1) - 1
 * @returns {SheetLayout}
 */
export function signatureLayout(pageCount, signaturePages) {
  const S = signaturePages;
  if (S < 4 || S % 4) throw new Error(`Signature size must be a multiple of 4, got ${S}`);
  if (pageCount <= 0 || pageCount % S) {
    throw new Error(`${pageCount} pages cannot be split into ${S}-page signatures`);
  }
  const perSig = S / 4;
  const sides = [];
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
  return { sides, signaturePages: S, sheetCount: sides.length / 2 };
}

export const saddleStitchLayout = (pageCount) => signatureLayout(pageCount, pageCount);

/** The sheet layout, or null when the binding is not imposed or the count is invalid. */
export function layoutFor(rule, pageCount) {
  if (rule.coverPages) return withSeparateCover(rule, pageCount);
  if (pageCount <= 0 || pageCount % rule.pageMultiple) return null;
  if (rule.binding === Binding.SADDLE) return saddleStitchLayout(pageCount);
  if (rule.signaturePages) return signatureLayout(pageCount, rule.signaturePages);
  return null;
}

/**
 * Perfect, sewn and hardcover books: the pages between the covers fold into signatures;
 * the cover comes after them on a sheet of its own (outside: back | front; inside: inside
 * front | inside back), as the separate part it is when made.
 */
function withSeparateCover(rule, pageCount) {
  const inner = foldedPages(rule, pageCount);
  if (inner <= 0 || inner % rule.pageMultiple) return null;
  const block = signatureLayout(inner, rule.signaturePages);
  const sides = block.sides.map((s) => ({ ...s, left: s.left + 2, right: s.right + 2 }));
  const sheet = block.sheetCount + 1;
  const common = { sheet, signature: 0, depth: 0, cover: true };
  sides.push({ ...common, side: "front", left: pageCount, right: 1 });
  sides.push({ ...common, side: "back", left: 2, right: pageCount - 1 });
  return { sides, signaturePages: rule.signaturePages, sheetCount: sheet, coverSheet: true };
}

/** Creep for a sheet at `depth` within its signature. Zero on the outermost sheet. */
export const creepMm = (depth, paperThicknessMm) => depth * paperThicknessMm;
