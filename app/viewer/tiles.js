// The tile cache: the pages kept on the GPU as a map keeps its tiles. A page is a pyramid of
// levels, level 0 its base image (every page has one, see ui/pages.js) and each level above
// twice as fine, cut into tiles of TILE texels; the tiles that are drawn are rendered once
// (ui/tiles.js asks for them) into one big texture array here and kept until the room is
// needed for others, least recently drawn first. The page shader (TILE_GLSL in shaders.js)
// looks each fragment's tile up in the page's table and falls back to a coarser level, in
// the end the base image, for what isn't there yet. So a view that was on screen before is
// drawn again from the cache at once, zooming out never shows less than what is kept, and
// zooming in shows the coarser level for the few frames its tiles take to land.
//
// Tiles are ink images (pdf/mupdf-render.js, mode "ink"), so the plates and the profile's look
// switch them with everything else; a tile's spot channels take a second layer. Each carries a stamp, what its inks were
// drawn with besides the page (ui/pages.js inkStamp): a tile with an outdated one is still
// drawn, but no longer counts as there (has), and its replacement takes its layer when it
// comes. Each goes up with two mips made where it was drawn (pdf/mips.js): the texture array
// keeps no mipmap pass of its own.
//
// The geometry and the bookkeeping (TileIndex) are pure and tested; TileCache adds the GPU.

import * as THREE from "three";

export const TILE = 1024; // a tile's side in texels, border included
export const TILE_BORDER = 4; // texels of the neighbours at each edge: filtering never sees a tile's edge
export const TILE_PAYLOAD = TILE - 2 * TILE_BORDER; // what a tile covers of its page
export const TILE_MIPS = 2; // mip levels below a tile (minification up to 4:1 within one level's tiles)
export const TILE_SUPERSAMPLE = 1.25; // texels per screen pixel a level is chosen for (as the strips were, see SUPERSAMPLE in ui/pages.js)
export const TILE_MAX_LEVEL = 5; // 32 × the base image: 800 % on a Retina screen with the smallest base
const TILE_BYTES = TILE * TILE * 4 * (1 + 1 / 4 + 1 / 16); // a tile on the GPU, with its mips
const TILE_FADE_MS = 160; // a tile fades in over the level under it (a pop was a flicker)

/**
 * A page's pyramid: `scale0` texels per mm at level 0 (its base image's density), the page's
 * size in level-0 texels, and the table's shape (TILE_MAX_LEVEL's tiling: every level's band
 * fits in it).
 * @param {number} h0 the base image's height (px)
 * @param {{width: number, height: number}} pageMm
 */
export function tilePage(h0, pageMm) {
  const scale0 = h0 / pageMm.height;
  const w0 = scale0 * pageMm.width;
  const top = tileGrid({ w0, h0 }, TILE_MAX_LEVEL);
  return { scale0, w0, h0, cols: top.cols, rows: top.rows };
}

/** The tiling of a page at a level: how many tiles across and down. (Exported for its tests too.) */
export function tileGrid(page, level) {
  const f = 2 ** level;
  return { cols: Math.max(1, Math.ceil((page.w0 * f) / TILE_PAYLOAD)), rows: Math.max(1, Math.ceil((page.h0 * f) / TILE_PAYLOAD)) };
}

/**
 * The level a part of a page seen at `pxPerMm` device pixels a millimetre needs: the first
 * with at least TILE_SUPERSAMPLE texels a pixel; 0 where the base image has that.
 */
export function tileLevel(pxPerMm, scale0) {
  if (!(pxPerMm > 0)) return 0;
  const k = Math.ceil(Math.log2((TILE_SUPERSAMPLE * pxPerMm) / scale0));
  return Math.max(0, Math.min(TILE_MAX_LEVEL, k));
}

/** The tile at a level that holds a point of the page (texture uv, v = 0 at the head). */
export function tileAt(page, level, u, v) {
  const f = 2 ** level;
  const { cols, rows } = tileGrid(page, level);
  return {
    ix: Math.max(0, Math.min(cols - 1, Math.floor((u * page.w0 * f) / TILE_PAYLOAD))),
    iy: Math.max(0, Math.min(rows - 1, Math.floor((v * page.h0 * f) / TILE_PAYLOAD))),
  };
}

