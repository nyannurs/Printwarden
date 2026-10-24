// Pages drawn by MuPDF (vendor/mupdf: Printwarden's build of MuPDF's WebAssembly, see
// tools/mupdf/README.md), as the press prints them: overprint honoured, spot colours as their
// inks, plain CMYK read in the chosen profile and RGB content converted through it, as Acrobat's
// Output Preview shows a file. Used in the render threads (mupdf-worker.js) and, where threads
// can't start, on the main thread (render.js).
//
// Two kinds of image. `ink`: the page's inks, a byte a channel (Cyan, Magenta, Yellow, Black),
// in the chosen profile: plain CMYK as it is, RGB content converted into it; and its spot colours
// as channels of their own (up to SPOT_CHANNELS of them; any further ones composited into the
// four). What the 3D view and the timeline draw through the ink table (`lut`: the profile as a
// grid, see viewer/inklut.js), every plate switched there, the spots mixed in as MuPDF mixes them
// (CMYK + tint × the spot's look in the profile, at most full ink; see INK_GLSL).
// `rgb`: the page as an ImageBitmap in sRGB through the profile, white paper, for what leaves
// the app (the client viewer's pages) and for anything drawn as an image.
//
// Both are drawn for a press (tools/mupdf/printwarden.c): plain CMYK means the chosen profile,
// however the PDF sets its colour spaces (the output intent included: the profile chosen is
// what the press prints with, "From PDF" its own).
//
// Coordinates: a request names a rectangle of the page in PDF user space (mm, y up, as the
// structure gives trim boxes); MuPDF draws in page space (points, y down, the page's rotation
// applied), which a PDF page's transform maps user space to.

import * as mupdf from "../../vendor/mupdf/mupdf.js";
import { libmupdfModule as libmupdf } from "../../vendor/mupdf/mupdf.js";
import { LUT_DEPTH, LUT_ENTRIES, lutInks } from "../viewer/inklut.js";
import { mipChain } from "./mips.js";

const PT_PER_MM = 72 / 25.4;
const { ColorSpace, Pixmap } = mupdf;

// Separation behaviours (fz_separation_behavior): composited into the process colours, a
// channel of its own, left out.
const SEP_COMPOSITE = 0;
const SEP_SPOT = 1;
const SEP_DISABLED = 2;

/** A page's spot colours drawn as channels of their own in an ink image (an RGBA texture's worth). */
export const SPOT_CHANNELS = 4;

// Scratch memory in MuPDF's heap for a rectangle handed to its glue (4 floats).
let rectPtr = 0;
function rectIn(x0, y0, x1, y1) {
  if (!rectPtr) rectPtr = libmupdf._wasm_malloc(4 * 4);
  const at = rectPtr >> 2;
  libmupdf.HEAPF32[at] = x0;
  libmupdf.HEAPF32[at + 1] = y0;
  libmupdf.HEAPF32[at + 2] = x1;
  libmupdf.HEAPF32[at + 3] = y1;
  return rectPtr;
}
let matrixPtr = 0;
function matrixIn(m) {
  if (!matrixPtr) matrixPtr = libmupdf._wasm_malloc(6 * 4);
  libmupdf.HEAPF32.set(m, matrixPtr >> 2);
  return matrixPtr;
}

mupdf.enableICC(); // embedded profiles and the chosen one honoured (LittleCMS inside MuPDF)

/**
 * A document and what is drawn from it: the chosen CMYK profile (an ICC colour space of
 * MuPDF's, or null for its own), its pages as they are used, each with its separations, and
 * the spot plates left out.
 */
export class InkDocument {
  /**
   * @param {Uint8Array | ArrayBuffer} bytes the file (copied into MuPDF's memory)
   */
  constructor(bytes) {
    this.doc = mupdf.Document.openDocument(bytes, "application/pdf");
    this.count = this.doc.countPages();
    /** @type {any} the chosen CMYK profile as a MuPDF colour space, or null */
    this.profile = null;
    /** @type {Map<number, {page: any, seps: number, spots: string[]}>} */
    this.pages = new Map();
    /** @type {Set<string>} the spot plates left out, by name */
    this.spotsOff = new Set();
  }

  /** The chosen CMYK profile (ICC bytes), or null for MuPDF's own. Pages are read again with it. */
  setProfile(bytes) {
    this.profile?.destroy();
    this.profile = bytes ? new ColorSpace(bytes, "chosen CMYK") : null;
    this.forget();
  }

  /**
   * The spot plates left out (their names): not drawn from now on. (The process plates are the
   * viewer's, switched in the shaders, see viewer/shaders.js INK_GLSL: the drawings carry all
   * four.)
   * @param {string[]} names
   */
  setSpotsOff(names) {
    this.spotsOff = new Set(names);
  }

