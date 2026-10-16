// Screenshots and videos: the view rendered offline, larger than the screen (tile by tile)
// or frame by frame on the scene's own clock (see BookScene.captureImage, recordVideo).
// `own`: the scene's own steps (camera, animations, uploads).

import * as THREE from "three";
import { renderView } from "./draw.js";
import { layoutLeaves } from "./layout.js";
import { LEAF_ROWS } from "./shaders.js";

/**
 * Render the current view as a large image, tile by tile. Before each tile,
 * `prepare(visible, tile)` is awaited: it receives the pages in that tile with their
 * densities in output pixels, so page images can be re-rendered from the PDF's vectors
 * at exactly the resolution the tile needs. Resolution is then limited only by the
 * output size, not by the screen or by texture memory.
 * @param {import("./scene.js").BookScene} scene
 * @param {import("./scene.js").SceneSteps} own
 * @param {{width: number, height: number, transparent?: boolean,
 *          prepare?: (visible: ReturnType<import("./scene.js").BookScene["visiblePages"]>,
 *                     tile: {x: number, y: number, w: number, h: number}) => Promise<void>,
 *          onProgress?: (done: number, total: number) => void}} options
 * @returns {Promise<Blob>} PNG
 */
export async function captureImage(scene, own, { width, height, transparent = false, prepare = async () => {}, onProgress = () => {} }) {
  const tileMax = Math.min(4096, scene.renderer.capabilities.maxTextureSize);
  const cols = Math.ceil(width / tileMax);
  const rows = Math.ceil(height / tileMax);
  const tw = Math.ceil(width / cols);
  const th = Math.ceil(height / rows);
  const target = new THREE.WebGLRenderTarget(tw, th, { samples: Math.min(8, scene.renderer.capabilities.maxSamples), resolveDepthBuffer: false });
  target.texture.colorSpace = THREE.SRGBColorSpace; // read back as sRGB, like the screen
  const out = new OffscreenCanvas(width, height);
  const ctx = out.getContext("2d");
  const pixels = new Uint8Array(tw * th * 4);
  const background = scene.scene.background;
  const aspect = scene.camera.aspect;
  const clearColor = scene.renderer.getClearColor(new THREE.Color());
  const clearAlpha = scene.renderer.getClearAlpha();
  scene.capturing = true;
  try {
    layoutLeaves(scene);
    scene.camera.aspect = width / height;
    own.frameCamera(); // framed for the output's shape: the whole book fits
    own.placeCamera();
    if (transparent) scene.scene.background = null;
    scene.renderer.setClearColor(0x000000, 0);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        onProgress(r * cols + c, rows * cols);
        const x = c * tw;
        const y = r * th;
        const w = Math.min(tw, width - x);
        const h = Math.min(th, height - y);
        scene.camera.setViewOffset(width, height, x, y, w, h);
        scene.camera.updateProjectionMatrix();
        await prepare(scene.visiblePages({ width: w, height: h }), { x, y, w, h });
        target.setSize(w, h);
        renderView(scene, target, { W: width, H: height, x, y, w, h });
        scene.renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
        scene.renderer.setRenderTarget(null);
        const img = new ImageData(w, h);
        for (let row = 0; row < h; row++) {
          // Rows come bottom-up; colour is premultiplied over transparent black.
          const src = (h - 1 - row) * w * 4;
          const dst = row * w * 4;
          for (let i = 0; i < w * 4; i += 4) {
            const a = pixels[src + i + 3];
            const k = a && a < 255 ? 255 / a : 1;
            img.data[dst + i] = Math.min(255, pixels[src + i] * k);
            img.data[dst + i + 1] = Math.min(255, pixels[src + i + 1] * k);
            img.data[dst + i + 2] = Math.min(255, pixels[src + i + 2] * k);
            img.data[dst + i + 3] = a;
          }
        }
        ctx.putImageData(img, x, y);
      }
    }
    onProgress(rows * cols, rows * cols);
    return await out.convertToBlob({ type: "image/png" });
  } finally {
    scene.camera.clearViewOffset();
    scene.camera.aspect = aspect;
    own.frameCamera();
    scene.camera.updateProjectionMatrix();
    scene.scene.background = background;
    scene.renderer.setClearColor(clearColor, clearAlpha);
    target.dispose();
    scene.capturing = false;
    scene.dirty = true;
  }
}

/**
 * How far the camera must be, this frame, for every page in the picture: points along each
 * leaf from root to fore-edge, at head and foot (and the middle, turning), seen from the camera's direction (which doesn't
 * depend on the distance), inside `margin` of the frame. A point r from the target, x and y
 * across the view, d toward the camera: it fits when distance ≥ d + |x| / (margin · tan(half
 * fov)), and the same for y.
 */
