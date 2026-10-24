// Page images for the 3D view: every page of the document, nearest first, at a size the
// whole book fits in memory with (its base image, the pyramid's level 0: the sharper levels
// are tiles, kept as a map keeps them, see ui/tiles.js); the timeline's thumbnails. All of them
// as the page's inks (pdf/mupdf-render.js, mode "ink"): the 3D view and the timeline turn them
// into colour through the ink table, so the profile and the process plates change them at once.
// What the inks themselves depend on besides the page (the profile, which RGB content is
// converted into, and the spot plates left out) is each image's stamp (inkStamp): when it
// changes, the page is drawn again in the background, shown as it was until then (redrawInks).

import { pageSizeOf } from "../core/analysis.js";
import { baseHeight, THUMB_HEIGHT } from "../pdf/render.js";
import { filmstrip, scene, state } from "./app.js";
import { showLoad } from "./dom.js";
import { applySpine, averageEdge } from "./spine-panel.js";
import { refreshTiles } from "./tiles.js";

export const CAPTURE_PRIORITY = -3; // a capture's images: never cancelled by the view
export const DETAIL_MAX_SIDE = 8192; // a capture's strips (see ui/capture.js prepareCaptureTile)

/** Which part of which source page a folio shows ("blank": none). */
function textureKey(folio) {
  const g = state.analysis.geometry[folio - 1];
  if (!g) return "blank";
  const src = state.analysis.book.pages[folio - 1].source;
  const rect = [g.trim.x0, g.trim.y0, g.trim.x1, g.trim.y1].map((v) => v.toFixed(2));
  return `${src.index}|${rect}`;
}

/**
 * What a source page's inks are drawn with besides the page: the profile, and those of its
 * spots composited into its process inks (past its spot channels, see pdf/mupdf-render.js)
 * that are left out (state.drawn). Images of the page with another stamp are outdated. (Its
 * spot channels are switched where they are shown: they don't change the image.)
 * @param {number} sourceIndex the page in its file (a cover file's from COVER_BASE)
 */
export function inkStamp(sourceIndex) {
  const off = state.drawn.spotsOff.filter((name) => state.spots.some((s) => s.name === name && s.composited.includes(sourceIndex)));
  return `${state.drawn.profile}|${off.join("|")}`;
}

/** A folio's stamp (inkStamp), or "" for a blank. */
export function folioStamp(folio) {
  const src = state.analysis.book.pages[folio - 1]?.source;
  return src ? inkStamp(src.index) : "";
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

const thumbs = new Map(); // key and stamp -> Promise of the page's inks, THUMB_HEIGHT tall

/** Timeline thumbnail: the page's inks, small (the timeline draws them through the ink table, see ui/inkview.js). */
export function thumbnail(folio) {
  const key = `${textureKey(folio)}#${folioStamp(folio)}`;
  if (!thumbs.has(key)) thumbs.set(key, pageImage(folio, THUMB_HEIGHT, 100 + folio, { mode: "ink" }));
  return thumbs.get(key);
}

/**
 * The profile or the spot plates left out changed (state.drawn): what was being drawn for the
 * old is dropped (a capture's images aside), and every page whose stamp changed is drawn again,
 * its base image, thumbnail and tiles, each shown as it was until its new one comes.
 */
export function redrawInks() {
  if (!state.analysis) return;
  state.renderer?.cancel((job) => job.mode === "ink" && job.priority > CAPTURE_PRIORITY);
  const n = state.analysis.book.pages.length;
  const current = new Set(Array.from({ length: n }, (_, i) => `${textureKey(i + 1)}#${folioStamp(i + 1)}`));
  for (const key of thumbs.keys()) if (!current.has(key)) thumbs.delete(key);
  loadAllTextures();
  filmstrip.reloadThumbnails();
  refreshTiles();
}

/**
 * The book laid out anew (state.analysis just replaced): every page's image and tiles kept for the
 * folio that now shows that part of that page. A binding with endpapers (a hardcover) puts two
 * before the first page: every page moves two folios on, and was drawn again from scratch until
 * 2026-10-24, the author: "the entire book re-renders" switching to a hardcover and back. Pages
 * whose part is shown nowhere now are let go; the same part shown twice keeps its image once.
 * @returns {Map<number, number> | null} old folio -> new, or null if none moved
 */
export function carryPages() {
  /** @type {Map<string, number>} what a folio showed -> that folio */
  const was = new Map();
  for (const [folio, t] of state.textures) if (!t.blank && !was.has(t.key)) was.set(t.key, folio);
  /** @type {Map<number, number>} old folio -> new */
  const map = new Map();
  const n = state.analysis.book.pages.length;
  for (let folio = 1; folio <= n; folio++) {
    const from = was.get(textureKey(folio));
    if (from !== undefined && !map.has(from)) map.set(from, folio);
  }
  if ([...state.textures.keys()].every((folio) => map.get(folio) === folio || state.textures.get(folio).blank)) return null; // as they were
  const textures = new Map();
  for (const [from, to] of map) textures.set(to, state.textures.get(from));
  state.textures = textures;
  scene.renumberPages(map);
  return map;
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
    const stamp = folioStamp(folio);
    const have = state.textures.get(folio);
    if (have?.key === key && have.stamp === stamp && have.height >= height) continue;
    if (have && have.key !== key) scene.forgetTiles(folio); // its tiles were of the page that was
    if (key === "blank") {
      state.textures.set(folio, { key, stamp, height: Infinity, blank: true });
      scene.setPageTexture(folio, null);
      continue;
    }
    // An outdated image stays on screen until its replacement arrives: no flashing.
    const distance = Math.abs(folio - centre);
    const apply = (h) => (image) => {
      // (Not freed when not taken: a render asked for twice is one image, and the other
      // request may have handed it on.)
      const cur = state.textures.get(folio);
      if (gen !== state.generation || !image || stamp !== folioStamp(folio)) return; // outdated since asked
      if (cur?.key === key && cur.stamp === stamp && cur.height >= h) return;
      // Kept here: what the page is, and a cover's inks along the spine (see coverEdge).
      // The image goes to the 3D view, which frees it once it is on the GPU.
      const edge = folio === 1 || folio === n ? averageEdge(image, folio % 2 === 1) : null; // (its inks and spot channels)
      state.textures.set(folio, { key, stamp, height: h, edge });
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

/** Thumbnails made again (a new file; the profile and the plates need none till their stamp changes). */
export function forgetThumbnails() {
  thumbs.clear();
}
