"""Patches vendor/pdf.worker.mjs so that JpegStream.decodeImage asks our WebAssembly JPEG
decoder first (self.bookviewJpeg, installed by app/pdf/parser-profile.js; built from
tools/jpegwasm). Run after replacing pdf.js; does nothing when already applied.

    python tools/patch-pdfjs.py
"""
import pathlib
import sys

WORKER = pathlib.Path(__file__).resolve().parent.parent / "vendor" / "pdf.worker.mjs"
HOOK = "const bv=self.bookviewJpeg?.(e,this.jpegOptions,this.drawWidth,this.drawHeight,this.forceRGBA,this.forceRGB);if(bv){this.buffer=bv;this.bufferLength=bv.length;this.eof=!0;return bv}"
BEFORE = "decodeImage(e){if(this.eof)return this.buffer;e=this.#L(e||this.bytes);"

source = WORKER.read_text(encoding="utf-8")
if HOOK in source:
    print("already patched")
    sys.exit(0)
if source.count(BEFORE) != 1:
    sys.exit(f"{WORKER.name}: decodeImage not found as expected ({source.count(BEFORE)} matches); "
             "pdf.js changed, see tools/patch-pdfjs.py")
WORKER.write_text(source.replace(BEFORE, BEFORE + HOOK), encoding="utf-8", newline="\n")
print("patched", WORKER)
