// The book's spine: which bindings have one, how wide it is, and its look. Pure numbers.
//
// The width can't be read from the PDF: it depends on the paper, not the layout. It is
// calculated from the page count and the paper (the same model as the 3D book), or set to
// the exact figure a print shop gives, which then also sets the 3D book's thickness.

import { Binding } from "./binding.js";
import { coverOf, paperThicknessMm } from "./paper.js";

/** Bindings with a spine you can colour: glued, sewn, cased, and a stitched booklet's fold. */
export const hasSpine = (binding) => binding === Binding.PERFECT || binding === Binding.SEWN
  || binding === Binding.HARDCOVER || binding === Binding.SADDLE;

/** Bindings whose spine can carry printed artwork (a stitched fold only a colour). */
export const spineTakesArtwork = (binding) => binding === Binding.PERFECT || binding === Binding.SEWN || binding === Binding.HARDCOVER;

/** A hardcover's boards (mm): 2 mm greyboard, the usual weight, plus its covering. */
export const BOARD_MM = 2.5;

/** How thick each cover is (mm): a hardcover's boards, else the cover stock. */
export function coverMmFor(binding, paper) {
  if (binding === Binding.HARDCOVER) return BOARD_MM;
  const cover = coverOf(paper);
  return paperThicknessMm(cover.gsm, cover.finish);
}

/**
 * Spine look and size. color: "front" / "back" (sampled from the covers' spine edges) or a
 * hex colour; widthMm: the printer's figure, or null for calculated; rotation: of imported
 * artwork, in quarter turns.
 * @typedef {{color: string, widthMm: number | null, rotation: 0 | 1 | 2 | 3}} Spine
 */

/** @returns {Spine} */
export const defaultSpine = () => ({ color: "front", widthMm: null, rotation: 0 });

/**
 * The calculated spine width: every leaf's thickness, covers included (a leaf is two pages).
 * @param {number} pageCount
 * @param {import("./paper.js").Paper} paper
 */
export function calculatedSpine(pageCount, paper, binding = null) {
  const leaves = Math.max(1, Math.ceil(pageCount / 2));
  const paperMm = paperThicknessMm(paper.gsm, paper.finish);
  const coverMm = coverMmFor(binding, paper);
  const covers = Math.min(2, leaves);
  const inner = leaves - covers;
  return { leaves, inner, covers, paperMm, coverMm, widthMm: inner * paperMm + covers * coverMm };
}

/**
 * How thick the book is closed (mm): the printer's spine width where one is given and the
 * covers fit in it (it sets the 3D book too), else calculated, covers included.
 * @param {{paper: import("./paper.js").Paper, spine?: Spine, binding: string}} setup
 */
export function bookThicknessMm(setup, pageCount) {
  const { paper, spine, binding } = setup;
  const coverMm = coverMmFor(binding, paper);
  if (hasSpine(binding) && spine?.widthMm && paperForSpine(spine.widthMm, pageCount, coverMm)) return spine.widthMm;
  return calculatedSpine(pageCount, paper, binding).widthMm;
}

/**
 * The paper thickness that makes the book exactly `widthMm` thick with these covers, or null
 * if it can't (too few leaves, or covers alone thicker than the spine).
 */
export function paperForSpine(widthMm, pageCount, coverMm) {
  const leaves = Math.ceil(pageCount / 2);
  if (!(widthMm > 0) || leaves <= 2) return null;
  const t = (widthMm - 2 * coverMm) / (leaves - 2);
  return t > 0.01 ? t : null;
}
