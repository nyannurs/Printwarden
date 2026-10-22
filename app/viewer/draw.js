// Drawing a frame, beyond three's own: the shadow map only when what it shows changed, where
// shadow casters are near (for the soft shadows' search), and the sheets nearest first.

import * as THREE from "three";

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
    scene.leaves[i].first.renderOrder = -1000 - order.length + rank; // before them all (see makeLeaf)
  });
  showFlaps(scene);
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
