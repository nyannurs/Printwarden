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
 *
 * volume: the paper's bulk (cm³/g: thickness = weight × volume), or null for the finish's
 * typical one. Papers of one weight differ a lot in thickness (a bulky uncoated book paper
 * nearly twice a gloss one), and a printer quotes the caliper (µm), so it can be set: the
 * panel shows it as the thickness and keeps the volume, which a paper keeps as its weight
 * changes. Choosing another finish is choosing another paper: the volume goes back to null.
 * @typedef {{color: string, gsm: number, finish: keyof typeof PAPER_FINISHES, volume?: number | null,
 *            coverColor: string | null, coverGsm: number | null, coverFinish: keyof typeof PAPER_FINISHES | null,
 *            coverVolume?: number | null, endpaperColor?: string | null}} Paper
 *   endpaperColor: a hardcover's endpapers (the pastedowns inside the boards and the lining
 *   across the joints), hex; null = the pages' colour
 */

/** @returns {Paper} */
export const defaultPaper = () => ({
  color: "#ffffff", gsm: 120, finish: "uncoated", volume: null,
  coverColor: "#ffffff", coverGsm: 120, coverFinish: "uncoated", coverVolume: null,
});

/** The cover's stock, with the pages' values where it has none of its own. */
export const coverOf = (paper) => ({
  color: paper.coverColor ?? paper.color,
  gsm: paper.coverGsm ?? paper.gsm,
  finish: paper.coverFinish ?? paper.finish,
  volume: paper.coverVolume ?? null,
});

/** A stock's bulk (cm³/g): its own, or the finish's typical one. */
export const volumeOf = (finish, volume = null) => volume ?? PAPER_FINISHES[finish]?.bulk ?? 1.2;

/** Sheet thickness in mm, from grammage and bulk (the stock's own volume, or the finish's typical). */
export function paperThicknessMm(gsm, finish = "uncoated", volume = null) {
  return (gsm / 1000) * volumeOf(finish, volume);
}

/** A stock's caliper in whole µm, as printers quote it. */
export const caliperUm = (stock) => Math.round(paperThicknessMm(stock.gsm, stock.finish, stock.volume ?? null) * 1000);

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
