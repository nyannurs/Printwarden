// Text on the 3D page can't go missing (0.17.81). Plain text is drawn from its outlines
// (vector text) and the page's images leave exactly those glyphs out, so text shows only if
// both agree: every render thread must leave out the same glyphs, told which, and a text
// request must never be answered with "none" because a render on its thread failed (every
// cancelled render did that, and pages loading while flipping quickly lost their text).
// Also the press's overprint: shown as ink over ink, or ignored, as chosen.

import { createRenderer } from "../app/pdf/render.js";
import { makeSamplePdf } from "../app/pdf/sample.js";
import { openForRendering } from "../app/pdf/load.js";
import { eq, ok, test } from "./harness.js";

/** An image's pixels (RGBA), closing it. */
async function pixelsOf(image) {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  image.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

const darkPixels = (px) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 300) n++; return n; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test("vector text: a render that fails on a thread doesn't lose the text request waiting on it", async () => {
  const bytes = await makeSamplePdf({ pages: 8 });
  const r = await createRenderer(bytes, () => openForRendering(bytes));
  try {
    ok(r.workers?.length >= 2, "worker threads");
    for (const index of [3, 5]) {
      // Before any render, a page's text is asked of the thread index % threads; a render
      // of a page that doesn't exist fails on that same thread meanwhile.
      const slot = r.workers[index % r.workers.length];
      const failing = r.render(9999, { x0: 0, y0: 0, x1: 10, y1: 10 }, 50, -3, { cache: false, slot }).then(() => "rendered", () => "failed");
      const [text, outcome] = await Promise.all([r.vectorText(index), failing]);
      eq(outcome, "failed");
      ok(text, `page ${index + 1}: the text came (null: dropped)`);
      ok(text.instances.length > 0, `page ${index + 1}: it has glyphs`);
      ok(text.instances.every((g) => typeof g.key === "string" && g.key), "every placement names its glyph for the renders to leave out");
    }
  } finally {
    r.destroy();
  }
});

test("vector text: every render thread leaves out exactly the glyphs it is told, and keeps all text when told none", async () => {
  const bytes = await makeSamplePdf({ pages: 4 });
  const r = await createRenderer(bytes, () => openForRendering(bytes));
  try {
    // Page 2: dark type on a light ground (the cover's type is white on a dark one).
    const trim = { x0: 9, y0: 9, x1: 157, y1: 219 };
    const text = await r.vectorText(1);
    const keys = text.instances.map((g) => g.key);
    ok(keys.length > 5, `page 2 has ${keys.length} glyphs`);
    // The same image from every thread, also the ones that never saw the page before.
    const images = await Promise.all(r.workers.map((slot) => r.render(1, trim, 400, -3, { cache: false, slot, vector: keys })));
    const pixels = await Promise.all(images.map(pixelsOf));
    for (let i = 1; i < pixels.length; i++) ok(same(pixels[0], pixels[i]), `thread ${i} drew the page differently from thread 0`);
    // Told nothing to leave out: the text is in the image (more dark pixels).
    const full = await pixelsOf(await r.render(1, trim, 400, -3, { cache: false, vector: null }));
    const without = darkPixels(pixels[0]);
    const withText = darkPixels(full);
    ok(withText > without + 200, `with its text ${withText} dark pixels, without ${without}`);
    // Half the glyphs left out: between the two.
    const half = await pixelsOf(await r.render(1, trim, 400, -3, { cache: false, vector: keys.slice(0, keys.length >> 1) }));
    const partly = darkPixels(half);
    ok(partly > without && partly < withText, `half the glyphs: ${partly} dark pixels`);
  } finally {
    r.destroy();
  }
});

test("overprint: an overprinting fill multiplies with what is under it when shown, covers it when ignored", async () => {
  const { PDFDocument, PDFName, cmyk, pushGraphicsState, popGraphicsState, setGraphicsState } = await import("../vendor/pdf-lib.esm.js");
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 200]);
  page.drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: cmyk(1, 0, 0, 0) }); // cyan
  const gs = pdf.context.register(pdf.context.obj({ Type: "ExtGState", OP: true, op: true, OPM: 1 }));
  page.node.setExtGState(PDFName.of("GSo"), gs);
  page.pushOperators(pushGraphicsState(), setGraphicsState("GSo"));
  page.drawRectangle({ x: 50, y: 50, width: 100, height: 100, color: cmyk(0, 0, 1, 0) }); // yellow, overprinting
  page.pushOperators(popGraphicsState());
  const bytes = await pdf.save();
  const centre = async (shown) => {
    const r = await createRenderer(bytes, () => openForRendering(bytes), null, shown);
    try {
      const px = await pixelsOf(await r.render(0, { x0: 0, y0: 0, x1: 70.56, y1: 70.56 }, 100, -3, { cache: false }));
      const i = 4 * (50 * 100 + 50);
      return [px[i], px[i + 1], px[i + 2]];
    } finally {
      r.destroy();
    }
  };
  const [shown, ignored] = await Promise.all([centre(true), centre(false)]);
  ok(ignored[0] > 180 && ignored[1] > 180 && ignored[2] < 120, `ignored: yellow covers the cyan (${ignored})`);
  ok(shown[0] < 100 && shown[1] > 100 && shown[2] < 120, `shown: yellow over cyan is green (${shown})`);
});
