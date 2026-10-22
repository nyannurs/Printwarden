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
// Tiles are ink images (pdf/mupdf-render.js, mode "ink"), so plates and the profile switch
// them with everything else. Each goes up with two mips made where it was drawn
// (pdf/mips.js): the texture array keeps no mipmap pass of its own.
//
// The geometry and the bookkeeping (TileIndex) are pure and tested; TileCache adds the GPU.

import * as THREE from "three";

export const TILE = 1024; // a tile's side in texels, border included
export const TILE_BORDER = 4; // texels of the neighbours at each edge: filtering never sees a tile's edge
export const TILE_PAYLOAD = TILE - 2 * TILE_BORDER; // what a tile covers of its page
export const TILE_MIPS = 2; // mip levels below a tile (minification up to 4:1 within one level's tiles)
export const TILE_SUPERSAMPLE = 1.25; // texels per screen pixel a level is chosen for (as the strips were, see SUPERSAMPLE in ui/pages.js)
export const TILE_MAX_LEVEL = 5; // 32 × the base image: 800 % on a Retina screen with the smallest base
export const TILE_BYTES = TILE * TILE * 4 * (1 + 1 / 4 + 1 / 16); // a tile on the GPU, with its mips
export const TILE_FADE_MS = 160; // a tile fades in over the level under it (a pop was a flicker)

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

/** The tiling of a page at a level: how many tiles across and down. */
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
 * band of entries, one per tile position, RGBA bytes: the layer's index low and high, 255
 * if the tile is there, and how far it has faded in).
 */
export class TileIndex {
  /** @param {number} capacity layers in the texture array */
  constructor(capacity) {
    this.capacity = capacity;
    /** @type {({key: string, folio: number, level: number, ix: number, iy: number, used: number, arrived: number} | null)[]} */
    this.slots = Array.from({ length: capacity }, () => null);
    /** @type {Map<string, number>} key -> layer */
    this.byKey = new Map();
    /** @type {Map<number, {page: ReturnType<typeof tilePage>, data: Uint8Array, width: number, height: number, dirty: boolean}>} */
    this.tables = new Map();
    this.frame = 0; // counts the views drawn (touch marks what a view used)
    this.free = capacity;
  }

  nextFrame() {
    this.frame++;
  }

  has(key) {
    return this.byKey.has(key);
  }

  /** A tile drawn by this view: not the next to go. */
  touch(key) {
    const layer = this.byKey.get(key);
    if (layer !== undefined) this.slots[layer].used = this.frame;
  }

  /** The page's table, made on its first tile. */
  table(folio, page) {
    let t = this.tables.get(folio);
    if (!t) {
      const width = page.cols;
      const height = page.rows * (TILE_MAX_LEVEL + 1);
      t = { page, data: new Uint8Array(width * height * 4), width, height, dirty: true };
      this.tables.set(folio, t);
    }
    return t;
  }

  #entry(t, level, ix, iy) {
    return ((level * t.page.rows + iy) * t.width + ix) * 4;
  }

  /**
   * Room for a tile: a free layer, else the one least recently drawn that this view didn't
   * use. Takes it: the tile is listed, its table entry set (fading in from `now`).
   * @returns {number | null} the layer, or null when every layer is in use by this view
   */
  place(folio, level, ix, iy, page, now) {
    const key = tileKey(folio, level, ix, iy);
    if (this.byKey.has(key)) return this.byKey.get(key);
    let layer = -1;
    if (this.free > 0) {
      layer = this.slots.findIndex((s) => !s);
      this.free--;
    } else {
      let oldest = Infinity;
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (s.used < this.frame && s.used < oldest) { oldest = s.used; layer = i; }
      }
      if (layer < 0) return null;
      this.#evict(layer);
    }
    this.slots[layer] = { key, folio, level, ix, iy, used: this.frame, arrived: now };
    this.byKey.set(key, layer);
    const t = this.table(folio, page);
    const o = this.#entry(t, level, ix, iy);
    t.data[o] = layer & 255;
    t.data[o + 1] = layer >> 8;
    t.data[o + 2] = 255;
    t.data[o + 3] = 0;
    t.dirty = true;
    return layer;
  }

  #evict(layer) {
    const s = this.slots[layer];
    if (!s) return;
    this.byKey.delete(s.key);
    this.slots[layer] = null;
    const t = this.tables.get(s.folio);
    if (t) {
      const o = this.#entry(t, s.level, s.ix, s.iy);
      t.data.fill(0, o, o + 4);
      t.dirty = true;
    }
  }

  /**
   * The tiles fading in brought on to `now`: their table entries' alpha.
   * @returns {boolean} whether any is still fading (the tables change: draw again)
   */
  fade(now) {
    let fading = false;
    for (const s of this.slots) {
      if (!s || s.arrived < 0) continue;
      const a = Math.max(0, Math.min(255, Math.round((255 * (now - s.arrived)) / TILE_FADE_MS)));
      const t = this.tables.get(s.folio);
      if (t) {
        t.data[this.#entry(t, s.level, s.ix, s.iy) + 3] = a;
        t.dirty = true;
      }
      if (a >= 255) s.arrived = -1;
      else fading = true;
    }
    return fading;
  }

  /** A page's tiles and table let go (its image changed). */
  forgetPage(folio) {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i]?.folio === folio) { this.#evict(i); this.free++; }
    }
    this.tables.delete(folio);
  }

  reset() {
    this.slots.fill(null);
    this.byKey.clear();
    this.tables.clear();
    this.free = this.capacity;
  }
}

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
    /** @type {{folio: number, level: number, ix: number, iy: number, page: ReturnType<typeof tilePage>, tile: {data: Uint8Array, mips?: Uint8Array[], close?: () => void}}[]} */
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

  has(key) {
    return !!this.index?.has(key);
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

  /** A tile drawn: queued for the GPU (flush). The tile's bytes are let go once it is there. */
  queueTile(folio, level, ix, iy, page, tile) {
    if (this.failed) return tile.close?.();
    this.queue.push({ folio, level, ix, iy, page, tile });
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
      const { folio, level, ix, iy, page, tile } = this.queue.shift();
      const layer = this.index.place(folio, level, ix, iy, page, now);
      if (layer === null) { tile.close?.(); continue; } // every layer in use by this view: next time
      if (!this.tableTextures.has(folio)) newTables.add(folio);
      this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, this.glTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, TILE, TILE, 1, gl.RGBA, gl.UNSIGNED_BYTE, tile.data);
      const mips = tile.mips ?? [];
      for (let i = 0; i < TILE_MIPS; i++) {
        const side = TILE >> (i + 1);
        const data = mips[i] ?? new Uint8Array(side * side * 4); // (no mips given: blank, never chosen while the level fits)
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, i + 1, 0, 0, layer, side, side, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
      }
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
