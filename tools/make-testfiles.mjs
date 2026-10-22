// The test documents (testfiles/): PDFs made to check the app against, each with what to
// expect printed on it. For development only; see testfiles/README.md for what each is for.
//
//   node tools/make-testfiles.mjs          writes them all into testfiles/
//
// Made with pdf-lib, as the app's own sample is (app/pdf/sample.js); the spine widths come
// from the app's own arithmetic (app/core/spine.js), so the cover files fit the books they
// go with as the app calculates them with its default paper (120 gsm uncoated).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cmyk, degrees, PDFDocument, PDFName, popGraphicsState, pushGraphicsState, rgb, setGraphicsState, StandardFonts,
  concatTransformationMatrix, drawObject, PDFNumber, PDFOperator,
} from "pdf-lib";
import { defaultPaper } from "../app/core/paper.js";
import { BOARD_MM, calculatedSpine, CASE_JOINT_MM, CASE_SQUARE_MM } from "../app/core/spine.js";
import { mmToPt } from "../app/core/units.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "..", "testfiles");
const pt = mmToPt;
const W = 148;
const H = 210;
const BLEED = 3;

// A spread's colour (both pages of an opening alike), light, in CMYK as a print file has it.
const spreadColour = (opening) => {
  const hues = [[0.25, 0, 0, 0], [0, 0.22, 0, 0], [0, 0, 0.35, 0], [0.2, 0.2, 0, 0], [0, 0.18, 0.3, 0], [0.22, 0, 0.22, 0]];
  const [c, m, y, k] = hues[opening % hues.length];
  return cmyk(c, m, y, k);
};
const INK = cmyk(0, 0, 0, 1);
const PAPER = cmyk(0, 0, 0, 0);

/** A page of a single-page export: media box with bleed round the trim, the boxes set, white. */
function addPage(doc, { width = W, height = H, bleed = BLEED } = {}) {
  const page = doc.addPage([pt(width + 2 * bleed), pt(height + 2 * bleed)]);
  page.setTrimBox(pt(bleed), pt(bleed), pt(width), pt(height));
  page.setBleedBox(0, 0, pt(width + 2 * bleed), pt(height + 2 * bleed));
  return page;
}

/** Text at (x, y) mm from the trim's lower left, size in pt. */
function text(page, font, s, x, y, size, { color = INK, bleed = BLEED, rotate = 0 } = {}) {
  page.drawText(s, { x: pt(bleed + x), y: pt(bleed + y), size, font, color, rotate: degrees(rotate) });
}

/** A filled rectangle, mm from the trim's lower left (negative: into the bleed). */
function box(page, x, y, w, h, color, { bleed = BLEED, opacity } = {}) {
  page.drawRectangle({ x: pt(bleed + x), y: pt(bleed + y), width: pt(w), height: pt(h), color, opacity });
}

/** The head's arrow and the word TOP: a page printed upside down is seen at once. */
function headMark(page, font, width = W, height = H, { bleed = BLEED } = {}) {
  const cx = width / 2;
  page.drawLine({ start: { x: pt(bleed + cx), y: pt(bleed + height - 14) }, end: { x: pt(bleed + cx), y: pt(bleed + height - 6) }, thickness: 1.2, color: INK });
  page.drawLine({ start: { x: pt(bleed + cx - 2.5), y: pt(bleed + height - 9) }, end: { x: pt(bleed + cx), y: pt(bleed + height - 6) }, thickness: 1.2, color: INK });
  page.drawLine({ start: { x: pt(bleed + cx + 2.5), y: pt(bleed + height - 9) }, end: { x: pt(bleed + cx), y: pt(bleed + height - 6) }, thickness: 1.2, color: INK });
  text(page, font, "TOP", cx - 4.2, height - 19, 8, { bleed });
}

/**
 * A millimetre scale along the fore-edge, 0 at the trim: after trimming, a booklet's inner
 * pages lose millimetres here (creep), and the scale shows how many.
 */
