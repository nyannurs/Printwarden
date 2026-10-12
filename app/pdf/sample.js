// A synthetic InDesign-style export for trying the tool: single pages with trim, bleed
// and slug boxes. Both pages of each opening share a colour, so a correct pairing shows
// matching colours across the spine and a broken one is obvious at a glance.

import { PDFDocument, rgb, StandardFonts } from "../../vendor/pdf-lib.esm.js";
import { mmToPt } from "../core/units.js";

export async function makeSamplePdf({ pages = 44, width = 148, height = 210, bleed = 3, slug = 6 } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const small = await doc.embedFont(StandardFonts.Helvetica);
  const W = mmToPt(width);
  const H = mmToPt(height);
  const B = mmToPt(bleed);
  const S = mmToPt(slug);
  const off = B + S;

  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([W + 2 * off, H + 2 * off]);
    page.setTrimBox(off, off, W, H);
    page.setBleedBox(S, S, W + 2 * B, H + 2 * B);

    const opening = Math.floor(n / 2);
    const cover = n === 1 || n === pages;
    const hue = cover ? 0.58 : (opening * 0.13) % 1;
    const [r, g, b] = hsl(hue, cover ? 0.35 : 0.45, cover ? 0.32 : 0.8);
    page.drawRectangle({ x: S, y: S, width: W + 2 * B, height: H + 2 * B, color: rgb(r, g, b) });

    const recto = n % 2 === 1;
    const ink = cover ? rgb(1, 1, 1) : rgb(0.12, 0.12, 0.14);
    const margin = mmToPt(14);
    const numberText = String(n);
    const size = mmToPt(48);
    const tw = font.widthOfTextAtSize(numberText, size);
    const x = recto ? off + W - margin - tw : off + margin;
    page.drawText(numberText, { x, y: off + H - margin - size * 0.72, size, font, color: ink });

    const caption = cover
      ? n === 1 ? "Front cover" : "Back cover"
      : `${recto ? "Right-hand" : "Left-hand"} page • opening ${n >> 1}`;
    page.drawText(caption, { x: recto ? off + W - margin - small.widthOfTextAtSize(caption, 11) : off + margin, y: off + margin, size: 11, font: small, color: ink });

    // Slug text, outside the bleed: trimmed off, never visible in the book.
    page.drawText(`sample.indd  page ${n}`, { x: off, y: S / 3, size: 6, font: small, color: rgb(0.4, 0.4, 0.4) });
    if (n === 1) page.drawText("Sample publication", { x: off + margin, y: off + H / 2, size: 28, font, color: ink });
  }
  return doc.save();
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
