// The author's view reports (Ctrl/Cmd+Shift+G, see ui/report.js), kept in tests/reports/ with
// their pictures left out: each the frame something looked wrong in, rebuilt (tests/drawn.js
// restoreView) and played on, frame by frame, with what was wrong checked.

import { BookScene } from "../app/viewer/scene.js";
import { motionRecorder, readSheets, restoreView } from "./drawn.js";
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
