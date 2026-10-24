// The book's geometry as drawn, and checks on it: what the author sees, measured. The sheets
// are built on the GPU (SHEET_VERTEX in viewer/shaders.js) from their cross-sections, so a
// check on the model (the cross-sections, as the geometry proof in geometry.test.js takes them)
// can pass while what is drawn is wrong. Here every sheet's vertices are read back from the
// GPU, through the very shader code the frame draws them with (sheetShader), and the parts
// built on the CPU (the coil, the spine, the folds) from their meshes. Then:
//
//   - crossings: the drawn surfaces sliced across the spine, at every row of the sheets'
//     meshes and between; two slices crossing are two solids passing through each other
//     (sheets, a spine and the sheets; where a spine's part meets a sheet's root, a joint);
//   - the coil: along its wire, how close the paper comes (the punched holes cut out of it):
//     the wire's surface must stay clear of the paper everywhere;
//   - stretch: how much a sheet's drawn faces are longer or shorter than the paper;
//   - jumps: frame to frame, a sheet (or the coil) moving far more in one frame than in the
//     frames either side, the "spazzing" seen in motion;
//   - sequences: clicks, closings and their timing, at random (seeded), run frame by frame
//     on the scene's clock and checked every frame; a failing one cut down to the fewest
//     actions that still fail.
//
// For development: the audit page (tests/audit.html) runs it; the test suite checks the
// readback itself (drawn.test.js).

import * as THREE from "three";
import { HOLE_OFFSET_MM } from "../app/viewer/model.js";
import { LEAF_FILL, LEAF_ROWS, MID_ROW, sheetShader } from "../app/viewer/shaders.js";

const READ_WIDTH = 1024; // the readback target's width, in vertices
// The wire may press into the paper this far (mm) before it counts: the paper is soft, and the
// sampling of the wire and of the sheets' meshes is finite.
export const COIL_TOLERANCE = 0.05;

/** The readback's target and each leaf's material, kept per scene. */
const readers = new WeakMap();

/**
 * Every sheet's vertices as the GPU places them, in the book block's space (mm; the spine
 * along z, head at -z): per leaf, its vertices in the order of its geometry (see makeLeaf in
 * viewer/leaf.js). The scene must be laid out (debugStep) first.
 * @param {import("../app/viewer/scene.js").BookScene} scene
 * @returns {{i: number, verts: Float32Array}[]}
 */
export function readSheets(scene) {
  const r = scene.renderer;
  const counts = scene.leaves.map((l) => l.geo.attributes.position.count);
  const total = counts.reduce((a, b) => a + b, 0);
  const height = Math.max(1, Math.ceil(total / READ_WIDTH));
  let reader = readers.get(scene);
  if (!reader || reader.target.height < height) {
    reader?.target.dispose();
    reader = {
      target: new THREE.WebGLRenderTarget(READ_WIDTH, height, {
        type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
        depthBuffer: false, generateMipmaps: false,
      }),
      materials: new Map(),
      scene: new THREE.Scene(),
      camera: new THREE.Camera(),
    };
    readers.set(scene, reader);
  }
  const { target, scene: points, camera } = reader;
  points.clear();
  let offset = 0;
  scene.leaves.forEach((leaf, k) => {
    let m = reader.materials.get(leaf.i);
    if (!m) {
      m = new THREE.ShaderMaterial({
        uniforms: { uOffset: { value: 0 }, uWidth: { value: READ_WIDTH }, uHeight: { value: 1 } },
        vertexShader: /* glsl */ `
uniform float uOffset;
uniform float uWidth;
uniform float uHeight;
varying vec4 vPlace;
void main() {
#include <beginnormal_vertex>
#include <begin_vertex>
  vPlace = vec4( ( modelMatrix * vec4( transformed, 1.0 ) ).xyz, 1.0 );
  float id = float( gl_VertexID ) + uOffset;
  gl_Position = vec4( ( mod( id, uWidth ) + 0.5 ) / uWidth * 2.0 - 1.0, ( floor( id / uWidth ) + 0.5 ) / uHeight * 2.0 - 1.0, 0.0, 1.0 );
  gl_PointSize = 1.0;
}`,
        fragmentShader: /* glsl */ `
varying vec4 vPlace;
void main() { gl_FragColor = vPlace; }`,
        depthTest: false,
        depthWrite: false,
      });
      // The sheets' own vertex code, exactly as the frame's materials take it.
      m.onBeforeCompile = (shader) => sheetShader(shader, scene.shared);
      reader.materials.set(leaf.i, m);
    }
    m.uniforms.uOffset.value = offset;
    m.uniforms.uHeight.value = target.height;
    const p = new THREE.Points(leaf.geo, m);
    p.frustumCulled = false;
    p.matrixAutoUpdate = false;
    p.matrixWorldAutoUpdate = false;
    leaf.mesh.updateMatrix();
    p.matrixWorld.copy(leaf.mesh.matrix); // the leaf's place in the block
    points.add(p);
    offset += counts[k];
  });
  const before = r.getRenderTarget();
  const clear = r.getClearColor(new THREE.Color());
  const alpha = r.getClearAlpha();
  r.setRenderTarget(target);
  r.setClearColor(0x000000, 0);
  r.clear(true, false, false);
  r.render(points, camera);
  const data = new Float32Array(READ_WIDTH * target.height * 4);
  r.readRenderTargetPixels(target, 0, 0, READ_WIDTH, target.height, data);
  r.setRenderTarget(before);
  r.setClearColor(clear, alpha);
  offset = 0;
  return scene.leaves.map((leaf, k) => {
    const verts = new Float32Array(counts[k] * 3);
    for (let v = 0; v < counts[k]; v++) {
      const o = (offset + v) * 4;
      verts[3 * v] = data[o];
      verts[3 * v + 1] = data[o + 1];
      verts[3 * v + 2] = data[o + 2];
    }
    offset += counts[k];
    return { i: leaf.i, verts };
  });
}

