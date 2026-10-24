// Helpers the tests share: built from the app's own pieces, used only here (the app has no need
// of them). The app's modules export a few things only their tests use besides; each says so
// where it is defined.

import { contentKey } from "../app/core/book.js";
import { facingPairs } from "../app/core/pairing.js";
import { sides } from "../app/core/setup.js";

/**
 * For each content page, the content page it faces (null = nothing or a blank). Keyed by
 * content identity, so books built from the same source can be compared (pages added or taken
 * out move pages, but pages that faced each other should still).
 */
export function partnerMap(book) {
  const partners = new Map();
  for (const { left, right } of facingPairs(book)) {
    const lk = left && contentKey(left);
    const rk = right && contentKey(right);
    if (lk) partners.set(lk, rk ?? null);
    if (rk) partners.set(rk, lk ?? null);
  }
  return partners;
}

/**
 * A page setup typed in, as the Page panel makes one: `bleed` and `slug` mm on every side, or
 * per side ({top, bottom, inside, outside}).
 * @returns {import("../app/core/setup.js").PageSetup}
 */
export function manualSetup(width, height, bleed = 0, slug = 0) {
  return {
    mode: "manual",
    width,
    height,
    bleed: typeof bleed === "number" ? sides(bleed) : bleed,
    slug: typeof slug === "number" ? sides(slug) : slug,
  };
}
