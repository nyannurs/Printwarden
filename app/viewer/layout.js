// The book laid out for a frame: every leaf's cross-section (layoutBook in model.js), row by
// row where a corner leads a turn, the pages' bow, which faces can be seen, and the sheets
// whose shape changed sent to the GPU; then what the binding adds (extras.js).

import { layoutExtras } from "./extras.js";
import { packSheet, shapeChanged, uploadSheets } from "./leaf.js";
import { layoutBook, rowTurn } from "./model.js";
import { LEAF_FILL, LEAF_ROWS, STACK_FILL } from "./shaders.js";

// How far an open page's corners lift at the fore-edge (mm); the middle of the fore-edge
// half of that. Subtle on purpose: paper, not a curl.
const PAGE_BOW_MM = 1.2;

export function layoutLeaves(scene) {
  scene.layoutVersion++;
  const m = scene.model;
  const c = scene.closed * scene.closed * (3 - 2 * scene.closed);
  const open = 1 - c;
  // Each pile is one stack of offset sheets: no sheet ever passes through another (see
  // layoutBook; proved for every binding in tests/geometry.test.js).
  const state = { closed: scene.closed, side: scene.closedSide, opening: scene.opening };
  const cache = {}; // shared by this frame's layouts (see layoutRows)
  const turning = new Set(scene.leaves.filter((l) => l.start != null && l.from !== l.to).map((l) => l.i));
  layoutBook(m, scene.leaves, state, { cache, turning });
  layoutRows(scene, state, cache);
  const R = LEAF_ROWS;
  const rows = scene.leaves.some((l) => l.rowsActive) ? R : 1; // rows bowed on their own
  for (const leaf of scene.leaves) {
    // Open pages bow a little: corners lift, none closed or upright. Coil pages less down
    // the stack; glued, sewn and stitched piles bow together (see below).
    const left = leaf.i < scene.opening;
    const rank = left ? scene.opening - 1 - leaf.i : leaf.i - scene.opening;
    const count = left ? scene.opening : m.leafCount - scene.opening;
    const depth = (leaf.start != null && !leaf.settle) || m.style.spine !== "coil" ? 1 : Math.max(0, 1 - rank / Math.max(1, count));
    const bow = (theta) => {
      const flat = Math.min(1, Math.abs(theta) / 60);
      return leaf.board ? 0 : PAGE_BOW_MM * (m.style.spine === "coil" ? 0.6 : 1) * open * depth * flat * flat * (3 - 2 * flat) * Math.sign(theta || 1);
    };
    leaf.bows ??= new Float32Array(R);
    if (!leaf.rowsActive) leaf.bows.fill(bow(leaf.theta));
    else {
      // A corner-led row bows as it lies: a row already landed bows like the pile it
      // landed on (the angle of its chord, spine to fore-edge), or the pile's corners
      // would poke through it.
      for (let r = 0; r < R; r++) {
        const p = leaf.rows[r];
        const last = p.x.length - 1;
        leaf.bows[r] = bow((Math.atan2(p.x[last] - p.x[0], p.y[last] - p.y[0]) * 180) / Math.PI);
      }
    }
  }
  // No bow lifts a sheet into the sheet above it. The room above a sheet is measured
  // straight up from it (along its upward normal, where the bow lifts it) at half, three
  // quarters and the whole of its width, to where the sheet above crosses that line;
  // nothing above that point, no limit. (Measured to the nearest point of the sheet above
  // instead, a page passing upright counted as no room at all, and every page beneath it
  // dropped its bow for a few frames: the jitter seen while flipping.) A sheet may bow as
  // much as the one above, plus a quarter of the room at each point scaled by how much the
  // bow lifts there (the square of the way out): the room opens toward the fore-edge
  // (curl lifts as the cube), so all of it would meet the sheet above part way in.
  const rowOf = (leaf, r) => (leaf.rowsActive ? leaf.rows[r] : leaf.profile);
  const roomAbove = (leaf, r, q, gap) => {
    const p = rowOf(leaf, r);
    const sgn = Math.sign(leaf.bows[r] || leaf.theta || 1);
    const last = p.x.length - 1;
    const w = leaf.s[last];
    let limit = Infinity;
    for (const share of [0.5, 0.75, 1]) {
      let k = last;
      while (k > 0 && leaf.s[k - 1] >= share * w) k--;
      const nx = -Math.cos(p.phi[k]) * sgn;
      const ny = Math.sin(p.phi[k]) * sgn;
      let up = Infinity;
      for (let j = 0; j < q.x.length - 1; j++) {
        // p_k + n t = q_j + e a
        const ex = q.x[j + 1] - q.x[j];
        const ey = q.y[j + 1] - q.y[j];
        const den = nx * ey - ny * ex;
        if (Math.abs(den) < 1e-12) continue;
        const wx = q.x[j] - p.x[k];
        const wy = q.y[j] - p.y[k];
        const t = (wx * ey - wy * ex) / den;
        const a = (wx * ny - wy * nx) / den;
        if (t > 0 && t < up && a >= 0 && a <= 1) up = t;
      }
      const a = Math.min(1, Math.hypot(p.x[k] - p.x[0], p.y[k] - p.y[0]) / w);
      if (Number.isFinite(up)) limit = Math.min(limit, Math.max(0, up - gap) / (4 * a * a));
    }
    return limit;
  };
  const MID = (LEAF_ROWS - 1) / 2;
  const capDown = (list, r) => {
    // Below the leaves laid out by row, a row comes out as the middle one once the leaf
    // above has the middle row's bow (the same sums on the same numbers): copied from there.
    let lastByRow = -1;
    if (r !== MID) list.forEach((l, k) => { if (l.rowsActive) lastByRow = k; });
    let above = null;
    for (let k = 0; k < list.length; k++) {
      const leaf = list[k];
      if (above) {
        if (r !== MID && k > lastByRow + 1 && above.bows[r] === above.bows[MID]) {
          for (let j = k; j < list.length; j++) list[j].bows[r] = list[j].bows[MID];
          return;
        }
        // The cap is never below the bow above: no need to measure the room for one that
        // bows no more (a stack turning together, a pile at rest).
        if (Math.abs(leaf.bows[r]) > Math.abs(above.bows[r])) {
          const room = roomAbove(leaf, r, rowOf(above, r), (m.thickness[leaf.i] + m.thickness[above.i]) / 2);
          if (Number.isFinite(room)) {
            const cap = Math.abs(above.bows[r]) + room;
            if (Math.abs(leaf.bows[r]) > cap) leaf.bows[r] = Math.sign(leaf.bows[r]) * cap;
          }
        }
      }
      above = leaf;
    }
  };
  const left = scene.leaves.filter((l) => l.theta < 0).reverse(); // the last leaf on top
  const right = scene.leaves.filter((l) => l.theta >= 0); // the first leaf on top
  // Each row on its own (where corners lead, the rows differ), the middle one first; one
  // for all otherwise.
  for (const r of rows === 1 ? [MID] : [MID, ...Array.from({ length: R }, (_, k) => k).filter((k) => k !== MID)]) {
    capDown(left, r);
    capDown(right, r);
  }
  if (rows === 1) for (const leaf of scene.leaves) leaf.bows.fill(leaf.bows[MID]);
  // In a stack turning together, a sheet's face against the next sheet of it can't be seen
  // (they are offset copies, see layoutBook): only the stack's outer faces and every
  // sheet's edges are shaded as pages; the faces between are plain paper (below). (Seen nearly edge-on, a curved stack is seen from both sides
  // at once, and no order of drawing spares the GPU shading every sheet: 45 ms a frame
  // for half a 240-page book standing up.) Not a coil book's (its pages fan out in the air)
  // nor against a hardcover's board (it overhangs the pages).
  const coil = m.style.spine === "coil";
  // Diagnosis from the console (the author's Mac draws a flying stack's edges as dashes;
  // nothing here reproduces it): `app.scene.debugInnerFaces = true` draws the faces between
  // a stack's sheets, `app.scene.debugStackFill = 0.9` packs them as a pile at rest is.
  const against = (leaf, j) => !scene.debugInnerFaces && !coil && leaf.group != null && !leaf.board && scene.leaves[j]?.group === leaf.group && !scene.leaves[j].board;
  for (const leaf of scene.leaves) {
    // A face against the next sheet is drawn unlit (its page's image: inkFiller), not shaded
    // as a page.
    const frontHidden = against(leaf, leaf.i - 1); // the front lies on the leaf before
    const backHidden = against(leaf, leaf.i + 1);
    // Each its page's image, unlit (inkFillerMaterial); `app.scene.debugFillerInk = false` plain paper.
    const filler = scene.debugFillerInk === false ? scene.sheetFiller : scene.inkFiller;
    leaf.mesh.material[0] = frontHidden ? filler : leaf.front;
    leaf.mesh.material[1] = backHidden ? filler : leaf.back;
    leaf.filler = frontHidden || backHidden; // drawn on its own then (see draw.js batchable)
  }
  // Only sheets whose shape changed go to the GPU: while one page turns, the rest hold still.
  // Sheets are drawn a little thinner than they are (LEAF_FILL), so neighbours never share a
  // surface; in a stack turning together the faces between its sheets aren't drawn at all
  // (above), and through the gaps between its thinned sheets the whole stack could be seen
  // through, edge-on (opening a closed book deep in, the pile swung over looked transparent,
  // 0.17.83). Such a stack's sheets are drawn at their full thickness: offsets of one curve,
  // they close up exactly, and a hair over (STACK_FILL).
  const stacked = new Map();
  for (const l of scene.leaves) if (l.group != null) stacked.set(l.group, (stacked.get(l.group) ?? 0) + 1);
  const changed = [];
  for (const leaf of scene.leaves) {
    leaf.fill = leaf.group != null && stacked.get(leaf.group) > 1 ? (scene.debugStackFill ?? STACK_FILL) : LEAF_FILL;
    if (!shapeChanged(leaf)) continue;
    packSheet(leaf, scene.sheets, m.thickness[leaf.i]);
    leaf.stale = true; // for picking (see makeLeaf)
    changed.push(leaf);
  }
  uploadSheets(scene, changed);
  layoutExtras(scene);
}

