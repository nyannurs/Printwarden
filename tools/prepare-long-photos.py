"""Photos for the long test book (tools/make-long-pdf.mjs): 240 JPEGs made from the 60
photos make-heavy-pdf.py downloaded (Lorem Picsum, see there), so nothing is downloaded
again. Each photo in four treatments (as printed, greyscale, a warm duotone, a tight crop),
RGB, 1500 px on the long side, JPEG quality 82: about a quarter megabyte each, so the book
weighs about 60 MB and every one of its 240 pictures is a different image.

  python tools/prepare-long-photos.py            # writes _build/test-out/long-photos/p000.jpg ...
"""
import glob
import os
import sys

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "_build", "test-out", "photos")
OUT = os.path.join(ROOT, "_build", "test-out", "long-photos")
LONG = 1500
COUNT = 240


def treat(im, kind, k):
    im = ImageOps.exif_transpose(im).convert("RGB")
    if kind == 1:
        return ImageOps.grayscale(im).convert("RGB")
    if kind == 2:
        g = ImageOps.grayscale(im)
        return ImageOps.colorize(g, (48, 32, 24), (246, 232, 208)).convert("RGB")
    if kind == 3:
        w, h = im.size
        f = 0.55 + 0.1 * (k % 3)
        cw, ch = int(w * f), int(h * f)
        x = (w - cw) * ((k * 37) % 100) // 100
        y = (h - ch) * ((k * 53) % 100) // 100
        return im.crop((x, y, x + cw, y + ch))
    return im


def main():
    files = sorted(glob.glob(os.path.join(CACHE, "*.jpg")))
    if len(files) < 20:
        sys.exit(f"{len(files)} photos in {CACHE}: run tools/make-heavy-pdf.py first (it downloads them)")
    os.makedirs(OUT, exist_ok=True)
    for k in range(COUNT):
        src = files[k % len(files)]
        kind = (k // len(files)) % 4
        out = os.path.join(OUT, f"p{k:03d}.jpg")
        if os.path.exists(out):
            continue
        with Image.open(src) as im:
            t = treat(im, kind, k)
            w, h = t.size
            s = LONG / max(w, h)
            t = t.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
            t.save(out, "JPEG", quality=82, optimize=True, progressive=False)
        if k % 40 == 0:
            print(f"{k + 1}/{COUNT}")
    total = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
    print(f"{COUNT} photos in {OUT}, {total / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
