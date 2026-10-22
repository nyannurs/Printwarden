// Page images for the 3D view: every page of the document, nearest first, at a size the
// whole book fits in memory with; then, once the view stops, the part of each page on
// screen again from the PDF's vectors, as sharp as the screen needs (see sharpen).

import { pageSizeOf } from "../core/analysis.js";
import { MM_PER_PT } from "../core/units.js";
import { baseHeight, THUMB_HEIGHT } from "../pdf/render.js";
import { baseSuffices, planDetail } from "../viewer/detail.js";
import { MAX_DETAIL } from "../viewer/shaders.js";
import { packVectorText } from "../viewer/vectortext.js";
import { scene, state } from "./app.js";
import { showLoad } from "./dom.js";
import { applySpine, averageEdge } from "./spine-panel.js";

// Sharp renders jump the queue, ahead of everything else.
const SHARP_FINE = -1;
export const CAPTURE_PRIORITY = -3; // screenshot tiles: never cancelled by the view
// Image pixels per device pixel in a sharp strip, at the strip's densest point. With the
// page shader's one tap and its 0.7 gradients (see pageSample), 1.25 read crispest against
// pdf.js's own rendering (1.0 and 1.1 a little softer, more a little aliased); it also keeps
// no part of the strip magnified (the density is sampled on a grid, the true peak lies
// between samples). Three, until 0.17.75: nine times the pixels, read through a filter that
// blurred them.
const SUPERSAMPLE = 1.25;
export const DETAIL_MAX_SIDE = 8192;
const DETAIL_MAX_PIXELS = 36e6;
const STRIP_MAX_PIXELS = 7e6; // larger strips take more than a frame to upload

function textureKey(folio) {
  const g = state.analysis.geometry[folio - 1];
  if (!g) return "blank";
  const src = state.analysis.book.pages[folio - 1].source;
  const rect = [g.trim.x0, g.trim.y0, g.trim.x1, g.trim.y1].map((v) => v.toFixed(2));
  return `${state.colour.choice}|${state.colour.overprint === false ? "op-off" : "op"}|${src.index}|${rect}`;
}

// Text drawn on the 3D page from its outlines, exact at any zoom (see viewer/vectortext.js):
// the page's images for the 3D view leave it out.
export const VECTOR_TEXT = true;

/**
 * A page's vector text, packed for the 3D page, or null: the glyphs' placements from the
 * render threads (glyph space to PDF user space) taken to this page's texture coordinates
 * (u across its trim box, v down from the head). Asked once a page (and colour profile):
 * the same answer for the 3D page and for every image of it, which leaves out exactly the
 * glyphs packed here (`keys`) and nothing else. Without vector text, images keep all text.
 * @returns {Promise<ReturnType<typeof packVectorText>>}
 */
export function vectorText(folio) {
  const key = textureKey(folio);
  if (!texts.has(key)) {
    texts.set(key, (async () => {
      const a = state.analysis;
      const g = a.geometry[folio - 1];
      if (!VECTOR_TEXT || !g) return null;
      const renderer = await state.rendererReady;
      const text = await renderer.vectorText(a.book.pages[folio - 1].source.index);
      if (!text?.instances.length) return null;
      const t = g.trim;
      const w = t.x1 - t.x0;
      const h = t.y1 - t.y0;
      const k = MM_PER_PT;
      const instances = text.instances.map(({ glyph, m: [a1, b1, c1, d1, e1, f1], color, key: id }) => ({
        glyph, color, key: id, m: [(a1 * k) / w, (-b1 * k) / h, (c1 * k) / w, (-d1 * k) / h, (e1 * k - t.x0) / w, (t.y1 - f1 * k) / h],
      }));
      return packVectorText({ glyphs: text.glyphs, instances });
    })().catch(() => null));
  }
  return texts.get(key);
}
const texts = new Map(); // textureKey -> Promise of the page's packed vector text (see vectorText)

/** What a render of the page for the 3D view leaves out: its vector text's glyphs (null: nothing). */
async function textLeftOut(folio) {
  const keys = (await vectorText(folio))?.keys;
  return keys?.length ? keys : null;
}

/**
 * A rendered image (ImageBitmap) of a finished page, or null for a blank. `vector: true`:
 * for the 3D page, without the glyphs it draws from their outlines (see vectorText).
 */
export async function pageImage(folio, height, priority, options = {}) {
  const g = state.analysis.geometry[folio - 1];
  if (!g) return null;
  const page = state.analysis.book.pages[folio - 1];
  const vector = options.vector ? await textLeftOut(folio) : null;
  const r = await state.rendererReady;
  return r.render(page.source.index, g.trim, height, priority, { ...options, vector });
}