/**
 * Turns led by a corner (rowTurn in model.js): while pages turn, every row of the book from
 * head to foot is laid out on its own, the turning pages' rows each a little ahead of or
 * behind their middle. Each row is a whole layout, so no sheet passes through another row
 * by row. The middle row is the leaves' own profile (everything else reads that one). Only
 * the turning leaves are laid out again per row; the piles and their shapes in them are
 * shared (`cache`), and still leaves and boards are the same in every row.
 */
function layoutRows(scene, state, cache) {
  const m = scene.model;
  const R = LEAF_ROWS;
  const mid = (R - 1) / 2;
  const n = scene.leaves.length;
  // Rigid: a hardcover's boards, and the pages a board carries; and stacks sent turning
  // together (a pile swung over to close the book), which turn as one block, as a thick
  // block does: not led by a corner (and laid out row by row, a 240-page book's half took
  // most of a frame).
  const boardGroups = new Set([scene.leaves[0].group, scene.leaves[n - 1].group].filter((g, k) => g && scene.leaves[k === 0 ? 0 : n - 1].board));
  const size = new Map();
  for (const l of scene.leaves) if (l.group != null) size.set(l.group, (size.get(l.group) ?? 0) + 1);
  const rigid = (l) => l.board || (l.group != null && (boardGroups.has(l.group) || size.get(l.group) > 1));
  const only = new Set(m.style.spine === "coil" ? [] : scene.leaves.filter((l) => l.start != null && l.from !== l.to && !rigid(l)).map((l) => l.i));
  for (const leaf of scene.leaves) leaf.rowsActive = only.has(leaf.i);
  if (!only.size) return;
  for (const leaf of scene.leaves) {
    if (!only.has(leaf.i)) continue;
    if (!leaf.rows) {
      leaf.rows = Array.from({ length: R }, () => ({
        x: new Float32Array(leaf.s.length), y: new Float32Array(leaf.s.length), phi: new Float32Array(leaf.s.length),
      }));
    }
    leaf.rows[mid].x.set(leaf.profile.x);
    leaf.rows[mid].y.set(leaf.profile.y);
    leaf.rows[mid].phi.set(leaf.profile.phi);
  }
  for (let r = 0; r < R; r++) {
    if (r === mid) continue;
    const zz = (2 * r) / (R - 1) - 1;
    const row = scene.leaves.map((l) => {
      if (!only.has(l.i)) return { theta: l.theta, curl: l.curl, s: l.s, profile: l.profile, group: l.group };
      const t = rowTurn(l.theta, l.from, l.to, l.curl, zz);
      return { theta: t.theta, curl: t.curl, s: l.s, profile: l.rows[r], group: l.group };
    });
    layoutBook(m, row, state, { cache, only });
  }
}
