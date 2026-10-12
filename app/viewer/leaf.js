// A leaf (one sheet: two pages) in 3D: its mesh, whose vertices the GPU places from the
// sheet's cross-sections (see SHEET_VERTEX), its materials, the sheets texture they are
// read from, and picking (a click, a zoom's aim) against it.

import * as THREE from "three";
import { HOLE_OFFSET_MM, leafShape } from "./model.js";
import {
  FINISH_FRAGMENT, FINISH_HIGHLIGHT, FINISH_REFLECTION, HOLE_DISCARD, LEAF_FILL, LEAF_ROWS, MAX_DETAIL, MID_ROW,
  OTHER_ROWS, PAGE_FRAGMENT_HEADER, PAGE_MAP_FRAGMENT, PAPER_ROLLOFF, patchShader, sheetShader, SHOW_THROUGH,
} from "./shaders.js";

/** The first and last leaves are the covers (a single leaf is both). */
export function isCover(model, i) {
  return i === 0 || i === model.leafCount - 1;
}

export function makeLeaf(scene, i) {
  const size = leafShape(scene.model, i);
  const n = size.s.length;
  const R = LEAF_ROWS;
  const geo = new THREE.BufferGeometry();
  // Front and back: n × R grids (along the page × head to foot); head and foot edges;
  // fore-edge and spine-end faces (R rows each). The GPU builds them from the sheet's
  // cross-sections (see SHEET_VERTEX): a vertex holds only its place on the sheet (point,
  // row, code), code = side (0 front, 1 back) + 2 × part (0 face, 1 head, 2 foot,
  // 3 fore-edge, 4 spine end) + 16 × the sheet's index. (Built on the CPU, every sheet
  // that moved was rewritten and sent to the GPU each frame, with its normals: most of a
  // frame's time when a whole pile moves, and 180 kB a sheet.)
  const vCount = 2 * n * R + 4 * n + 4 * R;
  const place = new Float32Array(vCount * 3);
  const put = (v, k, r, side, part) => place.set([k, r, side + 2 * part + 16 * i], 3 * v);
  const F = 0;
  const B = n * R;
  const HE = 2 * n * R;
  const FE = HE + 2 * n;
  const FORE = FE + 2 * n;
  const ROOT = FORE + 2 * R;
  for (let k = 0; k < n; k++) {
    for (let r = 0; r < R; r++) {
      put(F + k * R + r, k, r, 0, 0);
      put(B + k * R + r, k, r, 1, 0);
    }
    for (const side of [0, 1]) {
      put(HE + 2 * k + side, k, 0, side, 1);
      put(FE + 2 * k + side, k, R - 1, side, 2);
    }
  }
  for (let r = 0; r < R; r++) {
    for (const side of [0, 1]) {
      put(FORE + 2 * r + side, n - 1, r, side, 3);
      put(ROOT + 2 * r + side, 0, r, side, 4);
    }
  }
  geo.setAttribute("position", new THREE.BufferAttribute(place, 3));
  // Its bounds are only the drawn sheet's (never culled; three sorts by them, then by the
  // draw order set per sheet): not of these places.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  const uv = new Float32Array(vCount * 2);
  const w = scene.model.width;
  const h = scene.model.height;
  for (let k = 0; k < n; k++) {
    const u = (size.uStart + size.s[k]) / w;
    for (let r = 0; r < R; r++) {
      // v = 0 at the head: page images are ImageBitmaps, uploaded without flipping.
      const v = (size.height * (r / (R - 1)) - (size.height - h) / 2) / h;
      uv.set([u, v], (k * R + r) * 2); // front
      uv.set([1 - u, v], (n * R + k * R + r) * 2); // back, mirrored to read from its side
    }
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));

  const idx = [];
  for (let k = 0; k < n - 1; k++) {
    for (let r = 0; r < R - 1; r++) {
      const p = F + k * R + r;
      idx.push(p, p + 1, p + R, p + R, p + 1, p + R + 1);
    }
  }
  for (let k = 0; k < n - 1; k++) {
    for (let r = 0; r < R - 1; r++) {
      const p = B + k * R + r;
      idx.push(p, p + R, p + 1, p + R, p + R + 1, p + 1);
    }
  }
  const edgesStart = idx.length;
  for (const base of [HE, FE]) {
    for (let k = 0; k < n - 1; k++) {
      const a = base + 2 * k;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
  }
  for (let r = 0; r < R - 1; r++) {
    const f0 = FORE + 2 * r;
    idx.push(f0, f0 + 2, f0 + 1, f0 + 1, f0 + 2, f0 + 3);
    const g0 = ROOT + 2 * r;
    idx.push(g0, g0 + 1, g0 + 2, g0 + 1, g0 + 3, g0 + 2);
  }
  geo.setIndex(idx);
  const faceCount = 6 * (n - 1) * (R - 1);
  const front = pageMaterial(scene, true);
  const back = pageMaterial(scene, false);
  const board = size.width !== scene.model.width; // a hardcover's board: its edges are covered too
  const edges = scene.sheetEdges.get(board ? (i === 0 ? scene.frontWrapMat : scene.backWrapMat) : isCover(scene.model, i) ? scene.coverEdgeMat : scene.edgeMat);
  const materials = [front, back, edges];
  const style = scene.model.style;
  if (style.spine === "coil") {
    // The punched holes only in the strip along the spine that has them (see pageMaterial).
    const reach = HOLE_OFFSET_MM + (style.holeRadius ?? 2.5) + 1;
    const kh = Math.min(n - 1, Math.max(1, size.s.findIndex((sv) => sv >= reach)));
    const strip = 6 * kh * (R - 1);
    materials.push(pageMaterial(scene, true, front), pageMaterial(scene, false, back));
    geo.addGroup(0, strip, 3);
    geo.addGroup(strip, faceCount - strip, 0);
    geo.addGroup(faceCount, strip, 4);
    geo.addGroup(faceCount + strip, faceCount - strip, 1);
  } else {
    geo.addGroup(0, faceCount, 0);
    geo.addGroup(faceCount, faceCount, 1);
  }
  geo.addGroup(edgesStart, idx.length - edgesStart, 2);
  const mesh = new THREE.Mesh(geo, materials);
  mesh.onBeforeRender = (renderer, scene, camera, geometry, material) => {
    const base = material.userData.twinOf;
    if (base) twin(material, base);
  };
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.customDepthMaterial = scene.sheetDepth;
  scene.block.add(mesh);
  // On Apple's GPUs, the faces' depth alone, drawn for every sheet before any is shaded:
  // then only the face in front is shaded at each point. (There, every shader drawing with
  // multisampling also writes which samples it covers: Chromium's ANGLE works so over
  // Metal. The GPU then can't skip hidden points before shading them: an open book's piles
  // were shaded sheet by sheet, half the frame at full resolution. Elsewhere, drawn
  // nearest first, hidden points are skipped anyway, and the extra pass only costs: 1-2 ms
  // a frame at 4K on an RTX 4060.)
  const first = new THREE.Mesh(geo, [firstMaterial(scene, true), firstMaterial(scene, false), scene.noDraw, ...scene.holesFirst]);
  first.frustumCulled = false;
  first.visible = scene.depthPass;
  first.raycast = () => {};
  mesh.add(first);
  const profile = { x: new Float32Array(n), y: new Float32Array(n), phi: new Float32Array(n) };
  // Paper never lines up perfectly: each leaf a fixed hair off at the fore-edge and along
  // the spine (tenths of a millimetre).
  const jitter = { fore: (hash(i * 2 + 1) - 0.5) * 0.16, along: (hash(i * 2 + 2) - 0.5) * 0.1 };
  const leaf = { i, mesh, first, geo, front, back, profile, jitter, bows: new Float32Array(LEAF_ROWS), board, ...size, theta: 90, from: 90, to: 90, start: null, duration: scene.turnMs, curl: 0, curlFrom: 0, pick: null, stale: true };
  // Picking (a click, a zoom's aim) needs the sheet where the GPU draws it: written on the
  // CPU only when a ray could meet it, into a mesh never drawn.
  leaf.pick = new THREE.Mesh(new THREE.BufferGeometry(), materials);
  leaf.pick.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vCount * 3), 3));
  leaf.pick.geometry.setIndex(geo.index);
  leaf.pick.geometry.groups = geo.groups;
  leaf.stale = true;
  mesh.raycast = (raycaster, hits) => {
    if (leaf.stale) {
      const near = sheetBounds(leaf, scene.model.thickness[i]).applyMatrix4(mesh.matrixWorld);
      if (!raycaster.ray.intersectsSphere(near)) return;
      writeLeafGeometry(leaf, leaf.pick.geometry, scene.model.thickness[i]);
      leaf.stale = false;
    }
    leaf.pick.matrixWorld.copy(mesh.matrixWorld);
    const from = hits.length;
    leaf.pick.raycast(raycaster, hits);
    for (let k = from; k < hits.length; k++) hits[k].object = mesh;
  };
  return leaf;
}

