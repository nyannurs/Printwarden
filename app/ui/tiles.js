// Which tiles the view needs (see viewer/tiles.js), asked of the renderer and handed to the
// cache as they come. While the view moves, a few times a frame's worth apart: for every
// density sample the scene measures on the pages in view, the tile at the level that part
// needs, the tiles one sample's spacing around it (the gaps between samples, and a margin
// past the screen's edge, so panning finds its tiles already there), and the level under it
// (shown until the tile lands, and the one a zoom out needs). At rest, the next finer level
// too, so a zoom in finds it there. What is kept is never asked for again; what is no longer
// wanted but still queued is cancelled.

import { pageSizeOf } from "../core/analysis.js";
import { baseHeight } from "../pdf/render.js";
import { TILE, TILE_MAX_LEVEL, TILE_MIPS, tileAt, tileKey, tileLevel, tilePage, tileRect } from "../viewer/tiles.js";
import { scene, state } from "./app.js";
import { pageRegionImage } from "./pages.js";

const TILE_PRIORITY = -1; // the band: after a capture's images (-3), before every base image (100 and up)
const MOVING_INTERVAL_MS = 24; // between updates while the view moves (the rays cost a little)
const REQUESTS_PER_UPDATE = 24;
const IN_FLIGHT_MAX = 40;

/** @type {Map<string, {folio: number, level: number, ix: number, iy: number, priority: number, asked: number}>} tiles asked for, not yet here */
const inFlight = new Map();
/** For the performance check and the console: tiles asked for and landed, and how long the last ones took. */
export const tileStats = { asked: 0, landed: 0, cancelled: 0, lastMs: 0, updates: 0, updateMs: 0, latencies: /** @type {number[]} */ ([]) };
/** @type {Map<number, {page: ReturnType<typeof tilePage>, trim: {x0: number, y0: number, x1: number, y1: number}}>} per folio, for a generation */
let pages = new Map();
let pagesFor = -1;
let lastUpdate = -Infinity;

/** A page's pyramid: its base image's density (the document's base height) over its trim. */
function pageOf(folio) {
  if (pagesFor !== state.generation) {
    pages = new Map();
    pagesFor = state.generation;
  }
  let p = pages.get(folio);
  if (p === undefined) {
    const a = state.analysis;
    const g = a.geometry[folio - 1];
    if (!g) p = null;
    else {
      const size = pageSizeOf(a) ?? { width: 1, height: 1 };
      const h0 = baseHeight(a.book.pages.length, size.width / size.height);
      p = { page: tilePage(h0, { width: g.trim.x1 - g.trim.x0, height: g.trim.y1 - g.trim.y0 }), trim: g.trim };
    }
    pages.set(folio, p);
  }
  return p;
}

/** A new document, or the renderer gone: nothing in flight counts. */
export function resetTiles() {
  inFlight.clear();
  pages = new Map();
  pagesFor = -1;
  lastUpdate = -Infinity;
  scene.tiles.reset();
}

/** Queued tile renders dropped (a capture wants the renderer). */
export function cancelTiles() {
  state.renderer?.cancel((job) => !!job.tag);
}

/**
 * The tiles this view needs, asked for. `settled`: the view is at rest (the next finer level
 * too, and no throttling).
 */
export function updateTiles(now, { settled = false } = {}) {
  if (!state.analysis || !state.renderer || state.capturing || scene.tiles.failed) return;
  if (!settled && now - lastUpdate < MOVING_INTERVAL_MS) return;
  lastUpdate = now;
  const t0 = performance.now();
  tileStats.updates++;
  const cache = scene.tiles;
  cache.nextFrame();
  /** @type {Map<string, {folio: number, level: number, ix: number, iy: number, priority: number}>} */
  const wanted = new Map();
  const want = (folio, page, level, u, v, priority) => {
    if (u < 0 || u > 1 || v < 0 || v > 1) return;
    const { ix, iy } = tileAt(page, level, u, v);
    const key = tileKey(folio, level, ix, iy);
    const had = wanted.get(key);
    if (!had) wanted.set(key, { folio, level, ix, iy, priority });
    else if (priority < had.priority) had.priority = priority;
  };
  for (const view of scene.visiblePages()) {
    const p = pageOf(view.folio);
    if (!p) continue;
    const { folio, region, samples } = view;
    // One sample's spacing, about: the region is the screen's part of the page.
    const du = Math.max(0.005, (region.u1 - region.u0) / 16);
    const dv = Math.max(0.005, (region.v1 - region.v0) / 12);
    for (const s of samples) {
      const level = tileLevel(s.pxPerMm, p.page.scale0);
      if (level < 1) continue; // the base image has it
      const d = Math.hypot(s.sx - 0.5, s.sy - 0.5); // from the screen's middle, 0 to 0.7
      const priority = TILE_PRIORITY + d;
      want(folio, p.page, level, s.u, s.v, priority);
      for (const [ou, ov] of [[du, 0], [-du, 0], [0, dv], [0, -dv], [du, dv], [-du, dv], [du, -dv], [-du, -dv]]) {
        want(folio, p.page, level, s.u + ou, s.v + ov, priority + 0.3);
      }
      if (level >= 2) want(folio, p.page, level - 1, s.u, s.v, priority + 0.5);
      if (settled && level < TILE_MAX_LEVEL) want(folio, p.page, level + 1, s.u, s.v, priority + 0.8);
    }
  }
  let requested = 0;
  for (const [key, t] of wanted) {
    if (cache.has(key)) { cache.touch(key); continue; }
    if (inFlight.has(key) || requested >= REQUESTS_PER_UPDATE || inFlight.size >= IN_FLIGHT_MAX) continue;
    requested++;
    request(key, t);
  }
  state.renderer.cancel((job) => !!job.tag && !wanted.has(job.tag));
  tileStats.updateMs = performance.now() - t0;
}

function request(key, t) {
  const { folio, level, ix, iy, priority } = t;
  const p = pageOf(folio);
  if (!p) return;
  const gen = state.generation;
  const asked = performance.now();
  inFlight.set(key, { ...t, asked });
  tileStats.asked++;
  pageRegionImage(folio, tileRect(p.page, level, ix, iy, p.trim), TILE, priority, { mode: "ink", cache: false, flex: true, tag: key, mips: TILE_MIPS })
    .then((tile) => {
      inFlight.delete(key);
      if (!tile) return;
      tileStats.landed++;
      tileStats.lastMs = performance.now() - asked;
      if (tileStats.latencies.push(tileStats.lastMs) > 64) tileStats.latencies.shift();
      if (gen !== state.generation) return tile.close?.();
      scene.tiles.queueTile(folio, level, ix, iy, p.page, tile);
      scene.dirty = true; // a frame: the tile goes up (flush) and shows
    }, () => { inFlight.delete(key); tileStats.cancelled++; }); // cancelled, or the renderer closed
}
