// One call from a loaded document plus settings to everything the UI displays.

import { Binding, hasWire, HEADBAND_COLORS, ruleFor, WIRE_COLORS } from "./binding.js";
import { buildBook, buildImposedBook, isRecto } from "./book.js";
import { detectSpreads, SpreadMode, SpreadPattern } from "./detect.js";
import { COVER_BASE } from "./document.js";
import { layoutFor } from "./imposition.js";
import { facingPairs } from "./pairing.js";
import { defaultPaper, paperThicknessMm } from "./paper.js";
import { calculatedSpine, defaultSpine } from "./spine.js";
import { bleedRectFor, setupFromPdf, trimRectFor } from "./setup.js";
import { rectSize, rotated } from "./units.js";
import { validate } from "./validate.js";

/**
 * @typedef {{
 *   source: "pages" | "imposed",   // how the PDF is laid out
 *   binding: string, spreadMode: string, signaturePages: number | null,
 *   blanks: import("./book.js").BlankInsertion[],
 *   paper: import("./paper.js").Paper,
 *   wire: string,                  // wire colour (spiral, wire-o), hex
 *   spine: import("./spine.js").Spine,
 *   page: import("./setup.js").PageSetup | null,   // null = derive from the PDF
 *   glueMm: number,                // side glue (perfect, sewn): the first and last page glued to the cover this far from the spine; 0 none
 *   boardMm: number | null,        // a hardcover's boards (mm); null = the usual 2.5 (BOARD_MM)
 *   headband: string,              // a hardcover's headbands, hex
 *   spineShape: "square" | "round", // a hardcover's back
 *   sheetPages: number,            // the press sheets: 2 (one spread a side), or a folding scheme of 8 or 16 pages a sheet
 *   coverSheet?: boolean,          // imposed files: false for those made before covers had a sheet of their own
 * }} Setup
 */

/** @returns {Setup} */
export const defaultSetup = () => ({
  source: "pages",
  binding: Binding.SADDLE,
  spreadMode: SpreadMode.AUTO,
  signaturePages: null,
  blanks: [],
  paper: defaultPaper(),
  wire: WIRE_COLORS[0].hex,
  spine: defaultSpine(),
  page: null,
  glueMm: 6,
  boardMm: null,
  headband: HEADBAND_COLORS[0].hex,
  spineShape: "square",
  sheetPages: 2,
});

const MAX_SPINE_MM = 80; // wider than two pages by more: flaps

/**
 * A separate cover file: page 1 the outside as one spread (back cover, spine, front cover,
 * flaps beyond if any), page 2 the inside the same way, or none (the inside unprinted). What
 * the book gets: four pages cut from it (C1 the front, C2 and C3 the inside, C4 the back),
 * each a source page of its own with the cover page's boxes and its region as the trim.
 * The spine is what is left of the cover's width beyond two pages, up to MAX_SPINE_MM; more
 * than that is flaps, each half of what is left beyond the spine set (the printer's), or
 * calculated. The spine's strip is the spine's artwork (spineRect), see app.js.
 *
 * @param {{name?: string, pages: import("./document.js").SourcePage[]}} cover
 * @param {import("./setup.js").PageSetup} page
 */