/**
 * The texture the GPU builds the sheets from (see SHEET_VERTEX, packSheet): per column of
 * sheets, first two rows each (settings, middle cross-section), then the other rows of
 * corner-led turns, eight each. A book closing or opening moves every sheet with only its
 * middle row: one upload of the first part. Columns side by side only past the largest
 * texture's height (a 16384-texel texture holds 1600 sheets per column).
 */
export function makeSheets(scene) {
  const count = scene.leaves.length;
  const blockW = Math.max(4, ...scene.leaves.map((l) => l.s.length));
  const perColumn = Math.max(1, Math.floor(scene.renderer.capabilities.maxTextureSize / (LEAF_ROWS + 1)));
  const columns = Math.ceil(count / perColumn);
  const rows = Math.min(count, perColumn);
  const width = columns * blockW;
  const height = rows * (LEAF_ROWS + 1);
  const data = new Float32Array(width * height * 4);
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  tex.needsUpdate = true;
  scene.sheets = { tex, data, width, blockW, perColumn, extra: 2 * rows };
  scene.shared.uSheets.value = tex;
  scene.shared.uSheetLayout.value.set(blockW, perColumn, 2 * rows);
}

/**
 * Send the sheets whose shape changed to the GPU: runs of neighbours together. Straight to
 * WebGL through three's own record of what is bound (three's copyTextureToTexture asks the
 * GPU for its upload settings first, five round trips each time: 2 ms a frame).
 */
