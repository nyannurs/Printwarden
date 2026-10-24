// Reading-order facing pairs: what the reader sees with the book open.
// Not to be confused with imposed sheets (imposition.js), which is how pages are
// grouped on press. In saddle stitch the two only coincide at the centre spread.


/** [null, 1], [2, 3], [4, 5], … and a trailing [N, null] when N is even. */
export function pairNumbers(pageCount) {
  if (pageCount <= 0) return [];
  const pairs = [[null, 1]];
  for (let left = 2; left <= pageCount; left += 2) {
    pairs.push([left, left + 1 <= pageCount ? left + 1 : null]);
  }
  return pairs;
}

/** The middle opening, if the book has one (N a multiple of 4). */
export function centreSpread(pageCount) {
  if (pageCount < 4 || pageCount % 4) return null;
  return [pageCount / 2, pageCount / 2 + 1];
}

/**
 * @param {import("./book.js").Book} book
 * @returns {{left: import("./book.js").BookPage | null, right: import("./book.js").BookPage | null,
 *            numbers: [number|null, number|null], isCentreSpread: boolean}[]}
 */
export function facingPairs(book) {
  const n = book.pages.length;
  const centre = centreSpread(n);
  return pairNumbers(n).map(([l, r]) => ({
    left: l ? book.pages[l - 1] : null,
    right: r ? book.pages[r - 1] : null,
    numbers: [l, r],
    isCentreSpread: !!centre && centre[0] === l && centre[1] === r,
  }));
}

/** Opening index (0 = cover) that shows the given folio. */
export const openingOf = (folio) => Math.floor(folio / 2);
