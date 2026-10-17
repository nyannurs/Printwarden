// Planning the sharp detail images for a page in view. Pure numbers, no DOM.
//
// A page seen at an angle needs far more resolution near the camera than far away. One
// image at one resolution either wastes memory on the far part or, capped, leaves the
// near part soft. So the visible region is cut into strips across the direction in which
// the need changes most, and each strip is rendered at what its own part of the screen
// needs. Like a PDF viewer's tiles, but perspective-aware.

/**
 * @param {{region: {u0: number, v0: number, u1: number, v1: number},
 *          samples: {u: number, v: number, pxPerMm: number}[]}} view
 *   what's on screen (texture uv, v = 0 at the head) and the screen density measured at
 *   sample points (device pixels per mm of paper)
 * @param {{width: number, height: number}} pageMm
 * @param {{supersample?: number, maxTiles?: number, maxSide?: number, maxPixels?: number,
 *          maxStripPixels?: number, step?: number}} options  step: density ratio one strip
 *   may span; maxStripPixels: split finer so no single strip is costly to upload
 * @returns {{region: {u0: number, v0: number, u1: number, v1: number}, pxPerMm: number,
 *            widthPx: number, heightPx: number}[]}
 */
/**
 * Whether a page's base image is fine enough for the screen everywhere the plan would put a
 * strip: at least one image pixel per screen pixel at each strip's densest point (a plan's
 * density is the screen's times `supersample`). Then the page keeps its base image: drawn as
 * crisp as a strip would be, and nothing on screen changes as the view comes to rest.
 * @param {ReturnType<typeof planDetail>} plan
 * @param {number} baseDensity the base image's pixels per mm
 */
export function baseSuffices(plan, baseDensity, supersample) {
  return plan.every((tile) => tile.pxPerMm / supersample <= baseDensity);
}

/**
 * How tall a video's page image should be rendered for a frame that needs `px` pixels a
 * millimetre of a page `mm` tall, given the image on hand (`have` px tall, or null): null to
 * keep it, else the new height. The image carries `supersample` pixels a video pixel where
 * the page is densest; it is rendered again as soon as a frame needs it sharper, or needs
 * under 1 / `slack` of it (read from a smaller mipmap level a sharper image goes softer, and
 * it holds memory for nothing), at `ahead` times the need, so a page coming nearer is redone
 * every few frames, not every frame.
 */
export function videoImageHeight(px, mm, have, maxHeight, { supersample = 1.25, slack = 1.3, ahead = 1.1 } = {}) {
  if (!(px > 0) || !(mm > 0)) return null;
  const least = Math.min(maxHeight, Math.max(256, Math.ceil(supersample * px * mm)));
  if (have != null && have >= least && have <= least * slack) return null;
  return Math.min(maxHeight, Math.round(least * ahead));
}

export function planDetail(view, pageMm, options = {}) {
  const { supersample = 2, maxTiles = 6, maxSide = 8192, maxPixels = 24e6, maxStripPixels = Infinity, step = 1.3 } = options;
  const { region, samples } = view;
  if (!samples.length) return [];
  const densities = samples.map((s) => s.pxPerMm);
  const lo = Math.max(1e-6, Math.min(...densities));
  const hi = Math.max(...densities);

  // Along which axis does the need change most? Compare the densest sample's position
  // with the thinnest's.
  const dense = samples[densities.indexOf(hi)];
  const thin = samples[densities.indexOf(lo)];
  const du = Math.abs(dense.u - thin.u) * pageMm.width;
  const dv = Math.abs(dense.v - thin.v) * pageMm.height;
  const axis = du >= dv ? "u" : "v";

  const [a0, a1] = axis === "u" ? [region.u0, region.u1] : [region.v0, region.v1];
  // Pixels the whole region would take at the densest need (an upper bound).
  const areaMm = (region.u1 - region.u0) * pageMm.width * (region.v1 - region.v0) * pageMm.height;
  const total = Math.min(maxPixels, areaMm * (hi * supersample) ** 2);
  const count = Math.max(1, Math.min(maxTiles,
    Math.max(Math.ceil(Math.log(hi / lo) / Math.log(step)), Math.ceil(total / maxStripPixels))));
  const tiles = [];
  for (let k = 0; k < count; k++) {
    const s0 = a0 + ((a1 - a0) * k) / count;
    const s1 = a0 + ((a1 - a0) * (k + 1)) / count;
    const r = axis === "u" ? { ...region, u0: s0, u1: s1 } : { ...region, v0: s0, v1: s1 };
    // Densest sample inside the strip, or within half a strip of it (samples are sparse).
    const pad = (s1 - s0) / 2;
    let need = 0;
    for (const s of samples) {
      const c = axis === "u" ? s.u : s.v;
      if (c >= s0 - pad && c <= s1 + pad) need = Math.max(need, s.pxPerMm);
    }
    if (!need) need = hi;
    const wMm = (r.u1 - r.u0) * pageMm.width;
    const hMm = (r.v1 - r.v0) * pageMm.height;
    let density = need * supersample;
    const scale = Math.min(1, maxSide / (wMm * density), maxSide / (hMm * density),
      Math.sqrt(maxPixels / count / (wMm * hMm * density * density)));
    density *= scale;
    tiles.push({
      region: r,
      pxPerMm: density,
      widthPx: Math.max(1, Math.round(wMm * density)),
      heightPx: Math.max(1, Math.round(hMm * density)),
    });
  }
  return tiles;
}