function foreEdgeScale(page, font, recto, { width = W, height = H, bleed = BLEED } = {}) {
  const x0 = recto ? width : 0;
  const dir = recto ? -1 : 1;
  for (let mm = 0; mm <= 12; mm++) {
    const long = mm % 5 === 0;
    const y0 = height / 2 - 30;
    page.drawLine({ start: { x: pt(bleed + x0 + dir * mm), y: pt(bleed + y0) }, end: { x: pt(bleed + x0 + dir * mm), y: pt(bleed + y0 + (long ? 6 : 3)) }, thickness: 0.4, color: INK });
    if (long) text(page, font, String(mm), x0 + dir * mm - 1.2, y0 + 7.5, 6, { bleed });
  }
  text(page, font, "mm from the trimmed edge", recto ? width - 36 : 2, height / 2 - 36, 6, { bleed });
}

/** A page of a book: number, head mark, the spread's colour, labels. */
function bookPage(doc, fonts, n, total, { recto = n % 2 === 1, label = null, signature = null, glueStrip = false } = {}) {
  const page = addPage(doc);
  const opening = Math.floor(n / 2);
  box(page, -BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED, spreadColour(opening));
  const num = String(n);
  const size = pt(40);
  const tw = fonts.bold.widthOfTextAtSize(num, size);
  // The number at the fore-edge (outer) top corner, as folios go.
  page.drawText(num, { x: pt(BLEED + (recto ? W - 16 - tw / pt(1) * 0 : 16)) - (recto ? tw : 0), y: pt(BLEED + H - 16) - size * 0.75, size, font: fonts.bold, color: INK });
  headMark(page, fonts.regular);
  foreEdgeScale(page, fonts.regular, recto);
  const caption = label ?? `${recto ? "Right-hand" : "Left-hand"} page • opening ${opening} of ${Math.floor(total / 2)}`;
  text(page, fonts.regular, caption, recto ? 16 : 16, 14, 9);
  if (signature != null) {
    // A tab at the spine edge, lower down for each signature: seen on the block's spine side
    // when the book is closed, the signatures show as steps.
    const y = 40 + signature * 14;
    box(page, recto ? -BLEED : W - 10, y, 10 + BLEED, 10, INK);
    text(page, fonts.regular, `signature ${signature + 1}`, recto ? 14 : W - 40, y + 3, 7);
  }
  if (glueStrip) {
    // Ticks every millimetre from the spine for 12 mm: side glue hides the first 6 of them.
    for (let mm = 1; mm <= 12; mm++) {
      const x = recto ? mm : W - mm;
      page.drawLine({ start: { x: pt(BLEED + x), y: pt(BLEED + H / 2 - 20) }, end: { x: pt(BLEED + x), y: pt(BLEED + H / 2 + 20) }, thickness: mm % 6 === 0 ? 0.8 : 0.3, color: INK });
    }
    text(page, fonts.regular, "glue zone: 1 mm ticks from the spine (6 mm of them hidden by the side glue)", recto ? 14 : 14, H / 2 + 24, 6);
  }
  return page;
}

