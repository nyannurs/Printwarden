"""Patches vendor/pdf.worker.mjs, two lines (app/pdf/parser-profile.js installs what they call):

1. JpegStream.decodeImage asks our WebAssembly JPEG decoder first (self.bookviewJpeg, built
   from tools/jpegwasm).
2. The graphics state's overprint keys (OP for strokes, op for fills), which pdf.js ignores,
   set the blend mode: multiply while on, as Acrobat's Overprint Preview shows it (ink laid
   over ink, white set to overprint vanishing), normal while off. Only when
   self.bookviewOverprint is set (the Overprint choice under Color).

Run after replacing pdf.js; a patch already applied is left alone.

    python tools/patch-pdfjs.py
"""
import pathlib
import sys

WORKER = pathlib.Path(__file__).resolve().parent.parent / "vendor" / "pdf.worker.mjs"
PATCHES = [
    ("decodeImage(e){if(this.eof)return this.buffer;e=this.#L(e||this.bytes);",
     "const bv=self.bookviewJpeg?.(e,this.jpegOptions,this.drawWidth,this.drawHeight,this.forceRGBA,this.forceRGB);if(bv){this.buffer=bv;this.bufferLength=bv.length;this.eof=!0;return bv}"),
    # In PartialEvaluator.setGState's switch over the keys (`a`, the value `i`, the state `h`).
    ('case"OP":case"op":case"OPM":case"BG":',
     'case"OP":case"op":self.bookviewOverprint&&h.push(["BM",!0===i?"multiply":"source-over"]);break;case"OPM":case"BG":'),
]

source = WORKER.read_text(encoding="utf-8")
applied = 0
for before, hook in PATCHES:
    if hook in source:
        continue
    if source.count(before) != 1:
        sys.exit(f"{WORKER.name}: {before[:40]!r} not found as expected ({source.count(before)} matches); "
                 "pdf.js changed, see tools/patch-pdfjs.py")
    # The JPEG hook goes after its line; the overprint one replaces its keys.
    source = source.replace(before, before + hook if hook.startswith("const bv") else hook)
    applied += 1
if applied:
    WORKER.write_text(source, encoding="utf-8", newline="\n")
print(f"patched {WORKER} ({applied} applied, {len(PATCHES) - applied} already there)")
