// The finished publication: source pages split into halves, blanks inserted, numbered.
//
// Two numberings exist and must never be conflated:
//  - the source index (position in the PDF), on SourcePage;
//  - the folio (1-based position in the bound object), BookPage.number.
// Folio 1 is always a recto. Labels (what the user sees) come from the PDF's own page
// numbering (its page labels, e.g. InDesign's section numbering); they never change folios.

/**
 * @typedef {{
 *   number: number,
 *   source: import("./document.js").SourcePage | null,   // null = inserted blank
 *   half: "full" | "left" | "right",
 *   label?: string | null,         // a name of its own (a cover file's C1–C4, printed or not)
 * }} BookPage
 * @typedef {{after: number, count: number}} BlankInsertion
 *   Insert `count` blanks after the first `after` pages of the book *before* any
 *   insertion is applied (0 = at the very front).
 * @typedef {{pages: BookPage[], folioStart: number, labelled: boolean}} Book
 *   folioStart: the number of folio 1, from the PDF's numbering (1 if it has none);
 *   labelled: whether pages show the PDF's own labels (not for imposed sheets).
 */

export const isRecto = (folio) => folio % 2 === 1;

/** Identity of a page's content, stable across blank insertions. */
export const contentKey = (page) => (page.source ? `${page.source.index}${page.half[0]}` : null);

/**
 * The page's name for the user: the PDF's label for it (the right half of a spread: the
 * next number), else its number counted from `folioStart` (inserted blanks, unlabelled
 * files, imposed sheets).
 */
export function label(book, folio) {
  const page = book.pages[folio - 1];
  const own = page?.label ?? (book.labelled ? page?.source?.label : null);
  if (own) {
    if (page.half !== "right") return own;
    if (/^\d+$/.test(own)) return String(Number(own) + 1);
  }
  return String(folio - 1 + book.folioStart);
}

/** Folio 1's number from the PDF's labels: the first page labelled with a plain number. */
function folioStartOf(pages) {
  for (const page of pages) {
    const own = page.source?.label;
    if (own && /^\d+$/.test(own)) return Number(own) + (page.half === "right" ? 1 : 0) - (page.number - 1);
  }
  return 1;
}

/**
 * @param {import("./document.js").SourcePage[]} pages
 * @param {boolean[]} isSpread
 * @param {BlankInsertion[]} blanks
 * @returns {Book}
 */
export function buildBook(pages, isSpread, blanks = []) {
  if (pages.length !== isSpread.length) throw new Error("isSpread must have one entry per page");
  const content = [];
  pages.forEach((page, i) => {
    if (isSpread[i]) content.push([page, "left"], [page, "right"]);
    else content.push([page, "full"]);
  });
  for (const b of blanks) {
    if (b.after < 0 || b.count < 1 || b.after > content.length) {
      throw new Error(`Cannot insert ${b.count} blank(s) after page ${b.after}: the book has ${content.length} pages`);
    }
  }
  // Apply from the back so earlier positions are unaffected.
  for (const b of [...blanks].sort((x, y) => y.after - x.after)) {
    content.splice(b.after, 0, ...Array.from({ length: b.count }, () => [null, "full"]));
  }
  const book = content.map(([source, half], i) => ({ number: i + 1, source, half }));
  return { pages: book, folioStart: folioStartOf(book), labelled: true };
}

/**
 * Fold an imposed file back into reading order: PDF page i is sheet side i (front,
 * back, front, back, …) and holds two folios, as `layout.sides[i]` says. The result is
 * what the printed, folded, trimmed job would read like, so a wrong imposition shows
 * up as wrong pages in the book.
 *
 * @param {import("./document.js").SourcePage[]} sheets
 * @param {import("./imposition.js").SheetLayout} layout
 * @returns {Book}
 */
export function buildImposedBook(sheets, layout) {
  if (sheets.length !== layout.sides.length) {
    throw new Error(`The file has ${sheets.length} sheet sides; the layout expects ${layout.sides.length}`);
  }
  const pages = new Array(layout.sides.length * 2);
  layout.sides.forEach((side, i) => {
    pages[side.left - 1] = { number: side.left, source: sheets[i], half: "left" };
    pages[side.right - 1] = { number: side.right, source: sheets[i], half: "right" };
  });
  // A sheet's label names the sheet, not its pages.
  return { pages, folioStart: 1, labelled: false };
}
