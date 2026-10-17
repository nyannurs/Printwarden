// A long test book: 240 pages of photographs and sample layouts, A5 with 3 mm bleed, single
// pages (as InDesign exports them). For the 3D view and the client viewer with a real book's
// length: chapter openers, full-bleed photos, images crossing the gutter, two-column text,
// pull quotes, picture grids, captions, blank versos, a table of contents, a colophon. Every
// page has its number in the outer corner and a running head. Photos: 240 JPEGs made by
// tools/prepare-long-photos.py (from the Lorem Picsum photos make-heavy-pdf.py downloads).
//
//   node tools/make-long-pdf.mjs                 # writes testfiles/long-layouts-240.pdf
//   node tools/make-long-pdf.mjs --pages 120     # a shorter one (a multiple of 4)
//
// Output is byte-stable for the same inputs (fixed dates), so git sees only real changes.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, cmyk } from "pdf-lib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PHOTOS = path.join(ROOT, "_build", "test-out", "long-photos");
const args = process.argv.slice(2);
const PAGES = Number(args[args.indexOf("--pages") + 1]) || 240;
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : path.join(ROOT, "testfiles", `long-layouts-${PAGES}.pdf`);

const W = 148, H = 210, BLEED = 3; // mm
const pt = (mm) => (mm * 72) / 25.4;
const PW = pt(W + 2 * BLEED), PH = pt(H + 2 * BLEED);
const INK = cmyk(0, 0, 0, 1);
const GREY = cmyk(0, 0, 0, 0.55);
const ACCENTS = [cmyk(0.9, 0.5, 0, 0), cmyk(0, 0.8, 0.9, 0), cmyk(0.7, 0, 0.6, 0), cmyk(0, 0.3, 0.95, 0), cmyk(0.85, 0.75, 0, 0.1), cmyk(0.2, 0.95, 0.3, 0.1)];

// Deterministic pseudo-Latin, so the text differs from page to page but never changes between runs.
const WORDS = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum paper spine fold signature gutter margin bleed trim press sheet imposition creep".split(" ");
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const word = () => WORDS[Math.floor(rnd() * WORDS.length)];
const sentence = () => { const n = 6 + Math.floor(rnd() * 10); const w = Array.from({ length: n }, word); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return w.join(" ") + "."; };
const paragraph = () => Array.from({ length: 3 + Math.floor(rnd() * 4) }, sentence).join(" ");
const title = () => { const w = Array.from({ length: 2 + Math.floor(rnd() * 3) }, word); return w.map((s) => s[0].toUpperCase() + s.slice(1)).join(" "); };

