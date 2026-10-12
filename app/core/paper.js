// Paper stock: colour, weight and finish. Drives the 3D look (colour, gloss, show-through,
// thickness) and the creep / spine arithmetic.

export const PAPER_COLORS = [
  { id: "white", label: "Bright white", hex: "#ffffff" },
  { id: "natural", label: "Natural white", hex: "#f7f4ec" },
  { id: "cream", label: "Cream", hex: "#f3ead6" },
  { id: "recycled", label: "Recycled gray", hex: "#e9e7e1" },
];

// specular: how much light the surface reflects as sheen. Uncoated paper scatters almost
// everything, which is also why its blacks stay deep; gloss coating reflects visibly.
export const PAPER_FINISHES = {
  uncoated: { label: "Uncoated", bulk: 1.25, roughness: 0.95, specular: 0.12, clearcoat: 0 },
  matte: { label: "Matte coated", bulk: 1.0, roughness: 0.7, specular: 0.3, clearcoat: 0.05 },
  gloss: { label: "Gloss coated", bulk: 0.9, roughness: 0.4, specular: 0.6, clearcoat: 0.45 },
};

/**
 * The inside pages' stock, and the cover's: separate from the start (the same white,
 * uncoated, 120 gsm), so changing the pages never changes the cover. A null cover value (from
 * a setup of before 0.17.10) is the pages'.
 * @typedef {{color: string, gsm: number, finish: keyof typeof PAPER_FINISHES,
 *            coverColor: string | null, coverGsm: number | null, coverFinish: keyof typeof PAPER_FINISHES | null}} Paper
 */

/** @returns {Paper} */
export const defaultPaper = () => ({
  color: "#ffffff", gsm: 120, finish: "uncoated", coverColor: "#ffffff", coverGsm: 120, coverFinish: "uncoated",
});

/** The cover's stock, with the pages' values where it has none of its own. */
export const coverOf = (paper) => ({
  color: paper.coverColor ?? paper.color,
  gsm: paper.coverGsm ?? paper.gsm,
  finish: paper.coverFinish ?? paper.finish,
});

/** Sheet thickness in mm, from grammage and the finish's typical bulk. */
export function paperThicknessMm(gsm, finish = "uncoated") {
  return (gsm / 1000) * (PAPER_FINISHES[finish]?.bulk ?? 1.2);
}

/**
 * How much the other side of a leaf shows through (0–1).
 *
 * Paper opacity rises steeply with weight: ~90 % at 60 gsm, ~96 % at 90 gsm, ~99 % at
 * 150 gsm. What remains visible is only strong, dark content on the back, and only
 * faintly; above ~170 gsm it is effectively nothing. Coating adds a little opacity.
 */
export function showThrough(gsm, finish = "uncoated") {
  const base = 0.09 * Math.exp(-(gsm - 60) / 28);
  return Math.min(0.12, finish === "uncoated" ? base : base * 0.7);
}