/**
 * The readback against the model: each sheet's middle row, front and back, as drawn, against
 * its cross-section (the profile) offset by half the paper and the bow there. The largest
 * difference (mm): a check of the readback itself.
 */
export function readbackError(scene, sheets) {
  let worst = 0;
  const R = LEAF_ROWS;
  for (const { i, verts } of sheets) {
    const leaf = scene.leaves[i];
    const p = leaf.rowsActive ? leaf.rows[MID_ROW] : leaf.profile;
    const n = leaf.s.length;
    const half = (scene.model.thickness[i] * (leaf.fill ?? LEAF_FILL)) / 2;
    const bow = leaf.bows[MID_ROW];
    for (let k = 0; k < n; k++) {
      const a = Math.min(1, Math.hypot(p.x[k] - p.x[0], p.y[k] - p.y[0]) / leaf.width);
      const d = bow * a * a * 0.4;
      const nx = -Math.cos(p.phi[k]), ny = Math.sin(p.phi[k]);
      for (const [side, base] of [[1, 0], [-1, n * R]]) {
        const v = base + k * R + MID_ROW;
        const x = p.x[k] + nx * (side * half + d);
        const y = p.y[k] + ny * (side * half + d);
        const z = -leaf.height / 2 + leaf.rise + (leaf.height * MID_ROW) / (R - 1); // (a spiral's page as far up as it hangs)
        worst = Math.max(worst, Math.hypot(verts[3 * v] - x, verts[3 * v + 1] - y, verts[3 * v + 2] - z));
      }
    }
  }
  return worst;
}

// --- slices --------------------------------------------------------------------------------

/**
 * A solid's triangles for slicing: flat [x, y, z, s] a corner (s: where on its page, mm from
 * the spine edge, for the punched holes; NaN where it has no page), 12 numbers a triangle.
 */
function sheetTriangles(scene, leaf, verts) {
  const index = leaf.geo.index.array;
  const place = leaf.geo.attributes.position.array;
  const tris = new Float64Array((index.length / 3) * 12);
  for (let t = 0; t < index.length; t++) {
    const v = index[t];
    const k = Math.round(place[3 * v]);
    const o = t * 4;
    tris[o] = verts[3 * v];
    tris[o + 1] = verts[3 * v + 1];
    tris[o + 2] = verts[3 * v + 2];
    tris[o + 3] = leaf.uStart + leaf.s[k]; // where the page's own coordinates put it (see HOLE_DISCARD)
  }
  return tris;
}

/** A mesh's triangles in the block's space (s: NaN). */
function meshTriangles(scene, mesh) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const index = g.index ? g.index.array : null;
  const count = index ? index.length : pos.count;
  const toBlock = new THREE.Matrix4().copy(scene.block.matrixWorld).invert().multiply(mesh.matrixWorld);
  const v = new THREE.Vector3();
  const tris = new Float64Array(count * 4);
  for (let t = 0; t < count; t++) {
    v.fromBufferAttribute(pos, index ? index[t] : t).applyMatrix4(toBlock);
    tris.set([v.x, v.y, v.z, NaN], t * 4);
  }
  return tris;
}

/**
 * The solids in the book: every sheet, and the parts the extras build (by kind). Each with
 * its triangles; `leaf` for a sheet.
 */
export function solids(scene, sheets) {
  scene.block.updateMatrixWorld(true);
  const out = sheets.map(({ i, verts }) => ({ kind: "sheet", leaf: i, tris: sheetTriangles(scene, scene.leaves[i], verts) }));
  const ex = scene.extras ?? {};
  const meshesOf = (root) => {
    const list = [];
    root?.traverse((o) => { if (/** @type {any} */ (o).isMesh && o.visible) list.push(o); });
    return list;
  };
  for (const m of meshesOf(ex.coil)) out.push({ kind: "coil", tris: meshTriangles(scene, m) });
  for (const key of ["slab", "caseSpine", "fold"]) {
    for (const m of meshesOf(ex[key])) out.push({ kind: "spine", tris: meshTriangles(scene, m) });
  }
  return out;
}

