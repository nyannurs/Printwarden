// Drawing a frame, beyond three's own: the shadow map only when what it shows changed, where
// shadow casters are near (for the soft shadows' search), and the sheets nearest first.

import * as THREE from "three";

import { occluderMaterial } from "./leaf.js";

/** The occluder (see makeOccluder) takes every this-many-th sheet, besides the piles' top sheets. */
export const OCCLUDER_EVERY = 8;

/**
 * Render the view into `target` (whose size it takes). `view`: the part of a larger
 * image this is (a screenshot tile), or null for all of it.
 */
export function renderView(scene, target, view) {
  const cam = scene.camera;
  if (view) cam.setViewOffset(view.W, view.H, view.x, view.y, view.w, view.h);
  cam.updateProjectionMatrix();
  scene.renderer.setRenderTarget(target);
  scene.renderer.clear();
  shadows(scene);
  drawOrder(scene);
  scene.renderer.render(scene.scene, cam);
}

/**
 * Redraw the shadow map only if what it shows changed: the book's layout, where it stands
 * or tilts, the key light, its shadow camera. Turning the camera alone leaves it as it is
 * (drawing it every frame cost a tenth of a frame on a fast graphics card, more on a
 * laptop's).
 */
export function shadows(scene) {
  const cam = scene.key.shadow.camera;
  const now = [scene.layoutVersion, ...scene.key.position.toArray(), ...scene.key.target.position.toArray(),
    ...scene.root.position.toArray(), scene.root.rotation.x, scene.root.rotation.y, scene.root.rotation.z,
    ...scene.block.position.toArray(), scene.block.rotation.x, scene.block.rotation.y, scene.block.rotation.z,
    cam.left, cam.right, cam.top, cam.bottom, cam.near, cam.far];
  const was = scene.shadowState;
  if (!was || was.length !== now.length || now.some((v, i) => v !== was[i])) {
    scene.shadowState = now;
    scene.renderer.shadowMap.needsUpdate = true;
  }
  // The nearest casters, once the shadow map has stood still for a frame (drawn, and not
  // about to be drawn again): while it changes every frame (a page turning) the soft shadows
  // search in full; while only the camera moves, they skip where nothing is near.
  const map = scene.key.shadow.map;
  const settled = !!map && !scene.renderer.shadowMap.needsUpdate;
  if (!settled) scene.casters.current = false;
  else if (!scene.casters.current) {
    nearestCasters(scene, map.texture);
    scene.casters.current = true;
  }
  scene.shared.uCasterMapOn.value = scene.casters.current ? 1 : 0;
}

/**
 * For the soft shadows' search (pvSoftShadow): the depth of the caster nearest the light
 * anywhere the search could look from each 8 × 8 block of the shadow map. The block's
 * own nearest (64 texels each), then spread to the blocks the search reaches, one way and
 * then the other (separable: a few dozen reads a block, not thousands). A point no caster
 * is nearer than is lit, as the full search would find. Three passes on the GPU, about a
 * shadow map's worth of reads, once per still shadow map.
 */