/** Part of a page (`rect`, mm in PDF user space) for the 3D page: without its vector text. */
export async function pageRegionImage(folio, rect, height, priority, options = {}) {
  const page = state.analysis.book.pages[folio - 1];
  const vector = await textLeftOut(folio);
  const r = await state.rendererReady;
  return r.render(page.source.index, rect, height, priority, { ...options, vector });
}

/**
 * A small image of a page with its text, for its timeline thumbnail, for showing through
 * its leaf, and for the 3D page where it is small on screen (its own image leaves vector
 * text out): one render for all.
 */
function smallImage(folio, priority) {
  if (!VECTOR_TEXT) {
    const size = pageSizeOf(state.analysis) ?? { width: 1, height: 1 };
    return pageImage(folio, baseHeight(state.analysis.book.pages.length, size.width / size.height), priority);
  }
  return pageImage(folio, THUMB_HEIGHT * 2, priority);
}

const thumbs = new Map(); // key -> Promise<ImageBitmap>

/** Timeline thumbnail. */
export function thumbnail(folio) {
  const key = textureKey(folio);
  if (!thumbs.has(key)) {
    thumbs.set(key, smallImage(folio, 100 + folio).then((img) => img && createImageBitmap(img, { resizeHeight: THUMB_HEIGHT, resizeQuality: "high" })));
  }
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
    if (key === "blank") {
      state.textures.set(folio, { key, height: Infinity, blank: true });
      scene.setPageTexture(folio, null, { vector: null, small: null });
      continue;
    }
    // An outdated image stays on screen until its replacement arrives: no flashing.
    const distance = Math.abs(folio - centre);
    const apply = (h) => ([image, vector, small]) => {
      // (Not freed when not taken: a render asked for twice is one image, and the other
      // request may have handed it on.)
      const cur = state.textures.get(folio);
      if (gen !== state.generation || !image || (cur?.key === key && cur.height >= h)) return;
      // Kept here: what the page is, and a cover's colour along the spine (see coverEdge).
      // The image goes to the 3D view, which frees it once it is on the GPU.
      const edge = folio === 1 || folio === n ? averageEdge(image, folio % 2 === 1) : null;
      state.textures.set(folio, { key, height: h, edge });
      // Image and text together: the image leaves the vector text out.
      scene.setPageTexture(folio, image, { vector, small: VECTOR_TEXT ? small : null });
      if (folio === 1 || folio === n) applySpine(); // the spine colour may come from a cover
    };
    // Per page: its image, its vector text and a small image with the text; nearest first.
    pending++;
    Promise.all([pageImage(folio, height, 100 + distance, { vector: VECTOR_TEXT, cache: "pending" }), vectorText(folio).catch(() => null),
      VECTOR_TEXT ? smallImage(folio, 100 + distance).catch(() => null) : null])
      .then(apply(height))
      .catch(() => {})
      .finally(() => {
        pending--;
        if (gen === state.generation) showLoad((n - pending) / n);
      });
  }
  showLoad(pending ? (n - pending) / n : null);
}

/**
 * Keep type and linework crisp at any zoom. The part of each page on screen is re-rendered
 * from the PDF's vectors as strips, each at the resolution its own part of the screen needs
 * (a tilted page needs far more near the camera than far away), and laid over the page.
 *
 * One pass once the view stops (none while it moves: type is drawn from its outlines and
 * stays exact anyway, and strips arriving mid-motion stalled frames as they went to the GPU):
 * the strips at the screen's own density (SUPERSAMPLE), mipmapped for when the view moves
 * on. (Until 0.17.75 two passes, a quick one at screen density and a fine one at three times
 * it: the page changed look twice after every move, and the fine one's pixels were read
 * through a filter that blurred them.) A new pass cancels the renders of an outdated one,
 * even mid-drawing; so does moving again.
 * The strips render in parallel on every thread that knows the page (warmVisiblePages).
 */