function coverPages(cover, page, setup, bookPages) {
  const c = cover.pages[0];
  const inside = cover.pages[1] ?? null;
  const trim = c.trimBox ?? c.mediaBox;
  const W = page.width;
  const H = page.height;
  const widthMm = trim.x1 - trim.x0;
  const heightMm = trim.y1 - trim.y0;
  const extra = widthMm - 2 * W;
  const calculatedSpineMm = calculatedSpine(bookPages, setup.paper, setup.binding, setup.boardMm).widthMm;
  let error = null;
  let spineMm = 0;
  let flapMm = 0;
  if (c.rotation % 360) error = "The cover page is rotated. Export the cover unrotated.";
  else if (extra < -0.5) error = `The cover is ${formatWidth(widthMm)} mm wide, narrower than two ${formatWidth(W)} mm pages.`;
  else if (extra <= MAX_SPINE_MM) spineMm = Math.max(0, extra);
  else {
    spineMm = setup.spine.widthMm ?? calculatedSpineMm;
    flapMm = Math.max(0, (extra - spineMm) / 2);
  }
  const x0 = trim.x0 + flapMm;
  const region = (x, w) => ({ x0: x, y0: trim.y0, x1: x + w, y1: trim.y1 });
  const back = region(x0, W);
  const spineRect = spineMm > 0.05 ? region(x0 + W, spineMm) : null;
  const front = region(x0 + W + spineMm, W);
  // The flaps, on the outside page beyond each cover: shown folded in over the inside covers.
  const frontFlapRect = flapMm > 0.5 ? region(x0 + 2 * W + spineMm, flapMm) : null;
  const backFlapRect = flapMm > 0.5 ? region(trim.x0, flapMm) : null;
  const cut = (source, index, rect, label) => (source
    ? { ...source, index: COVER_BASE + index, trimBox: rect, bleedBox: source.bleedBox, file: "cover", label }
    : null);
  const pages = [
    cut(c, 0, front, "C1"),
    cut(inside, 1, back, "C2"), // the inside spread is the sheet turned over: the front's inside on the left
    cut(inside, 1, front, "C3"),
    cut(c, 0, back, "C4"),
  ];
  return {
    pages,
    info: { name: cover.name ?? "cover", pageCount: cover.pages.length, inside: !!inside, widthMm, heightMm, pageHeightMm: H,
      spineMm, calculatedSpineMm, flapMm, spineRect, frontFlapRect, backFlapRect, error },
  };
}
const formatWidth = (v) => (Math.round(v * 10) / 10).toString();

/**
 * @param {{pages: import("./document.js").SourcePage[], name?: string,
 *          cover?: {name?: string, pages: import("./document.js").SourcePage[]} | null}} doc
 * @param {Partial<Setup>} partial
 */