/** Where the paper is punched at z (the page's own, from its middle), per hole a range of s; [] without holes. */
function holesAt(scene, z) {
  const st = scene.model.style;
  if (st.spine !== "coil") return [];
  const h = scene.model.height;
  const pitch = st.pitch ?? 8;
  const loops = Math.floor((h - 6) / pitch);
  const margin = (h - loops * pitch) / 2;
  const r = st.holeRadius ?? 2.5;
  const out = [];
  for (let k = 0; k < loops; k++) {
    const dz = Math.abs(z + h / 2 - (margin + (k + 0.5) * pitch)); // the page's z (see HOLE_DISCARD)
    let w = -1;
    if (st.squareHoles) {
      // A square with rounded corners (0.4 mm), as HOLE_DISCARD cuts it.
      const flat = r - 0.4;
      if (dz <= flat) w = r;
      else if (dz < r) w = flat + Math.sqrt(0.16 - (dz - flat) ** 2);
    } else if (dz < r) {
      w = Math.sqrt(r * r - dz * dz);
    }
    if (w > 0) out.push([HOLE_OFFSET_MM - w, HOLE_OFFSET_MM + w]);
  }
  return out;
}

/**
 * A solid cut at z: its segments in the plane, appended to `out` as [x0, y0, x1, y1], with the
 * paper's punched holes (`holes`: ranges of s) left out of a sheet's. `candidates`: the
 * triangles (their offsets in `tris`) that can reach z.
 */
function slice(tris, z, holes, candidates, out) {
  for (let j = 0; j < candidates.length; j++) {
    const t = candidates[j];
    let n = 0;
    let x0 = 0, y0 = 0, s0 = 0, x1 = 0, y1 = 0, s1 = 0;
    for (let e = 0; e < 3; e++) {
      const a = t + 4 * e, b = t + 4 * ((e + 1) % 3);
      const za = tris[a + 2] - z, zb = tris[b + 2] - z;
      if ((za > 0) === (zb > 0) || za === zb) continue;
      const f = za / (za - zb);
      const x = tris[a] + f * (tris[b] - tris[a]);
      const y = tris[a + 1] + f * (tris[b + 1] - tris[a + 1]);
      const sv = tris[a + 3] + f * (tris[b + 3] - tris[a + 3]);
      if (n === 0) { x0 = x; y0 = y; s0 = sv; } else { x1 = x; y1 = y; s1 = sv; }
      n++;
    }
    if (n !== 2) continue;
    if (!holes.length || Number.isNaN(s0)) {
      out.push(x0, y0, x1, y1);
      continue;
    }
    // The parts of the segment outside every hole's range of s.
    let pieces = [[0, 1]];
    for (const [lo, hi] of holes) {
      const next = [];
      for (const [f0, f1] of pieces) {
        const sa = s0 + f0 * (s1 - s0), sb = s0 + f1 * (s1 - s0);
        const smin = Math.min(sa, sb), smax = Math.max(sa, sb);
        if (smax <= lo || smin >= hi) { next.push([f0, f1]); continue; }
        const at = (sv) => (sv - s0) / (s1 - s0 || 1e-12);
        const fl = at(lo), fh = at(hi);
        const [lowEnd, highEnd] = sa < sb ? [f0, f1] : [f1, f0];
        if (smin < lo) next.push([lowEnd, fl].sort((u, v) => u - v));
        if (smax > hi) next.push([fh, highEnd].sort((u, v) => u - v));
      }
      pieces = next;
    }
    for (const [f0, f1] of pieces) out.push(x0 + f0 * (x1 - x0), y0 + f0 * (y1 - y0), x0 + f1 * (x1 - x0), y0 + f1 * (y1 - y0));
  }
}

/**
 * Segments of different owners that cross properly, binned on a grid: per pair of owners
 * that `wanted` accepts, the first crossing found, [owner a, owner b, x, y].
 * @param {number[][]} segments per owner, flat [x0, y0, x1, y1, ...]
 */