const PASSES = {
  sharp: { priority: SHARP_FINE, supersample: SUPERSAMPLE, maxTiles: MAX_DETAIL, step: 1.3, enough: 0.9 },
};
export const isSharp = (job) => job.priority === SHARP_FINE;
let sharpenRun = 0;
export function sharpen() {
  const a = state.analysis;
  if (!a || !state.renderer || state.capturing) return;
  // Every render thread reads the pages in view, for their strips to render on all of them.
  // Here, at rest, not as each page turns: every thread reading every page flipped past took
  // the processor from drawing, 20-40 ms frames the first time through a document.
  warmVisiblePages();
  const gen = state.generation;
  const run = ++sharpenRun;
  state.renderer.cancel(isSharp);
  const visible = scene.visiblePages();
  const inView = new Set(visible.map((v) => v.folio));
  for (const folio of [...state.details.keys()]) {
    if (!inView.has(folio)) {
      scene.setPageDetails(folio, []);
      state.details.delete(folio);
    }
  }
  for (const view of visible) {
    const { folio } = view;
    const g = a.geometry[folio - 1];
    const t = state.textures.get(folio);
    if (!g || !t || t.blank) continue;
    const pageMm = { width: g.trim.x1 - g.trim.x0, height: g.trim.y1 - g.trim.y0 };
    for (const kind of ["sharp"]) {
      const pass = PASSES[kind];
      const plan = planDetail(view, pageMm, {
        // Per point of the screen: a Retina screen's pixels are already twice as fine, and the
        // same supersampling of them took four times the pixels (36 megapixels a turn).
        supersample: pass.supersample,
        maxTiles: pass.maxTiles,
        maxSide: Math.min(DETAIL_MAX_SIDE, scene.maxTextureSize),
        maxPixels: DETAIL_MAX_PIXELS,
        maxStripPixels: STRIP_MAX_PIXELS,
        step: pass.step,
      });
      // The base image is enough wherever it has at least a pixel for every screen pixel: it
      // is drawn as crisp as the strips would be, and nothing on screen changes as the view
      // settles. (Until 0.17.79 strips came as soon as the base had fewer than 1.25 pixels a
      // screen pixel, which made strips hardly finer than the base, 5.9 pixels a millimetre
      // over its 5.85, at an ordinary size of the view: the page changed look when it came
      // to rest for no gain, and on a Mac the strip came out softer than the base beside it.)
      if (baseSuffices(plan, t.height / pageMm.height, pass.supersample)) {
        if (state.details.delete(folio)) scene.setPageDetails(folio, []);
        break;
      }
      if (sufficient(state.details.get(folio), view.region, plan, pass.enough)) continue;
      // A pass cancelled by a newer one, or by moving on, just stops.
      renderStrips(folio, g, pageMm, view.region, plan, pass, () => gen !== state.generation
        || run !== sharpenRun || state.capturing).catch(() => {});
    }
  }
}

/** Render a page's planned strips and lay them over it, unless outdated by then. */
function renderStrips(folio, g, pageMm, seen, plan, pass, outdated) {
  const tr = g.trim;
  const renders = plan.map(({ region, heightPx }) => {
    // Image v runs from the head down; PDF y runs up.
    const rect = {
      x0: tr.x0 + region.u0 * pageMm.width, x1: tr.x0 + region.u1 * pageMm.width,
      y0: tr.y1 - region.v1 * pageMm.height, y1: tr.y1 - region.v0 * pageMm.height,
    };
    return pageRegionImage(folio, rect, heightPx, pass.priority, { cache: false, flex: true });
  });
  return Promise.all(renders).then((images) => {
    const stale = outdated() || !scene.visiblePages().some((v) => v.folio === folio)
      // A quicker set arriving after a sharper one mustn't replace it.
      || sufficient(state.details.get(folio), seen, plan, 1.0001);
    if (stale) {
      for (const img of images) img.close();
      return;
    }
    scene.setPageDetails(folio, images.map((image, i) => ({ image, region: plan[i].region })));
    state.details.set(folio, plan.map(({ region, pxPerMm }) => ({ region, pxPerMm })));
  }, (err) => Promise.all(renders.map((r) => r.then((img) => img.close(), () => {}))).then(() => { throw err; }));
}

/**
 * Do the strips on screen already cover `seen` at `ratio` of the density the new plan
 * wants, everywhere the plan has a strip?
 */
function sufficient(current, seen, plan, ratio) {
  if (!current?.length) return false;
  const covers = (r, q) => r.u0 <= q.u0 + 1e-6 && r.v0 <= q.v0 + 1e-6 && r.u1 >= q.u1 - 1e-6 && r.v1 >= q.v1 - 1e-6;
  const union = current.reduce((acc, c) => ({
    u0: Math.min(acc.u0, c.region.u0), v0: Math.min(acc.v0, c.region.v0),
    u1: Math.max(acc.u1, c.region.u1), v1: Math.max(acc.v1, c.region.v1),
  }), { u0: 1, v0: 1, u1: 0, v1: 0 });
  if (!covers(union, seen)) return false;
  return plan.every((tile) => current.some((c) => overlaps(c.region, tile.region) && c.pxPerMm >= ratio * tile.pxPerMm)
    && current.filter((c) => overlaps(c.region, tile.region)).every((c) => c.pxPerMm >= ratio * tile.pxPerMm));
}

const overlaps = (a, b) => a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;

/** Teach every render thread the pages in view, so their strips can render in parallel. */
export function warmVisiblePages() {
  const a = state.analysis;
  if (!a || !state.renderer) return;
  const folios = scene.shownFolios;
  for (const folio of folios) {
    const src = a.book.pages[folio - 1]?.source;
    if (src) state.renderer.warm(src.index);
  }
}

/** Thumbnails made again (a new file, a new CMYK profile). */
export function forgetThumbnails() {
  thumbs.clear();
  texts.clear(); // a page's vector text, asked again with its images
}
