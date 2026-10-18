// Binding types and the page-count constraints each one imposes.

export const Binding = {
  SADDLE: "saddle",
  PERFECT: "perfect",
  SEWN: "sewn",
  HARDCOVER: "hardcover",
  SPIRAL: "spiral",
  WIRE_O: "wire-o",
};

export const BINDING_LABELS = {
  saddle: "Staple binding",
  perfect: "Perfect binding",
  sewn: "Sewn binding",
  hardcover: "Hardcover",
  spiral: "Spiral binding",
  "wire-o": "Wire-o binding",
};

/** Spiral and wire-o books are bound with wire; the others aren't. */
export const hasWire = (binding) => binding === Binding.SPIRAL || binding === Binding.WIRE_O;

/**
 * Wire colours: bare metal (silver, gold), or coated wire, which is how coloured wire comes
 * (black, white, and any custom colour).
 */
export const WIRE_COLORS = [
  { id: "silver", label: "Silver", hex: "#c9cbd0", metal: true },
  { id: "black", label: "Black", hex: "#1f2023", metal: false },
  { id: "white", label: "White", hex: "#ebe9e4", metal: false },
  { id: "gold", label: "Gold", hex: "#c8a24e", metal: true },
];

/** Whether a wire colour is bare metal (the presets' own finish); custom colours are coated. */
export const wireIsMetal = (hex) => WIRE_COLORS.find((w) => w.hex === hex.toLowerCase())?.metal ?? false;

/**
 * Side glue (mm from the spine, 0 none): perfect and sewn books of 6 pages or more glue the
 * first and last page to the cover. One rule for the 3D view, the client viewer and Preflight.
 * @param {string} binding
 * @param {number | null | undefined} glueMm the setup's
 * @param {number} pageCount
 */
export const sideGlueMm = (binding, glueMm, pageCount) =>
  (binding === Binding.PERFECT || binding === Binding.SEWN) && pageCount >= 6 && glueMm > 0 ? glueMm : 0;

/**
 * A hardcover's headbands: the cotton bands at head and foot of the spine, by colour. Four,
 * as every swatch row has, and the colour picker for any other (seven pushed the picker off
 * the panel).
 */
export const HEADBAND_COLORS = [
  { id: "natural", label: "Natural", hex: "#ece4d2" },
  { id: "white", label: "White", hex: "#f4f2ee" },
  { id: "black", label: "Black", hex: "#2a2a2c" },
  { id: "red", label: "Red", hex: "#b4342f" },
];

const DEFAULT_SIGNATURE = { perfect: 4, sewn: 16, hardcover: 16 };

/**
 * @typedef {{
 *   binding: string,
 *   pageMultiple: number,            // of the pages that fold: all of them, or between the covers
 *   signaturePages: number | null,   // null: unfolded leaves, or saddle (one signature)
 *   coverPages: number,              // 4: the cover is made apart (outside and inside, front and back)
 *   minPagesHint?: number, maxPagesHint?: number, maxThicknessMm?: number, innerEdgeLossMm: number,
 * }} BindingRule
 * maxThicknessMm: the thickest block the largest coil made takes (plastic spiral 50 mm
 * across, about 44 mm of block; wire-o 1 1/4 inch, about 28 mm).
 * @returns {BindingRule}
 */
export function ruleFor(binding, signaturePages = null) {
  if (signaturePages !== null && (signaturePages < 4 || signaturePages % 4)) {
    throw new Error(`Signature size must be a multiple of 4, got ${signaturePages}`);
  }
  switch (binding) {
    case Binding.SADDLE:
      return { binding, pageMultiple: 4, signaturePages: null, coverPages: 0, maxPagesHint: 64, innerEdgeLossMm: 0 };
    case Binding.PERFECT:
    case Binding.SEWN:
    case Binding.HARDCOVER: { // a hardcover's block is sewn signatures, cased in boards
      // The cover (a paperback's wrap, a hardcover's case) is made apart from the block:
      // only the pages between the covers fold into signatures. The PDF's first two and
      // last two pages are the cover's outside and inside.
      const sig = signaturePages ?? DEFAULT_SIGNATURE[binding];
      return {
        binding,
        pageMultiple: sig,
        signaturePages: sig,
        coverPages: 4,
        minPagesHint: binding === Binding.PERFECT ? 32 : undefined,
        innerEdgeLossMm: 0,
      };
    }
    case Binding.SPIRAL:
      return { binding, pageMultiple: 1, signaturePages: null, coverPages: 0, innerEdgeLossMm: 9, maxThicknessMm: 44 };
    case Binding.WIRE_O:
      return { binding, pageMultiple: 1, signaturePages: null, coverPages: 0, innerEdgeLossMm: 9, maxThicknessMm: 28 };
    default:
      throw new Error(`Unknown binding ${binding}`);
  }
}

export const pagesToAdd = (count, multiple) => (multiple - (count % multiple)) % multiple;

/** The pages that fold into signatures: all of them, or those between a separate cover. */
export const foldedPages = (rule, pageCount) => pageCount - (rule.coverPages ?? 0);
