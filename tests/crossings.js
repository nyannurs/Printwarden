// Which closed outlines cross each other (sheets passing through sheets): used by the
// geometry proof and the click replays. Exact: every two edges that could meet are tested.
// Fast: edges are binned on a fine grid by their bounds, so only edges near each other are
// compared (two edges that cross share a point, so they share the grid cell around it).
// Testing every edge of every sheet against every edge of every other took about 200 ms
// for a 44-page book; this takes a few.

/**
 * @param {ArrayLike<number>[]} outlines closed polygons, flat [x0, y0, x1, y1, ...]
 * @param {(i: number, j: number) => boolean} [wanted] which pairs to test (i < j)
 * @param {number} [cell] grid cell size, in the outlines' units
 * @returns {[number, number][]} the pairs that cross, i < j
 */
export function crossingPairs(outlines, wanted = () => true, cell = 0.5) {
  let count = 0;
  for (const o of outlines) count += o.length >> 1;
  const owner = new Int32Array(count);
  const seg = new Float64Array(count * 4); // ax, ay, bx, by
  const grid = new Map(); // cell -> segment ids
  let s = 0;
  outlines.forEach((o, i) => {
    const n = o.length >> 1;
    for (let k = 0; k < n; k++, s++) {
      const ax = o[2 * k], ay = o[2 * k + 1];
      const q = (k + 1) % n;
      const bx = o[2 * q], by = o[2 * q + 1];
      owner[s] = i;
      seg[4 * s] = ax; seg[4 * s + 1] = ay; seg[4 * s + 2] = bx; seg[4 * s + 3] = by;
      const cx0 = Math.floor(Math.min(ax, bx) / cell), cx1 = Math.floor(Math.max(ax, bx) / cell);
      const cy0 = Math.floor(Math.min(ay, by) / cell), cy1 = Math.floor(Math.max(ay, by) / cell);
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = (cx + 2 ** 20) * 2 ** 21 + (cy + 2 ** 20);
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(s);
        }
      }
    }
  });
  const found = new Set();
  const out = [];
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      const sa = list[a];
      for (let b = a + 1; b < list.length; b++) {
        const sb = list[b];
        let i = owner[sa], j = owner[sb];
        if (i === j) continue;
        if (i > j) [i, j] = [j, i];
        const pair = i * outlines.length + j;
        if (found.has(pair) || !wanted(i, j)) continue;
        if (segmentsCross(seg, sa, sb)) {
          found.add(pair);
          out.push([i, j]);
        }
      }
    }
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** Two edges cross properly (each one's ends strictly on either side of the other). */
function segmentsCross(seg, sa, sb) {
  const ax = seg[4 * sa], ay = seg[4 * sa + 1], bx = seg[4 * sa + 2], by = seg[4 * sa + 3];
  const cx = seg[4 * sb], cy = seg[4 * sb + 1], dx = seg[4 * sb + 2], dy = seg[4 * sb + 3];
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}
