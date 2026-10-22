// Pages drawn by MuPDF (vendor/mupdf: Printwarden's build of MuPDF's WebAssembly, see
// tools/mupdf/README.md), as the press prints them: overprint honoured, spot colours as their
// inks, plain CMYK read in the chosen profile and RGB content converted through it, as Acrobat's
// Output Preview shows a file. Used in the render threads (mupdf-worker.js) and, where threads
// can't start, on the main thread (render.js).
//
// Two kinds of image. `ink`: the page's inks, a byte a channel (Cyan, Magenta, Yellow, Black;
// its spot colours composited into them), device CMYK, what the 3D view and the timeline draw
// through the ink table (`lut`: the chosen profile as a grid, see viewer/inklut.js) with the
// plates switched there. `rgb`: the page as an ImageBitmap in sRGB through the profile, white
// paper, for what leaves the app (the client viewer's pages) and for anything drawn as an image.
//
// Coordinates: a request names a rectangle of the page in PDF user space (mm, y up, as the
// structure gives trim boxes); MuPDF draws in page space (points, y down, the page's rotation
// applied), which a PDF page's transform maps user space to.

import * as mupdf from "../../vendor/mupdf/mupdf.js";
import { libmupdfModule as libmupdf } from "../../vendor/mupdf/mupdf.js";
import { LUT_DEPTH, LUT_ENTRIES, lutInks } from "../viewer/inklut.js";

const PT_PER_MM = 72 / 25.4;
const { ColorSpace, DrawDevice, Pixmap } = mupdf;

// Separation behaviours (fz_separation_behavior): composited into the process colours, a
// channel of its own, left out.
const SEP_COMPOSITE = 0;
const SEP_DISABLED = 2;

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
 * MuPDF's, or null for its own), its pages as they are used, each with its separations.
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
    /** @type {Map<number, {page: any, seps: number, spots: {name: string, cmyk: number[]}[], overprint: boolean}>} */
    this.pages = new Map();
    /** @type {boolean[]} which plates print (Cyan, Magenta, Yellow, Black, then spots by their order on the page) */
    this.inkOn = [];
  }

  /** The chosen CMYK profile (ICC bytes), or null for MuPDF's own. Pages are read again with it. */
  setProfile(bytes) {
    this.profile?.destroy();
    this.profile = bytes ? new ColorSpace(bytes, "chosen CMYK") : null;
    this.forget();
  }

  /**
   * Which plates print: by plate (Cyan, Magenta, Yellow, Black, then spots); false leaves one
   * out. The spots: a spot left out isn't drawn. The process plates are the viewer's (switched
   * in the shaders, see viewer/shaders.js INK_GLSL): the drawings carry all four.
   */
  setInks(inkOn) {
    this.inkOn = inkOn;
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
    const n = libmupdf._wasm_pw_count_separations(seps);
    const cmyk = ColorSpace.DeviceCMYK; // the equivalents in the inks' own terms (see draw: the inks are device CMYK)
    const spots = [];
    for (let i = 0; i < n; i++) {
      const name = libmupdf.UTF8ToString(libmupdf._wasm_pw_separation_name(seps, i));
      spots.push({ name, cmyk: [0, 1, 2, 3].map((c) => libmupdf._wasm_pw_separation_equivalent(seps, i, cmyk.pointer, c)) });
    }
    p = { page, seps, spots, overprint: !!libmupdf._wasm_pw_page_uses_overprint(page.pointer) };
    this.pages.set(index, p);
    while (this.pages.size > KEEP_PAGES) {
      const [oldest, old] = this.pages.entries().next().value;
      this.pages.delete(oldest);
      this.#dropPage(old);
    }
    return p;
  }

  /** What a page carries: its spot colours (name, CMYK equivalent at full tint) and whether it overprints. */
  info(index) {
    const { spots, overprint } = this.page(index);
    return { spots, overprint };
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
   * Draw `rect` (mm, PDF user space) of page `index` at `height` pixels, with the inks that print.
   * `mode` "rgb": {width, height, data: Uint8ClampedArray RGBA, sRGB, opaque}; "ink": {width,
   * height, n: 4, data: Uint8Array, 4 bytes a pixel: C, M, Y, K, the spots composited in}.
   */
  draw(index, rect, height, mode = "rgb") {
    const p = this.page(index);
    const { ctm, width, height: hPx } = this.#place(p, rect, height);
    const ink = mode === "ink";
    const spotCount = p.spots.length;
    for (let i = 0; i < spotCount; i++) {
      const on = this.inkOn[4 + i] !== false;
      libmupdf._wasm_pw_set_separation_behavior(p.seps, i, on ? SEP_COMPOSITE : SEP_DISABLED);
    }
    const cs = ink ? ColorSpace.DeviceCMYK : ColorSpace.DeviceRGB;
    const bbox = rectIn(0, 0, width, hPx);
    let pix = null;
    let dev = null;
    try {
      if (ink) {
        // All in MuPDF: a device CMYK pixmap (plain CMYK keeps its values exactly; through the
        // profile, even as both ends, MuPDF went by way of Lab and made a four-colour black of
        // K), its spots composited in. The profile applies where the inks are shown (the ink
        // table); RGB content is converted by MuPDF's own CMYK profile, close to a coated one's.
        pix = new Pixmap(libmupdf._wasm_pw_new_pixmap_from_page(p.page.pointer, matrixIn(ctm), bbox, cs.pointer, p.seps, 0, 0, 0, 0));
      } else {
        // An opaque RGBA pixmap (an alpha channel, cleared to white) for an ImageBitmap's layout.
        pix = new Pixmap(libmupdf._wasm_pw_new_pixmap_with_bbox(cs.pointer, bbox, p.seps, 1));
        pix.clear(255);
        dev = new DrawDevice(mupdf.Matrix.identity, pix);
        libmupdf._wasm_pw_set_default_colorspaces(dev.pointer, this.profile?.pointer ?? 0, 0, 0);
        p.page.run(dev, ctm);
        dev.close();
      }
      const n = pix.getNumberOfComponents();
      const data = (ink ? new Uint8Array(width * hPx * n) : new Uint8ClampedArray(width * hPx * 4));
      data.set(pix.getPixels()); // a view into MuPDF's heap: copied out before anything else moves it
      if (!ink) return { width, height: hPx, data, overprint: p.overprint };
      // (The process plates are switched where the inks are shown: every ink image carries all four.)
      return { width, height: hPx, n, data, spots: p.spots, overprint: p.overprint };
    } finally {
      dev?.destroy();
      pix?.destroy();
    }
  }
}

const KEEP_PAGES = 8;

/** An rgb drawing as an ImageBitmap (zero-copy to another thread). */
export function toBitmap(drawn) {
  return createImageBitmap(new ImageData(drawn.data, drawn.width, drawn.height), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}