/**
 * A tile's rectangle on the page in PDF user space (mm, y up), border included: TILE texels
 * square at the level's scale, so drawn TILE px tall it comes out TILE px wide.
 * @param {{x0: number, y0: number, x1: number, y1: number}} trim the page's trim box (mm)
 */
export function tileRect(page, level, ix, iy, trim) {
  const scale = page.scale0 * 2 ** level; // texels per mm
  const x = (ix * TILE_PAYLOAD - TILE_BORDER) / scale;
  const y = (iy * TILE_PAYLOAD - TILE_BORDER) / scale; // from the head
  const side = TILE / scale;
  return { x0: trim.x0 + x, x1: trim.x0 + x + side, y0: trim.y1 - y - side, y1: trim.y1 - y };
}

export const tileKey = (folio, level, ix, iy) => `t:${folio}:${level}:${ix}:${iy}`;

/**
 * The cache's bookkeeping, without the GPU: which tile sits in which layer of the texture
 * array, which were drawn lately, and each page's table (what the shader reads: per level a
 * band of entries, two per tile position, RGBA bytes: the layer's index low and high, 255 if
 * the tile is there, and how far it has faded in; then its spot channels' layer, low and high,
 * 255 if it has them). (Exported for its tests, tests/tiles.test.js:
 * the app uses it only through TileCache.)
 */
export class TileIndex {
  /** @param {number} capacity layers in the texture array */
  constructor(capacity) {
    this.capacity = capacity;
    /** @type {(TileRecord | null)[]} each layer's tile (a tile with spot channels holds two) */
    this.slots = Array.from({ length: capacity }, () => null);
    /** @type {Map<string, TileRecord>} */
    this.byKey = new Map();
    /** @type {Map<number, {page: ReturnType<typeof tilePage>, data: Uint8Array, width: number, height: number, dirty: boolean}>} */
    this.tables = new Map();
    this.frame = 0; // counts the views drawn (touch marks what a view used)
    this.free = capacity;
  }

  nextFrame() {
    this.frame++;
  }

  /** Whether the tile is kept: with `stamp`, only as drawn with that (see the header). */
  has(key, stamp) {
    const r = this.byKey.get(key);
    return !!r && (stamp === undefined || r.stamp === stamp);
  }

  /** A tile drawn by this view: not the next to go. */
  touch(key) {
    const r = this.byKey.get(key);
    if (r) r.used = this.frame;
  }

  /** The page's table, made on its first tile: two entries a tile position (see the class's doc). */
  table(folio, page) {
    let t = this.tables.get(folio);
    if (!t) {
      const width = 2 * page.cols;
      const height = page.rows * (TILE_MAX_LEVEL + 1);
      t = { page, data: new Uint8Array(width * height * 4), width, height, dirty: true };
      this.tables.set(folio, t);
    }
    return t;
  }