export function uploadSheets(scene, changed) {
  const S = scene.sheets;
  if (!changed.length || !S) return;
  if (!S.uploaded) {
    scene.renderer.initTexture(S.tex); // the first time, whole
    S.uploaded = true;
    return;
  }
  const gl = scene.renderer.getContext();
  // three's own handle on the texture (not public: a three.js upgrade may rename it)
  const handle = scene.renderer.properties.get(S.tex).__webglTexture;
  if (!handle) throw new Error("three.js changed: no __webglTexture for the sheets");
  scene.renderer.state.bindTexture(gl.TEXTURE_2D, handle);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, S.width);
  const send = (x, y, w, h) => gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.FLOAT, S.data, 4 * (y * S.width + x));
  let run = null;
  const flush = () => {
    if (run) send(run.column * S.blockW, 2 * run.from, S.blockW, 2 * (run.to - run.from + 1));
    run = null;
  };
  for (const leaf of changed) {
    const column = Math.floor(leaf.i / S.perColumn);
    const j = leaf.i - column * S.perColumn;
    if (run && run.column === column && run.to === j - 1) run.to = j;
    else {
      flush();
      run = { column, from: j, to: j };
    }
    if (leaf.rowsActive) send(column * S.blockW, S.extra + OTHER_ROWS.length * j, leaf.s.length, OTHER_ROWS.length);
  }
  flush();
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); // as three expects it
}

/**
 * A page's material. `holesOf`: the same page's material, for a twin that also punches a
 * coil's holes: it shares that one's uniforms and takes its settings before every draw
 * (see makeLeaf). Only the strip along the spine uses it: a shader that can discard
 * fragments keeps the GPU from skipping the ones hidden under sheets above, and a pile
 * shaded sheet by sheet costs several times as much.
 */