function crossingsAmong(segments, owners, wanted, cell = 0.5) {
  let count = 0;
  for (const segs of segments) count += segs.length >> 2;
  const seg = new Float64Array(count * 4);
  const owner = new Int32Array(count);
  const grid = new Map();
  let id = 0;
  segments.forEach((segs, o) => {
    for (let k = 0; k < segs.length; k += 4, id++) {
      seg.set([segs[k], segs[k + 1], segs[k + 2], segs[k + 3]], id * 4);
      owner[id] = o;
      const x0 = Math.floor(Math.min(segs[k], segs[k + 2]) / cell), x1 = Math.floor(Math.max(segs[k], segs[k + 2]) / cell);
      const y0 = Math.floor(Math.min(segs[k + 1], segs[k + 3]) / cell), y1 = Math.floor(Math.max(segs[k + 1], segs[k + 3]) / cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = (cx + 2 ** 20) * 2 ** 21 + (cy + 2 ** 20);
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(id);
        }
      }
    }
  });
  const found = new Map();
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        let sa = list[a], sb = list[b];
        if (owner[sa] === owner[sb]) continue;
        if (owner[sa] > owner[sb]) [sa, sb] = [sb, sa];
        const key = owner[sa] * owners.length + owner[sb];
        if (found.has(key) || !wanted(owners[owner[sa]], owners[owner[sb]])) continue;
        const p = crossPoint(seg, sa * 4, seg, sb * 4);
        if (p) found.set(key, [owner[sa], owner[sb], p[0], p[1]]);
      }
    }
  }
  return [...found.values()];
}

/** Where two segments cross properly (each one's ends strictly either side of the other, by more than a micrometre), or null. */
function crossPoint(A, a, B, b) {
  const ax = A[a], ay = A[a + 1], bx = A[a + 2], by = A[a + 3];
  const cx = B[b], cy = B[b + 1], dx = B[b + 2], dy = B[b + 3];
  const ex = bx - ax, ey = by - ay, fx = dx - cx, fy = dy - cy;
  const lf = Math.hypot(fx, fy), le = Math.hypot(ex, ey);
  if (lf < 1e-9 || le < 1e-9) return null;
  // Signed distances (mm) of each segment's ends from the other's line.
  const d1 = (fx * (ay - cy) - fy * (ax - cx)) / lf;
  const d2 = (fx * (by - cy) - fy * (bx - cx)) / lf;
  const d3 = (ex * (cy - ay) - ey * (cx - ax)) / le;
  const d4 = (ex * (dy - ay) - ey * (dx - ax)) / le;
  const eps = 1e-3;
  if (!(((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps)))) return null;
  const f = d1 / (d1 - d2);
  return [ax + f * ex, ay + f * ey];
}

/**
 * Solids passing through each other in the book as drawn, found by slicing across the spine
 * at every row of the sheets' meshes and `between` more planes between rows. Each fault: the
 * two solids (a sheet's leaf index, or the kind of part), and where (x, y, z; mm).
 * Which pairs count: sheets against sheets, against the coil (its wire through the punched
 * holes is not a fault: they are left out of the paper), and against the spine's parts (a
 * fold's U round its own sheets is the sheets' continuation: those pairs are left out).
 * `moved`: if given, only pairs with at least one of these (owners: "sheet 3", "spine") are
 * tested: two that held still since a frame found clean are clean.
 * @param {ReturnType<typeof solids>} parts
 * @param {{between?: number, moved?: Set<string> | null}} [options]
 */
export function crossings(scene, parts, { between = 3, moved = null } = {}) {
  const R = LEAF_ROWS;
  const zs = new Set();
  for (const leaf of scene.leaves) {
    const z0 = -leaf.height / 2 + leaf.rise;
    for (let r = 0; r < R; r++) {
      for (let q = 0; q <= (r < R - 1 ? between : 0); q++) zs.add(z0 + (leaf.height * (r + q / (between + 1))) / (R - 1));
    }
  }
  // Each solid's triangles by band of z, a sheet's row apart (a sheet's triangles each lie
  // within a row): a plane cuts only those of its band.
  const BAND = scene.model.height / (R - 1);
  const bands = parts.map((p) => {
    const m = new Map();
    for (let t = 0; t < p.tris.length; t += 12) {
      const z0 = Math.min(p.tris[t + 2], p.tris[t + 6], p.tris[t + 10]);
      const z1 = Math.max(p.tris[t + 2], p.tris[t + 6], p.tris[t + 10]);
      for (let b = Math.floor(z0 / BAND); b <= Math.floor(z1 / BAND); b++) {
        if (!m.has(b)) m.set(b, []);
        m.get(b).push(t);
      }
    }
    return m;
  });
  const owners = parts.map((p) => (p.kind === "sheet" ? `sheet ${p.leaf}` : p.kind));
  // (The coil has a check of its own, coilClearance: a wire's loop lies at one z, which a
  // slice finds only if it lies in the wire.)
  // Neighbours in a stack swung over together overlap by design (their fill over 1, so no
  // window opens between them: STACK_FILL in viewer/layout.js); any other pair counts.
  const leafOf = (name) => (name.startsWith("sheet ") ? scene.leaves[Number(name.slice(6))] : null);
  const stacked = (a, b) => {
    const la = leafOf(a), lb = leafOf(b);
    return !!la && !!lb && Math.abs(la.i - lb.i) === 1 && la.group != null && la.group === lb.group && la.fill > 1 && lb.fill > 1;
  };
  const wanted = (a, b) => (a.startsWith("sheet") || b.startsWith("sheet")) && a !== "coil" && b !== "coil"
    && (!moved || moved.has(a) || moved.has(b)) && !stacked(a, b);
  const faults = new Map();
  for (const z of [...zs].sort((a, b) => a - b)) {
    const segs = parts.map((p, k) => {
      const out = [];
      // (A spiral's pages each as far up as they hang on the wire, their holes with them.)
      const holes = p.kind === "sheet" ? holesAt(scene, z - scene.leaves[p.leaf].rise) : [];
      slice(p.tris, z, holes, bands[k].get(Math.floor(z / BAND)) ?? [], out);
      return out;
    });
    for (const [a, b, x, y] of crossingsAmong(segs, owners, wanted)) {
      // A spine's part crossing a sheet within a millimetre of the sheet's root: the joint
      // (a case's covering over a board's spine edge, a fold's U at its sheet's root).
      const sheet = owners[a].startsWith("sheet") ? parts[a] : parts[b];
      const other = sheet === parts[a] ? owners[b] : owners[a];
      const prof = scene.leaves[sheet.leaf]?.profile;
      const fromRoot = prof ? Math.hypot(x - prof.x[0], y - prof.y[0]) : Infinity;
      const kind = other === "spine" && fromRoot < 1 ? "joint" : "crossing";
      const key = `${owners[a]} × ${owners[b]} ${kind}`;
      if (!faults.has(key)) faults.set(key, { a: owners[a], b: owners[b], kind, x, y, z, planes: 0, fromRoot });
      faults.get(key).planes++;
    }
  }
  return [...faults.values()];
}