function nearestCasters(scene, shadowMap) {
  const c = scene.casters;
  const size = shadowMap.image.width / 8;
  if (!c.targets || c.size !== size) {
    for (const t of c.targets ?? []) t.dispose();
    // Plain 32-bit depths, not packed into bytes as the shadow map is (packed again, the
    // nearest came out to a 256th, nearer than some casters were).
    const make = () => new THREE.WebGLRenderTarget(size, size, {
      type: THREE.FloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
    c.targets = [make(), make()];
    c.size = size;
    // How many blocks the search reaches (PV_PCSS_SEARCH of the map), plus one for where in
    // its block a point lies.
    const reach = Math.ceil((0.02 * shadowMap.image.width) / 8) + 1;
    const vertexShader = "void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }";
    c.block = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null } },
      vertexShader,
      fragmentShader: `#include <packing>
uniform sampler2D uMap;
void main() {
ivec2 o = ivec2( gl_FragCoord.xy ) * 8;
float m = 1.0;
for ( int y = 0; y < 8; y++ ) for ( int x = 0; x < 8; x++ ) m = min( m, unpackRGBAToDepth( texelFetch( uMap, o + ivec2( x, y ), 0 ) ) );
gl_FragColor = vec4( m );
}`,
    });
    c.spread = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uStep: { value: new THREE.Vector2(1, 0) } },
      vertexShader,
      fragmentShader: `uniform highp sampler2D uMap;
uniform ivec2 uStep;
void main() {
ivec2 p = ivec2( gl_FragCoord.xy );
ivec2 last = textureSize( uMap, 0 ) - 1;
float m = 1.0;
for ( int k = -${reach}; k <= ${reach}; k++ ) m = min( m, texelFetch( uMap, clamp( p + uStep * k, ivec2( 0 ), last ), 0 ).r );
gl_FragColor = vec4( m );
}`,
    });
    for (const m of [c.block, c.spread]) m.depthTest = m.depthWrite = false;
    c.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), c.block);
    c.quad.frustumCulled = false;
    c.scene = new THREE.Scene();
    c.scene.add(c.quad);
    c.camera = new THREE.Camera();
  }
  const r = scene.renderer;
  const before = r.getRenderTarget();
  const pass = (material, input, output, step) => {
    material.uniforms.uMap.value = input;
    if (step) material.uniforms.uStep.value.set(...step);
    c.quad.material = material;
    r.setRenderTarget(output);
    r.render(c.scene, c.camera);
  };
  pass(c.block, shadowMap, c.targets[0]);
  pass(c.spread, c.targets[0].texture, c.targets[1], [1, 0]);
  pass(c.spread, c.targets[1].texture, c.targets[0], [0, 1]);
  r.setRenderTarget(before);
  scene.shared.uCasterMap.value = c.targets[0].texture;
}

const _look = new THREE.Vector3(); // the camera's place

const _point = new THREE.Vector3();

/**
 * The sheets drawn nearest first, before anything else: the GPU then skips what lies behind
 * a sheet already drawn. Each by how far the camera is from a point a little past the middle
 * of its middle row: the sheets of a pile or of a stack in the air are parallel, so these
 * points are in their order from whichever side they are seen. (Not by depth along the view:
 * a stack standing upright in front of the camera lies edge-on to it, and its sheets all tie.
 * In a fixed order, top of each pile first, a pile swung over to close the book was drawn
 * back to front, every sheet shaded in full: 60 ms a frame at 44 pages, 300 at 240.)
 */
export function drawOrder(scene) {
  const cam = scene.camera;
  scene.block.updateWorldMatrix(true, false);
  cam.updateWorldMatrix(true, false);
  _look.setFromMatrixPosition(cam.matrixWorld);
  const depth = scene.leaves.map((leaf) => {
    const p = leaf.profile;
    const k = Math.round(0.6 * (p.x.length - 1));
    return _point.set(p.x[k], p.y[k], 0).applyMatrix4(scene.block.matrixWorld).distanceToSquared(_look);
  });
  const order = scene.leaves.map((_, i) => i).sort((a, b) => depth[a] - depth[b]);
  order.forEach((i, rank) => {
    scene.leaves[i].mesh.renderOrder = -1000 + rank;
  });
  chooseOccluders(scene);
  showFlaps(scene);
}

/**
 * The occluder: a surface drawn before the sheets for its depth alone, which nothing can
 * see (it lies inside the paper) and which hides what lies behind it before the graphics
 * card shades it. A sheet's faces lie half the paper either side of its cross-section, its
 * edges close the slab between them; the surface at the cross-section itself (uSheetSide 0,
 * on the front face's own vertex grid) lies inside that slab, so a ray reaching it has come
 * in through a face or an edge that is drawn: it can only hide what the sheet hides already.
 * Its rim is an eighth of a cell in from the sheet's (sheetPosition), and a coil sheet's part
 * starts well past its holes (leaf.occluderRange): nowhere a ray could reach it without
 * having come in through something drawn. Of every OCCLUDER_EVERY-th sheet and of the sheets on top of
 * the piles: a ray into a pile then crosses at most that many sheets before it stops. One
 * mesh, one draw: the sheets' places as their meshes hold them (see makeLeaf), its index
 * rebuilt when the choice of sheets changes (chooseOccluders). Nothing else: no shadow, no
 * picking.
 *
 * (Apple's GPUs remove hidden points before shading them, whatever the drawing order; but
 * under Chromium and Safari every shader is translated for Metal with an output saying which
 * samples it covers, written whenever the target is multisampled (ANGLE, TranslatorMSL), and
 * a shader that can change its own coverage can't be removed before it runs. Seen low at the
 * fore-edge, an open book's piles were shaded sheet by sheet, dozens deep: 19.5 ms a frame on
 * the author's M4 Pro, 2026-10-24. Depth that is in the buffer before a sheet is drawn does
 * reject it: every sheet's faces drawn first for their depth, 0.15.7 to 1.1.0, halved that
 * frame once, but by 2026-10-24 cost more than it saved dragging round, building every sheet
 * twice. This builds a few, once.)
 */
