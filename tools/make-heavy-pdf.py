"""A heavy test document (testfiles/heavy-cmyk-photos.pdf): 44 A4 pages with 3 mm bleed, 40 of
them a full-bleed CMYK photo at 300 ppi as InDesign's press-quality export writes them (JPEG,
DeviceCMYK, Adobe's inverted convention with a Decode array), about 310 MB. For the checks on
large files: how fast the book appears, that pages fill in, memory, the client viewer with many
heavy pages. For development only.

Photos: Lorem Picsum (picsum.photos), which serves Unsplash photographs under the Unsplash
license (free to use); downloaded once into _build/test-out/photos/, 60 of them, about 150 MB.
Converted to CMYK through the ISO Coated v2 profile the app ships (vendor/icc) and written as
baseline JPEGs by Pillow. Needs Pillow (pip install pillow).

    python tools/make-heavy-pdf.py                 64 pages, testfiles/heavy-cmyk-photos.pdf
    python tools/make-heavy-pdf.py --pages 12 --out small.pdf

The file is too large for the repository (GitHub refuses files over 100 MB): it is ignored by
git, made here when needed, or handed over as a draft asset of the private repository.
"""
import argparse
import io
import os
import sys
import urllib.request
import zlib

from PIL import Image, ImageCms

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "_build", "test-out", "photos")
ICC = os.path.join(ROOT, "vendor", "icc", "ISOcoated_v2_eci.icc")
MM = 72 / 25.4
W, H, BLEED = 210, 297, 3  # A4, mm
PPI = 300
# Picsum photo ids with portrait-friendly subjects; the service crops to the size asked.
IDS = [1011, 1015, 1016, 1018, 1019, 1020, 1021, 1022, 1024, 1025, 1026, 1027, 1028, 1029, 1031, 1032, 1033, 1035, 1036, 1037,
       1038, 1039, 1040, 1041, 1042, 1043, 1044, 1047, 1048, 1049, 1050, 1051, 1052, 1053, 1054, 1055, 1056, 1057, 1058, 1059,
       1060, 1061, 1062, 1063, 1064, 1065, 1066, 1067, 1068, 1069, 1070, 1071, 1072, 1073, 1074, 1075, 1076, 1077, 1078, 1079,
       1080, 1081, 1082, 1083, 1084, 10, 100, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1008, 1009, 101, 1010, 102, 103]


