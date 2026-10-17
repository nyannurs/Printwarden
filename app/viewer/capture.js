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
  const { tanH, tanV } = halfFov(scene.camera, margin);
  let need = 0;
  bookPoints(scene, own, (x, y, d) => {
    need = Math.max(need, d + Math.abs(x) / tanH, d + Math.abs(y) / tanV);
  });
  return need;
}

/** The tangents of the camera's half field of view, across and up, times `margin`. */
function halfFov(cam, margin) {
  const tanV = Math.tan((cam.fov * Math.PI) / 360) * margin;
  return { tanV, tanH: tanV * cam.aspect };
}

/**
 * Every point of the book that bounds it in the picture, in the camera's frame about its aim:
 * x across, y up, d toward the camera (`visit(x, y, d)`). Points along each leaf from root to
 * fore-edge, at head and foot (and the middle, turning).
 */
function bookPoints(scene, own, visit) {
  const cam = scene.camera;
  cam.updateMatrixWorld();
  const e = cam.matrixWorld.elements;
  const t = own.currentTarget();
  scene.block.updateWorldMatrix(true, false);
  const m = scene.block.matrixWorld;
  const v = new THREE.Vector3();
  const h2 = scene.model.height / 2;
  const R = LEAF_ROWS - 1;
  for (const leaf of scene.leaves) {
    // A page turning corner first: its head and foot rows each on their own (see rowTurn in
    // model.js), the corners ahead of or behind its middle; else one shape head to foot.
    const ends = leaf.rowsActive ? [[leaf.rows[0], -h2], [leaf.rows[R / 2], 0], [leaf.rows[R], h2]] : [[leaf.profile, -h2], [leaf.profile, h2]];
    for (const [p, z] of ends) {
      const last = p.x.length - 1;
      for (const k of [0, last >> 2, last >> 1, (3 * last) >> 2, last]) {
        v.set(p.x[k], p.y[k], z).applyMatrix4(m).sub(t);
        visit(v.x * e[0] + v.y * e[1] + v.z * e[2], v.x * e[4] + v.y * e[5] + v.z * e[6], v.x * e[8] + v.y * e[9] + v.z * e[10]);
      }
    }
  }
}