/** Lines of `text` wrapped to `width` pt in `font` at `size`. */
function wrap(font, size, text, width) {
  const lines = [];
  let line = "";
  for (const w of text.split(" ")) {
    const t = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > width && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

/** Draws `paragraphs` in a column; returns the y it stopped at. */
function column(page, font, size, leading, paragraphs, x, yTop, width, yBottom) {
  let y = yTop;
  for (const p of paragraphs) {
    for (const l of wrap(font, size, p, width)) {
      if (y - leading < yBottom) return y;
      page.drawText(l, { x, y: y - size, size, font, color: INK });
      y -= leading;
    }
    y -= leading * 0.6;
  }
  return y;
}

/** An image drawn to cover a box (mm, from the trim's bottom-left), cropped by the box. */
function cover(page, img, x0, y0, w, h, { shift = 0 } = {}) {
  const bx = pt(BLEED + x0), by = pt(BLEED + y0), bw = pt(w), bh = pt(h);
  const s = Math.max(bw / img.width, bh / img.height);
  const iw = img.width * s, ih = img.height * s;
  // pdf-lib has no clip helper: a rectangle path, clipped, round the picture.
  const { pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = pdfOps;
  page.pushOperators(pushGraphicsState(), rectangle(bx, by, bw, bh), clip(), endPath());
  page.drawImage(img, { x: bx + (bw - iw) / 2 + shift * iw, y: by + (bh - ih) / 2, width: iw, height: ih });
  page.pushOperators(popGraphicsState());
}
let pdfOps;

function furniture(page, fonts, n, head) {
  const outer = n % 2 === 1; // recto: the outer edge is the right
  const y = pt(BLEED + 8);
  const num = String(n);
  const nw = fonts.regular.widthOfTextAtSize(num, 8);
  page.drawText(num, { x: outer ? pt(BLEED + W - 12) - nw : pt(BLEED + 12), y, size: 8, font: fonts.regular, color: INK });
  const hw = fonts.regular.widthOfTextAtSize(head, 6.5);
  page.drawText(head, { x: outer ? pt(BLEED + W - 12) - hw : pt(BLEED + 12), y: pt(BLEED + H - 9), size: 6.5, font: fonts.regular, color: GREY });
}

async function main() {
  pdfOps = await import("pdf-lib");
  const names = (await fs.readdir(PHOTOS).catch(() => [])).filter((f) => f.endsWith(".jpg")).sort();
  if (names.length < 20) throw new Error(`${names.length} photos in ${PHOTOS}: run tools/prepare-long-photos.py first`);
  const doc = await PDFDocument.create();
  const fixed = new Date("2026-10-17T00:00:00Z");
  doc.setCreationDate(fixed); doc.setModificationDate(fixed);
  doc.setProducer("Printwarden test files"); doc.setCreator("tools/make-long-pdf.mjs");
  doc.setTitle(`Long book, ${PAGES} pages`);
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), serif: await doc.embedFont(StandardFonts.TimesRoman), italic: await doc.embedFont(StandardFonts.TimesRomanItalic) };
  const photos = [];
  let next = 0;
  const photo = async () => {
    const k = next++ % names.length;
    if (!photos[k]) photos[k] = await doc.embedJpg(await fs.readFile(path.join(PHOTOS, names[k])));
    return photos[k];
  };
  const addPage = () => {
    const p = doc.addPage([PW, PH]);
    p.setTrimBox(pt(BLEED), pt(BLEED), pt(W), pt(H));
    p.setBleedBox(0, 0, PW, PH);
    return p;
  };
  const box = (page, x, y, w, h, color) => page.drawRectangle({ x: pt(BLEED + x), y: pt(BLEED + y), width: pt(w), height: pt(h), color });
  const text = (page, font, s, x, y, size, color = INK) => page.drawText(s, { x: pt(BLEED + x), y: pt(BLEED + y), size, font, color });
  const M = 14; // margin mm
  const chapters = [];
  const bookTitle = "Long Book";

  // The cycle of layouts in a chapter (12 pages; chapter openers fall on odd pages: rectos).
  const cycle = ["opener", "photo", "text2", "caption", "textquote", "spreadL", "spreadR", "grid", "textimage", "photo", "text2", "blank"];
  for (let n = 1; n <= PAGES; n++) {
    const page = addPage();
    const chapter = chapters.length;
    const accent = ACCENTS[chapter % ACCENTS.length];
    if (n === 1) {
      cover(page, await photo(), -BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED);
      box(page, 0, 60, W, 46, cmyk(0, 0, 0, 0.85));
      text(page, fonts.bold, bookTitle, M, 84, 30, cmyk(0, 0, 0, 0));
      text(page, fonts.regular, `${PAGES} pages of photographs and sample layouts`, M, 72, 9, cmyk(0, 0, 0, 0));
      text(page, fonts.regular, "Printwarden test file: long-layouts", M, 66, 7, cmyk(0, 0, 0, 0));
      continue;
    }
    if (n === 2) { text(page, fonts.regular, "Inside front cover (C2). Unprinted but for this line.", M, H - M - 4, 7, GREY); continue; }
    if (n === 3) {
      text(page, fonts.bold, bookTitle, M, H - 60, 26);
      text(page, fonts.serif, "A test book for the 3D preview and the client viewer", M, H - 72, 10);
      text(page, fonts.regular, "A5, single pages, 3 mm bleed. Chapters of twelve pages: an opener, full-bleed", M, 40, 7.5);
      text(page, fonts.regular, "photographs, a picture across the gutter, two-column text, a pull quote, a grid,", M, 35, 7.5);
      text(page, fonts.regular, "text with a picture, a blank verso. Every page numbered in its outer corner.", M, 30, 7.5);
      continue;
    }
    if (n === 4) { furniture(page, fonts, n, bookTitle); continue; }
    if (n === 5 || n === 6) {
      furniture(page, fonts, n, "Contents");
      if (n === 5) text(page, fonts.bold, "Contents", M, H - 40, 18);
      const first = n === 5 ? 0 : 20;
      const chapterCount = Math.ceil((PAGES - 8) / cycle.length);
      let y = n === 5 ? H - 56 : H - 30;
      for (let c = first; c < Math.min(chapterCount, first + 20); c++) {
        const pageNo = 7 + c * cycle.length;
        if (pageNo > PAGES - 2) break;
        text(page, fonts.serif, `${c + 1}  ${titleOf(c)}`, M, y, 9);
        const s = String(pageNo);
        page.drawText(s, { x: pt(BLEED + W - M) - fonts.serif.widthOfTextAtSize(s, 9), y: pt(BLEED + y), size: 9, font: fonts.serif, color: INK });
        y -= 6.5;
      }
      continue;
    }
    if (n === PAGES - 1) {
      furniture(page, fonts, n, "Colophon");
      text(page, fonts.bold, "Colophon", M, H - 40, 14);
      text(page, fonts.regular, "Photographs: Lorem Picsum (picsum.photos), Unsplash photographers, Unsplash licence.", M, H - 52, 7.5);
      text(page, fonts.regular, "Text: generated nonsense. Made by tools/make-long-pdf.mjs for testing Printwarden.", M, H - 58, 7.5);
      continue;
    }
    if (n === PAGES) {
      cover(page, await photo(), -BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED);
      box(page, 0, 20, W, 30, cmyk(0, 0, 0, 0.85));
      text(page, fonts.regular, "Back cover (C4)", M, 36, 10, cmyk(0, 0, 0, 0));
      text(page, fonts.regular, `${PAGES} pages, ${Math.ceil((PAGES - 8) / cycle.length)} chapters`, M, 28, 7, cmyk(0, 0, 0, 0));
      continue;
    }
    const k = (n - 7) % cycle.length;
    if (k === 0) chapters.push(titleOf(chapters.length));
    const head = `${bookTitle} · ${chapters[chapters.length - 1] ?? ""}`;
    const kind = cycle[k];
    const textWidth = pt(W - 2 * M);
    if (kind === "opener") {
      box(page, -BLEED, -BLEED, W + 2 * BLEED, 90 + BLEED, accent);
      text(page, fonts.bold, String(chapters.length), M, H - 70, 64, accent);
      text(page, fonts.serif, chapters[chapters.length - 1], M, H - 84, 16);
      text(page, fonts.italic, sentence(), M, H - 94, 9, GREY);
      text(page, fonts.regular, `Chapter ${chapters.length} opens on a right-hand page.`, M, 20, 7.5, cmyk(0, 0, 0, 0));
      furniture(page, fonts, n, head);
    } else if (kind === "photo") {
      cover(page, await photo(), -BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED);
      box(page, n % 2 ? W - 30 : 0, 0, 30, 10, cmyk(0, 0, 0, 0.8));
      page.drawText(String(n), { x: pt(BLEED + (n % 2 ? W - 16 : 14)) - (n % 2 ? fonts.regular.widthOfTextAtSize(String(n), 8) : 0), y: pt(BLEED + 3), size: 8, font: fonts.regular, color: cmyk(0, 0, 0, 0) });
    } else if (kind === "text2") {
      furniture(page, fonts, n, head);
      text(page, fonts.bold, title(), M, H - 30, 12);
      const colW = (W - 2 * M - 5) / 2;
      const paras = Array.from({ length: 6 }, paragraph);
      column(page, fonts.serif, 8, 10.5, paras.slice(0, 3), pt(BLEED + M), pt(BLEED + H - 38), pt(colW), pt(BLEED + 18));
      column(page, fonts.serif, 8, 10.5, paras.slice(3), pt(BLEED + M + colW + 5), pt(BLEED + H - 38), pt(colW), pt(BLEED + 18));
    } else if (kind === "caption") {
      furniture(page, fonts, n, head);
      cover(page, await photo(), M, 70, W - 2 * M, H - 70 - 24);
      text(page, fonts.italic, `Fig. ${n}. ${sentence()}`, M, 62, 7.5, GREY);
      column(page, fonts.serif, 8, 10.5, [paragraph(), paragraph()], pt(BLEED + M), pt(BLEED + 56), textWidth, pt(BLEED + 18));
    } else if (kind === "textquote") {
      furniture(page, fonts, n, head);
      const y = column(page, fonts.serif, 8, 10.5, [paragraph(), paragraph()], pt(BLEED + M), pt(BLEED + H - 24), textWidth, pt(BLEED + 110));
      box(page, M, 72, 2, 34, accent);
      const q = wrap(fonts.italic, 13, `"${sentence()}"`, textWidth - pt(10));
      q.forEach((l, i) => text(page, fonts.italic, l, M + 6, 100 - i * 8, 13));
      column(page, fonts.serif, 8, 10.5, [paragraph(), paragraph()], pt(BLEED + M), Math.min(y, pt(BLEED + 66)), textWidth, pt(BLEED + 18));
    } else if (kind === "spreadL" || kind === "spreadR") {
      // One picture across the gutter: the left page shows its left half, the right its right.
      if (kind === "spreadL") page.userData = { img: await photo() };
      const img = kind === "spreadL" ? page.userData.img : lastSpread;
      lastSpread = img;
      const left = kind === "spreadL";
      // The picture spans 2 W + 2 BLEED; this page shows one half, bleeding past the gutter by the bleed.
      const bx = pt(0), by = pt(BLEED + 40), bw = PW, bh = pt(H - 40 - 30);
      const full = 2 * PW;
      const s = Math.max(full / img.width, bh / img.height);
      const iw = img.width * s, ih = img.height * s;
      const { pushGraphicsState, popGraphicsState, rectangle, clip, endPath } = pdfOps;
      page.pushOperators(pushGraphicsState(), rectangle(bx, by, bw, bh), clip(), endPath());
      page.drawImage(img, { x: (left ? 0 : -PW) + (full - iw) / 2, y: by + (bh - ih) / 2, width: iw, height: ih });
      page.pushOperators(popGraphicsState());
      furniture(page, fonts, n, head);
      text(page, fonts.italic, left ? "A picture across the gutter: its left half." : "Its right half. The join is at the spine.", M, 32, 7.5, GREY);
      column(page, fonts.serif, 8, 10.5, [paragraph()], pt(BLEED + M), pt(BLEED + H - 16), textWidth, pt(BLEED + H - 38));
    } else if (kind === "grid") {
      furniture(page, fonts, n, head);
      text(page, fonts.bold, title(), M, H - 30, 12);
      const gw = (W - 2 * M - 4) / 2, gh = (H - 60 - 4) / 2;
      for (let i = 0; i < 4; i++) cover(page, await photo(), M + (i % 2) * (gw + 4), 22 + (1 - Math.floor(i / 2)) * (gh + 4), gw, gh);
    } else if (kind === "textimage") {
      furniture(page, fonts, n, head);
      text(page, fonts.bold, title(), M, H - 30, 12);
      cover(page, await photo(), n % 2 ? W - M - 60 : M, H - 110, 60, 70);
      const colX = n % 2 ? M : M + 64;
      column(page, fonts.serif, 8, 10.5, [paragraph(), paragraph()], pt(BLEED + colX), pt(BLEED + H - 40), pt(W - 2 * M - 64), pt(BLEED + 104));
      column(page, fonts.serif, 8, 10.5, [paragraph(), paragraph(), paragraph()], pt(BLEED + M), pt(BLEED + 96), textWidth, pt(BLEED + 18));
    } else if (kind === "blank") {
      furniture(page, fonts, n, head);
      text(page, fonts.regular, "This page is intentionally blank.", M, H / 2, 7, GREY);
    }
  }
  const bytes = await doc.save({ useObjectStreams: true });
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, bytes);
  console.log(`${path.relative(ROOT, OUT)}: ${PAGES} pages, ${(bytes.length / 1e6).toFixed(0)} MB, ${chapters.length} chapters, ${next} photos placed`);
}
let lastSpread = null;
const TITLES = [];
function titleOf(c) {
  while (TITLES.length <= c) TITLES.push(title());
  return TITLES[c];
}

main().catch((err) => { console.error(err); process.exit(1); });