def fetch(photo_id, px_w, px_h):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{photo_id}-{px_w}x{px_h}.jpg")
    if not os.path.exists(path):
        url = f"https://picsum.photos/id/{photo_id}/{px_w}/{px_h}"
        print(f"  downloading {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "Printwarden test files"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
        except urllib.error.HTTPError as e:
            print(f"  not there ({e.code}): skipped")
            return None
        with open(path, "wb") as f:
            f.write(data)
    return path


def cmyk_jpeg(path, px_w, px_h, transform):
    """The photo as a CMYK JPEG (bytes), the page's size, converted through the press profile."""
    im = Image.open(path).convert("RGB")
    if im.size != (px_w, px_h):
        im = im.resize((px_w, px_h), Image.LANCZOS)
    cmyk = ImageCms.applyTransform(im, transform)
    out = io.BytesIO()
    # Pillow writes CMYK JPEGs inverted with Adobe's APP14 marker, as Photoshop and InDesign do;
    # the PDF says so with /Decode [1 0 1 0 1 0 1 0].
    cmyk.save(out, "JPEG", quality=92, dpi=(PPI, PPI), subsampling=0)
    return out.getvalue()


def solid_cmyk_jpeg(px_w, px_h, c, m, y, k):
    """A flat CMYK JPEG (for checking the colours come out right: no inversion)."""
    im = Image.new("CMYK", (px_w, px_h), (round(c * 255), round(m * 255), round(y * 255), round(k * 255)))
    out = io.BytesIO()
    im.save(out, "JPEG", quality=95, dpi=(PPI, PPI))
    return out.getvalue()


class Pdf:
    """A PDF written object by object: pages with boxes, JPEG images, a little Helvetica text."""

    def __init__(self):
        self.objects = []  # bytes per object, 1-based

    def add(self, body):
        self.objects.append(body)
        return len(self.objects)

    def stream(self, dict_src, data):
        return self.add(b"<< " + dict_src + b" /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream")

    def save(self, path, root):
        out = io.BytesIO()
        out.write(b"%PDF-1.6\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for i, body in enumerate(self.objects, 1):
            offsets.append(out.tell())
            out.write(f"{i} 0 obj\n".encode() + body + b"\nendobj\n")
        xref = out.tell()
        out.write(f"xref\n0 {len(self.objects) + 1}\n0000000000 65535 f \n".encode())
        for o in offsets:
            out.write(f"{o:010d} 00000 n \n".encode())
        out.write(f"trailer\n<< /Size {len(self.objects) + 1} /Root {root} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
        with open(path, "wb") as f:
            f.write(out.getvalue())
        return out.tell()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=64, help="pages in all (a multiple of 4; the first two and last two are plain)")
    ap.add_argument("--out", default=os.path.join(ROOT, "testfiles", "heavy-cmyk-photos.pdf"))
    args = ap.parse_args()
    if not os.path.exists(ICC):
        sys.exit(f"missing {ICC} (see vendor/icc/README.txt)")
    px_w = round((W + 2 * BLEED) / 25.4 * PPI)
    px_h = round((H + 2 * BLEED) / 25.4 * PPI)
    srgb = ImageCms.createProfile("sRGB")
    press = ImageCms.getOpenProfile(ICC)
    transform = ImageCms.buildTransform(srgb, press, "RGB", "CMYK", renderingIntent=ImageCms.Intent.PERCEPTUAL)

    pdf = Pdf()
    font = pdf.add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pages_ref = len(pdf.objects) + 1  # the Pages object comes next
    pdf.add(b"")  # placeholder for Pages
    page_ids = []
    mw, mh = (W + 2 * BLEED) * MM, (H + 2 * BLEED) * MM
    boxes = (f"/MediaBox [0 0 {mw:.3f} {mh:.3f}] /TrimBox [{BLEED * MM:.3f} {BLEED * MM:.3f} {(W + BLEED) * MM:.3f} {(H + BLEED) * MM:.3f}] "
             f"/BleedBox [0 0 {mw:.3f} {mh:.3f}]").encode()
    photo = 0
    for n in range(1, args.pages + 1):
        plain = n <= 2 or n >= args.pages - 1
        content = []
        resources = b"/Font << /F1 " + str(font).encode() + b" 0 R >>"
        if plain:
            # A flat CMYK photo-like panel on the covers: a check that CMYK JPEGs come out in
            # their own colours (pure cyan here; inverted, it would be red).
            jpg = solid_cmyk_jpeg(512, 512, 1, 0, 0, 0) if n == 1 else None
            label = {1: "Front cover: heavy-cmyk-photos", 2: "Inside front cover", args.pages - 1: "Inside back cover", args.pages: "Back cover"}[n]
            content.append(f"BT /F1 24 Tf {20 * MM:.1f} {(H - 30) * MM:.1f} Td ({label}) Tj ET".encode())
            content.append(f"BT /F1 10 Tf {20 * MM:.1f} {(H - 40) * MM:.1f} Td ({args.pages} pages A4, 3 mm bleed, {args.pages - 4} full-bleed CMYK JPEG photos at 300 ppi) Tj ET".encode())
            if jpg:
                img = pdf.stream(b"/Type /XObject /Subtype /Image /Width 512 /Height 512 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode /Decode [1 0 1 0 1 0 1 0]", jpg)
                resources += b" /XObject << /Im0 " + str(img).encode() + b" 0 R >>"
                content.append(f"q {60 * MM:.2f} 0 0 {60 * MM:.2f} {20 * MM:.2f} {(H - 110) * MM:.2f} cm /Im0 Do Q".encode())
                content.append(f"BT /F1 9 Tf {20 * MM:.1f} {(H - 116) * MM:.1f} Td (This square is a CMYK JPEG of pure cyan: it must look cyan, not red.) Tj ET".encode())
        else:
            src = None
            while src is None:
                pid = IDS[photo % len(IDS)]
                photo += 1
                src = fetch(pid, px_w, px_h)
            print(f"page {n}: photo {pid}")
            jpg = cmyk_jpeg(src, px_w, px_h, transform)
            img = pdf.stream(f"/Type /XObject /Subtype /Image /Width {px_w} /Height {px_h} /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode /Decode [1 0 1 0 1 0 1 0]".encode(), jpg)
            resources += b" /XObject << /Im0 " + str(img).encode() + b" 0 R >>"
            content.append(f"q {mw:.3f} 0 0 {mh:.3f} 0 0 cm /Im0 Do Q".encode())
            # The page number, white on a black tab.
            x = (W - 24 + BLEED) * MM if n % 2 else (BLEED + 8) * MM
            content.append(f"q 0 0 0 1 k {x:.1f} {(BLEED + 8) * MM:.1f} {16 * MM:.1f} {10 * MM:.1f} re f Q".encode())
            content.append(f"BT 0 0 0 0 k /F1 14 Tf {x + 3 * MM:.1f} {(BLEED + 10.5) * MM:.1f} Td ({n}) Tj ET".encode())
        cs = pdf.stream(b"/Filter /FlateDecode", zlib.compress(b"\n".join(content)))
        page = pdf.add(b"<< /Type /Page /Parent " + str(pages_ref).encode() + b" 0 R " + boxes + b" /Resources << " + resources + b" >> /Contents " + str(cs).encode() + b" 0 R >>")
        page_ids.append(page)
    kids = b" ".join(f"{p} 0 R".encode() for p in page_ids)
    pdf.objects[pages_ref - 1] = b"<< /Type /Pages /Kids [" + kids + b"] /Count " + str(len(page_ids)).encode() + b" >>"
    root = pdf.add(b"<< /Type /Catalog /Pages " + str(pages_ref).encode() + b" 0 R >>")
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    size = pdf.save(args.out, root)
    print(f"wrote {args.out}: {size / 1e6:.0f} MB, {args.pages} pages")


if __name__ == "__main__":
    main()