export function makeOccluder(scene) {
  const bases = [];
  let count = 0;
  let total = 0;
  for (const leaf of scene.leaves) {
    bases.push(count);
    count += leaf.geo.attributes.position.count;
    total += leaf.occluderRange.count;
  }
  const place = new Float32Array(count * 3);
  for (const [i, leaf] of scene.leaves.entries()) place.set(leaf.geo.attributes.position.array, bases[i] * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(place, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(total), 1));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  scene.occluder = { mesh: null, geo, bases, side: { value: 0 }, key: "" };
  const mesh = new THREE.Mesh(geo, occluderMaterial(scene));
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.raycast = () => {};
  mesh.renderOrder = -1e6; // before the sheets (see drawOrder)
  scene.block.add(mesh);
  scene.occluder.mesh = mesh;
}

export function freeOccluder(scene) {
  const o = scene.occluder;
  if (!o) return;
  scene.block.remove(o.mesh);
  o.geo.dispose();
  o.mesh.material.dispose();
  scene.occluder = null;
}

/**
 * Which sheets the occluder is made of this frame (see makeOccluder): every
 * `scene.occluderEvery`-th (0: none, for the performance check's comparison), the covers, and
 * the two sheets at the opening (the piles' tops); only sheets that are drawn.
 */
function chooseOccluders(scene) {
  const o = scene.occluder;
  if (!o) return;
  const every = scene.occluderEvery;
  const n = scene.leaves.length;
  const chosen = [];
  if (every > 0) {
    for (const leaf of scene.leaves) {
      const i = leaf.i;
      const top = i === 0 || i === n - 1 || i === scene.opening - 1 || i === scene.opening;
      if (leaf.mesh.visible && (top || i % every === 0)) chosen.push(i);
    }
  }
  const key = chosen.join(",");
  o.mesh.visible = chosen.length > 0;
  if (key === o.key) return;
  o.key = key;
  const index = /** @type {THREE.BufferAttribute} */ (o.geo.index);
  const out = /** @type {Uint32Array} */ (index.array);
  let at = 0;
  for (const i of chosen) {
    const leaf = scene.leaves[i];
    const g = leaf.occluderRange;
    const src = leaf.geo.index.array;
    const base = o.bases[i];
    for (let k = g.start; k < g.start + g.count; k++) out[at++] = src[k] + base;
  }
  index.clearUpdateRanges();
  index.addUpdateRange(0, at);
  index.needsUpdate = true;
  o.geo.setDrawRange(0, at);
}

/**
 * A cover file's flaps (makeFlap in leaf.js) lie on the insides of the covers, a paper's
 * thickness off them: just where the first or last page lies on that cover too. Shown only
 * while their cover's inside is uncovered (the book open at it, or the page beside it in the
 * air, or the cover itself turning): under the pages the two shared a place and the flap showed
 * through them, "floating on top a few pages into the book" (the designer, 2026-10-22). (Shown
 * only for the page beside turning, the flap went while its own cover turned: the author.)
 */
function showFlaps(scene) {
  for (const [folio, mesh] of scene.flaps ?? []) {
    const k = Math.ceil(folio / 2) - 1; // the cover's leaf; even folios its back, odd its front
    const back = folio % 2 === 0;
    const beside = scene.leaves[back ? k + 1 : k - 1];
    const uncovered = !scene.isClosed && scene.opening === (back ? k + 1 : k);
    mesh.visible = !!beside && (uncovered || beside.start != null || scene.leaves[k]?.start != null);
  }
}
