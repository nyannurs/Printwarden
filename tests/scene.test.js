// The 3D view itself (app/viewer/scene.js): it changes three.js's shaders as text, which a
// three.js upgrade can break. Every kind of sheet drawn once: a change that no longer fits
// throws, and a shader that no longer compiles fails here instead of only in the console.

import { BookScene } from "../app/viewer/scene.js";
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
