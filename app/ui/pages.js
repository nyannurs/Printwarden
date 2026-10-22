// Page images for the 3D view: every page of the document, nearest first, at a size the
// whole book fits in memory with (its base image, the pyramid's level 0: the sharper levels
// are tiles, kept as a map keeps them, see ui/tiles.js); the timeline's thumbnails. All of them
// as the page's inks (pdf/mupdf-render.js, mode "ink"): the 3D view and the timeline turn them
// into colour through the ink table, so the profile and the plates change them at once.

import { pageSizeOf } from "../core/analysis.js";
import { baseHeight, THUMB_HEIGHT } from "../pdf/render.js";
import { scene, state } from "./app.js";
import { showLoad } from "./dom.js";
import { applySpine, averageEdge } from "./spine-panel.js";

export const CAPTURE_PRIORITY = -3; // a capture's images: never cancelled by the view
export const DETAIL_MAX_SIDE = 8192; // a capture's strips (see ui/capture.js prepareCaptureTile)

function textureKey(folio) {
  const g = state.analysis.geometry[folio - 1];
  if (!g) return "blank";
  const src = state.analysis.book.pages[folio - 1].source;
  const rect = [g.trim.x0, g.trim.y0, g.trim.x1, g.trim.y1].map((v) => v.toFixed(2));
  return `${src.index}|${rect}`; // inks: the profile and the plates don't change the image
}

/** A rendered image (ImageBitmap) of a finished page, or null for a blank. */
export async function pageImage(folio, height, priority, options = {}) {
  const g = state.analysis.geometry[folio - 1];
  if (!g) return null;
  const page = state.analysis.book.pages[folio - 1];
  const r = await state.rendererReady;
  return r.render(page.source.index, g.trim, height, priority, options);
}

/** Part of a page (`rect`, mm in PDF user space). */
export async function pageRegionImage(folio, rect, height, priority, options = {}) {
  const page = state.analysis.book.pages[folio - 1];
  const r = await state.rendererReady;
  return r.render(page.source.index, rect, height, priority, options);
}

const thumbs = new Map(); // key -> Promise of the page's inks, THUMB_HEIGHT tall

/** Timeline thumbnail: the page's inks, small (the timeline draws them through the ink table, see ui/inkview.js). */
export function thumbnail(folio) {
  const key = textureKey(folio);
  if (!thumbs.has(key)) thumbs.set(key, pageImage(folio, THUMB_HEIGHT, 100 + folio, { mode: "ink" }));
  return thumbs.get(key);
}

export function loadAllTextures() {
  const a = state.analysis;
  const gen = state.generation;
  const n = a.book.pages.length;
  const size = pageSizeOf(a) ?? { width: 1, height: 1 };
  const height = baseHeight(n, size.width / size.height);
  const centre = 2 * scene.opening + 0.5;
  let pending = 0;

  for (let folio = 1; folio <= n; folio++) {
    const key = textureKey(folio);
    const have = state.textures.get(folio);
    if (have?.key === key && have.height >= height) continue;
    if (have && have.key !== key) scene.forgetTiles(folio); // its tiles were of the page that was
    if (key === "blank") {
      state.textures.set(folio, { key, height: Infinity, blank: true });
      scene.setPageTexture(folio, null);
      continue;
    }
    // An outdated image stays on screen until its replacement arrives: no flashing.
    const distance = Math.abs(folio - centre);
    const apply = (h) => (image) => {
      // (Not freed when not taken: a render asked for twice is one image, and the other
      // request may have handed it on.)
      const cur = state.textures.get(folio);
      if (gen !== state.generation || !image || (cur?.key === key && cur.height >= h)) return;
      // Kept here: what the page is, and a cover's inks along the spine (see coverEdge).
      // The image goes to the 3D view, which frees it once it is on the GPU.
      const edge = folio === 1 || folio === n ? averageEdge(image, folio % 2 === 1) : null;
      state.textures.set(folio, { key, height: h, edge });
      scene.setPageTexture(folio, image);
      if (folio === 1 || folio === n) applySpine(); // the spine colour may come from a cover
    };
    // Per page: its image, nearest first.
    pending++;
    pageImage(folio, height, 100 + distance, { mode: "ink", cache: "pending" })
      .then(apply(height))
      .catch(() => {})
      .finally(() => {
        pending--;
        if (gen === state.generation) showLoad((n - pending) / n);
      });
  }
  showLoad(pending ? (n - pending) / n : null);
}

/** Thumbnails made again (a new file, a new CMYK profile). */
export function forgetThumbnails() {
  thumbs.clear();
}