// --- the coil ----------------------------------------------------------------------------------

/** How far into a punched hole (mm) a point of the page is (s, z: the page's own mm, from its middle): > 0 inside. */
function intoHole(scene, sPage, zBlock) {
  const st = scene.model.style;
  const h = scene.model.height;
  const pitch = st.pitch ?? 8;
  const loops = Math.floor((h - 6) / pitch);
  const margin = (h - loops * pitch) / 2;
  const r = st.holeRadius ?? 2.5;
  const z = zBlock + h / 2;
  const k = Math.max(0, Math.min(loops - 1, Math.floor((z - margin) / pitch)));
  const px = sPage - HOLE_OFFSET_MM;
  const pz = z - (margin + (k + 0.5) * pitch);
  if (st.squareHoles) {
    // As HOLE_DISCARD: a square of half-width r, corners rounded 0.4 mm.
    const qx = Math.abs(px) - (r - 0.4), qz = Math.abs(pz) - (r - 0.4);
    return -(Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - 0.4);
  }
  return r - Math.hypot(px, pz);
}

/** The nearest point of a triangle to p, and its barycentric weights. */
function nearestOnTriangle(p, a, b, c) {
  // Ericson, Real-Time Collision Detection, 5.1.5.
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return [1, 0, 0];
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return [0, 1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return [1 - v, v, 0]; }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return [0, 0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return [1 - w, 0, w]; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return [0, 1 - w, w]; }
  const den = 1 / (va + vb + vc);
  const v = vb * den, w = vc * den;
  return [1 - v - w, v, w];
}

/**
 * The coil's wire against the paper: along its centreline, the clearance (mm) between the
 * wire's surface and the nearest paper, the punched holes cut out of the paper (where the
 * nearest point of the uncut sheet lies in a hole, the paper's nearest is the hole's edge:
 * as far again as that point is inside it). Per sheet, the least clearance and where; a
 * negative clearance is the wire inside the paper. Null without a coil.
 * @param {ReturnType<typeof readSheets>} sheets
 */