  /** A tile position's first entry in its page's table (the second follows it). */
  #entry(t, level, ix, iy) {
    return ((level * t.page.rows + iy) * t.width + 2 * ix) * 4;
  }

  /**
   * Room for a tile, and its spot channels' (`spots`) in a second layer: free layers, else those
   * of the tiles least recently drawn that this view didn't use. Takes them: the tile is listed,
   * its table entries set (fading in from `now`). A tile kept already (with another stamp)
   * keeps its layers, to be drawn over in place: no fade, the page never shows less in between.
   * @returns {{layer: number, spotLayer: number} | null} its layers (spotLayer -1: none), or
   *   null when this view uses every layer it could have
   */
  place(folio, level, ix, iy, page, now, stamp = "", spots = false) {
    const key = tileKey(folio, level, ix, iy);
    const kept = this.byKey.get(key);
    if (kept && (kept.spotLayer >= 0) === spots) {
      kept.stamp = stamp;
      return kept;
    }
    if (kept) this.#evict(kept); // (its spot channels came or went: placed anew)
    const layers = [];
    while (layers.length < (spots ? 2 : 1)) {
      const layer = this.#take();
      if (layer < 0) {
        for (const l of layers) { this.slots[l] = null; this.free++; }
        return null;
      }
      layers.push(layer);
      this.slots[layer] = /** @type {any} */ (true); // taken (the record comes below)
    }
    /** @type {TileRecord} */
    const r = { key, folio, level, ix, iy, stamp, layer: layers[0], spotLayer: layers[1] ?? -1, used: this.frame, arrived: now };
    for (const l of layers) this.slots[l] = r;
    this.byKey.set(key, r);
    const t = this.table(folio, page);
    const o = this.#entry(t, level, ix, iy);
    t.data.set([r.layer & 255, r.layer >> 8, 255, 0], o);
    t.data.set(r.spotLayer >= 0 ? [r.spotLayer & 255, r.spotLayer >> 8, 255, 255] : [0, 0, 0, 0], o + 4);
    t.dirty = true;
    return r;
  }

  /** A free layer, else one freed by letting go of the tile drawn least recently, not by this view; -1 if none. */
  #take() {
    if (this.free > 0) {
      this.free--;
      return this.slots.findIndex((s) => !s);
    }
    let oldest = null;
    for (const r of this.byKey.values()) {
      if (r.used < this.frame && (!oldest || r.used < oldest.used)) oldest = r;
    }
    if (!oldest) return -1;
    this.#evict(oldest);
    this.free--;
    return this.slots.findIndex((s) => !s);
  }

  #evict(r) {
    this.byKey.delete(r.key);
    for (const l of [r.layer, r.spotLayer]) {
      if (l < 0) continue;
      this.slots[l] = null;
      this.free++;
    }
    const t = this.tables.get(r.folio);
    if (t) {
      const o = this.#entry(t, r.level, r.ix, r.iy);
      t.data.fill(0, o, o + 8);
      t.dirty = true;
    }
  }

  /**
   * The tiles fading in brought on to `now`: their table entries' alpha.
   * @returns {boolean} whether any is still fading (the tables change: draw again)
   */
  fade(now) {
    let fading = false;
    for (const r of this.byKey.values()) {
      if (r.arrived < 0) continue;
      const a = Math.max(0, Math.min(255, Math.round((255 * (now - r.arrived)) / TILE_FADE_MS)));
      const t = this.tables.get(r.folio);
      if (t) {
        t.data[this.#entry(t, r.level, r.ix, r.iy) + 3] = a;
        t.dirty = true;
      }
      if (a >= 255) r.arrived = -1;
      else fading = true;
    }
    return fading;
  }

  /** A page's tiles and table let go (its image changed). */
  forgetPage(folio) {
    for (const r of [...this.byKey.values()]) if (r.folio === folio) this.#evict(r);
    this.tables.delete(folio);
  }

  /**
   * The pages numbered anew (`map`: old folio -> new; see TileCache renumber): their tiles keep
   * their layers, their tables go with them; a page not in `map` is let go.
   * @param {Map<number, number>} map
   */
  renumber(map) {
    for (const folio of [...this.tables.keys()]) if (!map.has(folio)) this.forgetPage(folio);
    for (const r of [...this.byKey.values()]) if (!map.has(r.folio)) this.#evict(r);
    const records = [...this.byKey.values()];
    this.byKey.clear();
    for (const r of records) {
      r.folio = /** @type {number} */ (map.get(r.folio));
      r.key = tileKey(r.folio, r.level, r.ix, r.iy);
      this.byKey.set(r.key, r);
    }
    this.tables = new Map([...this.tables].map(([folio, t]) => [/** @type {number} */ (map.get(folio)), t]));
  }

  reset() {
    this.slots.fill(null);
    this.byKey.clear();
    this.tables.clear();
    this.free = this.capacity;
  }
}