function pageMaterial(scene, isFront, holesOf = null) {
  const m = new THREE.MeshPhysicalMaterial({
    map: scene.white,
    bumpMap: scene.grain,
    bumpScale: 0.3,
    roughness: 0.92,
    specularIntensity: 0.2,
    clearcoat: 0.001,
    clearcoatRoughness: 0.3,
    depthWrite: !scene.depthPass, // else already drawn (see makeLeaf)
  });
  m.userData.uniforms = holesOf?.userData.uniforms ?? {
    uBack: { value: scene.white },
    uShow: { value: 0.01 },
    uSpineAtU0: { value: isFront ? 1 : 0 },
    // Up to MAX_DETAIL sharp strips laid over the page (see detail.js).
    ...Object.fromEntries(Array.from({ length: MAX_DETAIL }, (_, i) => [
      [`uDetail${i}`, { value: scene.white }],
      [`uDetailRect${i}`, { value: new THREE.Vector4(0, 0, 0, 0) }],
    ]).flat()),
    uDetailCount: { value: 0 },
    uOuterCover: { value: 0 }, // 1 on the outside of the covers: no gutter shade there
    uFinish: { value: scene.none }, // spot finish mask (any ink = finished), see setFinish
    uFinishKind: { value: 0 },
    uVecF: { value: scene.vector.noF }, // vector text, see #setVector
    uVecU: { value: scene.vector.noU },
    uVecInfo: { value: [0, 1, 1, 0] },
    uVecOn: { value: 0 },
    uSmall: { value: scene.white }, // the page with its text, small (see #setSmall)
    uSmallOn: { value: 0 },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, m.userData.uniforms, scene.shared);
    sheetShader(shader, scene.shared);
    shader.fragmentShader = patchShader(shader.fragmentShader, [
      ["void main() {", PAGE_FRAGMENT_HEADER + "void main() {\n" + (holesOf ? HOLE_DISCARD : "")],
      ["#include <map_fragment>", PAGE_MAP_FRAGMENT + SHOW_THROUGH],
      ["#include <lights_physical_fragment>", (line) => line + "\n" + FINISH_FRAGMENT],
      ["vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;", (line) => line + PAPER_ROLLOFF],
      ["#include <lights_fragment_maps>", (line) => line + "\n" + FINISH_REFLECTION],
      ["#include <opaque_fragment>", (line) => FINISH_HIGHLIGHT + line],
    ]);
  };
  m.customProgramCacheKey = () => (holesOf ? "bookview-page-holes" : "bookview-page");
  if (holesOf) m.userData.twinOf = holesOf;
  return m;
}

/** A sheet face's depth alone (see makeLeaf); `holes`: a coil's, punched as on the page. */
export function firstMaterial(scene, isFront, holes = false) {
  const m = new THREE.MeshDepthMaterial({ colorWrite: false, map: holes ? scene.white : null });
  m.onBeforeCompile = (shader) => {
    sheetShader(shader, scene.shared);
    if (!holes) return;
    Object.assign(shader.uniforms, { uHoles: scene.shared.uHoles, uPageSize: scene.shared.uPageSize, uSpineAtU0: { value: isFront ? 1 : 0 } });
    shader.fragmentShader = patchShader(shader.fragmentShader, [
      ["void main() {", `uniform vec4 uHoles;
uniform vec2 uPageSize;
uniform float uSpineAtU0;
void main() {
${HOLE_DISCARD}`],
      ["#include <map_fragment>", ""],
    ]);
  };
  m.customProgramCacheKey = () => (holes ? "bookview-first-holes" : "bookview-first");
  return m;
}

/**
 * Where a ray (in the leaf's own space) meets one side of a leaf, as texture uv, or null:
 * the nearest crossing of its cross-section curve (the profile, swept from head to foot)
 * seen from that side (either side: null), between `near` and `far` along the ray. The
 * bow and the paper's thickness are left out (a millimetre at most, at the corners).
 */
export function pageHit(model, leaf, ray, front, near = 0, far = Infinity) {
  const { x, y, phi } = leaf.profile;
  const s = leaf.s;
  const o = ray.origin;
  const d = ray.direction;
  const dl = Math.hypot(d.x, d.y);
  if (dl < 1e-9) return null; // straight along the spine
  let best = far;
  let hit = null;
  for (let k = 0; k < s.length - 1; k++) {
    // o + d t = P_k + (P_k+1 - P_k) a, in the cross-section plane.
    const ex = x[k + 1] - x[k];
    const ey = y[k + 1] - y[k];
    const den = d.x * ey - d.y * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = x[k] - o.x;
    const wy = y[k] - o.y;
    const t = (wx * ey - wy * ex) / den;
    const a = (wx * d.y - wy * d.x) / den;
    if (t <= near || t >= best || a < 0 || a > 1) continue;
    // Seen from the front: the ray runs against the front's normal (-cos φ, sin φ).
    const f = phi[k] + (phi[k + 1] - phi[k]) * a;
    const facing = d.x * Math.cos(f) - d.y * Math.sin(f) > 0;
    if (front !== null && facing !== front) continue;
    const z = o.z + d.z * t;
    const v = (z - leaf.jitter.along + model.height / 2) / model.height;
    if (v < -0.05 || v > 1.05) continue;
    const u = (leaf.uStart + s[k] + (s[k + 1] - s[k]) * a) / model.width;
    best = t;
    hit = { x: front ? u : 1 - u, y: v };
  }
  return hit;
}

