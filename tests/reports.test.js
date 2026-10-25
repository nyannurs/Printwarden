// The author's view reports (Ctrl/Cmd+Shift+G, see ui/report.js), kept in tests/reports/ with
// their pictures left out: each the frame something looked wrong in, rebuilt (tests/drawn.js
// restoreView) and played on, frame by frame, with what was wrong checked.

import { BookScene } from "../app/viewer/scene.js";
import { headbandEnds, motionRecorder, readSheets, restoreView } from "./drawn.js";
import { eq, test } from "./harness.js";

const load = async (name) => (await fetch(new URL(`./reports/${name}.json`, import.meta.url))).json();

/** A scene of its own, off-screen, for `fn`. */
async function withScene(fn) {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  try {
    return await fn(new BookScene(box));
  } finally {
    box.remove();
  }
}

/** The vertices of the parts the extras build at the spine (a case, a slab, a fold), in one array. */
function spinePlaces(scene) {
  const out = [];
  for (const key of ["caseSpine", "slab", "fold"]) {
    const pos = scene.extras?.[key]?.geometry?.attributes?.position;
    if (pos) out.push(...pos.array);
  }
  return Float32Array.from(out);
}

/** The report's moment played on for `ms` at 60 frames a second: the jumps in the sheets and the spine. */
function playOn(scene, ms) {
  const motion = motionRecorder();
  const t0 = scene.clock;
  for (let f = 0; f * (1000 / 60) <= ms; f++) {
    scene.clock = t0 + f * (1000 / 60);
    scene.debugStep();
    const places = new Map(readSheets(scene).map(({ i, verts }) => [`sheet ${i}`, verts]));
    places.set("spine", spinePlaces(scene));
    motion.add(f, places);
  }
  return motion.jumps();
}

test("REPORT hardcover-joint-snap: the front board and the case's spine turn without a jump (240 pages, flung open to spread 36)", () => withScene(async (scene) => {
  restoreView(scene, await load("hardcover-joint-snap"));
  eq(playOn(scene, 800).map((j) => `${j.part} at frame ${j.frame}: ${j.moved.toFixed(1)} mm (${j.around.toFixed(1)} either side)`), []);
}));

/**
 * The case's spine against the boards, as drawn: where any of its points lies over a board
 * (from the board's spine edge on, along its face), how near the board's outer face; and how
 * much of its surface lies flat in the planes of its head and foot (a square-cut end: its whole
 * section; rolled over: none, the roll only touches them).
 */
function caseAgainstBoards(scene) {
  const m = scene.model;
  const geo = scene.extras.caseSpine.geometry;
  const pos = geo.attributes.position;
  const height = m.height + 2 * m.style.square;
  let nearest = Infinity;
  for (const [leaf, out] of [[scene.leaves[0], 1], [scene.leaves[scene.leaves.length - 1], -1]]) {
    const p = leaf.profile;
    const tx = Math.sin(p.phi[0]), ty = Math.cos(p.phi[0]);
    const nx = -Math.cos(p.phi[0]) * out, ny = Math.sin(p.phi[0]) * out; // the board's outside
    const face = m.thickness[0] / 2;
    for (let k = 0; k < pos.count; k++) {
      const rx = pos.getX(k) - p.x[0], ry = pos.getY(k) - p.y[0];
      if (rx * tx + ry * ty <= 0.01) continue; // not over the board
      nearest = Math.min(nearest, Math.abs(rx * nx + ry * ny - face));
    }
  }
  let flatEnds = 0;
  const idx = geo.index.array;
  const v = (k) => [pos.getX(k), pos.getY(k), pos.getZ(k)];
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [v(idx[t]), v(idx[t + 1]), v(idx[t + 2])];
    if (![a, b, c].every((q) => Math.abs(q[2]) > height / 2 - 1e-4)) continue;
    flatEnds += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return { nearest, flatEnds };
}

test("REPORT hardcover-spine-clip: the case's covering lies in no board's face (they fought, serrating the cover's artwork) and rolls over at head and foot (cut square, it stood out beside the boards' rolled edges); the headband's ends run into the case's walls, no caps (round spine and square, 244 pages)", () => withScene(async (scene) => {
  const report = await load("hardcover-spine-clip");
  const found = [];
  for (const roundSpine of [true, false]) {
    restoreView(scene, { ...report, scene: { ...report.scene, book: { ...report.scene.book, roundSpine } } });
    const { nearest, flatEnds } = caseAgainstBoards(scene);
    const shape = roundSpine ? "round" : "square";
    if (nearest < 0.005) found.push(`${shape}: the covering ${nearest.toFixed(4)} mm from a board's face`);
    if (flatEnds > 0.01) found.push(`${shape}: ${flatEnds.toFixed(1)} mm² of the case cut square at head and foot`);
    const ends = headbandEnds(scene);
    if (!ends.every((e) => e > 0)) found.push(`${shape}: headband ends ${ends.map((e) => e.toFixed(2)).join(", ")} mm past the case's walls (in the open)`);
    if (!scene.extras.headbands.every((b) => b.userData.ends?.every((e) => e.visible))) found.push(`${shape}: headband ends not cut flat`);
  }
  eq(found, []);
}));