async function fontsOf(doc) {
  return { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
}

async function booklet(pages, name) {
  const doc = await newDoc();
  const fonts = await fontsOf(doc);
  for (let n = 1; n <= pages; n++) {
    const label = n === 1 ? "Front cover (page 1)" : n === pages ? `Back cover (page ${pages})` : null;
    bookPage(doc, fonts, n, pages, { label });
  }
  text(doc.getPage(0), fonts.bold, name, 16, H / 2, 18);
  text(doc.getPage(0), fonts.regular, `${pages} pages, A5, 3 mm bleed. Staple binding.`, 16, H / 2 - 8, 9);
  text(doc.getPage(0), fonts.regular, "Every page: its number top outer corner, TOP at the head, a mm scale at the fore-edge.", 16, H / 2 - 14, 7);
  return doc.save();
}

async function book36() {
  const doc = await newDoc();
  const fonts = await fontsOf(doc);
  const n = 36;
  for (let p = 1; p <= n; p++) {
    const cover = p <= 2 || p >= n - 1;
    const label = p === 1 ? "Front cover (C1)" : p === 2 ? "Inside front cover (C2)" : p === n - 1 ? "Inside back cover (C3)" : p === n ? "Back cover (C4)" : null;
    // Between the covers, 16-page signatures: pages 3-18 the first, 19-34 the second.
    const signature = cover ? null : Math.floor((p - 3) / 16);
    const page = bookPage(doc, fonts, p, n, { label, signature, glueStrip: p === 2 || p === 3 || p === n - 2 || p === n - 1 });
    if (cover) box(page, -BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED, cmyk(0.6, 0.3, 0, 0.5));
    if (cover) {
      text(page, fonts.bold, label, 16, H / 2, 16, { color: PAPER });
      text(page, fonts.bold, String(p), 16, H - 40, 30, { color: PAPER });
    }
  }
  text(doc.getPage(0), fonts.regular, "book-36: 36 pages, A5, 3 mm bleed. Perfect, sewn (16-page signatures) or hardcover.", 16, 30, 7, { color: PAPER });
  text(doc.getPage(0), fonts.regular, "Pages 1, 2, 35, 36 are the cover; 3 to 34 the block in two signatures.", 16, 25, 7, { color: PAPER });
  return doc.save();
}

/**
 * A cover file: page 1 the outside as one spread (back cover, spine, front cover, flaps
 * beyond), page 2 the inside the same way (or none).
 */
async function coverFile({ spineMm, flapMm = 0, inside = true, height = H, name, note }) {
  const doc = await newDoc();
  const fonts = await fontsOf(doc);
  const width = 2 * W + spineMm + 2 * flapMm;
  const make = (outside) => {
    const page = addPage(doc, { width, height });
    const x = (v) => v; // mm from the trim's left
    const left = flapMm; // the back cover starts here
    // Back (or inside back) | spine | front (or inside front).
    box(page, x(left), 0, W, height, outside ? cmyk(0, 0.7, 0.6, 0.1) : cmyk(0, 0.2, 0.15, 0));
    box(page, x(left + W), 0, spineMm, height, outside ? cmyk(0, 0, 0, 0.9) : cmyk(0, 0, 0, 0.2));
    box(page, x(left + W + spineMm), 0, W, height, outside ? cmyk(0.7, 0.2, 0, 0.1) : cmyk(0.2, 0.05, 0, 0));
    if (flapMm) {
      box(page, x(0), 0, flapMm, height, outside ? cmyk(0, 0.4, 0.9, 0) : cmyk(0, 0.1, 0.3, 0));
      box(page, x(left + 2 * W + spineMm), 0, flapMm, height, outside ? cmyk(0.4, 0, 0.9, 0) : cmyk(0.1, 0, 0.3, 0));
      text(page, fonts.bold, outside ? "BACK FLAP (outside)" : "back flap, inside", 6, height / 2, 12, { color: outside ? INK : INK, rotate: 90 });
      text(page, fonts.bold, outside ? "FRONT FLAP (outside)" : "front flap, inside", left + 2 * W + spineMm + 6, height / 2 - 30, 12, { rotate: 90 });
    }
    const big = outside ? PAPER : INK;
    text(page, fonts.bold, outside ? "BACK COVER (C4)" : "INSIDE BACK COVER (C3)", left + 14, height / 2, 18, { color: big });
    text(page, fonts.bold, outside ? "FRONT COVER (C1)" : "INSIDE FRONT COVER (C2)", left + W + spineMm + 14, height / 2, 18, { color: big });
    text(page, fonts.regular, name, left + W + spineMm + 14, height / 2 - 10, 9, { color: big });
    text(page, fonts.regular, note, left + W + spineMm + 14, height / 2 - 16, 7, { color: big });
    // The spine's text reads from the head down, as on a shelf (Europe: bottom to top is also
    // common; the app shows whatever is printed). An arrow points to the head.
    if (spineMm >= 2) {
      const sx = left + W + spineMm / 2;
      text(page, fonts.bold, outside ? `SPINE ${spineMm} mm, head this way >` : "spine, inside", sx + 1.4, height - 20, Math.min(10, spineMm * 3), { color: outside ? PAPER : INK, rotate: -90 });
    }
    for (const [x, lab] of [[left + 2, "back"], [left + W, "spine"], [left + W + spineMm + 2, "front"]]) {
      text(page, fonts.regular, lab, x, 4, 6, { color: outside ? PAPER : INK });
    }
    headMark(page, fonts.regular, width, height);
    return page;
  };
  make(true);
  if (inside) make(false);
  return doc.save();
}

/**
 * A hardcover's case wrap, as a printer wants it: the boards, the joints and the case spine
 * that show outside, with a turn-in all round (it wraps round the boards' edges and ends under
 * the endpapers). Visible: two boards' faces (the page's width, a square, less a joint each),
 * the joints and spine between (the case spine and a joint on either side), the boards' height
 * (the pages' and a square above and below). See caseWrapPages in app/core/analysis.js.
 */
async function caseWrap({ spineMm, turnInMm = 15, name, note }) {
  const doc = await newDoc();
  const fonts = await fontsOf(doc);
  const board = W + CASE_SQUARE_MM - CASE_JOINT_MM;
  const visibleW = 2 * W + 2 * CASE_SQUARE_MM + spineMm;
  const visibleH = H + 2 * CASE_SQUARE_MM;
  const width = visibleW + 2 * turnInMm;
  const height = visibleH + 2 * turnInMm;
  const page = addPage(doc, { width, height });
  const t = turnInMm;
  box(page, 0, 0, width, height, cmyk(0, 0, 0, 0.3)); // the turn-ins
  box(page, t, t, board, visibleH, cmyk(0, 0.7, 0.6, 0.1)); // the back board
  box(page, t + board, t, visibleW - 2 * board, visibleH, cmyk(0, 0, 0, 0.9)); // joints and spine
  box(page, t + visibleW - board, t, board, visibleH, cmyk(0.7, 0.2, 0, 0.1)); // the front board
  text(page, fonts.bold, "BACK BOARD (C4)", t + 14, t + visibleH / 2, 18, { color: PAPER });
  text(page, fonts.bold, "FRONT BOARD (C1)", t + visibleW - board + 14, t + visibleH / 2, 18, { color: PAPER });
  text(page, fonts.regular, name, t + visibleW - board + 14, t + visibleH / 2 - 10, 9, { color: PAPER });
  text(page, fonts.regular, note, t + visibleW - board + 14, t + visibleH / 2 - 16, 7, { color: PAPER });
  const sx = t + W + CASE_SQUARE_MM + spineMm / 2;
  text(page, fonts.bold, `SPINE ${spineMm} mm, head this way >`, sx + 1.4, t + visibleH - 20, Math.min(10, spineMm * 3), { color: PAPER, rotate: -90 });
  text(page, fonts.regular, `turn-in ${turnInMm} mm`, 4, 4, 7, { color: INK });
  headMark(page, fonts.regular, width, height);
  return doc.save();
}

/** Spine artwork on its own: the spine's size, an arrow to the head, text reading down. */
async function spineArt(widthMm, heightMm, name) {
  const doc = await newDoc();
  const fonts = await fontsOf(doc);
  const page = addPage(doc, { width: widthMm, height: heightMm, bleed: 0 });
  box(page, 0, 0, widthMm, heightMm, cmyk(0.8, 0.5, 0, 0.2), { bleed: 0 });
  box(page, 0, heightMm - 12, widthMm, 12, cmyk(0, 0.8, 0.9, 0), { bleed: 0 }); // a red band at the head
  text(page, fonts.bold, `${name}  to the head: up`, widthMm / 2 + 1.4, heightMm - 16, Math.min(9, widthMm * 2.6), { color: PAPER, bleed: 0, rotate: -90 });
  return doc.save();
}

/** A spot finish: shapes on white, one page for C1 and one for C4 of a book. */
async function finishCovers() {
  const doc = await newDoc();
  const fonts = await fontsOf(doc);
  for (const which of ["FRONT", "BACK"]) {
    const page = addPage(doc);
    page.drawCircle({ x: pt(BLEED + W / 2), y: pt(BLEED + H / 2 + 20), size: pt(30), color: INK });
    text(page, fonts.bold, which, W / 2 - 22, 40, 36);
    text(page, fonts.regular, "finish layer: the black is where the varnish or foil goes", 10, 20, 7);
  }
  return doc.save();
}

/** A new document with fixed dates: made again, a file is the same bytes (git sees only real changes). */
async function newDoc() {
  const doc = await PDFDocument.create();
  const fixed = new Date("2026-10-17T00:00:00Z");
  doc.setCreationDate(fixed);
  doc.setModificationDate(fixed);
  doc.setProducer("Printwarden test files");
  doc.setCreator("tools/make-testfiles.mjs");
  return doc;
}

/** Overprint: the same objects knocking out (left) and overprinting (right) on a cyan panel. */
async function overprint() {
  const doc = await newDoc();
  const fonts = await fontsOf(doc);
  const page = addPage(doc);
  const gs = doc.context.register(doc.context.obj({ Type: "ExtGState", OP: true, op: true, OPM: 1 }));
  page.node.setExtGState(PDFName.of("GSop"), gs);
  const over = (draw) => {
    page.pushOperators(pushGraphicsState(), setGraphicsState("GSop"));
    draw();
    page.pushOperators(popGraphicsState());
  };
  box(page, 10, 60, W - 20, 120, cmyk(1, 0, 0, 0)); // the cyan panel
  text(page, fonts.bold, "overprint", 10, H - 25, 20);
  text(page, fonts.regular, "Color › Overprint. Left column: ordinary objects (knockout). Right column: the same, set to overprint.", 10, H - 33, 7);
  text(page, fonts.regular, "Shown: white text vanishes, yellow turns green, black stays black. Ignored: both columns look alike.", 10, H - 39, 7);
  text(page, fonts.bold, "KNOCKOUT", 16, 170, 9, { color: PAPER });
  text(page, fonts.bold, "OVERPRINT", W / 2 + 6, 170, 9, { color: PAPER });
  // Row 1: white text.
  text(page, fonts.bold, "White text", 16, 150, 16, { color: PAPER });
  over(() => text(page, fonts.bold, "White text", W / 2 + 6, 150, 16, { color: PAPER }));
  text(page, fonts.regular, "stays white", 16, 144, 6, { color: PAPER });
  text(page, fonts.regular, "shown: vanishes", W / 2 + 6, 144, 6, { color: PAPER });
  // Row 2: yellow box.
  box(page, 16, 108, 50, 28, cmyk(0, 0, 1, 0));
  over(() => box(page, W / 2 + 6, 108, 50, 28, cmyk(0, 0, 1, 0)));
  text(page, fonts.regular, "yellow", 16, 102, 6, { color: PAPER });
  text(page, fonts.regular, "shown: green (yellow × cyan)", W / 2 + 6, 102, 6, { color: PAPER });
  // Row 3: black text.
  text(page, fonts.bold, "Black text", 16, 80, 16);
  over(() => text(page, fonts.bold, "Black text", W / 2 + 6, 80, 16));
  text(page, fonts.regular, "black", 16, 74, 6, { color: PAPER });
  text(page, fonts.regular, "black either way", W / 2 + 6, 74, 6, { color: PAPER });
  text(page, fonts.regular, "The choice is remembered: quit and start again, it should be as left.", 10, 50, 7);
  for (let n = 2; n <= 4; n++) bookPage(doc, fonts, n, 4, { label: n === 4 ? "Back cover (page 4)" : null });
  return doc.save();
}

/**
 * A spot colour twice: left a flat fill, right an image in the same ink, as Photoshop exports a
 * monotone or a spot channel (a one-ink DeviceN, NChannel, the ink defined under /Colorants)
 * with Photoshop's tint transform, which halves the ink's chroma. Drawn as the ink (Acrobat,
 * and pdf.js as patched, see tools/patch-pdfjs.py), both halves are the same pink; by the tint
 * transform the image is dull mauve (the designer's spot test).
 */
async function spotImage() {
  const doc = await newDoc();
  const fonts = await fontsOf(doc);
  const ctx = doc.context;
  const lab = ctx.obj([PDFName.of("Lab"), { WhitePoint: [0.9642, 1, 0.8249], Range: [-128, 127, -128, 127] }]);
  const ink = PDFName.of("Rubine Test");
  const separation = ctx.register(ctx.obj([PDFName.of("Separation"), ink, lab,
    { FunctionType: 2, Domain: [0, 1], C0: [100, 0, 0], C1: [60.39, 57, 10], N: 1, Range: [0, 100, -128, 127, -128, 127] }]));
  // Photoshop's: L as the ink's, a and b each half of it ({t} -> {100 - 39.6t, 28.5t, 5t}).
  const tint = ctx.register(ctx.stream("{ dup -39.61 mul 100 add exch dup 28.5 mul exch 5 mul }",
    { FunctionType: 4, Domain: [0, 1], Range: [0, 100, -128, 127, -128, 127] }));
  const nchannel = ctx.obj({ Subtype: "NChannel", Colorants: ctx.obj({ "Rubine Test": separation }) });
  const deviceN = ctx.obj([PDFName.of("DeviceN"), ctx.obj([ink]), lab, tint, nchannel]);
  const image = ctx.register(ctx.stream(new Uint8Array(64).fill(255), {
    Type: "XObject", Subtype: "Image", Width: 8, Height: 8, BitsPerComponent: 8, ColorSpace: deviceN,
  }));
  const page = addPage(doc);
  page.node.setXObject(PDFName.of("ImSpot"), image);
  const res = page.node.Resources();
  res.set(PDFName.of("ColorSpace"), ctx.obj({ CSspot: separation }));
  const at = (mm) => mmToPt(mm);
  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of("cs", [PDFName.of("CSspot")]),
    PDFOperator.of("scn", [PDFNumber.of(1)]),
    PDFOperator.of("re", [at(10), at(60), at(60), at(100)].map((v) => PDFNumber.of(v))),
    PDFOperator.of("f"),
    popGraphicsState(),
    pushGraphicsState(),
    concatTransformationMatrix(at(60), 0, 0, at(100), at(78), at(60)),
    drawObject("ImSpot"),
    popGraphicsState(),
  );
  text(page, fonts.bold, "spot-image", 10, H - 25, 20);
  text(page, fonts.regular, "Left: the spot colour as a flat fill. Right: an image in the same ink, as Photoshop exports a monotone.", 10, H - 33, 7);
  text(page, fonts.regular, "Both halves should be the same bright pink, as Acrobat shows them; a dull right half is the ink's tint transform.", 10, H - 39, 7);
  text(page, fonts.bold, "FLAT", 12, 52, 9);
  text(page, fonts.bold, "IMAGE", 80, 52, 9);
  for (let n = 2; n <= 4; n++) bookPage(doc, fonts, n, 4, { label: n === 4 ? "Back cover (page 4)" : null });
  return doc.save();
}

