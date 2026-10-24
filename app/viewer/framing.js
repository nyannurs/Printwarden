// Where the camera stands and aims (the book framed, then placed for a frame on the rig's angles,
// see camera.js), and which parts of which pages it sees, how densely (for the tiles, ui/tiles.js,
// and a capture's strips). Functions of the scene (scene.js), as input.js and capture.js are.

import * as THREE from "three";
import { pageHit } from "./leaf.js";

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Frame the book: how far the camera stands (fitDistance) and where it aims (target), for the
 * spread, a page, or the closed book as they blend (closed, pageFrame, coverFrame, coverShift);
 * the floating presets' tilt about that aim; the lights, fixed to the book.
 * @param {import("./scene.js").BookScene} scene
 */
export function frameCamera(scene) {
  if (!scene.model) return;
  const { width: w, height: h, ground, total } = scene.model;
  const c = ease(scene.closed);
  const aspect = scene.camera.aspect;
  const vfov = (scene.camera.fov * Math.PI) / 360;
  const hfov = Math.atan(Math.tan(vfov) * aspect);
  const spreadFit = Math.max((w * 1.15) / Math.tan(hfov), (h * 0.62) / Math.tan(vfov));
  const closedFit = Math.max((w * 0.75) / Math.tan(hfov), (h * 0.66) / Math.tan(vfov));
  // Open at a cover, the pages lie on one side: framed like a single page, centred on it.
  // So is the one page asked for (focus).
  const s = scene.coverShift;
  const p = scene.pageFrame;
  // A page asked for: never farther than the spread (in a wide view both fill its height, and
  // a page framed with the closed book's room above and below drew back as it was asked for).
  // At a cover: as the closed book, which it is about to be (a coil book closing from there
  // stepped back as it tilted onto its coil, 0.17.24 to 0.17.38).
  const openFit = lerp(spreadFit, lerp(Math.min(closedFit, spreadFit), closedFit, scene.coverFrame), p);
  scene.fitDistance = 1.08 * lerp(openFit, closedFit, c);
  const openY = lerp(w * 0.2, total / 2, p);
  scene.target.set(lerp((s * w) / 2, (scene.closedSide * w) / 2, c), ground + lerp(openY, total / 2, c), h * 0.03);
  // Floating: the book is tilted about the point the camera aims at, which stays put.
  const tilt = scene.float;
  scene.root.rotation.set(tilt?.x ?? 0, 0, tilt?.z ?? 0);
  scene.root.position.copy(scene.target).sub(scene.target.clone().applyEuler(scene.root.rotation));
  scene.root.updateMatrixWorld();
  // Key light upper left in front; rim light behind. Fixed to the book, not to where the
  // camera aims: as the view re-frames (closing, opening at a cover) a light following it
  // moved the shadow map a fraction of a texel each frame, and shadows crawled. Floating,
  // they turn with the book: lit as it would be lying on a table, however it hangs.
  const d = Math.max(w, h) * 3;
  const anchor = new THREE.Vector3(0, ground, 0); // the spine on the table, in the book's frame
  const around = (x, y, z) => scene.root.localToWorld(new THREE.Vector3(x, y, z).add(anchor));
  scene.key.position.copy(around(-d * 0.35, d, d * 0.5));
  scene.key.target.position.copy(around(0, 0, 0));
  scene.rim.position.copy(around(d * 0.6, d * 0.5, -d));
  scene.rim.target.position.copy(around(0, 0, 0));
  const cam = scene.key.shadow.camera;
  const span = Math.max(w, h) * 1.4;
  Object.assign(cam, { left: -span, right: span, top: span, bottom: -span, near: d * 0.2, far: d * 2.5 });
  cam.updateProjectionMatrix();
}

/**
 * Where the camera looks: the framed aim, moved by the pan.
 * @param {import("./scene.js").BookScene} scene
 */
export function currentTarget(scene) {
  const p = scene.rig.pan;
  return scene.target.clone().add(new THREE.Vector3(p.x, p.y, p.z));
}

/**
 * The camera placed for a frame: on the rig's angles and zoom about its aim, its depth range
 * to the distance; the table hidden from below.
 * @param {import("./scene.js").BookScene} scene
 */
export function placeCamera(scene) {
  const { azimuth, elevation, zoom } = scene.rig;
  const d = scene.fitDistance * zoom;
  const t = currentTarget(scene);
  scene.camera.position.set(
    t.x + d * Math.sin(azimuth) * Math.cos(elevation),
    t.y + d * Math.sin(elevation),
    t.z + d * Math.cos(azimuth) * Math.cos(elevation),
  );
  scene.camera.up.set(0, 1, 0);
  scene.camera.lookAt(t);
  // Depth range follows the distance: precise enough for 0.1 mm paper at any zoom.
  scene.camera.near = Math.max(0.2, d * 0.02);
  scene.camera.far = d * 40 + 5000;
  scene.camera.updateProjectionMatrix();
  // From beneath the table (orbited there to see the book's underside), the table and
  // its shadows aren't there to see.
  const above = !scene.model || scene.float || scene.camera.position.y > scene.model.ground;
  scene.ground.visible = scene.contact.visible = above && !scene.float;
}