/**
 * Plan a video before rendering it, by running its timeline without drawing (cheap: the
 * layout only). The camera is fixed for the whole video, an artboard the book moves in: the
 * direction, aim and zoom it has on the first open spread at rest, and the distance at which
 * every page stays in the picture in every frame (distanceToFit: the farthest any frame
 * needs; never closer than the scene frames that spread). Before (0.17.72) the distance
 * followed the pages, easing out for each turn: the picture pulsed; and the camera turned
 * and moved as the book opened and closed, as on screen. Then, frame by frame, the pages'
 * density: how many pixels a millimetre each page that can be in the picture has at its
 * densest, so its image can be as sharp as that frame needs (see renderVideo in
 * ui/capture.js). Every frame, not only the frames at rest (until 0.17.80): a page swinging
 * up comes nearer the camera than it lies, and its image, sized for it at rest, was enlarged
 * and soft through every turn.
 * @returns {{fix: () => void, need: Map<number, number>[]}} `fix`: after the scene frames
 *   its camera, put the video's in place (then placeCamera); `need`: by frame, by folio, px
 *   per mm (0: a page that may be in the picture but wasn't met)
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
  const frameOf = (ms) => Math.min(frames - 1, Math.max(0, Math.ceil((ms * fps) / 1000) - 1));
  // The first open spread at rest: just before the second turn (or, with one turn, the end).
  const reference = cues.length > 1 ? frameOf(cues[1].at) : frames - 1;
  let view = null;
  run((i) => {
    if (i !== reference) return;
    view = {
      target: scene.target.clone(), pan: { ...scene.rig.pan },
      azimuth: scene.rig.azimuth, elevation: scene.rig.elevation, zoom: scene.rig.zoom,
      distance: scene.fitDistance * scene.rig.zoom,
    };
  });
  const aim = () => {
    scene.target.copy(view.target);
    scene.rig.pan = { ...view.pan };
    scene.rig.azimuth = view.azimuth;
    scene.rig.elevation = view.elevation;
    scene.rig.zoom = view.zoom;
  };
  // The distance at which every frame fits; then the aim moved to the middle of all the book
  // does in the picture (a page swinging up reaches far above the spread), and fitted again:
  // the book as large as it can be with nothing leaving the picture.
  const fit = () => {
    let need = 0;
    run(() => {
      aim();
      own.placeCamera();
      need = Math.max(need, distanceToFit(scene, own, margin));
    });
    return need;
  };
  let distance = Math.max(view.distance, fit());
  for (let round = 0; round < 2; round++) {
    const { tanH, tanV } = halfFov(scene.camera, 1);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    run(() => {
      aim();
      own.placeCamera();
      bookPoints(scene, own, (x, y, d) => {
        const depth = Math.max(1e-3, distance - d);
        x0 = Math.min(x0, x / (depth * tanH)); x1 = Math.max(x1, x / (depth * tanH));
        y0 = Math.min(y0, y / (depth * tanV)); y1 = Math.max(y1, y / (depth * tanV));
      });
    });
    // Across and up in the camera's frame, at the aim's distance (near enough: the shift is small).
    scene.camera.updateMatrixWorld();
    const e = scene.camera.matrixWorld.elements;
    const sx = ((x0 + x1) / 2) * distance * tanH;
    const sy = ((y0 + y1) / 2) * distance * tanV;
    view.target.add(new THREE.Vector3(e[0] * sx + e[4] * sy, e[1] * sx + e[5] * sy, e[2] * sx + e[6] * sy));
    distance = fit();
  }
  const fix = () => {
    aim();
    scene.fitDistance = distance / view.zoom;
  };
  // The pages that can be in the picture: the spread turned to and the one before (its
  // leaves are still turning), the pages under them (a page lifting shows the one below),
  // and the covers. Their own rays tell which are met (see visiblePages).
  const candidates = () => {
    const o = scene.opening;
    const set = new Set([1, scene.pageCount]);
    for (let f = 2 * o - 4; f <= 2 * o + 3; f++) set.add(f);
    return [...set].filter((f) => f >= 1 && f <= scene.pageCount);
  };
  const need = [];
  run((i) => {
    fix();
    own.placeCamera();
    scene.camera.updateMatrixWorld();
    const folios = candidates();
    const here = new Map(folios.map((f) => [f, 0]));
    for (const seen of scene.visiblePages({ width, height, folios })) {
      here.set(seen.folio, Math.max(0, ...seen.samples.map((q) => q.pxPerMm)));
    }
    need[i] = here;
  });
  return { fix, need };
}

/**
 * Render an animation offline, frame by frame on the scene's own clock, so every frame is
 * evenly spaced whatever it costs to draw. `cues` are actions at times (ms from the start,
 * e.g. turning to the next page); before each frame `prepare(ms)` is awaited (e.g. sharper
 * page images for what comes into view); each frame goes to `onFrame(rgba, index)`, rows
 * top down, straight (not premultiplied) alpha, in order. Framed for the output's shape.
 * With `reset` (puts the book where the video starts), the video is planned first (see
 * planVideo): one camera for all of it, every page in the picture, and `prepare` gets the
 * density each page has in that frame (px per mm, by folio; 0: may be in the picture).
 *
 * Pipelined: the GPU turns each frame top down and straight-alpha itself, frames are read
 * back without stalling it, and while `onFrame` hands one frame on (to the encoder), the
 * next ones are already being drawn.
 * @param {import("./scene.js").BookScene} scene
 * @param {import("./scene.js").SceneSteps} own
 * @param {{width: number, height: number, fps: number, durationMs: number,
 *          cues: {at: number, run: () => void}[], transparent?: boolean,
 *          reset?: () => void, prepare?: (ms: number, need: Map<number, number>) => Promise<void>,
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
    // Planned first (the camera, the pages' density frame by frame), then run again for real.
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
      await prepare(ms, plan?.need[i] ?? new Map());
      own.update(scene.clock);
      while (scene.uploads.size) own.flushUploads(); // every page image for this frame
      own.frameCamera();
      plan?.fix(); // the video's fixed camera: every page in the picture, no moving or pulsing
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