export function coilClearance(scene, sheets, { samples = 4000 } = {}) {
  const path = coilPoints(scene, samples);
  if (!path) return null;
  const wire = scene.model.wireRadius;
  const reach = wire + 1; // paper farther than this from the centreline is no concern
  const cell = 2;
  const keyOf = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  // The sheets' triangles near the wire, binned.
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let k = 0; k < path.length; k += 3) {
    for (let d = 0; d < 3; d++) {
      box[d] = Math.min(box[d], path[k + d] - reach);
      box[d + 3] = Math.max(box[d + 3], path[k + d] + reach);
    }
  }
  const grid = new Map();
  const tris = [];
  for (const { i, verts } of sheets) {
    const leaf = scene.leaves[i];
    const index = leaf.geo.index.array;
    const place = leaf.geo.attributes.position.array;
    for (let t = 0; t < index.length; t += 3) {
      const v = [index[t], index[t + 1], index[t + 2]];
      const pts = v.map((w) => [verts[3 * w], verts[3 * w + 1], verts[3 * w + 2]]);
      const lo = [0, 1, 2].map((d) => Math.min(pts[0][d], pts[1][d], pts[2][d]));
      const hi = [0, 1, 2].map((d) => Math.max(pts[0][d], pts[1][d], pts[2][d]));
      if (hi[0] < box[0] || lo[0] > box[3] || hi[1] < box[1] || lo[1] > box[4] || hi[2] < box[2] || lo[2] > box[5]) continue;
      const id = tris.length;
      tris.push({ leaf: i, pts, s: v.map((w) => leaf.uStart + leaf.s[Math.round(place[3 * w])]) });
      for (let x = Math.floor(lo[0] / cell); x <= Math.floor(hi[0] / cell); x++) {
        for (let y = Math.floor(lo[1] / cell); y <= Math.floor(hi[1] / cell); y++) {
          for (let z = Math.floor(lo[2] / cell); z <= Math.floor(hi[2] / cell); z++) {
            const key = `${x},${y},${z}`;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(id);
          }
        }
      }
    }
  }
  /** @type {Map<number, {leaf: number, clearance: number, x: number, y: number, z: number, inHole: boolean}>} */
  const worst = new Map();
  for (let k = 0; k < path.length; k += 3) {
    const p = [path[k], path[k + 1], path[k + 2]];
    const seen = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = grid.get(keyOf(p[0] + dx * cell, p[1] + dy * cell, p[2] + dz * cell));
          if (!list) continue;
          for (const id of list) {
            if (seen.has(id)) continue;
            seen.add(id);
            const t = tris[id];
            const [wa, wb, wc] = nearestOnTriangle(p, ...t.pts);
            const q = [0, 1, 2].map((d) => wa * t.pts[0][d] + wb * t.pts[1][d] + wc * t.pts[2][d]);
            const dist = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
            if (dist > reach) continue;
            const sPage = wa * t.s[0] + wb * t.s[1] + wc * t.s[2];
            const inside = intoHole(scene, sPage, q[2] - scene.leaves[t.leaf].rise);
            // The paper's nearest: this point, or (inside a hole) the hole's edge beyond it.
            const paper = inside > 0 ? Math.hypot(dist, inside) : dist;
            const clearance = paper - wire;
            const had = worst.get(t.leaf);
            if (!had || clearance < had.clearance) worst.set(t.leaf, { leaf: t.leaf, clearance, x: p[0], y: p[1], z: p[2], inHole: inside > 0 });
          }
        }
      }
    }
  }
  return [...worst.values()].sort((a, b) => a.clearance - b.clearance);
}

// --- stretch ---------------------------------------------------------------------------------

/**
 * How far each sheet's drawn faces are from the paper's size: the largest relative difference
 * between a face's edge and the paper it stands for (along the page: the cross-section's
 * spacing; head to foot: the row spacing). Per leaf, and the worst.
 */
export function stretch(scene, sheets) {
  const R = LEAF_ROWS;
  let worst = { leaf: -1, value: 0 };
  for (const { i, verts } of sheets) {
    const leaf = scene.leaves[i];
    const n = leaf.s.length;
    const dz = leaf.height / (R - 1);
    let most = 0;
    for (const base of [0, n * R]) {
      for (let k = 0; k < n; k++) {
        for (let r = 0; r < R; r++) {
          const v = base + k * R + r;
          const at = (w) => [verts[3 * w], verts[3 * w + 1], verts[3 * w + 2]];
          const p = at(v);
          if (k < n - 1) {
            const q = at(v + R);
            const want = leaf.s[k + 1] - leaf.s[k];
            if (want > 1e-6) most = Math.max(most, Math.abs(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / want - 1));
          }
          if (r < R - 1) {
            const q = at(v + 1);
            most = Math.max(most, Math.abs(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / dz - 1));
          }
        }
      }
    }
    if (most > worst.value) worst = { leaf: i, value: most };
  }
  return worst;
}

// --- motion ----------------------------------------------------------------------------------

/**
 * A recorder of motion, frame by frame: per part (each sheet, the coil, the spine), the most any
 * of its vertices changed its motion at a frame (the second difference of its places: the
 * frame's step against the one before; mm), and the jumps: a frame where that is more than
 * `factor` times the most at the frames either side, and over `floor` mm. Smooth motion, however
 * fast, changes its steps evenly (a fore-edge sweeping 15 mm a frame changes by a millimetre or
 * so); a snap, a flip, a part that "spazzes" changes them at once, at a frame or two. (Steps
 * alone hid a board's root snapping 5 mm while its fore-edge swept 15: the author's report.)
 */
