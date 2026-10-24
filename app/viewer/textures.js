// Textures the scene makes for itself: placeholders (white paper, no finish), the paper's
// grain, the contact shadow's soft footprint, the pages' inks and the ink table, and handling
// for page images once on the GPU.

import * as THREE from "three";
import { LUT_DEPTH, LUT_HEIGHT, LUT_WIDTH } from "./inklut.js";

/**
 * A page's inks as a texture: C, M, Y, K a byte each in the four channels (pdf/mupdf-render.js,
 * mode "ink"), read raw (no colour space), mipmapped and filtered as the page images were. The
 * shader turns them into colour through the ink table (INK_GLSL). The image's bytes are its own
 * until it is on the GPU (freeImage).
 * @param {{width: number, height: number, data: Uint8Array}} image
 */
export function makeInkTexture(image, anisotropy) {
  const t = new THREE.DataTexture(/** @type {any} */ (image.data), image.width, image.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.flipY = false;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy;
  t.needsUpdate = true;
  t.userData.ink = true;
  return t;
}

/** The ink table (inklut.js: RGBA bytes in lutIndex order) as the 3D texture the shaders read. */
export function makeInkLut(data) {
  const t = new THREE.Data3DTexture(data, LUT_WIDTH, LUT_HEIGHT, LUT_DEPTH);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** A page's placeholder as inks: none, so paper. */
export function makeInkPaper() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  t.userData.ink = true;
  return t;
}

/** One pixel to draw textures into once (see uploads.js warm). */
export function makeWarmer() {
  const vertexShader = "void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }";
  const float = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: null } }, vertexShader,
    fragmentShader: `uniform sampler2D uTex;
void main() { gl_FragColor = texture2D( uTex, vec2( 0.5 ) ); }`,
  });
  const uint = new THREE.ShaderMaterial({
    uniforms: { uTex: { value: null } }, vertexShader,
    fragmentShader: `uniform highp usampler2D uTex;
void main() { gl_FragColor = vec4( texture( uTex, vec2( 0.5 ) ) ); }`,
  });
  for (const m of [float, uint]) m.depthTest = m.depthWrite = false;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), float);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  return { target: new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }), scene, camera: new THREE.Camera(), quad, float, uint };
}

/**
 * A texture is on the GPU: its image is freed from memory, only its size kept. (three reads
 * the image only to upload it, and these are never uploaded again.)
 */
export function freeImage(tex) {
  const { image } = tex;
  if (!image) return;
  if (image.data) { // an ink image: its bytes go, the size stays
    tex.image = { width: image.width, height: image.height, data: null };
    return;
  }
  if (!image.close) return;
  tex.image = { width: image.width, height: image.height };
  image.close();
}

export function disposeTexture(tex, keep) {
  if (!tex || tex === keep) return;
  tex.dispose();
  if (tex.userData.owned) tex.image?.close?.();
}

/**
 * The contact shadow's alpha: dense under the book, fading over the margin around it. A
 * rounded rectangle blurred, on a 1 × 1 plane stretched to the footprint.
 */
export function makeContactMap() {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  ctx.filter = `blur(${size * 0.035}px)`;
  ctx.fillStyle = "#fff";
  const inset = size * 0.1;
  ctx.beginPath();
  ctx.roundRect(inset, inset, size - 2 * inset, size - 2 * inset, size * 0.03);
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export function makeWhite() {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Tileable paper grain for the bump map: fibres, not just noise. */
export function makeGrain() {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < size * size; i++) {
    const v = 128 + (rand() - 0.5) * 44;
    img.data.set([v, v, v, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  ctx.globalAlpha = 0.07;
  ctx.lineWidth = 0.8;
  ctx.strokeStyle = "#000";
  for (let i = 0; i < 1400; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const a = rand() * Math.PI;
    const l = 5 + rand() * 22;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + Math.cos(a + 0.4) * l * 0.5, y + Math.sin(a + 0.4) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