export function analyse(doc, partial = {}) {
  const input = { ...defaultSetup(), ...partial };
  const paper = { ...defaultPaper(), ...input.paper };
  const manual = input.page?.mode === "manual" ? input.page : null;
  const imposed = input.source === "imposed";
  // An imposed file from before covers had a sheet of their own folds them in.
  const rule = { ...ruleFor(input.binding, input.signaturePages), ...(imposed && input.coverSheet === false ? { coverPages: 0 } : {}) };

  let detection;
  let book;
  let layout;
  if (imposed) {
    const all = doc.pages.map(() => true);
    detection = { isSpread: all, mode: SpreadMode.AUTO, pattern: SpreadPattern.IMPOSED, note: "", spreadCount: all.length };
    layout = layoutFor(rule, doc.pages.length * 2);
    // If the sheets can't be folded with this binding, show them in file order instead
    // (validate reports why), so there is still something to look at.
    book = layout && layout.sides.length === doc.pages.length
      ? buildImposedBook(doc.pages, layout)
      : { ...buildBook(doc.pages, all, []), folioStart: 1, labelled: false };
  } else {
    detection = detectSpreads(doc.pages, input.spreadMode, manual);
  }
  const page = manual ?? setupFromPdf(doc.pages, detection.isSpread);
  const setup = {
    ...input,
    paper,
    page,
    blanks: imposed ? [] : input.blanks,
    paperThicknessMm: paperThicknessMm(paper.gsm, paper.finish, paper.volume ?? null),
  };
  let coverFile = null;
  if (!imposed) {
    book = buildBook(doc.pages, detection.isSpread, setup.blanks);
    if (doc.cover?.pages.length && !hasWire(input.binding)) {
      // The cover file's four pages round the block: C1, C2 … 1, 2, … C3, C4. The block's
      // own numbering stays (its first page is 1 whether labelled or not).
      const inner = book;
      // The spine is calculated for every leaf the block will have: the cover's four pages
      // and, in a case binding, the four endpaper pages added below (the Book spine panel
      // counts the same; counted without them, 0.17.84 said 7.7 mm where the panel said 8).
      const cut = coverPages(doc.cover, page, setup, inner.pages.length + 4 + (input.binding === Binding.HARDCOVER ? 4 : 0));
      const [c1, c2, c3, c4] = cut.pages;
      /** @type {import("./book.js").BookPage[]} */
      const pages = [c1, c2, ...inner.pages.map((p) => p.source), c3, c4].map((source, i) => ({ number: i + 1, source, half: "full", label: null }));
      inner.pages.forEach((p, i) => { pages[i + 2].half = p.half; });
      ["C1", "C2", "C3", "C4"].forEach((name, k) => { pages[k < 2 ? k : pages.length - 4 + k].label = name; });
      book = { pages, folioStart: inner.folioStart - 2, labelled: true };
      coverFile = cut.info;
    }
    if (input.binding === Binding.HARDCOVER && book.pages.length >= 4) {
      // A case binding's endpapers: a folded sheet at each end, half pasted down inside the
      // board (C2, C3: the pastedowns), half a flyleaf, unprinted (E1-E2, E3-E4): in the book,
      // between the pastedowns and the block, but not in the imposition.
      const fly = (name) => ({ number: 0, source: null, half: /** @type {const} */ ("full"), label: name, endpaper: true });
      const p = book.pages;
      const pages = [p[0], p[1], fly("E1"), fly("E2"), ...p.slice(2, -2), fly("E3"), fly("E4"), p[p.length - 2], p[p.length - 1]]
        .map((page, i) => ({ ...page, number: i + 1 }));
      // The case's pages are named as a cover file's (the block's numbering goes on from
      // its first page; counted past the flyleaves, the back pages would be off by two).
      ["C1", "C2", "C3", "C4"].forEach((name, k) => { const q = pages[k < 2 ? k : pages.length - 4 + k]; q.label ??= name; });
      book = { ...book, pages, folioStart: book.folioStart - 2, labelled: true };
    }
    const imposable = book.pages.length - book.pages.filter((p) => p.endpaper).length;
    layout = layoutFor(rule, imposable, input.sheetPages ?? 2);
    if (layout && imposable < book.pages.length) {
      // The sheets name the book's pages: past the pastedowns, the block's are two further
      // on, the back pastedown and cover four.
      const to = (k) => (k <= 2 ? k : k >= imposable - 1 ? k + 4 : k + 2);
      layout = { ...layout, sides: layout.sides.map((s) => ({
        ...s, left: to(s.left), right: to(s.right),
        ...(s.cells ? { cells: s.cells.map((row) => row.map((c) => ({ ...c, page: to(c.page) }))) } : {}),
      })) };
    }
    // The cover file isn't imposed here (it goes to the printer as it is): its sheet is left
    // out where the cover is made apart; a stitched booklet's cover folds round the block.
    if (coverFile && layout?.coverSheet) layout = { ...layout, sides: layout.sides.filter((s) => !s.cover), sheetCount: layout.sheetCount - 1, coverSheet: false };
  }
  const geometry = book.pages.map((p) => pageGeometry(p, page, imposed));
  const result = { document: doc, setup, rule, detection, book, geometry, pairs: facingPairs(book), layout, imposed, coverFile };
  const findings = validate(result);
  return { ...result, findings, hasErrors: findings.some((f) => f.severity === "error") };
}

/**
 * Where a finished page sits on its source page (PDF user space, mm), and its size.
 * null for inserted blanks.
 */
function pageGeometry(bookPage, pageSetup, imposed = false) {
  const src = bookPage.source;
  if (!src) return null;
  const recto = isRecto(bookPage.number);
  const trim = trimRectFor(src, bookPage.half, recto, pageSetup, imposed);
  const bleed = bleedRectFor(src, bookPage.half, recto, pageSetup, trim, imposed);
  const s = rectSize(trim);
  return { trim, bleed, size: src.rotation % 180 ? rotated(s) : s };
}
