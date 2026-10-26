// The pages' data on the GPU (app/viewer/pagedata.js): a layer array grown for a larger image
// or for more of them keeps what it holds exactly, its images padded by their edges into the
// new room; and a page whose image is larger than the others' still reaches every reader.

import * as THREE from "three";
import { LayerArray } from "../app/viewer/pagedata.js";
import { BookScene } from "../app/viewer/scene.js";
import { eq, ok, test } from "./harness.js";

/** A layer's texels at a level, read back from the GPU (RGBA bytes, rows from the top). */
function readLayer(renderer, arr, layer, level) {
  const gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());
  const w = Math.max(1, arr.width >> level);
  const h = Math.max(1, arr.height >> level);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, arr.glTexture, level, layer);
  const out = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  renderer.resetState();
  return { w, h, out };
}

/** An image with every smaller copy, each texel its own colour: (x, y, layer seed, level). */
function pattern(width, height, seed) {
  const levels = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const make = (w, h, level) => {
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([x & 255, y & 255, seed, level * 16 + ((x + y) & 15)], (y * w + x) * 4);
    return d;
  };
  const mips = [];
  for (let l = 1; l < levels; l++) mips.push(make(Math.max(1, width >> l), Math.max(1, height >> l), l));
  return { data: make(width, height, 0), mips };
}

test("pages' data: a layer array grown keeps every texel, its images padded by their edges into the new room", async () => {
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas });
  try {
    const arr = new LayerArray(renderer, { mips: true, name: "test" });
    ok(arr.ensure(40, 24, 2), "made");
    const a = pattern(40, 24, 7);
    const b = pattern(30, 20, 9); // smaller than the layer: padded by its edges
    const la = arr.take();
    const lb = arr.take();
    arr.upload(la, 40, 24, a.data, a.mips);
    arr.upload(lb, 30, 20, b.data, b.mips);
    let grew = 0;
    arr.onGrow = () => grew++;
    ok(arr.grow(64, 37, 5), "grown");
    eq([arr.width, arr.height, arr.layers, grew], [64, 37, 5, 1]);
    eq(arr.free.length, 3, "the new layers free, the old ones still taken");
    const bad = [];
    for (const [layer, img, w0, h0] of [[la, a, 40, 24], [lb, b, 30, 20]]) {
      for (let level = 0; level < 4; level++) {
        const src = level === 0 ? img.data : img.mips[level - 1];
        const iw = Math.max(1, w0 >> level);
        const ih = Math.max(1, h0 >> level);
        const { w, h, out } = readLayer(renderer, arr, layer, level);
        // Every texel: the image's own inside it, its nearest edge texel outside it.
        for (let y = 0; y < h && bad.length < 6; y++) {
          for (let x = 0; x < w; x++) {
            const sx = Math.min(x, iw - 1);
            const sy = Math.min(y, ih - 1);
            const want = src.subarray((sy * iw + sx) * 4, (sy * iw + sx) * 4 + 4);
            const got = out.subarray((y * w + x) * 4, (y * w + x) * 4 + 4);
            if (got.some((v, i) => v !== want[i])) { bad.push(`layer ${layer} level ${level} at ${x},${y}: ${[...got]} not ${[...want]}`); break; }
          }
        }
      }
    }
    eq(bad, []);
  } finally {
    renderer.dispose();
  }
});

test("pages' data: a page larger than the first goes in the page array (it grows), not on a texture of its own", async () => {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  const scene = new BookScene(box);
  try {
    const stock = { color: "#ffffff", roughness: 0.85, specular: 0.3, clearcoat: 0, show: 0.1 };
    const paper = { ...stock, cover: { ...stock, color: "#d8d0c0" }, thickness: 0.1, coverThickness: 0.3, gsm: 120, finish: "uncoated" };
    scene.setPageKind("ink");
    scene.setBook({ pageCount: 8, pageSize: { width: 148, height: 210 }, binding: "perfect", paper });
    const image = (w, h) => ({ width: w, height: h, ...pattern(w, h, 1), spots: null, spotNames: [] });
    scene.setPageTexture(3, image(140, 200));
    scene.setPageTexture(4, image(170, 230)); // larger: a cover file's page, say
    scene.setPageTexture(5, image(120, 180));
    for (let i = 0; i < 4 && scene.uploads.size; i++) scene.debugSample(0.5, 0.5);
    for (const folio of [3, 4, 5]) {
      const page = scene.pageTextures.get(folio);
      ok(page && page.layer >= 0 && !page.tex, `page ${folio} in the page array`);
      eq(scene.pageTable.get(folio, 0, 0), page.layer, `page ${folio}'s layer in the page table`);
      eq(+scene.pageTable.get(folio, 0, 2).toFixed(4), +(page.width / scene.pageArray.width).toFixed(4), `page ${folio}'s scale, as the array is now`);
    }
    eq([scene.pageArray.width, scene.pageArray.height], [170, 230], "grown to the largest");
    // A sharper image shown for now: in the sharp array, the page table's texel 10.
    scene.showPageImage(3, image(300, 420));
    const shown = scene.overrides.get(3);
    ok(shown && shown.layer >= 0 && shown.array === scene.sharpArray, "in the sharp array");
    eq(scene.pageTable.get(3, 10, 0), shown.layer);
    scene.showPageImage(3, null);
    eq(scene.pageTable.get(3, 10, 0), -1, "its own again");
  } finally {
    box.remove();
  }
});