  /**
   * The document's spot colours, every page's in the order they first appear: each with its
   * name, its look at full tint in the chosen profile's CMYK (0..1: what MuPDF composites it as,
   * from the file's alternate colour space), the pages (0-based) it is on, and those where it is
   * composited into the process inks of an ink image (past SPOT_CHANNELS on the page).
   * @returns {{name: string, cmyk: number[], pages: number[], composited: number[]}[]}
   */
  spots() {
    /** @type {Map<string, {name: string, cmyk: number[], pages: number[], composited: number[]}>} */
    const found = new Map();
    const cmyk = (this.profile ?? ColorSpace.DeviceCMYK).pointer;
    for (let index = 0; index < this.count; index++) {
      const kept = this.pages.get(index);
      const page = kept ? null : this.doc.loadPage(index);
      const seps = kept ? kept.seps : libmupdf._wasm_pw_page_separations(page.pointer);
      try {
        const n = seps ? libmupdf._wasm_pw_count_separations(seps) : 0;
        for (let i = 0; i < n; i++) {
          const name = libmupdf.UTF8ToString(libmupdf._wasm_pw_separation_name(seps, i));
          let s = found.get(name);
          if (!s) {
            s = { name, cmyk: [0, 1, 2, 3].map((c) => libmupdf._wasm_pw_separation_equivalent(seps, i, cmyk, c)), pages: [], composited: [] };
            found.set(name, s);
          }
          s.pages.push(index);
          if (i >= SPOT_CHANNELS) s.composited.push(index);
        }
      } finally {
        if (!kept) {
          if (seps) libmupdf._wasm_pw_drop_separations(seps);
          page.destroy();
        }
      }
    }
    return [...found.values()];
  }

  /** Let go of the pages read so far and MuPDF's caches (fonts, images). */
  forget() {
    for (const p of this.pages.values()) this.#dropPage(p);
    this.pages.clear();
    mupdf.emptyStore();
  }

  destroy() {
    this.forget();
    this.profile?.destroy();
    this.profile = null;
    this.doc.destroy();
  }

