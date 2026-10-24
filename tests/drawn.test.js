// The geometry audit's own trustworthiness (tests/drawn.js): what it reads back is what the
// GPU draws, and its checks see what they are for. (The audit itself, and what it finds in the
// book's geometry, is run from tests/audit.html.)

import { BookScene } from "../app/viewer/scene.js";
import { coilClearance, crossings, motionRecorder, readbackError, readSheets, restoreView, solids } from "./drawn.js";
import { eq, ok, test } from "./harness.js";

const stock = { color: "#ffffff", roughness: 0.85, specular: 0.3, clearcoat: 0, show: 0.1 };
const paper = { ...stock, cover: { ...stock, color: "#d8d0c0" }, thickness: 0.1, coverThickness: 0.3, gsm: 120, finish: "uncoated" };

function withScene(fn) {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  const scene = new BookScene(box);
  try {
    return fn(scene);
  } finally {
    box.remove();
  }
}

const build = (scene, binding, pageCount = 16) => {
  scene.setBook({ pageCount, pageSize: { width: 148, height: 210 }, binding, paper, signaturePages: 8 });
  scene.clock = 1e6;
  scene.goTo(Math.floor(scene.model.leafCount / 2), { animate: false });
  scene.debugStep();
};

test("AUDIT: the sheets read back from the GPU are where the model puts them (every binding, at rest and mid-turn)", () => withScene((scene) => {
  for (const binding of ["saddle", "perfect", "sewn", "hardcover", "spiral", "wire-o"]) {
    build(scene, binding);
    ok(readbackError(scene, readSheets(scene)) < 1e-3, `${binding} at rest`);
    scene.goTo(scene.opening + 1);
    scene.clock += 200;
    scene.debugStep();
    ok(readbackError(scene, readSheets(scene)) < 1e-3, `${binding} mid-turn`);
  }
}));

test("AUDIT: the coil's check finds the wire in the paper once the holes are too small for it", () => withScene((scene) => {
  for (const binding of ["spiral", "wire-o"]) {
    build(scene, binding);
    const sheets = readSheets(scene);
    ok(coilClearance(scene, sheets).every((c) => c.clearance > 0), `${binding}: clear of the paper as built`);
    const style = scene.model.style;
    const real = style.holeRadius;
    style.holeRadius = 0.5; // smaller than the wire's ring needs
    try {
      ok(coilClearance(scene, sheets).some((c) => c.clearance < -0.1), `${binding}: in the paper round holes too small`);
    } finally {
      style.holeRadius = real;
    }
  }
}));

test("AUDIT: the crossings check finds a sheet pushed through its neighbour", () => withScene((scene) => {
  build(scene, "perfect");
  const sheets = readSheets(scene);
  eq(crossings(scene, solids(scene, sheets), { between: 0 }).filter((c) => c.kind === "crossing"), [], "none as built");
  // Sheet 2 moved 1 mm toward the next (the pile's sheets lie 0.1 mm apart).
  const i = 2;
  const v = sheets[i].verts;
  const dir = Math.sign(sheets[i + 1].verts[1] - v[1]) || 1;
  for (let k = 1; k < v.length; k += 3) v[k] += dir * 1;
  const found = crossings(scene, solids(scene, sheets), { between: 0 }).filter((c) => c.kind === "crossing");
  ok(found.some((c) => c.a === `sheet ${i}` || c.b === `sheet ${i}`), JSON.stringify(found.slice(0, 3)));
}));

test("AUDIT: a jump is a frame that moves far more than the frames either side", () => {
  const m = motionRecorder();
  const at = (y) => new Map([["part", Float32Array.from([0, y, 0])]]);
  [0, 1, 2, 3, 30, 31, 32].forEach((y, frame) => m.add(frame, at(y)));
  eq(m.jumps().map((j) => j.frame), [4]);
});

test("AUDIT: a view report rebuilds the scene it was taken from: the same sheets, where they were", () => withScene((scene) => {
  build(scene, "spiral");
  scene.goTo(scene.opening + 1);
  scene.clock += 180;
  scene.debugStep();
  const report = { scene: JSON.parse(JSON.stringify(scene.snapshot())) };
  const before = readSheets(scene);
  withScene((other) => {
    restoreView(other, report);
    const after = readSheets(other);
    let worst = 0;
    before.forEach(({ verts }, k) => {
      for (let v = 0; v < verts.length; v++) worst = Math.max(worst, Math.abs(verts[v] - after[k].verts[v]));
    });
    ok(worst < 1e-3, `off by ${worst} mm`);
  });
}));
