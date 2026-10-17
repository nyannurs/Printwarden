// Folding schemes: which page lands where on a press sheet that is folded into a signature,
// and which way up. Found by folding, not remembered: a sheet of panels is folded as the
// folding machine folds it (right half onto the left, top half down, right onto left
// again), and the stack that results is read like a booklet. Pure arithmetic. The 16-page
// sheet comes out as the classic table (page 1 lower right on the front, upright; 5 12 9 8
// upside down above 4 13 16 1), which is the check that the folding is right.
//
// Schemes (pages per sheet, both sides): 8 (two by two a side, two right-angle folds) and
// 16 (two rows of four, three folds). 2 is the plain spread (see imposition.js). The sheet
// is landscape; its back is printed turned over on its short edge, so the back of panel
// (row, col) is at (row, cols - 1 - col) on the back side, as the 2-up sheets have it.

/**
 * @typedef {{page: number, turned: boolean}} Cell page 1..P of the sheet's booklet; turned:
 *   printed upside down (head toward the sheet's top fold)
 * @typedef {{pages: number, rows: number, cols: number, front: Cell[][], back: Cell[][],
 *            folds: string[]}} Scheme front and back: rows of cells, row 0 at the sheet's top
 */

/** @type {Record<number, {rows: number, cols: number, folds: ("vertical" | "horizontal")[]}>} */
const FOLDING = {
  8: { rows: 2, cols: 2, folds: ["vertical", "horizontal"] },
  16: { rows: 2, cols: 4, folds: ["vertical", "horizontal", "vertical"] },
};

/**
 * The scheme for a sheet of `pages` (8 or 16) pages.
 * @returns {Scheme}
 */
export function scheme(pages) {
  const f = FOLDING[pages];
  if (!f) throw new Error(`No folding scheme for ${pages} pages a sheet`);
  // Every panel of the flat sheet, as a pile of one layer: the panel's front face up,
  // the right way up.
  /** @type {{r: number, c: number, back: boolean, turned: boolean}[][][]} piles[row][col]: layers, top first */
  let piles = Array.from({ length: f.rows }, (_, r) => Array.from({ length: f.cols }, (_, c) => [{ r, c, back: false, turned: false }]));
  for (const fold of f.folds) {
    const rows = piles.length;
    const cols = piles[0].length;
    if (fold === "vertical") {
      // The right half folds over onto the left: its piles land on the mirrored columns,
      // turned over (back face up), on top, their layers in reverse order.
      piles = piles.map((row) => row.slice(0, cols / 2).map((pile, c) => [
        ...row[cols - 1 - c].slice().reverse().map((l) => ({ ...l, back: !l.back })),
        ...pile,
      ]));
    } else {
      // The top half folds down onto the bottom: turned over and, about a horizontal axis,
      // upside down as well.
      piles = piles.slice(rows / 2).map((row, r) => row.map((pile, c) => [
        ...piles[rows / 2 - 1 - r][c].slice().reverse().map((l) => ({ ...l, back: !l.back, turned: !l.turned })),
        ...pile,
      ]));
    }
  }
  // One pile is left: the folded signature, its last fold (the spine) at its right edge.
  // Read as a booklet with the spine on the left, it is this pile turned over: page 1 is
  // the bottom layer's face that was down, and so on up.
  const stack = piles[0][0].slice().reverse();
  const front = Array.from({ length: f.rows }, () => Array.from({ length: f.cols }, () => ({ page: 0, turned: false })));
  const back = front.map((row) => row.map((cell) => ({ ...cell })));
  stack.forEach((layer, k) => {
    // Turned over: the layer's face that was down now faces up (page 2k + 1), and the
    // one that was up faces down (page 2k + 2); a layer that lay upside down still does.
    const up = { face: layer.back ? "front" : "back", page: 2 * k + 1 };
    const down = { face: layer.back ? "back" : "front", page: 2 * k + 2 };
    for (const { face, page } of [up, down]) {
      // On the back side the panel sits at the mirrored column (short-edge turn).
      const cell = face === "front" ? front[layer.r][layer.c] : back[layer.r][f.cols - 1 - layer.c];
      cell.page = page;
      cell.turned = layer.turned;
    }
  });
  // The side with page 1 is the front (which of a sheet's two sides is printed first is
  // a convention: the one the booklet's outside is on).
  const firstOnFront = front.some((row) => row.some((c) => c.page === 1));
  return { pages, rows: f.rows, cols: f.cols, front: firstOnFront ? front : back, back: firstOnFront ? back : front, folds: f.folds.slice() };
}
