// Smaller copies of an ink image (RGBA bytes) for the GPU's mipmaps: each level the mean of
// 2 × 2 texels of the one before (a box filter, as the GPU makes them). Made where the image
// is drawn (the render thread), so a tile goes to the GPU with its mips and no mipmap pass
// runs over the whole tile cache for every tile that lands (see viewer/tiles.js).

/**
 * Half size, floored as the GPU sizes its levels: each texel the mean of exactly the part of the
 * image it stands for (2 × 2 texels at an even size; at an odd one a little over two each way,
 * the edge texels counted in part). Every level so stays registered on the image. (Until 1.1.0
 * an odd size took 2 × 2 and dropped the last row or column: each level after an odd one sat up
 * to half a texel off, and where the GPU switched levels on a page seen at a slant the picture
 * jumped sideways, the author's "line where rendering shifts" on a Mac.)
 * @param {Uint8Array | Float32Array} data RGBA, `w` × `h`
 * @returns {{data: Uint8Array, width: number, height: number, exact: Float32Array}} its bytes,
 *   and unrounded (to halve again from: rounded at every level, the errors added up)
 */
export function halve(data, w, h) {
  const width = Math.max(1, w >> 1);
  const height = Math.max(1, h >> 1);
  const xs = spans(w, width);
  const ys = spans(h, height);
  const out = new Uint8Array(width * height * 4);
  const exact = new Float32Array(width * height * 4);
  if (w === 2 * width && h === 2 * height) { // even both ways (a tile's every level): 2 × 2, quicker
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const a = ((2 * y) * w + 2 * x) * 4, b = a + 4, c = a + w * 4, d = c + 4;
        const o = (y * width + x) * 4;
        for (let ch = 0; ch < 4; ch++) {
          const v = (data[a + ch] + data[b + ch] + data[c + ch] + data[d + ch]) / 4;
          exact[o + ch] = v;
          out[o + ch] = Math.round(v);
        }
      }
    }
    return { data: out, width, height, exact };
  }
  const acc = new Float64Array(4);
  for (let y = 0; y < height; y++) {
    const ry = ys[y];
    for (let x = 0; x < width; x++) {
      const rx = xs[x];
      acc.fill(0);
      for (let j = 0; j < ry.at.length; j++) {
        const row = ry.at[j] * w;
        for (let i = 0; i < rx.at.length; i++) {
          const k = (row + rx.at[i]) * 4;
          const wt = ry.weight[j] * rx.weight[i];
          acc[0] += data[k] * wt;
          acc[1] += data[k + 1] * wt;
          acc[2] += data[k + 2] * wt;
          acc[3] += data[k + 3] * wt;
        }
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) {
        exact[o + c] = acc[c];
        out[o + c] = Math.round(acc[c]);
      }
    }
  }
  return { data: out, width, height, exact };
}

/** For each of `n` texels across `size`: the texels under it and how much of each (summing to 1). */
function spans(size, n) {
  const r = size / n;
  return Array.from({ length: n }, (_, x) => {
    const a = x * r, b = (x + 1) * r;
    const at = [], weight = [];
    for (let i = Math.floor(a); i < Math.min(size, Math.ceil(b)); i++) {
      const part = Math.min(b, i + 1) - Math.max(a, i);
      if (part > 1e-9) { at.push(i); weight.push(part / r); }
    }
    return { at, weight };
  });
}

/**
 * `n` levels below an image, each half the one before.
 * @returns {Uint8Array[]} their bytes, largest first
 */
export function mipChain(data, w, h, n) {
  const out = [];
  let level = { exact: data, width: w, height: h };
  for (let i = 0; i < n; i++) {
    const next = halve(level.exact, level.width, level.height);
    out.push(next.data);
    level = next;
  }
  return out;
}

/**
 * A worker's code that makes an image's every smaller copy as these do, for the client viewer
 * (its pages are JPEGs the browser decodes: the GPU would make their copies, a half texel off
 * on some, see halve). In: {id, bitmap} (an ImageBitmap, handed over). Out: {id, image: {width,
 * height, data, mips}} (RGBA bytes, as uploads.js takes a page's), or {id, bitmap} back where
 * the worker can't draw it (no OffscreenCanvas). These very functions, written into it.
 */
export const MIPS_WORKER_SOURCE = `${spans}
${halve}
${mipChain}
onmessage = (e) => {
  const { id, bitmap } = e.data;
  if (typeof OffscreenCanvas === "undefined") return postMessage({ id, bitmap }, [bitmap]);
  const w = bitmap.width, h = bitmap.height;
  const g = new OffscreenCanvas(w, h).getContext("2d");
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = new Uint8Array(g.getImageData(0, 0, w, h).data.buffer);
  const mips = mipChain(data, w, h, Math.floor(Math.log2(Math.max(w, h))));
  postMessage({ id, image: { width: w, height: h, data, mips } }, [data.buffer, ...mips.map((m) => m.buffer)]);
};
`;
