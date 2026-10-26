// The pages' data as the shaders read it, by folio: the page table (a texel row a page: which
// layer of the page array holds its image and its spot channels, its show-through, glue, score,
// turn-in, its tiles' table and shape, its spot matrix) and the layer arrays (every page's image
// in one texture array, its spot channels in another layer of it; the tiles' tables in one of
// their own, see tiles.js). A sheet's programs find the page from the vertex (vFolio, see
// SHEET_VERTEX), so one material draws any page, and many sheets go in one draw (draw.js
// makeBatches). Before 1.2 each page had its own textures and some forty uniforms on a material
// of its own: 420 draw calls a frame for 120 sheets, 4 ms of the main thread.

import * as THREE from "three";

/** Texels a folio takes in the page table (see PageTable). */
export const PT_TEXELS = 16;

/**
 * A texture array of RGBA8 layers, allocated whole on first use (texStorage3D, a layer's size
 * being the first image's), handed to three as the texture behind a uniform (bound by it,
 * never uploaded: version 0), its layers taken and given back. `mips`: with every mip level
 * (uploaded with each image, made where it was drawn, see pdf/mips.js), else one level,
 * unfiltered (a table).
 */
export class LayerArray {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer, { mips = true, name = "layers" } = {}) {
    this.renderer = renderer;
    this.mips = mips;
    this.name = name;
    this.texture = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
    this.glTexture = null;
    this.width = 0;
    this.height = 0;
    this.layers = 0;
    this.levels = 0;
    /** @type {number[]} layers free to take */
    this.free = [];
    this.failed = false;
  }

  /** Whether an image of this size can go in: the array's size once allocated, any before. */
  fits(width, height) {
    if (this.failed) return false;
    return this.layers === 0 || (width <= this.width && height <= this.height);
  }

  /**
   * The array, allocated for `layers` images of width × height (fewer if the GPU refuses: half
   * and half again, down to 4). True if there is one.
   */
  ensure(width, height, layers) {
    if (this.layers) return !this.failed;
    if (this.failed) return false;
    const gl = /** @type {WebGL2RenderingContext} */ (this.renderer.getContext());
    let n = Math.max(4, Math.min(layers, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)));
    const levels = this.mips ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    let tex = null;
    while (n >= 4) {
      tex = gl.createTexture();
      this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      while (gl.getError() !== gl.NO_ERROR); // (errors of others, cleared: ours is read below)
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, width, height, n);
      if (gl.getError() === gl.NO_ERROR) break;
      gl.deleteTexture(tex);
      tex = null;
      n >>= 1;
    }
    if (!tex) {
      this.failed = true;
      console.warn(`[${this.name}] no room on the GPU for ${layers} layers of ${width} x ${height}`);
      return false;
    }
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, this.mips ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, this.mips ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAX_LEVEL, levels - 1);
    if (this.mips) {
      const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
      if (aniso) gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, this.renderer.capabilities.getMaxAnisotropy());
    }
    // Handed to three as the texture behind the uniform: never uploaded by it (version 0), only bound.
    const props = /** @type {any} */ (this.renderer.properties.get(this.texture));
    if (props.__webglTexture) gl.deleteTexture(props.__webglTexture);
    props.__webglTexture = tex;
    props.__webglInit = true;
    this.glTexture = tex;
    this.width = width;
    this.height = height;
    this.layers = n;
    this.levels = levels;
    this.free = Array.from({ length: n }, (_, i) => n - 1 - i); // taken from the end: 0 first
    return true;
  }

  /** A free layer, or -1. */
  take() {
    return this.free.pop() ?? -1;
  }

  release(layer) {
    if (layer >= 0) this.free.push(layer);
  }

  /** How many images have a layer. */
  get used() {
    return this.layers - this.free.length;
  }

  /**
   * An image into a layer: its bytes (RGBA, rows from the top) and, with mips, every smaller
   * copy (`mips[k]`: level k + 1). Smaller than a layer, the image is padded by its edge texels
   * at every level, so sampling it at its own scale (see PageTable, texel 0) never reads past it.
   */
  upload(layer, width, height, data, mips = []) {
    const gl = /** @type {WebGL2RenderingContext} */ (this.renderer.getContext());
    this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, this.glTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (let level = 0; level < this.levels; level++) {
      const src = level === 0 ? data : mips[level - 1];
      if (!src) break;
      const w = Math.max(1, width >> level);
      const h = Math.max(1, height >> level);
      const W = Math.max(1, this.width >> level);
      const H = Math.max(1, this.height >> level);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, layer, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, src);
      if (w < W) {
        // The columns past the image: its last column, repeated.
        const pad = new Uint8Array((W - w) * h * 4);
        for (let y = 0; y < h; y++) {
          const o = (y * w + w - 1) * 4;
          for (let x = 0; x < W - w; x++) pad.set(src.subarray(o, o + 4), (y * (W - w) + x) * 4);
        }
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, w, 0, layer, W - w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, pad);
      }
      if (h < H) {
        // The rows past it: its last row (padded across), repeated.
        const row = new Uint8Array(W * 4);
        row.set(src.subarray((h - 1) * w * 4, h * w * 4));
        for (let x = w; x < W; x++) row.set(row.subarray((w - 1) * 4, w * 4), x * 4);
        const pad = new Uint8Array(W * (H - h) * 4);
        for (let y = 0; y < H - h; y++) pad.set(row, y * W * 4);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, h, layer, W, H - h, 1, gl.RGBA, gl.UNSIGNED_BYTE, pad);
      }
    }
  }

  /** Every layer free again; the array stays for images of the same size. */
  reset() {
    const n = this.layers;
    this.free = Array.from({ length: n }, (_, i) => n - 1 - i);
  }

  /** The array let go: the next image allocates one of its own size. */
  dispose() {
    if (this.glTexture) {
      const gl = this.renderer.getContext();
      gl.deleteTexture(this.glTexture);
      const props = /** @type {any} */ (this.renderer.properties.get(this.texture));
      delete props.__webglTexture;
      this.glTexture = null;
    }
    this.width = this.height = this.layers = this.levels = 0;
    this.free = [];
    this.failed = false;
  }
}

