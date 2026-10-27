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
    // Glued (plain sheets), then a coil (sheets with punched holes).
    for (const binding of ["perfect", "spiral"]) {
      scene.setBook({ pageCount: 8, pageSize: { width: 148, height: 210 }, binding, paper });
      scene.goTo(2, { animate: false });
      scene.debugSample(0.5, 0.5); // compiles what this view draws
    }
    eq(errors, []);
    ok(scene.renderer.info.programs.length >= 4, `${scene.renderer.info.programs.length} shader programs`);
  } finally {
    box.remove();
  }
});

test("the sheets' depth drawn first gives the same picture (the performance check's comparison)", async () => {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 480px; height: 300px;";
  document.body.append(box);
  const scene = new BookScene(box);
  const gl = scene.renderer.getContext();
  const shot = () => {
    scene.debugSample(0.5, 0.5); // renders
    const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const differ = (a, b) => {
    let n = 0;
    for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - b[k]) > 2 || Math.abs(a[k + 1] - b[k + 1]) > 2 || Math.abs(a[k + 2] - b[k + 2]) > 2) n++;
    return n;
  };
  const rig = scene.rig;
  const views = [
    ["framed", (n) => scene.goTo(n >> 1, { animate: false }), { azimuth: 0, elevation: rig.home.elevation, zoom: 1 }],
    ["low at the fore-edge", (n) => scene.goTo(n >> 1, { animate: false }), { azimuth: Math.PI / 2, elevation: 0.12, zoom: 0.6 }],
    ["from below", (n) => scene.goTo(n >> 1, { animate: false }), { azimuth: 0.7, elevation: -0.5, zoom: 0.8 }],
    ["closed", () => { scene.goTo(0, { animate: false }); scene.setClosed(true, { animate: false }); }, { azimuth: 0, elevation: rig.home.elevation, zoom: 1 }],
  ];
  try {
    for (const binding of ["perfect", "spiral", "hardcover", "saddle"]) {
      scene.setBook({ pageCount: 48, pageSize: { width: 148, height: 210 }, binding, paper });
      for (const [label, open, at] of views) {
        open(scene.model.leafCount);
        rig.free = true;
        rig.azimuth = rig.home.azimuth + at.azimuth;
        rig.elevation = at.elevation;
        rig.zoom = at.zoom;
        rig.springing = false;
        scene.zoomBias = 1;
        const asIs = shot();
        scene.setDepthFirst(true);
        const first = shot();
        // The comparison sees the sheets: without their depth at all they draw in a heap.
        for (const leaf of scene.leaves) leaf.depth.visible = false;
        const heap = shot();
        scene.setDepthFirst(false);
        const again = shot();
        eq(differ(asIs, again), 0, `${binding}, ${label}: the same view drawn twice`);
        eq(differ(asIs, first), 0, `${binding}, ${label}: depth first`);
        ok(differ(asIs, heap) > 50, `${binding}, ${label}: without depth ${differ(asIs, heap)} pixels change`);
      }
      scene.setClosed(false, { animate: false });
    }
  } finally {
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

test("thick coil books rest on the table at every opening, and closing from a cover", async () => {
  // A pile taller than the ring's centre is high (a thick book open near a cover) was stacked
  // down from that centre, through the table: 540 pages at their cover lay 17 mm under it.
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  const scene = new BookScene(box);
  const bad = [];
  const lowest = () => Math.min(...scene.leaves.map((l) => Math.min(...l.profile.y.slice(1)) - scene.model.thickness[l.i] / 2));
  try {
    for (const binding of ["spiral", "wire-o"]) {
      for (const pageCount of [200, 540]) {
        scene.setBook({ pageCount, pageSize: { width: 148, height: 210 }, binding, paper });
        const n = scene.model.leafCount;
        const table = scene.model.ground - 0.5; // the table, less the slack the thin books' sloping pages use
        for (const opening of [0, 1, 2, Math.floor(n / 2), n - 1, n]) {
          scene.clock = 1000;
          scene.goTo(opening, { animate: false });
          scene.debugStep();
          const low = lowest();
          if (low < table) bad.push(`${binding}, ${pageCount} pages, opening ${opening}: a page ${(table - low).toFixed(2)} mm under the table`);
          if (opening === 0 && pageCount === 200) {
            // Closing from the cover: every page stays above the table and clear of the others.
            scene.close();
            for (let t = 0; t < 3000 && bad.length < 8; t += 32) {
              scene.clock += 32;
              scene.debugStep();
              const l2 = lowest();
              if (l2 < table) bad.push(`${binding}, ${pageCount} pages, closing, ${t} ms: a page ${(table - l2).toFixed(2)} mm under the table`);
              const pairs = crossingPairs(scene.leaves.map((l) => outlineOf(scene, l)));
              if (pairs.length) bad.push(`${binding}, ${pageCount} pages, closing, ${t} ms: ${pairs.slice(0, 3).map((q) => q.join("/")).join(" ")}`);
            }
            ok(scene.isClosed && scene.closed === 1, `${binding} ${pageCount}: closed at the end`);
          }
        }
      }
    }
    eq(bad, []);
  } finally {
    scene.clock = null;
    box.remove();
  }
});

test("coil books closing from anywhere, pages still in the air: no sheet passes through another, none sinks into the table, frame by frame", async () => {
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
          // No page lower than the lowest lies at rest: a pile placed for the opening asked for
          // before its pages moved dropped below the table (0.17.40, see layoutBook).
          const lowest = () => Math.min(...scene.leaves.map((l) => Math.min(...l.profile.y.slice(1)) - scene.model.thickness[l.i] / 2));
          const floor = lowest() - 0.05;
          const where = (t) => `${binding}, ${pageCount} pages, from ${from}${flipTo != null ? ` flipping to ${flipTo}` : ""}, ${t} ms (closed ${scene.closed.toFixed(2)})`;
          scene.close();
          for (let t = 0; t < 3000 && bad.length < 8; t += 8) {
            scene.clock += 8;
            scene.debugStep();
            const pairs = crossingPairs(scene.leaves.map((l) => outlineOf(scene, l)));
            if (pairs.length) bad.push(`${where(t)}: ${pairs.slice(0, 3).map((q) => q.join("/")).join(" ")}`);
            const low = lowest();
            if (low < floor) bad.push(`${where(t)}: a page ${(floor + 0.05 - low).toFixed(2)} mm below the lowest at rest`);
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

test("captures: the pages printed with a page (its other side; a fold's other half) for drawing them as sharp", async () => {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  const scene = new BookScene(box);
  const sorted = (a) => [...a].sort((x, y) => x - y);
  try {
    // A stapled booklet of 16 pages: 4 sheets, each folded round the ones inside it, leaf k
    // joined to leaf 7 - k. Page 3 (leaf 1's front): its back, page 4, and leaf 6's pages 13, 14.
    scene.setBook({ pageCount: 16, pageSize: { width: 148, height: 210 }, binding: "saddle", paper });
    eq(sorted(scene.pagesWith(3)), [4, 13, 14]);
    eq(sorted(scene.pagesWith(16)), [1, 2, 15], "the cover's back: the cover's front half round the fold");
    // Glued: no folds, the other side only.
    scene.setBook({ pageCount: 16, pageSize: { width: 148, height: 210 }, binding: "perfect", paper });
    eq(scene.pagesWith(3), [4]);
    eq(scene.pagesWith(4), [3]);
  } finally {
    box.remove();
  }
});