/** Plain CMYK patches (change with the profile), RGB patches (don't), a plain CMYK image. */
async function colourProfiles({ intent }) {
  const doc = await newDoc();
  const fonts = await fontsOf(doc);
  const patches = [["C", cmyk(1, 0, 0, 0)], ["M", cmyk(0, 1, 0, 0)], ["Y", cmyk(0, 0, 1, 0)], ["K", cmyk(0, 0, 0, 1)],
    ["C+M", cmyk(1, 1, 0, 0)], ["C+Y", cmyk(1, 0, 1, 0)], ["M+Y", cmyk(0, 1, 1, 0)], ["C+M+Y", cmyk(1, 1, 1, 0)],
    ["rich black", cmyk(0.6, 0.4, 0.4, 1)], ["50 % K", cmyk(0, 0, 0, 0.5)], ["20 % tints", cmyk(0.2, 0.2, 0.2, 0)], ["C 50 %", cmyk(0.5, 0, 0, 0)]];
  const grid = (page, list, title, note) => {
    text(page, fonts.bold, title, 10, H - 25, 16);
    text(page, fonts.regular, note, 10, H - 33, 7);
    list.forEach(([name, color], i) => {
      const col = i % 3;
      const r = Math.floor(i / 3);
      const x = 10 + col * 44;
      const y = H - 80 - r * 36;
      box(page, x, y, 40, 26, color);
      text(page, fonts.regular, name, x, y - 5, 7);
    });
  };
  const p1 = addPage(doc);
  grid(p1, patches, "Plain CMYK", "These change with Color › CMYK profile (try US Newsprint or SWOP against ISO Coated).");
  const p2 = addPage(doc);
  const asRgb = [["C", rgb(0, 0.68, 0.94)], ["M", rgb(0.93, 0, 0.55)], ["Y", rgb(1, 0.95, 0)], ["K", rgb(0.14, 0.12, 0.13)],
    ["C+M", rgb(0.18, 0.19, 0.57)], ["C+Y", rgb(0, 0.65, 0.31)], ["M+Y", rgb(0.93, 0.11, 0.14)], ["C+M+Y", rgb(0.2, 0.19, 0.19)],
    ["rich black", rgb(0.05, 0.05, 0.06)], ["50 % K", rgb(0.58, 0.58, 0.59)], ["20 % tints", rgb(0.8, 0.8, 0.8)], ["C 50 %", rgb(0.5, 0.82, 0.97)]];
  grid(p2, asRgb, "RGB", "These never change: the profile converts plain CMYK only. RGB and images with their own profile keep their colours.");
  // Page 3: a plain CMYK image (a raw DeviceCMYK bitmap: gradients of each ink), changes with the profile.
  const p3 = addPage(doc);
  text(p3, fonts.bold, "Plain CMYK image", 10, H - 25, 16);
  text(p3, fonts.regular, "A bitmap in DeviceCMYK without a profile of its own: it changes with the profile, as a CMYK photo from InDesign does.", 10, H - 33, 7);
  const iw = 256;
  const ih = 256;
  const data = new Uint8Array(iw * ih * 4);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const o = 4 * (y * iw + x);
      const band = Math.floor((y / ih) * 4); // C, M, Y, K ramps from left to right
      data[o] = band === 0 ? x : 0;
      data[o + 1] = band === 1 ? x : 0;
      data[o + 2] = band === 2 ? x : 0;
      data[o + 3] = band === 3 ? x : 0;
    }
  }
  const image = doc.context.flateStream(data, { Type: "XObject", Subtype: "Image", Width: iw, Height: ih, ColorSpace: "DeviceCMYK", BitsPerComponent: 8 });
  const ref = doc.context.register(image);
  p3.node.setXObject(PDFName.of("ImCMYK"), ref);
  p3.pushOperators(pushGraphicsState(), concatTransformationMatrix(pt(120), 0, 0, pt(120), pt(BLEED + 14), pt(BLEED + 40)), drawObject("ImCMYK"), popGraphicsState());
  text(p3, fonts.regular, "rows: cyan, magenta, yellow, black, each 0 to 100 % left to right", 14, 34, 7);
  const p4 = addPage(doc);
  text(p4, fonts.bold, intent ? "This file names its own profile" : "This file names no profile", 10, H - 25, 16);
  text(p4, fonts.regular, intent
    ? "An output intent (CGATS001, a US coated condition). The app offers it as \"From PDF\" and starts with it unless another profile was chosen before."
    : "No output intent. The app starts with ISO Coated v2 (ECI), the profile it ships with.", 10, H - 33, 7);
  if (intent) {
    const icc = await fs.readFile(path.resolve(here, "..", "vendor", "pdf-iccs", "CGATS001Compat-v2-micro.icc"));
    const profile = doc.context.register(doc.context.flateStream(icc, { N: 4 }));
    const intentDict = doc.context.obj({ Type: "OutputIntent", S: "GTS_PDFX", OutputConditionIdentifier: "CGATS001", Info: "CGATS001 (test)", DestOutputProfile: profile });
    doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([doc.context.register(intentDict)]));
  }
  return doc.save();
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const paper = defaultPaper();
  // With a cover file the book has four pages more (C1 to C4 round book-36's own 36): the
  // cover files' spines are for 40 pages; the spine artwork alone goes on the 36-page book.
  const spineArtMm = Math.round(calculatedSpine(36, paper, "perfect").widthMm * 100) / 100;
  const spinePerfect = Math.round(calculatedSpine(40, paper, "perfect").widthMm * 100) / 100;
  // A hardcover adds four endpaper pages (E1 to E4) to the 40: 44, of which the cover's four are the boards.
  const spineHardcover = Math.round(calculatedSpine(44, paper, "hardcover", BOARD_MM).widthMm * 100) / 100;
  const files = {
    "booklet-16.pdf": () => booklet(16, "booklet-16"),
    "booklet-44.pdf": () => booklet(44, "booklet-44"),
    "book-36.pdf": book36,
    "cover-36.pdf": () => coverFile({ spineMm: spinePerfect, name: "cover-36: for book-36, perfect binding, 120 gsm uncoated", note: `spine ${spinePerfect} mm as the app calculates it; 2 pages: outside, inside` }),
    "cover-36-flaps.pdf": () => coverFile({ spineMm: spinePerfect, flapMm: 80, name: "cover-36-flaps: 80 mm flaps", note: "flaps fold in over the inside covers (C2, C3)" }),
    "cover-36-wrong-spine.pdf": () => coverFile({ spineMm: 6, name: "cover-36-wrong-spine: a 6 mm spine", note: `the book needs ${spinePerfect} mm: Preflight should say so` }),
    "cover-36-outside-only.pdf": () => coverFile({ spineMm: spinePerfect, inside: false, name: "cover-36-outside-only: one page", note: "no inside page: C2 and C3 unprinted" }),
    "cover-36-hardcover.pdf": () => caseWrap({ spineMm: spineHardcover, name: "cover-36-hardcover: a case wrap for book-36, 2.5 mm boards", note: `case spine ${spineHardcover} mm, 15 mm turn-ins, 3 mm squares` }),
    "spine-36.pdf": () => spineArt(spineArtMm, H, "spine-36"),
    "spine-36-too-wide.pdf": () => spineArt(12, H, "spine-36-too-wide (12 mm)"),
    "finish-covers.pdf": finishCovers,
    "overprint.pdf": overprint,
    "spot-image.pdf": spotImage,
    "colour-profiles.pdf": () => colourProfiles({ intent: false }),
    "colour-profiles-intent.pdf": () => colourProfiles({ intent: true }),
  };
  // `node tools/make-testfiles.mjs a.pdf b.pdf`: only those (every file is dated, so making all
  // of them changes all of them).
  const only = process.argv.slice(2);
  for (const [name, make] of Object.entries(files)) {
    if (only.length && !only.includes(name)) continue;
    const bytes = await make();
    await fs.writeFile(path.join(OUT, name), bytes);
    console.log(`${name.padEnd(28)} ${(bytes.length / 1024).toFixed(0).padStart(6)} KB`);
  }
  console.log(`spines: cover files perfect ${spinePerfect} mm, hardcover ${spineHardcover} mm; spine art ${spineArtMm} mm`);
}

await main();