/**
 * The page table: a row of PT_TEXELS float texels a folio (row 0 unused: folios start at 1),
 * read by texelFetch in every program that draws a page (PAGE_DATA_GLSL in shaders.js):
 *   0: the layer of the page array holding its image (-1: none, paper), the layer of its spot
 *      channels (-1: none), its scale in the layer (its size over the layer's: 1 for most);
 *   1: show-through, 1 on the outside of a cover, side glue (mm from the spine), the score (mm);
 *   2: 1 once the page has tiles, the layer of their table (tiles.js), its levels, its rows a level;
 *   3: the page in level-0 texels (x, y);
 *   4: a board's turn-in: its colour and a 1 when on;
 *   5-8: its spot matrix (spotInk in uploads.js), a column a texel.
 * Written here, sent whole when anything changed (flush, before a frame is drawn: small).
 */
export class PageTable {
  constructor() {
    this.capacity = 0;
    this.data = new Float32Array(0);
    /** @type {THREE.DataTexture | null} */
    this.texture = null;
    this.uniform = { value: /** @type {THREE.Texture | null} */ (null) };
    this.dirty = false;
  }

  /** Room for folios 1..n (and the spine's 0). */
  ensure(n) {
    if (n + 1 <= this.capacity) return;
    const capacity = Math.max(n + 1, 2 * this.capacity, 16);
    const data = new Float32Array(PT_TEXELS * 4 * capacity);
    data.set(this.data);
    for (let folio = this.capacity; folio < capacity; folio++) PageTable.#defaults(data, folio);
    this.data = data;
    this.capacity = capacity;
    this.#remake();
  }

  #remake() {
    this.texture?.dispose();
    const tex = new THREE.DataTexture(this.data, PT_TEXELS, this.capacity, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
    this.uniform.value = tex;
    this.dirty = false;
  }

  static #defaults(data, folio) {
    const o = folio * PT_TEXELS * 4;
    data.fill(0, o, o + PT_TEXELS * 4);
    data.set([-1, -1, 1, 1], o); // no image, no spots, at scale 1
    data[o + 4] = 0.01; // show-through, as a page material had it before its stock is set
  }

  /** One value: `texel` 0..PT_TEXELS-1, `comp` 0..3. */
  set(folio, texel, comp, value) {
    const o = (folio * PT_TEXELS + texel) * 4 + comp;
    if (this.data[o] === value) return;
    this.data[o] = value;
    this.dirty = true;
  }

  /** A whole texel. */
  set4(folio, texel, x, y, z, w) {
    this.set(folio, texel, 0, x);
    this.set(folio, texel, 1, y);
    this.set(folio, texel, 2, z);
    this.set(folio, texel, 3, w);
  }

  get(folio, texel, comp) {
    return this.data[(folio * PT_TEXELS + texel) * 4 + comp];
  }

  /** The page's spot matrix (a THREE.Matrix4, column-major: column i the look of spot channel i). */
  setSpotInk(folio, matrix) {
    const e = matrix.elements;
    for (let c = 0; c < 4; c++) this.set4(folio, 5 + c, e[4 * c], e[4 * c + 1], e[4 * c + 2], e[4 * c + 3]);
  }

  /** What the book sets cleared (a book built anew: setBook): show-through, the covers' outsides, glue, score, turn-ins. */
  clearBook() {
    for (let folio = 1; folio < this.capacity; folio++) {
      this.set4(folio, 1, 0.01, 0, 0, 0);
      this.set4(folio, 4, 0, 0, 0, 0);
    }
  }

  /** The pages' image fields cleared (a new file: clearPages): no image, no spots, no tiles, no spot matrix. */
  clearImages() {
    for (let folio = 1; folio < this.capacity; folio++) {
      this.set4(folio, 0, -1, -1, 1, 1);
      this.set4(folio, 2, 0, 0, 0, 0);
      this.set4(folio, 3, 0, 0, 0, 0);
      for (let c = 0; c < 4; c++) this.set4(folio, 5 + c, 0, 0, 0, 0);
    }
  }

  /**
   * The pages numbered anew (`map`: old folio -> new; see uploads.js renumberPages): every
   * folio's row goes with it; a folio not in the map starts afresh.
   * @param {Map<number, number>} map
   */
  renumber(map) {
    let most = 0;
    for (const to of map.values()) most = Math.max(most, to);
    this.ensure(most);
    const data = new Float32Array(this.data.length);
    for (let folio = 0; folio < this.capacity; folio++) PageTable.#defaults(data, folio);
    const stride = PT_TEXELS * 4;
    for (const [from, to] of map) {
      if (from < this.capacity) data.set(this.data.subarray(from * stride, (from + 1) * stride), to * stride);
    }
    this.data = data;
    this.#remake();
  }

  /** To the GPU if anything changed (before a frame). */
  flush() {
    if (this.dirty && this.texture) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
    this.uniform.value = null;
    this.capacity = 0;
    this.data = new Float32Array(0);
  }
}