/** A page material's twin (see pageMaterial) takes the settings the page's material has now. */
function twin(m, base) {
  m.map = base.map;
  m.color.copy(base.color);
  m.roughness = base.roughness;
  m.specularIntensity = base.specularIntensity;
  m.clearcoat = base.clearcoat;
  m.clearcoatRoughness = base.clearcoatRoughness;
  m.bumpMap = base.bumpMap;
  m.bumpScale = base.bumpScale;
}

/**
 * Write a sheet into the sheets texture (layout: makeSheets): its settings (the bow of each
 * row; half its drawn thickness; where it starts along the spine and how tall it is; how far
 * its fore-edge sits out; whether its rows differ; its point count), its middle cross-
 * section, and while a corner leads, its other rows: per point x, y, angle, and how far it
 * is from the spine (straight across, over the sheet's width: the bow grows with it).
 */
export function packSheet(leaf, sheets, thickness) {
  const { data, width, blockW, perColumn, extra } = sheets;
  const column = Math.floor(leaf.i / perColumn);
  const j = leaf.i - column * perColumn;
  const x0 = column * blockW;
  const n = leaf.s.length;
  const o = 4 * (2 * j * width + x0);
  const b = leaf.bows;
  for (let r = 0; r < 8; r++) data[o + r] = b[r];
  data[o + 8] = b[8];
  data[o + 9] = (thickness * LEAF_FILL) / 2;
  data[o + 10] = -leaf.height / 2 + leaf.jitter.along;
  data[o + 11] = leaf.height;
  data[o + 12] = leaf.jitter.fore;
  data[o + 13] = leaf.rowsActive ? 1 : 0;
  data[o + 14] = n;
  const row = (p, y) => {
    let q = 4 * (y * width + x0);
    const ox = p.x[0];
    const oy = p.y[0];
    for (let k = 0; k < n; k++, q += 4) {
      const dx = p.x[k] - ox;
      const dy = p.y[k] - oy;
      data[q] = p.x[k];
      data[q + 1] = p.y[k];
      data[q + 2] = p.phi[k];
      data[q + 3] = Math.min(1, Math.sqrt(dx * dx + dy * dy) / leaf.width);
    }
  };
  row(leaf.rowsActive ? leaf.rows[MID_ROW] : leaf.profile, 2 * j + 1);
  if (leaf.rowsActive) OTHER_ROWS.forEach((r, k) => row(leaf.rows[r], extra + OTHER_ROWS.length * j + k));
}

/** A sphere round a sheet as it lies (its own coordinates), from its cross-sections alone. */
const _bounds = new THREE.Sphere();

function sheetBounds(leaf, thickness) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of leaf.rowsActive ? leaf.rows : [leaf.profile]) {
    for (let k = 0; k < p.x.length; k++) {
      x0 = Math.min(x0, p.x[k]); x1 = Math.max(x1, p.x[k]);
      y0 = Math.min(y0, p.y[k]); y1 = Math.max(y1, p.y[k]);
    }
  }
  const out = (thickness * LEAF_FILL) / 2 + Math.max(...leaf.bows.map(Math.abs)) + Math.abs(leaf.jitter.fore);
  _bounds.center.set((x0 + x1) / 2, (y0 + y1) / 2, leaf.jitter.along);
  _bounds.radius = Math.hypot(x1 - x0, y1 - y0, leaf.height) / 2 + out;
  return _bounds;
}

/**
 * Whether a leaf's shape (its cross-sections, row by row while a corner leads, and its bow)
 * differs from the one its mesh was last written with; remembers the new one if so. Exact:
 * any change at all rewrites it.
 */
