// pdf.js loads its CMYK profile by a fixed file name with a synchronous request, the
// first time it meets plain CMYK colour. When a profile was chosen, answer that request
// with it instead.
//
// The profile arrives as a message ({bookviewProfile: blob URL or null}) that this
// listener sees before pdf.js does and keeps from it. That lets the document be opened
// before the profile is known (it depends on the file's output intent, read in parallel);
// the render worker sends it before asking for any page.

const BUILT_IN = "CGATS001Compat-v2-micro.icc";
let profile = null;

self.addEventListener("message", (/** @type {MessageEvent} */ event) => {
  if (event.data && typeof event.data === "object" && "bookviewProfile" in event.data) {
    profile = event.data.bookviewProfile;
    event.stopImmediatePropagation();
  }
});

// --- JPEG decoding ------------------------------------------------------------------------
//
// pdf.js hands RGB and grey JPEGs to the browser's decoder but decodes CMYK ones (what
// InDesign exports photos as) in JavaScript: 2-3 s for a full-page 300 ppi photo. Its
// JpegStream.decodeImage is patched (tools/patch-pdfjs.py) to ask bookviewJpeg first: the
// same decoding in WebAssembly (tools/jpegwasm, image-rs's jpeg-decoder), the pixels laid
// out as pdf.js's decoder lays them out. A JPEG it can't decode (12-bit, arithmetic
// coding, a broken file, a size other than the PDF says) goes to pdf.js's decoder as before.
// Each decode gets a fresh instance of the module: its memory (the file plus the pixels) is
// freed with it, instead of staying at the largest image's size.

const JPEG_WASM = new URL("../../vendor/jpeg-decoder.wasm", import.meta.url);
/** @type {WebAssembly.Module | null} */
let jpegModule = null;
try {
  // Read and compiled now, before pdf.js starts (a thread may read synchronously; compiling
  // the 120 KB takes a few ms): the first page's images already get it.
  const xhr = new XMLHttpRequest();
  xhr.open("GET", JPEG_WASM.href, false);
  xhr.responseType = "arraybuffer";
  xhr.send();
  if (xhr.status === 200 || xhr.status === 0) jpegModule = new WebAssembly.Module(xhr.response);
  else throw new Error(`HTTP ${xhr.status}`);
} catch (err) {
  console.warn("JPEG decoder unavailable (pdf.js decodes JPEGs itself):", err);
}

/** Whether the file carries Adobe's APP14 marker (then it, not the PDF, says the transform, as in pdf.js). */
function hasAdobeMarker(bytes) {
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; } // no length
    if (marker === 0xda || marker === 0xd9) return false; // the scan: no more markers before it
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker === 0xee && length >= 7 && bytes[at + 4] === 0x41 && bytes[at + 5] === 0x64 && bytes[at + 6] === 0x6f) return true; // "Ado"be
    at += 2 + length;
  }
  return false;
}

/**
 * The decoded pixels as JpegImage.getData gives them, or null (then pdf.js decodes).
 * @param {Uint8Array} bytes the JPEG
 * @param {{colorTransform?: number}} options the PDF's DecodeParms ColorTransform, if set
 * @param {number} width what the PDF says (drawWidth: the image's, or a larger mask's)
 * @param {number} height
 * @param {boolean} forceRGBA pdf.js wants RGBA (grey and RGB only; CMYK stays its own)
 * @param {boolean} forceRGB
 */
function bookviewJpeg(bytes, options, width, height, forceRGBA, forceRGB) {
  if (!jpegModule) return null;
  const transform = !hasAdobeMarker(bytes) && Number.isInteger(options?.colorTransform) ? options.colorTransform : -1;
  let exports;
  try {
    exports = /** @type {any} */ (new WebAssembly.Instance(jpegModule, {}).exports);
  } catch {
    return null;
  }
  const input = exports.jpeg_alloc(bytes.length);
  const out = exports.jpeg_alloc(20);
  if (!input || !out) return null;
  new Uint8Array(exports.memory.buffer).set(bytes, input);
  if (exports.jpeg_decode(input, bytes.length, transform, 0, 0, out) !== 0) return null;
  const [w, h, components, pixelsAt, length] = new Uint32Array(exports.memory.buffer, out, 5);
  if (w !== width || h !== height) return null;
  const pixels = new Uint8Array(exports.memory.buffer, pixelsAt, length);
  const n = w * h;
  if (components === 4) {
    if (forceRGBA || forceRGB) return null; // pdf.js's own CMYK to RGB formula then
    return new Uint8ClampedArray(pixels);
  }
  if (components === 3) {
    if (!forceRGBA) return new Uint8ClampedArray(pixels);
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      rgba[j] = pixels[3 * i];
      rgba[j + 1] = pixels[3 * i + 1];
      rgba[j + 2] = pixels[3 * i + 2];
      rgba[j + 3] = 255;
    }
    return rgba;
  }
  if (forceRGBA) {
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = pixels[i];
      rgba[j + 3] = 255;
    }
    return rgba;
  }
  if (forceRGB) {
    const rgb = new Uint8ClampedArray(n * 3);
    for (let i = 0, j = 0; i < n; i++, j += 3) rgb[j] = rgb[j + 1] = rgb[j + 2] = pixels[i];
    return rgb;
  }
  return new Uint8ClampedArray(pixels);
}
/** @type {any} */ (self).bookviewJpeg = bookviewJpeg;

const xhrOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  const redirected = profile && typeof url === "string" && url.endsWith(BUILT_IN) ? profile : url;
  return xhrOpen.call(this, method, redirected, ...rest);
};