function distanceToFit(scene, own, margin) {
  const cam = scene.camera;
  cam.updateMatrixWorld();
  const e = cam.matrixWorld.elements;
  const t = own.currentTarget();
  const tanV = Math.tan((cam.fov * Math.PI) / 360) * margin;
  const tanH = Math.tan((cam.fov * Math.PI) / 360) * cam.aspect * margin;
  scene.block.updateWorldMatrix(true, false);
  const m = scene.block.matrixWorld;
  const v = new THREE.Vector3();
  const h2 = scene.model.height / 2;
  let need = 0;
  const R = LEAF_ROWS - 1;
  for (const leaf of scene.leaves) {
    // A page turning corner first: its head and foot rows each on their own (see rowTurn in
    // model.js), the corners ahead of or behind its middle; else one shape head to foot.
    const ends = leaf.rowsActive ? [[leaf.rows[0], -h2], [leaf.rows[R / 2], 0], [leaf.rows[R], h2]] : [[leaf.profile, -h2], [leaf.profile, h2]];
    for (const [p, z] of ends) {
      const last = p.x.length - 1;
      for (const k of [0, last >> 2, last >> 1, (3 * last) >> 2, last]) {
        v.set(p.x[k], p.y[k], z).applyMatrix4(m).sub(t);
        const x = v.x * e[0] + v.y * e[1] + v.z * e[2];
        const y = v.x * e[4] + v.y * e[5] + v.z * e[6];
        const d = v.x * e[8] + v.y * e[9] + v.z * e[10];
        need = Math.max(need, d + Math.abs(x) / tanH, d + Math.abs(y) / tanV);
      }
    }
  }
  return need;
}

/**
 * Plan a video before rendering it, by running its timeline twice without drawing (cheap:
 * the layout only). First the camera: each frame's distance is the scene's own framing, or
 * farther where a page swinging up would leave the picture (distanceToFit); widened a little
 * ahead of and after each such moment and averaged over it, so the camera eases out and back
 * instead of following every frame (a window's maximum, then its mean: never closer than a
 * frame needs). Then the pages' density: how many pixels a millimetre each page has where it
 * lies at rest (where the camera is closest between turns, and at the end), so its image can be
 * rendered at the size that draws sharpest (see renderVideo in ui/capture.js).
 * @returns {{distances: Float64Array, density: Map<number, number>}}
 */
function planVideo(scene, own, { width, height, fps, frames, cues, reset, margin, start }) {
  const run = (each) => {
    reset();
    const pending = [...cues].sort((a, b) => a.at - b.at);
    for (let i = 0; i < frames; i++) {
      const ms = (i * 1000) / fps;
      scene.clock = start + ms;
      while (pending.length && pending[0].at <= ms) pending.shift().run();
      own.update(scene.clock);
      own.frameCamera();
      each(i, ms);
    }
  };
  const need = new Float64Array(frames);
  run((i) => {
    need[i] = Math.max(scene.fitDistance * scene.rig.zoom, distanceToFit(scene, own, margin));
  });
  const k = Math.max(1, Math.round(fps * 0.5));
  const envelope = need.map((_, i) => Math.max(...need.subarray(Math.max(0, i - k), Math.min(frames, i + k + 1))));
  const distances = envelope.map((_, i) => {
    const part = envelope.subarray(Math.max(0, i - k), Math.min(frames, i + k + 1));
    return part.reduce((s, x) => s + x, 0) / part.length;
  });
  // At rest: between turns, the frame where the camera is closest (pages largest), and the
  // last frame.
  const bounds = [0, ...cues.map((c) => Math.min(frames, Math.ceil((c.at * fps) / 1000))), frames];
  const rest = new Set([frames - 1]);
  for (let b = 0; b + 1 < bounds.length; b++) {
    let best = -1;
    for (let i = bounds[b]; i < bounds[b + 1]; i++) if (best < 0 || distances[i] < distances[best]) best = i;
    if (best >= 0) rest.add(best);
  }
  const density = new Map();
  run((i) => {
    if (!rest.has(i)) return;
    scene.fitDistance = distances[i] / scene.rig.zoom;
    own.placeCamera();
    scene.camera.updateMatrixWorld();
    for (const view of scene.visiblePages({ width, height })) {
      const most = Math.max(0, ...view.samples.map((s) => s.pxPerMm));
      density.set(view.folio, Math.max(density.get(view.folio) ?? 0, most));
    }
  });
  return { distances, density };
}