  #dropPage(p) {
    if (p.seps) libmupdf._wasm_pw_drop_separations(p.seps);
    p.page.destroy();
  }

  /** The page (0-based), read once and kept (the pages used last, KEEP_PAGES of them). */
  page(index) {
    let p = this.pages.get(index);
    if (p) {
      this.pages.delete(index);
      this.pages.set(index, p);
      return p;
    }
    const page = this.doc.loadPage(index);
    // Its separations (spot colours), or an empty set: a pixmap made with either is drawn
    // with overprint honoured (without one MuPDF draws every object knocking out).
    let seps = libmupdf._wasm_pw_page_separations(page.pointer);
    if (!seps) seps = libmupdf._wasm_pw_new_separations();
    const spots = Array.from({ length: libmupdf._wasm_pw_count_separations(seps) },
      (_, i) => libmupdf.UTF8ToString(libmupdf._wasm_pw_separation_name(seps, i)));
    p = { page, seps, spots };
    this.pages.set(index, p);
    while (this.pages.size > KEEP_PAGES) {
      const [oldest, old] = this.pages.entries().next().value;
      this.pages.delete(oldest);
      this.#dropPage(old);
    }
    return p;
  }

  /**
   * The ink table for a CMYK profile (ICC bytes, or null for MuPDF's own): every grid entry
   * (viewer/inklut.js) converted to sRGB by MuPDF, RGBA bytes in lutIndex order, paper white
   * (ink 0) brought to 255 so white paper stays white.
   */
  lut(bytes) {
    const cs = bytes ? new ColorSpace(bytes, "ink table") : ColorSpace.DeviceCMYK;
    const pix = new Pixmap(cs, [0, 0, LUT_DEPTH, LUT_DEPTH], false); // LUT_ENTRIES pixels, 4 bytes each, rows packed
    let rgb = null;
    try {
      pix.getPixels().set(lutInks());
      rgb = pix.convertToColorSpace(ColorSpace.DeviceRGB);
      const src = rgb.getPixels();
      const n = rgb.getNumberOfComponents();
      const out = new Uint8Array(LUT_ENTRIES * 4);
      const white = [src[0], src[1], src[2]].map((v) => Math.max(1, v));
      for (let i = 0; i < LUT_ENTRIES; i++) {
        for (let c = 0; c < 3; c++) out[4 * i + c] = Math.min(255, Math.round((src[n * i + c] * 255) / white[c]));
        out[4 * i + 3] = 255;
      }
      return out;
    } finally {
      rgb?.destroy();
      pix.destroy();
      if (bytes) cs.destroy();
    }
  }

  /**
   * The device matrix and pixel size for `rect` (mm, PDF user space) of page `index` at `height`
   * pixels tall: page space (points) scaled and shifted so the rectangle's top left is the origin.
   */
  #place(p, rect, height) {
    const t = p.page.getTransform?.() ?? [1, 0, 0, 1, 0, 0]; // user space (pt) to page space
    const corner = (xMm, yMm) => {
      const x = xMm * PT_PER_MM, y = yMm * PT_PER_MM;
      return [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
    };
    const a = corner(rect.x0, rect.y0), b = corner(rect.x1, rect.y1);
    const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
    const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
    const scale = height / h;
    return { ctm: [scale, 0, 0, scale, -x0 * scale, -y0 * scale], width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(height)) };
  }

  /**
   * Draw `rect` (mm, PDF user space) of page `index` at `height` pixels.
   * `mode` "rgb": {width, height, data: Uint8ClampedArray RGBA, sRGB, opaque}, the spots left
   * out not drawn, the others composited. "ink": {width, height, n: 4, data: Uint8Array, 4 bytes
   * a pixel: C, M, Y, K; spots: Uint8Array | null, 4 bytes a pixel: the page's first
   * SPOT_CHANNELS spots' tints (0 where it has fewer), spotNames: theirs}, its further spots
   * composited into the four (or left out). `mips`: smaller copies (half, quarter, ...: see
   * mips.js) of both, `mips` and `spotMips`.
   */
  draw(index, rect, height, mode = "rgb", { mips = 0 } = {}) {
    const p = this.page(index);
    const { ctm, width, height: hPx } = this.#place(p, rect, height);
    const ink = mode === "ink";
    const channels = ink ? Math.min(SPOT_CHANNELS, p.spots.length) : 0;
    p.spots.forEach((name, i) => {
      libmupdf._wasm_pw_set_separation_behavior(p.seps, i, i < channels ? SEP_SPOT : this.spotsOff.has(name) ? SEP_DISABLED : SEP_COMPOSITE);
    });
    // Ink: a pixmap in the profile itself (MuPDF's own CMYK without one), so plain CMYK is taken
    // as it is (the same colour space at both ends: no conversion) and RGB content converted
    // into it. RGB: opaque RGBA (an alpha channel, all paper) for an ImageBitmap's layout.
    const press = this.profile?.pointer ?? 0;
    const cs = ink ? (this.profile ?? ColorSpace.DeviceCMYK) : ColorSpace.DeviceRGB;
    const bbox = rectIn(0, 0, width, hPx);
    let pix = null;
    try {
      pix = new Pixmap(libmupdf._wasm_pw_new_pixmap_from_page(p.page.pointer, matrixIn(ctm), bbox, cs.pointer, p.seps, ink ? 0 : 1, press));
      const pixels = pix.getPixels(); // a view into MuPDF's heap: copied out before anything else moves it
      if (!ink) {
        const data = new Uint8ClampedArray(width * hPx * 4);
        data.set(pixels);
        return { width, height: hPx, data };
      }
      // C, M, Y, K, then the spot channels: the four apart, the spots apart (an RGBA texture each).
      const n = 4 + channels;
      const data = new Uint8Array(width * hPx * 4);
      const spots = channels ? new Uint8Array(width * hPx * 4) : null;
      if (!spots) data.set(pixels);
      else {
        for (let i = 0, o = 0; o < data.length; i += n, o += 4) {
          data[o] = pixels[i];
          data[o + 1] = pixels[i + 1];
          data[o + 2] = pixels[i + 2];
          data[o + 3] = pixels[i + 3];
          for (let c = 0; c < channels; c++) spots[o + c] = pixels[i + 4 + c];
        }
      }
      // (Every plate is switched where the inks are shown: every ink image carries them all.)
      const out = { width, height: hPx, n: 4, data, spots, spotNames: p.spots.slice(0, channels), mips: undefined, spotMips: undefined };
      if (mips > 0) {
        out.mips = mipChain(data, width, hPx, mips);
        if (spots) out.spotMips = mipChain(spots, width, hPx, mips);
      }
      return out;
    } finally {
      pix?.destroy();
    }
  }
}

const KEEP_PAGES = 8;

/** An rgb drawing as an ImageBitmap (zero-copy to another thread). */
export function toBitmap(drawn) {
  return createImageBitmap(new ImageData(drawn.data, drawn.width, drawn.height), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}