/**
 * @typedef {{key: string, folio: number, level: number, ix: number, iy: number, stamp: string,
 *            layer: number, spotLayer: number, used: number, arrived: number}} TileRecord
 *   a tile kept: its layer, and its spot channels' (-1: none)
 */

/** The tile cache's share of memory: a 24th of the computer's, 256 MB to 1 GB. */
export function tileBudget(systemBytes) {
  return Math.max(256 * 2 ** 20, Math.min(2 ** 30, Math.floor(systemBytes / 24)));
}

/**
 * The cache on the GPU: one texture array of TILE × TILE layers, allocated when the first
 * tile comes (the client viewer never needs it), its tables as small textures the page
 * shader reads with texelFetch, and the uploads paced a few a frame (flush).
 */
export class TileCache {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.budget = 256 * 2 ** 20;
    /** @type {TileIndex | null} */
    this.index = null;
    this.glTexture = null;
    // What the shaders bind (shared uniform uTiles): three's handle, pointed at our texture.
    this.texture = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
    /** @type {THREE.DataTexture} the table of a page without tiles */
    this.emptyTable = TileCache.#tableTexture(new Uint8Array(4), 1, 1);
    /** @type {Map<number, THREE.DataTexture>} folio -> its table on the GPU */
    this.tableTextures = new Map();
    /** @type {{folio: number, level: number, ix: number, iy: number, page: ReturnType<typeof tilePage>, tile: {data: Uint8Array, mips?: Uint8Array[], spots?: Uint8Array | null, spotMips?: Uint8Array[], close?: () => void}, stamp: string}[]} */
    this.queue = [];
    this.failed = false; // the texture array couldn't be made: tiles off
  }

  setBudget(bytes) {
    this.budget = bytes;
  }

  get pending() {
    return this.queue.length;
  }

  get capacity() {
    return this.index?.capacity ?? 0;
  }

  /** See TileIndex has. */
  has(key, stamp) {
    return !!this.index?.has(key, stamp);
  }

  touch(key) {
    this.index?.touch(key);
  }

  nextFrame() {
    this.index?.nextFrame();
  }

  static #tableTexture(data, width, height) {
    const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }

  /** The texture array, made on first use: as many layers as the budget allows, fewer if the GPU refuses. */
  #ensure() {
    if (this.index || this.failed) return !this.failed;
    const gl = /** @type {WebGL2RenderingContext} */ (this.renderer.getContext());
    let layers = Math.max(16, Math.min(gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS), Math.floor(this.budget / TILE_BYTES)));
    let tex = null;
    while (layers >= 16) {
      tex = gl.createTexture();
      this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      while (gl.getError() !== gl.NO_ERROR); // (errors of others, cleared: ours is read below)
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, TILE_MIPS + 1, gl.RGBA8, TILE, TILE, layers);
      if (gl.getError() === gl.NO_ERROR) break;
      gl.deleteTexture(tex);
      tex = null;
      layers >>= 1;
    }
    if (!tex) {
      this.failed = true;
      console.warn("[tiles] no room for a tile cache on the GPU");
      return false;
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, TILE_MIPS);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    // Handed to three as the texture behind uTiles: never uploaded by it (version 0), only bound.
    const props = /** @type {any} */ (this.renderer.properties.get(this.texture));
    if (props.__webglTexture) gl.deleteTexture(props.__webglTexture);
    props.__webglTexture = tex;
    props.__webglInit = true;
    this.glTexture = tex;
    this.index = new TileIndex(layers);
    return true;
  }

  /**
   * A tile drawn (`stamp`: what with, see the header): queued for the GPU (flush). The tile's
   * bytes are let go once it is there.
   */
  queueTile(folio, level, ix, iy, page, tile, stamp = "") {
    if (this.failed) return tile.close?.();
    this.queue.push({ folio, level, ix, iy, page, tile, stamp });
  }

  /**
   * Up to `max` queued tiles to the GPU, at `now`.
   * @returns {Set<number>} the folios whose tables are new (the scene binds them to the pages)
   */
  flush(max, now) {
    const newTables = new Set();
    if (!this.queue.length || !this.#ensure()) { this.queue.length = 0; return newTables; }
    const gl = /** @type {WebGL2RenderingContext} */ (this.renderer.getContext());
    let n = 0;
    while (this.queue.length && n < max) {
      const { folio, level, ix, iy, page, tile, stamp } = this.queue.shift();
      const placed = this.index.place(folio, level, ix, iy, page, now, stamp, !!tile.spots);
      if (placed === null) { tile.close?.(); continue; } // every layer in use by this view: next time
      if (!this.tableTextures.has(folio)) newTables.add(folio);
      this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, this.glTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      const upload = (layer, data, mips = []) => {
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, TILE, TILE, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
        for (let i = 0; i < TILE_MIPS; i++) {
          const side = TILE >> (i + 1);
          const level = mips[i] ?? new Uint8Array(side * side * 4); // (no mips given: blank, never chosen while the level fits)
          gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, i + 1, 0, 0, layer, side, side, 1, gl.RGBA, gl.UNSIGNED_BYTE, level);
        }
      };
      upload(placed.layer, tile.data, tile.mips);
      if (tile.spots) upload(placed.spotLayer, tile.spots, tile.spotMips);
      tile.close?.();
      n++;
    }
    this.#syncTables();
    return newTables;
  }

  /** The tiles fading in brought on: true while any still is. */
  tick(now) {
    if (!this.index) return false;
    const fading = this.index.fade(now);
    this.#syncTables();
    return fading;
  }

  #syncTables() {
    for (const [folio, t] of this.index.tables) {
      if (!t.dirty) continue;
      t.dirty = false;
      let tex = this.tableTextures.get(folio);
      if (!tex) {
        tex = TileCache.#tableTexture(t.data, t.width, t.height);
        this.tableTextures.set(folio, tex);
      } else tex.needsUpdate = true;
    }
  }

  /** What a page's material binds: its table and its pyramid's shape (null without tiles). */
  pageUniforms(folio) {
    const t = this.index?.tables.get(folio);
    const tex = this.tableTextures.get(folio);
    if (!t || !tex) return null;
    return { table: tex, page: [t.page.w0, t.page.h0, TILE_MAX_LEVEL, t.page.rows] };
  }

  /** The folios with tables (to bind again when the leaves are built anew). */
  pages() {
    return [...this.tableTextures.keys()];
  }

  forgetPage(folio) {
    this.index?.forgetPage(folio);
    this.tableTextures.get(folio)?.dispose();
    this.tableTextures.delete(folio);
    this.queue = this.queue.filter((q) => q.folio !== folio || (q.tile.close?.(), false));
  }

  /**
   * The pages numbered anew (`map`: old folio -> new), as a binding with endpapers adds or
   * drops them before the first page: the same pages' tiles, tables and queued tiles go with
   * them, none drawn again; a page not in `map` is let go.
   * @param {Map<number, number>} map
   */
  renumber(map) {
    this.index?.renumber(map);
    for (const [folio, tex] of this.tableTextures) if (!map.has(folio)) tex.dispose();
    this.tableTextures = new Map([...this.tableTextures].filter(([folio]) => map.has(folio)).map(([folio, tex]) => [/** @type {number} */ (map.get(folio)), tex]));
    this.queue = this.queue.filter((q) => map.has(q.folio) || (q.tile.close?.(), false));
    for (const q of this.queue) q.folio = /** @type {number} */ (map.get(q.folio));
  }

  /** Everything let go (a new document); the texture array stays for the next. */
  reset() {
    this.index?.reset();
    for (const tex of this.tableTextures.values()) tex.dispose();
    this.tableTextures.clear();
    for (const q of this.queue) q.tile.close?.();
    this.queue.length = 0;
  }

  dispose() {
    this.reset();
    if (this.glTexture) {
      const gl = this.renderer.getContext();
      gl.deleteTexture(this.glTexture);
      const props = /** @type {any} */ (this.renderer.properties.get(this.texture));
      delete props.__webglTexture;
      this.glTexture = null;
    }
    this.index = null;
    this.emptyTable.dispose();
  }
}