export function motionRecorder({ factor = 4, floor = 1 } = {}) {
  /** @type {Map<string, Float32Array>[]} the last two frames' places */
  let recent = [];
  /** @type {Map<string, number[]>} per part, per frame: the most change of motion (NaN: unknown) */
  const changes = new Map();
  const frames = [];
  return {
    /** A frame's places: name -> flat xyz (the same count each frame; another count starts afresh). */
    add(frame, places) {
      const [a, b] = recent; // two and one frames ago
      for (const [name, xyz] of places) {
        const p1 = b?.get(name), p0 = a?.get(name);
        if (!changes.has(name)) changes.set(name, frames.map(() => NaN));
        // The change at the frame before this one (it needs this one's place).
        let most = NaN;
        if (p0 && p1 && p0.length === xyz.length && p1.length === xyz.length) {
          most = 0;
          for (let v = 0; v < xyz.length; v += 3) {
            const dx = xyz[v] - 2 * p1[v] + p0[v];
            const dy = xyz[v + 1] - 2 * p1[v + 1] + p0[v + 1];
            const dz = xyz[v + 2] - 2 * p1[v + 2] + p0[v + 2];
            most = Math.max(most, Math.hypot(dx, dy, dz));
          }
        }
        const list = changes.get(name);
        if (list.length) list[list.length - 1] = most;
        list.push(NaN);
      }
      recent = [b, places];
      frames.push(frame);
    },
    jumps() {
      const out = [];
      const median = (xs) => {
        const v = xs.filter((x) => !Number.isNaN(x)).sort((x, y) => x - y);
        return v.length ? v[v.length >> 1] : 0;
      };
      for (const [name, c] of changes) {
        for (let t = 0; t < c.length; t++) {
          if (Number.isNaN(c[t]) || c[t] <= floor) continue;
          if (!(c[t] >= (c[t - 1] ?? 0) && c[t] >= (c[t + 1] ?? 0))) continue; // the peak of a snap
          // The motion's own changes round it, the snap's frames either side left out.
          const around = median([...c.slice(Math.max(0, t - 6), Math.max(0, t - 1)), ...c.slice(t + 2, t + 7)]);
          if (c[t] > factor * around) out.push({ part: name, frame: frames[t], moved: c[t], around });
        }
      }
      return out;
    },
  };
}

/** The coil's centreline (its tube's path, sampled), in the block's space, or null. */
export function coilPoints(scene, samples = 600) {
  const coil = scene.extras?.coil;
  if (!coil) return null;
  scene.block.updateMatrixWorld(true);
  const toBlock = new THREE.Matrix4().copy(scene.block.matrixWorld).invert();
  const out = [];
  coil.traverse((o) => {
    const path = /** @type {any} */ (o).geometry?.parameters?.path;
    if (!path) return;
    const m = new THREE.Matrix4().copy(toBlock).multiply(o.matrixWorld);
    for (let k = 0; k <= samples; k++) {
      const p = path.getPointAt(k / samples).applyMatrix4(m);
      out.push(p.x, p.y, p.z);
    }
  });
  return Float32Array.from(out);
}

// --- everything at once ----------------------------------------------------------------------

/**
 * Every check on the book as it is drawn now (the scene laid out): the crossings, the worst
 * stretch, and the readback's own error (it must be tiny for the rest to mean anything).
 */
export function checkNow(scene, { between = 3 } = {}) {
  const sheets = readSheets(scene);
  return {
    sheets,
    readback: readbackError(scene, sheets),
    crossings: crossings(scene, solids(scene, sheets), { between }),
    coil: coilClearance(scene, sheets),
    stretch: stretch(scene, sheets),
  };
}

// --- sequences -------------------------------------------------------------------------------

/** A seeded random number generator (mulberry32): the same sequence for the same seed. */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A sequence of what a reader does, at random: turns (next, back, far), closing and opening,
 * each at a time (ms from the start), some in quick succession. Plain data: it can be cut
 * down and replayed.
 * @returns {{at: number, act: "go" | "close" | "open", to?: number, side?: number}[]}
 */
export function randomSequence(seed, leafCount, { actions = 8, span = 2500 } = {}) {
  const rnd = random(seed);
  const out = [];
  let at = 0;
  let opening = 0;
  for (let k = 0; k < actions; k++) {
    at += rnd() < 0.5 ? 40 + rnd() * 160 : 200 + rnd() * (span / actions);
    const roll = rnd();
    if (roll < 0.55) {
      opening = Math.max(0, Math.min(leafCount, opening + (rnd() < 0.7 ? 1 : -1)));
      out.push({ at: Math.round(at), act: "go", to: opening });
    } else if (roll < 0.75) {
      opening = Math.floor(rnd() * (leafCount + 1));
      out.push({ at: Math.round(at), act: "go", to: opening });
    } else if (roll < 0.9) {
      out.push({ at: Math.round(at), act: "close", side: rnd() < 0.5 ? 1 : -1 });
    } else {
      out.push({ at: Math.round(at), act: "open" });
    }
  }
  return out;
}

