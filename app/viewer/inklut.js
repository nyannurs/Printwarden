// The ink table: the chosen CMYK profile as a grid, for turning a page's inks (Cyan, Magenta,
// Yellow, Black, 0..1 as its texture holds them) into the colour they print, sRGB. The page
// shader reads it as a 3D texture (INK_GLSL in viewer/shaders.js); the timeline's thumbnails
// through a small WebGL program (ui/inkview.js); the cover's edge colour here (inkToRgb). MuPDF
// fills it (mupdf-render.js `lut`): every entry converted through the profile by the same engine
// that draws the pages. Pure: no DOM, no three.
//
// 17 steps an ink (0, 1/16 … 1), 83,521 entries, RGBA bytes. As a 3D texture: 17 wide (Cyan),
// 17 high (Magenta), 289 deep (Yellow within Black: y + 17 k). The shader reads Cyan, Magenta
// and Yellow by the card's own trilinear filter and Black by two reads it mixes itself.

const INK_STEPS = 17;
export const LUT_WIDTH = INK_STEPS;
export const LUT_HEIGHT = INK_STEPS;
export const LUT_DEPTH = INK_STEPS * INK_STEPS;
export const LUT_ENTRIES = INK_STEPS ** 4;

/** The entry of grid steps (0..16 each). */
export function lutIndex(ci, mi, yi, ki) {
  return ci + INK_STEPS * (mi + INK_STEPS * (yi + INK_STEPS * ki));
}

/** The grid's inks, CMYK bytes an entry in lutIndex order (what MuPDF converts, see mupdf-render.js). */
export function lutInks() {
  const out = new Uint8Array(LUT_ENTRIES * 4);
  for (let ki = 0; ki < INK_STEPS; ki++) {
    for (let yi = 0; yi < INK_STEPS; yi++) {
      for (let mi = 0; mi < INK_STEPS; mi++) {
        for (let ci = 0; ci < INK_STEPS; ci++) {
          const o = lutIndex(ci, mi, yi, ki) * 4;
          out[o] = Math.round((ci * 255) / 16);
          out[o + 1] = Math.round((mi * 255) / 16);
          out[o + 2] = Math.round((yi * 255) / 16);
          out[o + 3] = Math.round((ki * 255) / 16);
        }
      }
    }
  }
  return out;
}

/** A table without a profile: the plain formula (each ink takes its share of the light). */
export function naiveLut() {
  const out = new Uint8Array(LUT_ENTRIES * 4);
  for (let ki = 0; ki < INK_STEPS; ki++) {
    for (let yi = 0; yi < INK_STEPS; yi++) {
      for (let mi = 0; mi < INK_STEPS; mi++) {
        for (let ci = 0; ci < INK_STEPS; ci++) {
          const o = lutIndex(ci, mi, yi, ki) * 4;
          const k = 1 - ki / 16;
          out[o] = Math.round(255 * (1 - ci / 16) * k);
          out[o + 1] = Math.round(255 * (1 - mi / 16) * k);
          out[o + 2] = Math.round(255 * (1 - yi / 16) * k);
          out[o + 3] = 255;
        }
      }
    }
  }
  return out;
}

/** The colour (sRGB, 0..255) the table gives inks (0..1): the nearest entry. */
export function inkToRgb(lut, c, m, y, k) {
  const step = (v) => Math.max(0, Math.min(INK_STEPS - 1, Math.round(v * (INK_STEPS - 1))));
  const o = lutIndex(step(c), step(m), step(y), step(k)) * 4;
  return [lut[o], lut[o + 1], lut[o + 2]];
}
