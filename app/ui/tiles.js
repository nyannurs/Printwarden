// Which tiles the view needs (see viewer/tiles.js), asked of the renderer and handed to the
// cache as they come. While the view moves, a few times a frame's worth apart: for every
// density sample the scene measures on the pages in view, the tile at the level that part
// needs, the tiles one sample's spacing around it (the gaps between samples, and a margin
// past the screen's edge, so panning finds its tiles already there), and the level under it
// (shown until the tile lands, and the one a zoom out needs). At rest, the next finer level
// too, so a zoom in finds it there. What is kept is never asked for again, unless its inks
// changed (the profile, a spot plate: its stamp, see inkStamp in pages.js; it stays on screen
// till its new one lands); what is no longer wanted but still queued is cancelled.

import { pageSizeOf } from "../core/analysis.js";
import { baseHeight } from "../pdf/render.js";
import { TILE, TILE_MAX_LEVEL, TILE_MIPS, tileAt, tileKey, tileLevel, tilePage, tileRect } from "../viewer/tiles.js";
import { scene, state } from "./app.js";
import { folioStamp, pageRegionImage } from "./pages.js";

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
let again = 0; // a further request at rest, pending (see request)

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
 * The inks changed (redrawInks in pages.js): what is in flight is of the old (dropped as it
 * lands), and the view asks again for what it shows.
 */
export function refreshTiles() {
  inFlight.clear();
  lastUpdate = -Infinity;
  updateTiles(performance.now(), { settled: scene.settled });
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
  /** @type {{folio: number, level: number, u: number, v: number, priority: number}[]} what this view needs, for the spreads either side */
  const ahead = [];
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
      if (settled) ahead.push({ folio, level, u: s.u, v: s.v, priority });
    }
  }
  // At rest, the spreads either side too, at the levels this view needs: they come to the same
  // place on screen with a turn, so the pages a turn reveals are sharp as they appear (they were
  // their base image until their tiles came: "things get blurry, then sharpen up", the author,
  // 2026-10-24). Only while the cache has room for them besides what's on screen.
  if (settled && ahead.length) {
    const n = state.analysis.book.pages.length;
    const keys = new Map();
    for (const a of ahead) {
      for (const f of [a.folio + 2, a.folio - 2]) {
        if (f < 1 || f > n) continue;
        const q = pageOf(f);
        if (!q) continue;
        const { ix, iy } = tileAt(q.page, a.level, a.u, a.v);
        keys.set(tileKey(f, a.level, ix, iy), { folio: f, page: q.page, level: a.level, u: a.u, v: a.v, priority: a.priority + 0.7 });
      }
    }
    // (Ahead of the next finer level, +0.8: a turn is likelier than a zoom.)
    if (wanted.size + keys.size <= 0.8 * (cache.capacity || Infinity)) {
      for (const t of keys.values()) want(t.folio, t.page, t.level, t.u, t.v, t.priority);
    }
  }
  let requested = 0;
  for (const [key, t] of [...wanted].sort((a, b) => a[1].priority - b[1].priority)) {
    if (cache.has(key)) cache.touch(key); // (outdated, it is drawn till its new one lands)
    if (cache.has(key, folioStamp(t.folio))) continue;
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
  const stamp = folioStamp(folio);
  const asked = performance.now();
  const flight = { ...t, asked };
  inFlight.set(key, flight);
  // (Only this request's entry: after refreshTiles another may be in flight for the key.)
  const landed = () => inFlight.get(key) === flight && inFlight.delete(key);
  tileStats.asked++;
  pageRegionImage(folio, tileRect(p.page, level, ix, iy, p.trim), TILE, priority, { mode: "ink", cache: false, flex: true, tag: key, mips: TILE_MIPS })
    .then((tile) => {
      landed();
      if (!tile) return;
      tileStats.landed++;
      tileStats.lastMs = performance.now() - asked;
      if (tileStats.latencies.push(tileStats.lastMs) > 64) tileStats.latencies.shift();
      if (gen !== state.generation || stamp !== folioStamp(folio)) return tile.close?.();
      scene.queueTile(folio, level, ix, iy, p.page, tile, stamp);
      // At rest, the view asked once for at most REQUESTS_PER_UPDATE: ask again as they land,
      // until everything it wants (the spreads either side included) is in.
      if (scene.settled && !again && inFlight.size < IN_FLIGHT_MAX / 2) {
        again = setTimeout(() => { again = 0; if (scene.settled) updateTiles(performance.now(), { settled: true }); }, 0);
      }
      scene.dirty = true; // a frame: the tile goes up (flush) and shows
    }, () => { landed(); tileStats.cancelled++; }); // cancelled, or the renderer closed
}
