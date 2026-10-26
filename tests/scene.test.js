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

test("the occluder changes no pixel, of any sheet it is made of, in any binding; pushed out of the paper it would", async () => {
  // See draw.js makeOccluder: a surface inside the paper, drawn first for its depth alone.
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  const scene = new BookScene(box);
  const gl = scene.renderer.getContext();
  const W = gl.drawingBufferWidth;
  const H = gl.drawingBufferHeight;
  const shot = () => {
    scene.lastRequest = -1e9;
    scene.debugSample(0.5, 0.5);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const differ = (a, b) => {
    let worst = 0;
    let count = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > worst) worst = d;
      if (d > 2) count++;
    }
    return { worst, count };
  };
  const view = (az, el, zoom) => {
    const g = scene.rig;
    g.free = true;
    g.pan = { x: 0, y: 0, z: 0 };
    g.azimuth = g.home.azimuth + az;
    g.elevation = el;
    g.zoom = zoom;
    g.springing = false;
    g.dragging = false;
    scene.zoomBias = 1;
  };
  const bad = [];
  try {
    for (const binding of ["perfect", "saddle", "sewn", "hardcover", "spiral", "wire-o"]) {
      scene.setBook({ pageCount: 44, pageSize: { width: 148, height: 210 }, binding, paper });
      const n = scene.model.leafCount;
      const views = {
        spread: () => { scene.goTo(Math.floor(n / 2), { animate: false }); scene.setClosed(false, { animate: false }); scene.rig.free = false; scene.settleCamera(); },
        closed: () => { scene.goTo(0, { animate: false }); scene.setClosed(true, { animate: false }); scene.rig.free = false; scene.settleCamera(); },
        foreEdge: () => { scene.goTo(Math.floor(n / 2), { animate: false }); scene.setClosed(false, { animate: false }); view(Math.PI / 2, 0.12, 0.6); },
        below: () => { scene.goTo(Math.floor(n / 2), { animate: false }); scene.setClosed(false, { animate: false }); view(0.7, -0.6, 1); },
        midTurn: () => { scene.clock = 1000; scene.goTo(Math.floor(n / 2), { animate: false }); scene.setClosed(false, { animate: false }); scene.rig.free = false; scene.settleCamera(); scene.goTo(Math.floor(n / 2) + 1); scene.clock = 1250; scene.debugStep(); },
      };
      for (const [name, go] of Object.entries(views)) {
        const where = `${binding}, ${name}`;
        go();
        scene.occluderEvery = 0;
        const without = shot();
        for (const every of [8, 1]) {
          scene.occluderEvery = every;
          const d = differ(without, shot());
          if (d.worst > 2) bad.push(`${where}, every ${every}: ${d.count} pixels changed, by up to ${d.worst}`);
        }
        // The same test must catch the surface pushed out of the paper, past the faces.
        scene.occluderEvery = 1;
        scene.occluder.side.value = 1.5;
        const d = differ(without, shot());
        scene.occluder.side.value = 0;
        if (d.count < 50) bad.push(`${where}: pushed out of the paper, only ${d.count} pixels changed (the check can't see the occluder)`);
        scene.clock = null;
      }
    }
    eq(bad, []);
  } finally {
    scene.clock = null;
    scene.occluderEvery = 8;
    box.remove();
  }
});

test("the sheets draw in batches: a few draws for a book, a sheet with a texture of its own drawn alone and back in again", async () => {
  // See draw.js makeBatches, batchable.
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  const scene = new BookScene(box);
  const r = scene.renderer;
  const leafOf = () => new Map(scene.leaves.map((l) => [l.mesh, l]));
  // One frame's draws: the sheets' own, and the batches'.
  const draws = () => {
    scene.lastRequest = -1e9;
    scene.debugSample(0.5, 0.5);
    const leaves = leafOf();
    const batches = new Set(Object.values(scene.batches ?? {}).map((b) => b.mesh));
    let own = 0;
    let batched = 0;
    const orig = r.renderBufferDirect.bind(r);
    r.renderBufferDirect = (camera, sc, geometry, material, object, group) => {
      if (camera === scene.camera) {
        if (leaves.has(object)) own++;
        else if (batches.has(object)) batched++;
      }
      return orig(camera, sc, geometry, material, object, group);
    };
    scene.composer.render();
    r.renderBufferDirect = orig;
    return { own, batched };
  };
  try {
    for (const [binding, batchesExpected] of [["saddle", 2], ["perfect", 2], ["spiral", 3], ["hardcover", 2]]) {
      scene.setBook({ pageCount: 44, pageSize: { width: 148, height: 210 }, binding, paper });
      scene.goTo(11, { animate: false });
      const d = draws();
      eq(d.batched, batchesExpected, `${binding}: the batches (faces, edges, a coil's strips)`);
      // The covers (their own stock; a hardcover's boards) are drawn on their own: 3 draws a sheet, 5 for a coil's.
      eq(d.own, 2 * (binding === "spiral" ? 5 : 3), `${binding}: the sheets drawn on their own`);
      ok(scene.leaves[5].mesh.visible === false, `${binding}: a page's own mesh isn't drawn while it is in the batches`);
    }
    scene.setBook({ pageCount: 44, pageSize: { width: 148, height: 210 }, binding: "saddle", paper });
    scene.goTo(11, { animate: false });
    const before = draws();
    // An image shown instead (a video's) puts the sheet on its own; its own again, back in the batches.
    const canvas = new OffscreenCanvas(64, 64);
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    scene.showPageImage(11, await createImageBitmap(canvas));
    const shown = draws();
    eq(shown.own, before.own + 3, "the sheet with an image of its own: drawn on its own");
    ok(scene.leaves[5].mesh.visible, "its mesh shown");
    scene.showPageImage(11, null);
    eq(draws().own, before.own, "its own image gone: in the batches again");
    // Every sheet on its own, for comparison: the batches draw nothing.
    scene.debugNoBatch = true;
    const none = draws();
    ok(none.batched <= 2, `the batches draw nothing (three still calls for them, with no ranges: ${none.batched})`);
    eq(none.own, 22 * 3);
    scene.debugNoBatch = false;
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