export function shapeChanged(leaf) {
  const rows = leaf.rowsActive ? leaf.rows : [leaf.profile];
  const n = leaf.profile.x.length;
  const size = rows.length * n * 3 + leaf.bows.length;
  let w = leaf.written;
  let same = !!w && w.rowsActive === leaf.rowsActive && w.values.length === size;
  if (!w || w.values.length !== size) w = leaf.written = { rowsActive: leaf.rowsActive, values: new Float64Array(size) };
  const v = w.values;
  let o = 0;
  for (const p of rows) {
    for (const a of [p.x, p.y, p.phi]) {
      for (let k = 0; k < n; k++, o++) {
        if (v[o] !== a[k]) {
          same = false;
          v[o] = a[k];
        }
      }
    }
  }
  for (let k = 0; k < leaf.bows.length; k++, o++) {
    if (v[o] !== leaf.bows[k]) {
      same = false;
      v[o] = leaf.bows[k];
    }
  }
  w.rowsActive = leaf.rowsActive;
  return !same;
}

/**
 * Where a sheet's vertices are, as the GPU puts them (see SHEET_VERTEX), into `geo`: for
 * picking only (see makeLeaf).
 */
function writeLeafGeometry(leaf, geo, t) {
  const R = LEAF_ROWS;
  const { height, width } = leaf;
  const n = leaf.s.length;
  const pos = geo.attributes.position.array;
  // Each row its own cross-section while the leaf turns by a corner (see layoutRows).
  const rowOf = (r) => (leaf.rowsActive ? leaf.rows[r] : leaf.profile);
  const half = t * LEAF_FILL / 2;
  const z0 = -height / 2 + leaf.jitter.along;
  const set = (v, px, py, pz) => {
    pos[3 * v] = px;
    pos[3 * v + 1] = py;
    pos[3 * v + 2] = pz;
  };
  // Lift (mm, along the page's upward side): corners most, the middle of the fore-edge
  // less, nothing at the spine. `leaf.bows` (per row) are signed: + lifts the front, - the back.
  const F = 0;
  const B = n * R;
  const HE = 2 * n * R;
  const FE = HE + 2 * n;
  const FORE = FE + 2 * n;
  const ROOT = FORE + 2 * R;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; // for the bounding sphere
  for (let k = 0; k < n; k++) {
    // The fore-edge sits a hair out or in (paper never lines up perfectly).
    const ext = k === n - 1 ? leaf.jitter.fore : 0;
    // Per cross-section, worked out once (the rows share one unless a corner leads).
    let p = null, nx = 0, ny = 0, cx = 0, cy = 0, a = 0;
    for (let r = 0; r < R; r++) {
      if (rowOf(r) !== p) {
        p = rowOf(r);
        const sin = Math.sin(p.phi[k]);
        const cos = Math.cos(p.phi[k]);
        nx = -cos;
        ny = sin;
        cx = p.x[k] + sin * ext;
        cy = p.y[k] + cos * ext;
        a = Math.min(1, Math.hypot(p.x[k] - p.x[0], p.y[k] - p.y[0]) / width); // 0 at the spine, 1 at the fore-edge
      }
      const zz = (2 * r) / (R - 1) - 1;
      const z = z0 + (height * r) / (R - 1);
      const d = leaf.bows[r] * a * a * (0.4 + 0.6 * zz * zz);
      const fx = cx + nx * (half + d);
      const fy = cy + ny * (half + d);
      const bx = cx - nx * (half - d);
      const by = cy - ny * (half - d);
      x0 = Math.min(x0, fx, bx); x1 = Math.max(x1, fx, bx);
      y0 = Math.min(y0, fy, by); y1 = Math.max(y1, fy, by);
      set(F + k * R + r, fx, fy, z);
      set(B + k * R + r, bx, by, z);
      if (r === 0) {
        set(HE + 2 * k, fx, fy, z);
        set(HE + 2 * k + 1, bx, by, z);
      }
      if (r === R - 1) {
        set(FE + 2 * k, fx, fy, z);
        set(FE + 2 * k + 1, bx, by, z);
      }
      if (k === n - 1) {
        set(FORE + 2 * r, fx, fy, z);
        set(FORE + 2 * r + 1, bx, by, z);
      }
      if (k === 0) {
        set(ROOT + 2 * r, fx, fy, z);
        set(ROOT + 2 * r + 1, bx, by, z);
      }
    }
  }
  // Round the box of what was just written (a little larger than the tightest).
  const sphere = (geo.boundingSphere ??= new THREE.Sphere());
  sphere.center.set((x0 + x1) / 2, (y0 + y1) / 2, z0 + height / 2);
  sphere.radius = Math.hypot(x1 - x0, y1 - y0, height) / 2;
}

/** A fixed pseudo-random number in [0, 1) for an integer (the same every time). */
function hash(n) {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}