/**
 * Render an animation offline, frame by frame on the scene's own clock, so every frame is
 * evenly spaced whatever it costs to draw. `cues` are actions at times (ms from the start,
 * e.g. turning to the next page); before each frame `prepare(ms)` is awaited (e.g. sharper
 * page images for what comes into view); each frame goes to `onFrame(rgba, index)`, rows
 * top down, straight (not premultiplied) alpha, in order. Framed for the output's shape.
 * With `reset` (puts the book where the video starts), the video is planned first (see
 * planVideo): the camera stands back where a page would leave the picture, and `prepare`
 * gets the pages' density at rest (px per mm, by folio).
 *
 * Pipelined: the GPU turns each frame top down and straight-alpha itself, frames are read
 * back without stalling it, and while `onFrame` hands one frame on (to the encoder), the
 * next ones are already being drawn.
 * @param {import("./scene.js").BookScene} scene
 * @param {import("./scene.js").SceneSteps} own
 * @param {{width: number, height: number, fps: number, durationMs: number,
 *          cues: {at: number, run: () => void}[], transparent?: boolean,
 *          reset?: () => void, prepare?: (ms: number, density: Map<number, number>) => Promise<void>,
 *          onFrame: (rgba: Uint8Array, index: number) => any,
 *          onProgress?: (done: number, total: number) => void}} options
 */
export async function recordVideo(scene, own, { width, height, fps, durationMs, cues, transparent = false, reset = null, prepare = async () => {}, onFrame, onProgress = () => {} }) {
  const IN_FLIGHT = 3;
  const target = new THREE.WebGLRenderTarget(width, height, { samples: Math.min(8, scene.renderer.capabilities.maxSamples), resolveDepthBuffer: false });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const out = new THREE.WebGLRenderTarget(width, height, { depthBuffer: false });
  out.texture.colorSpace = THREE.SRGBColorSpace;
  // Rows flipped to top down; colour (premultiplied over transparent black) divided by
  // alpha. Exact texels, no filtering.
  const post = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { tFrame: { value: target.texture }, uHeight: { value: height } },
    vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: `uniform sampler2D tFrame;
      uniform int uHeight;
      layout(location = 0) out highp vec4 frameColor;
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec4 c = texelFetch(tFrame, ivec2(p.x, uHeight - 1 - p.y), 0);
        frameColor = c.a > 0.0 ? vec4(c.rgb / c.a, c.a) : vec4(0.0);
      }`,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  }));
  post.frustumCulled = false;
  const postScene = new THREE.Scene();
  postScene.add(post);
  const postCamera = new THREE.Camera();
  const free = [];
  const background = scene.scene.background;
  const aspect = scene.camera.aspect;
  const clearColor = scene.renderer.getClearColor(new THREE.Color());
  const clearAlpha = scene.renderer.getClearAlpha();
  const start = performance.now();
  const frames = Math.max(1, Math.round((durationMs / 1000) * fps));
  const delivered = []; // per frame: resolves once onFrame has taken it
  scene.capturing = true;
  try {
    scene.camera.aspect = width / height;
    // Planned first (camera distance per frame, pages' density), then run again for real.
    const plan = reset ? planVideo(scene, own, { width, height, fps, frames, cues, reset, margin: 0.92, start }) : null;
    reset?.();
    const pending = [...cues].sort((a, b) => a.at - b.at);
    if (transparent) scene.scene.background = null;
    scene.renderer.setClearColor(0x000000, 0);
    for (let i = 0; i < frames; i++) {
      if (i >= IN_FLIGHT) await delivered[i - IN_FLIGHT];
      const ms = (i * 1000) / fps;
      scene.clock = start + ms;
      while (pending.length && pending[0].at <= ms) pending.shift().run();
      await prepare(ms, plan?.density ?? new Map());
      own.update(scene.clock);
      while (scene.uploads.size) own.flushUploads(); // every page image for this frame
      own.frameCamera();
      if (plan) scene.fitDistance = plan.distances[i] / scene.rig.zoom; // pages swinging up stay in the picture
      own.placeCamera();
      renderView(scene, target, null);
      scene.renderer.setRenderTarget(out);
      scene.renderer.render(postScene, postCamera);
      scene.renderer.setRenderTarget(null);
      const pixels = free.pop() ?? new Uint8Array(width * height * 4);
      const read = scene.renderer.readRenderTargetPixelsAsync(out, 0, 0, width, height, pixels);
      delivered[i] = Promise.all([read, delivered[i - 1]]).then(async () => {
        await onFrame(pixels, i);
        free.push(pixels);
        onProgress(i + 1, frames);
      });
      delivered[i].catch(() => {}); // surfaced by the awaits
    }
    await delivered[frames - 1];
  } finally {
    await Promise.allSettled(delivered);
    scene.clock = null;
    scene.camera.aspect = aspect;
    own.frameCamera();
    scene.camera.updateProjectionMatrix();
    scene.scene.background = background;
    scene.renderer.setClearColor(clearColor, clearAlpha);
    target.dispose();
    out.dispose();
    post.geometry.dispose();
    post.material.dispose();
    scene.capturing = false;
    scene.dirty = true;
  }
}