/**
 * The pages in view: which part of each page image is on screen (texture uv, v = 0 at
 * the head), and the screen density measured across it.
 *
 * Found by casting rays from a grid of screen points onto the page: exact at any zoom
 * and angle, including a page seen steeply, where near parts need far more detail than
 * distant ones (the densest part decides). Rays meet the page's cross-section curve, not
 * its triangles (see pageHit): zoomed in, every ray reaches the page's bounds, and
 * testing thousands of triangles each took about 50 ms a call while moving.
 * @returns {{folio: number, region: {u0: number, v0: number, u1: number, v1: number},
 *            samples: {u: number, v: number, pxPerMm: number, sx: number, sy: number}[]}[]}
 *   a sample's `sx`, `sy`: where on the screen it was taken (0 to 1)
 * @param {import("./scene.js").BookScene} scene
 * @param {{width?: number, height?: number, folios?: number[]}} [size] a capture tile's, in
 *   device pixels (else the canvas's); `folios`: the pages to look for (else the open spread's)
 */
export function visiblePages(scene, { width, height, folios = scene.shownFolios } = {}) {
  if (!scene.model) return [];
  // In device pixels of the canvas, or of a capture tile when given.
  const W = width ?? scene.renderer.domElement.width;
  const H = height ?? scene.renderer.domElement.height;
  const { width: pw, height: ph } = scene.model;
  const cols = 16;
  const rows = 12;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const out = [];
  const toLeaf = new THREE.Matrix4();
  const local = new THREE.Ray();
  for (const folio of folios) {
    const leaf = scene.leaves[Math.ceil(folio / 2) - 1];
    if (!leaf || folio < 1 || folio > scene.pageCount) continue;
    const front = folio % 2 === 1; // odd pages on the leaf's front
    leaf.mesh.updateWorldMatrix(true, false);
    toLeaf.copy(leaf.mesh.matrixWorld).invert();
    const grid = [];
    for (let j = 0; j <= rows; j++) {
      const row = [];
      for (let i = 0; i <= cols; i++) {
        ndc.set((i / cols) * 2 - 1, 1 - (j / rows) * 2);
        ray.setFromCamera(ndc, scene.camera);
        local.copy(ray.ray).applyMatrix4(toLeaf);
        row.push(pageHit(scene.model, leaf, local, front));
      }
      grid.push(row);
    }
    let u0 = 1;
    let u1 = 0;
    let v0 = 1;
    let v1 = 0;
    const samples = [];
    const stepX = W / cols;
    const stepY = H / rows;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const q = grid[j][i];
        if (!q) continue;
        u0 = Math.min(u0, q.x);
        u1 = Math.max(u1, q.x);
        v0 = Math.min(v0, q.y);
        v1 = Math.max(v1, q.y);
        // Screen pixels per mm of paper here: from the neighbouring rays.
        let here = 0;
        for (const [n, step] of [[grid[j][i + 1], stepX], [grid[j + 1]?.[i], stepY], [grid[j][i - 1], stepX], [grid[j - 1]?.[i], stepY]]) {
          if (!n) continue;
          const mm = Math.hypot((n.x - q.x) * pw, (n.y - q.y) * ph);
          if (mm > 1e-6) here = Math.max(here, step / mm);
        }
        if (here) samples.push({ u: q.x, v: q.y, pxPerMm: here, sx: i / cols, sy: j / rows });
      }
    }
    if (u1 < u0 || v1 < v0) continue; // not on screen
    // Grow by one ray spacing, as measured on the page (the widest step between neighbouring
    // rays): its edge, or the screen's, can lie up to that far past the last ray that met
    // it. (Until 0.17.79 by a sixteenth of the part met, a ninth of the true spacing on a
    // page filling six of the sixteen columns: the strips stopped 12 % short of the spine,
    // and the page showed a seam there between its strip and its base image.)
    let du = 0.01;
    let dv = 0.01;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const q = grid[j][i];
        if (!q) continue;
        for (const n of [grid[j][i + 1], grid[j + 1]?.[i]]) {
          if (!n) continue;
          du = Math.max(du, Math.min(0.5, Math.abs(n.x - q.x)));
          dv = Math.max(dv, Math.min(0.5, Math.abs(n.y - q.y)));
        }
      }
    }
    // Within a further spacing of the page's own edge: to the edge. Where the page curves
    // away into the spine its steps on screen are shorter than the widest measured, and the
    // last millimetres there fell between rays.
    const lo = (a, d) => (a - 2 * d <= 0 ? 0 : a - d);
    const hi = (a, d) => (a + 2 * d >= 1 ? 1 : a + d);
    out.push({ folio, region: { u0: lo(u0, du), v0: lo(v0, dv), u1: hi(u1, du), v1: hi(v1, dv) }, samples });
  }
  return out;
}
