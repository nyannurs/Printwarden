// Smaller copies of an ink image (RGBA bytes) for the GPU's mipmaps: each level the mean of
// 2 × 2 texels of the one before (a box filter, as the GPU makes them). Made where the image
// is drawn (the render thread), so a tile goes to the GPU with its mips and no mipmap pass
// runs over the whole tile cache for every tile that lands (see viewer/tiles.js).

/**
 * Half size: each texel the mean of the 2 × 2 under it (an odd edge takes what's there).
 * @param {Uint8Array} data RGBA, `w` × `h`
 * @returns {{data: Uint8Array, width: number, height: number}}
 */
export function halve(data, w, h) {
  const width = Math.max(1, w >> 1);
  const height = Math.max(1, h >> 1);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = 2 * y, y1 = Math.min(h - 1, 2 * y + 1);
    for (let x = 0; x < width; x++) {
      const x0 = 2 * x, x1 = Math.min(w - 1, 2 * x + 1);
      const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
      const o = (y * width + x) * 4;
      out[o] = (data[a] + data[b] + data[c] + data[d] + 2) >> 2;
      out[o + 1] = (data[a + 1] + data[b + 1] + data[c + 1] + data[d + 1] + 2) >> 2;
      out[o + 2] = (data[a + 2] + data[b + 2] + data[c + 2] + data[d + 2] + 2) >> 2;
      out[o + 3] = (data[a + 3] + data[b + 3] + data[c + 3] + data[d + 3] + 2) >> 2;
    }
  }
  return { data: out, width, height };
}

/**
 * `n` levels below an image, each half the one before.
 * @returns {Uint8Array[]} their bytes, largest first
 */
export function mipChain(data, w, h, n) {
  const out = [];
  let level = { data, width: w, height: h };
  for (let i = 0; i < n; i++) {
    level = halve(level.data, level.width, level.height);
    out.push(level.data);
  }
  return out;
}