/**
 * Run a sequence on the scene's clock, frame by frame (`fps`), checking every frame: the
 * crossings (every `every`-th frame, they cost the most) and the jumps. Stops at the first
 * frame with a fault if `stopAtFault`. The scene starts at rest at `start` (an opening).
 * @returns {{faults: {frame: number, ms: number, kind: string, detail: any}[], frames: number}}
 */
export function runSequence(scene, sequence, { start = 0, fps = 60, tail = 1200, every = 1, stopAtFault = true, between = 1 } = {}) {
  const t0 = 1e6;
  scene.clock = t0;
  scene.goTo(start, { animate: false });
  scene.setClosed(false, { animate: false });
  scene.debugStep();
  const end = (sequence.length ? sequence[sequence.length - 1].at : 0) + tail;
  const motion = motionRecorder();
  const faults = [];
  let next = 0;
  let frame = 0;
  /** @type {Map<string, Float32Array> | null} the places at the last frame checked */
  let checked = null;
  for (let ms = 0; ms <= end; ms += 1000 / fps, frame++) {
    while (next < sequence.length && sequence[next].at <= ms) {
      const a = sequence[next++];
      scene.clock = t0 + a.at;
      if (a.act === "go") scene.goTo(a.to);
      else if (a.act === "close") scene.setClosed(true, { side: a.side });
      else scene.open();
    }
    scene.clock = t0 + ms;
    scene.debugStep();
    const sheets = readSheets(scene);
    const places = new Map(sheets.map(({ i, verts }) => [`sheet ${i}`, verts]));
    const coil = coilPoints(scene, 200);
    if (coil) places.set("coil", coil);
    motion.add(frame, places);
    if (frame % every === 0) {
      // What moved since the last frame checked; the spine's parts (folds, a case) are laid
      // out with the sheets: moved whenever any did.
      const moved = new Set();
      for (const [name, xyz] of places) {
        const was = checked?.get(name);
        if (!was || was.length !== xyz.length || xyz.some((v, k) => Math.abs(v - was[k]) > 1e-6)) moved.add(name);
      }
      if (moved.size) moved.add("spine");
      checked = places;
      for (const c of crossings(scene, solids(scene, sheets), { between, moved })) {
        if (c.kind === "crossing") faults.push({ frame, ms, kind: "crossing", detail: c });
      }
      for (const c of coilClearance(scene, sheets, { samples: 1500 }) ?? []) {
        if (c.clearance < -COIL_TOLERANCE) faults.push({ frame, ms, kind: "coil", detail: c });
      }
    }
    if (stopAtFault && faults.length) break;
  }
  for (const j of motion.jumps()) faults.push({ frame: j.frame, ms: (j.frame * 1000) / fps, kind: "jump", detail: j });
  return { faults, frames: frame };
}

/**
 * A failing sequence cut down: actions dropped one at a time while it still fails (the same
 * kind of fault), until none can go. Returns the shortest found.
 */
export function shrink(scene, sequence, options = {}) {
  const fails = (seq) => runSequence(scene, seq, options).faults.length > 0;
  let current = sequence.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let k = 0; k < current.length; k++) {
      const shorter = current.filter((_, j) => j !== k);
      if (fails(shorter)) {
        current = shorter;
        changed = true;
        break;
      }
    }
  }
  return current;
}

// --- views reported by the author ------------------------------------------------------------

/**
 * Put a scene into the state a view report holds (the app's Ctrl/Cmd+Shift+G, see
 * ui/report.js; its `scene`: BookScene.snapshot): the book as built, the paper, the camera, and every sheet's motion at that
 * moment, on the scene's clock. Draws nothing.
 */
export function restoreView(scene, report) {
  const s = report.scene;
  scene.setBook(s.book);
  scene.setPaper(s.paper);
  if (s.preset) scene.setPreset(s.preset);
  scene.turnMs = s.turnMs ?? scene.turnMs;
  scene.closeMs = s.closeMs ?? scene.closeMs;
  scene.clock = 1e6;
  scene.goTo(s.opening, { animate: false });
  scene.setClosed(s.closed === 1, { animate: false, side: s.closedSide });
  Object.assign(scene, { closed: s.closed, closedSide: s.closedSide, coverShift: s.coverShift, pageFrame: s.pageFrame, coverFrame: s.coverFrame, focus: s.focus });
  scene.closeAnim = s.closeAnim ? { ...s.closeAnim, start: scene.clock + s.closeAnim.start } : null;
  s.leaves.forEach((l, i) => {
    const leaf = scene.leaves[i];
    if (!leaf) return;
    Object.assign(leaf, { ...l, start: l.start == null ? null : scene.clock + l.start });
  });
  scene.lastFrameTime = scene.clock;
  Object.assign(scene.rig, s.rig);
  scene.zoomBias = s.zoomBias;
  scene.geometryDirty = true;
  scene.debugStep();
}
