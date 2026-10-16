"""Patches pdf.js (vendor/), five lines; app/pdf/parser-profile.js installs what the first two call:

1. pdf.worker.mjs: JpegStream.decodeImage asks our WebAssembly JPEG decoder first
   (self.bookviewJpeg, built from tools/jpegwasm).
2. pdf.worker.mjs: the graphics state's overprint keys (OP for strokes, op for fills), which
   pdf.js ignores, set the blend mode: multiply while on, as Acrobat's Overprint Preview shows
   it (ink laid over ink, white set to overprint vanishing), normal while off. Only when
   self.bookviewOverprint is set (the Overprint choice under Color).
3. pdf.mjs: an image is smoothed only where it is drawn smaller than its own pixels (or the
   PDF asks for it: /Interpolate), never where it is enlarged, as a print RIP draws it.
   pdf.js smooths anything enlarged up to the screen's pixel ratio times 4/3 (1.33 in our
   render threads), so one image drew soft in a page rendered small and crisp in the same
   page rendered large.
4. pdf.mjs and pdf.worker.mjs: Util.singularValueDecompose2dScale (a transform's two scale
   factors) takes the square root of a difference that is exactly zero for a transform scaled
   alike both ways, and rounding makes it a hair negative for some scales (-1.8e-12 at one):
   NaN, which its `|| 1` turns into a scale of 1. An image enlarged 11 times then counted as
   drawn at its own size and was smoothed: one page of the author's pixel-art book came out
   blurry at some render sizes (1800, 2603, 2900, 3600 px tall) and sharp at the others, so
   it changed between the two as the view zoomed and the video's images were soft. The
   difference clamped at zero.

Run after replacing pdf.js; a patch already applied is left alone.

    python tools/patch-pdfjs.py
"""
import pathlib
import sys

VENDOR = pathlib.Path(__file__).resolve().parent.parent / "vendor"
# (file, text to find, what it becomes)
PATCHES = [
    ("pdf.worker.mjs",
     "decodeImage(e){if(this.eof)return this.buffer;e=this.#L(e||this.bytes);",
     "decodeImage(e){if(this.eof)return this.buffer;e=this.#L(e||this.bytes);"
     "const bv=self.bookviewJpeg?.(e,this.jpegOptions,this.drawWidth,this.drawHeight,this.forceRGBA,this.forceRGB);if(bv){this.buffer=bv;this.bufferLength=bv.length;this.eof=!0;return bv}"),
    # In PartialEvaluator.setGState's switch over the keys (`a`, the value `i`, the state `h`).
    ("pdf.worker.mjs",
     'case"OP":case"op":case"OPM":case"BG":',
     'case"OP":case"op":self.bookviewOverprint&&h.push(["BM",!0===i?"multiply":"source-over"]);break;case"OPM":case"BG":'),
    # getImageSmoothingEnabled: the enlargement up to which images are smoothed, 1 instead of
    # the screen's pixel ratio times 4/3.
    ("pdf.mjs",
     "Util.singularValueDecompose2dScale(t,Pt);const i=Math.fround(OutputScale.pixelRatio*PixelsPerInch.PDF_TO_CSS_UNITS);return Pt[0]<=i&&Pt[1]<=i}",
     "Util.singularValueDecompose2dScale(t,Pt);const i=1;return Pt[0]<=i&&Pt[1]<=i}"),
    # Util.singularValueDecompose2dScale: the square root of a difference that can round below zero.
    ("pdf.mjs",
     "c=Math.sqrt(h**2-(a*l-o**2));",
     "c=Math.sqrt(Math.max(0,h**2-(a*l-o**2)));"),
    ("pdf.worker.mjs",
     "c=Math.sqrt(f**2-(i*l-o**2));",
     "c=Math.sqrt(Math.max(0,f**2-(i*l-o**2)));"),
]

texts = {}
applied = 0
for name, before, after in PATCHES:
    source = texts.setdefault(name, (VENDOR / name).read_text(encoding="utf-8"))
    if after in source:
        continue
    if source.count(before) != 1:
        sys.exit(f"{name}: {before[:40]!r} not found as expected ({source.count(before)} matches); "
                 "pdf.js changed, see tools/patch-pdfjs.py")
    texts[name] = source.replace(before, after)
    applied += 1
for name, source in texts.items():
    if (VENDOR / name).read_text(encoding="utf-8") != source:
        (VENDOR / name).write_text(source, encoding="utf-8", newline="\n")
print(f"patched pdf.js ({applied} applied, {len(PATCHES) - applied} already there)")
