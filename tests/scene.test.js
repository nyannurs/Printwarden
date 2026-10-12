// The 3D view itself (app/viewer/scene.js): it changes three.js's shaders as text, which a
// three.js upgrade can break. Every kind of sheet drawn once: a change that no longer fits
// throws, and a shader that no longer compiles fails here instead of only in the console.

import { BookScene } from "../app/viewer/scene.js";
import { LEAF_FILL } from "../app/viewer/shaders.js";
import { crossingPairs } from "./crossings.js";
import { eq, ok, test } from "./harness.js";

const stock = { color: "#ffffff", roughness: 0.85, specular: 0.3, clearcoat: 0, show: 0.1 };
const paper = { ...stock, cover: { ...stock, color: "#d8d0c0" }, thickness: 0.1, coverThickness: 0.3, gsm: 120, finish: "uncoated" };

test("scene: three.js shaders take our changes, and every kind of sheet draws", async () => {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  const scene = new BookScene(box);
  const errors = [];
  scene.renderer.debug.onShaderError = (gl, program, vs, fs) => {
    errors.push((gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(program) || "a shader failed").trim());
  };
  try {
    // Glued (plain sheets), then a coil (sheets with punched holes); each also with the
    // sheets' depth drawn first (as on Apple's graphics).
    for (const binding of ["perfect", "spiral"]) {
      scene.setBook({ pageCount: 8, pageSize: { width: 148, height: 210 }, binding, paper });
      for (const depthFirst of [false, true]) {
        scene.depthFirst = depthFirst;
        scene.goTo(2, { animate: false });
        scene.debugSample(0.5, 0.5); // compiles what this view draws
      }
    }
    eq(errors, []);
    ok(scene.renderer.info.programs.length >= 4, `${scene.renderer.info.programs.length} shader programs`);
  } finally {
    scene.depthFirst = false;
    box.remove();
  }
});

/** A leaf's cross-section as drawn: an outline as thick as the sheet (see geometry.test.js). */
function outlineOf(scene, leaf) {
  const p = leaf.profile;
  const half = (scene.model.thickness[leaf.i] * LEAF_FILL) / 2;
  const front = [];
  const back = [];
  for (let k = 0; k < p.x.length; k++) {
    const nx = -Math.cos(p.phi[k]);
    const ny = Math.sin(p.phi[k]);
    front.push(p.x[k] + nx * half, p.y[k] + ny * half);
    back.unshift(p.x[k] - nx * half, p.y[k] - ny * half); // (both at once: the pair stays x, y)
  }
  return [...front, ...back]; // along the front, back along the back
}

test("coil books closing from anywhere, pages still in the air: no sheet passes through another, frame by frame", async () => {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  const scene = new BookScene(box);
  const bad = [];
  try {
    for (const binding of ["spiral", "wire-o"]) {
      for (const pageCount of [8, 44]) {
        scene.setBook({ pageCount, pageSize: { width: 148, height: 210 }, binding, paper });
        const n = scene.model.leafCount;
        // From a spread, from the back cover (every page turns), and mid-flip (closed at once
        // after a turn was asked for).
        for (const [from, flipTo] of [[1, null], [Math.floor(n / 2), null], [n - 1, null], [n, null], [2, Math.floor(n / 2)]]) {
          scene.clock = 1000;
          scene.goTo(from, { animate: false });
          scene.debugStep();
          if (flipTo != null) {
            scene.goTo(flipTo);
            scene.clock += 120;
            scene.debugStep();
          }
          scene.close();
          for (let t = 0; t < 3000 && bad.length < 8; t += 8) {
            scene.clock += 8;
            scene.debugStep();
            const pairs = crossingPairs(scene.leaves.map((l) => outlineOf(scene, l)));
            if (pairs.length) bad.push(`${binding}, ${pageCount} pages, from ${from}${flipTo != null ? ` flipping to ${flipTo}` : ""}, ${t} ms (closed ${scene.closed.toFixed(2)}): ${pairs.slice(0, 3).map((q) => q.join("/")).join(" ")}`);
          }
          ok(scene.isClosed && scene.closed === 1, `${binding} ${pageCount} from ${from}: closed at the end`);
        }
      }
    }
    eq(bad, []);
  } finally {
    scene.clock = null;
    box.remove();
  }
});
