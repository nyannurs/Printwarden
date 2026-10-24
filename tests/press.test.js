// Pages drawn for a press (tools/mupdf/printwarden.c, pdf/mupdf-render.js): plain CMYK taken as
// it is in the chosen profile, RGB content converted through it, however the PDF sets its
// colour spaces; the spot colours listed and left out by name; a render thread that fails
// replaced (pdf/render.js).

import { createRenderer } from "../app/pdf/render.js";
import { eq, near, ok, test } from "./harness.js";

const PT = 72 / 25.4;
const W = 300; // the test page, points: three patches 100 pt wide
const H = 100;
const whole = { x0: 0, y0: 0, x1: W / PT, y1: H / PT };

/** The ink bytes (C, M, Y, K) at a point of a drawing H px tall (1 px a point). */
const inkAt = (ink, x, y = 50) => [...ink.data.subarray((y * ink.width + x) * 4, (y * ink.width + x) * 4 + 4)];

const eci = async () => new Uint8Array(await (await fetch("../vendor/icc/ISOcoated_v2_eci.icc")).arrayBuffer());

/**
 * Page 1: black (K 100), cyan (C 100) and an RGB blue, side by side, then a strip of the spot
 * "Spot A". Page 2: "Spot B" then "Spot A" (the other order on the page), then an image in
 * "Spot A" (as Photoshop exports a spot channel). `intent`: an output
 * intent too (the ECI profile), which MuPDF applies over a draw device's own defaults.
 */
async function pressPdf({ intent = null } = {}) {
  const { PDFDocument, PDFName, PDFNumber, PDFOperator, cmyk, rgb } = await import("../vendor/pdf-lib.esm.js");
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const spot = (name, c1) => ctx.register(ctx.obj([PDFName.of("Separation"), PDFName.of(name), PDFName.of("DeviceCMYK"),
    { FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: c1, N: 1 }]));
  const a = spot("Spot A", [0, 0.5, 1, 0]);
  const b = spot("Spot B", [1, 0, 0, 0.5]);
  const fill = (cs, x) => [
    PDFOperator.of("q"), PDFOperator.of("cs", [PDFName.of(cs)]), PDFOperator.of("scn", [PDFNumber.of(1)]),
    PDFOperator.of("re", [x, 0, 100, 20].map((v) => PDFNumber.of(v))), PDFOperator.of("f"), PDFOperator.of("Q"),
  ];
  const p1 = doc.addPage([W, H]);
  p1.drawRectangle({ x: 0, y: 20, width: 100, height: 80, color: cmyk(0, 0, 0, 1) });
  p1.drawRectangle({ x: 100, y: 20, width: 100, height: 80, color: cmyk(1, 0, 0, 0) });
  p1.drawRectangle({ x: 200, y: 20, width: 100, height: 80, color: rgb(0.2, 0.6, 0.9) });
  p1.node.Resources().set(PDFName.of("ColorSpace"), ctx.obj({ A: a }));
  p1.pushOperators(...fill("A", 0));
  const p2 = doc.addPage([W, H]);
  p2.node.Resources().set(PDFName.of("ColorSpace"), ctx.obj({ B: b, A: a }));
  const image = ctx.register(ctx.stream(new Uint8Array(16).fill(255), {
    Type: "XObject", Subtype: "Image", Width: 4, Height: 4, BitsPerComponent: 8, ColorSpace: a,
  }));
  p2.node.setXObject(PDFName.of("ImA"), image);
  p2.pushOperators(...fill("B", 0), ...fill("A", 100),
    PDFOperator.of("q"), PDFOperator.of("cm", [100, 0, 0, 20, 200, 0].map((v) => PDFNumber.of(v))),
    PDFOperator.of("Do", [PDFName.of("ImA")]), PDFOperator.of("Q"));
  if (intent) {
    const profile = ctx.register(ctx.flateStream(intent, { N: 4 }));
    doc.catalog.set(PDFName.of("OutputIntents"), ctx.obj([ctx.obj({
      Type: "OutputIntent", S: PDFName.of("GTS_PDFX"), OutputConditionIdentifier: "FOGRA39", DestOutputProfile: profile,
    })]));
  }
  return doc.save();
}

test("PRESS: plain CMYK exact in the chosen profile, RGB converted through it, an output intent or not", async () => {
  const profile = await eci();
  for (const intent of [null, profile]) {
    const bytes = await pressPdf({ intent });
    const own = await createRenderer(bytes); // MuPDF's own CMYK
    const chosen = await createRenderer(bytes, profile);
    try {
      const a = await own.render(0, whole, H, 0, { mode: "ink", cache: false });
      const b = await chosen.render(0, whole, H, 0, { mode: "ink", cache: false });
      const what = intent ? "with an output intent" : "without one";
      for (const ink of [a, b]) {
        eq(inkAt(ink, 50, 20), [0, 0, 0, 255], `K 100 stays K 100 (${what})`);
        eq(inkAt(ink, 150, 20), [255, 0, 0, 0], `C 100 stays C 100 (${what})`);
      }
      const rgbOwn = inkAt(a, 250, 20), rgbChosen = inkAt(b, 250, 20);
      ok(rgbOwn.some((v, i) => Math.abs(v - rgbChosen[i]) >= 3), `RGB content follows the profile (${what}): ${rgbOwn} vs ${rgbChosen}`);
      // The sRGB image through the profile: ISO Coated v2's solid black and cyan.
      const img = await chosen.render(0, whole, H, 0, { cache: false });
      const c = new OffscreenCanvas(img.width, img.height).getContext("2d");
      c.drawImage(img, 0, 0);
      const px = (x) => [...c.getImageData(x, 20, 1, 1).data.slice(0, 3)];
      px(50).forEach((v, i) => near(v, [26, 26, 24][i], 3, `ECI black on screen (${what})`));
      px(150).forEach((v, i) => near(v, [0, 158, 227][i], 3, `ECI cyan on screen (${what})`));
    } finally {
      own.destroy();
      chosen.destroy();
    }
  }
});

test("SPOTS: the document's spots by name, their CMYK look and pages; one left out by name isn't drawn, whatever its order on a page", async () => {
  const r = await createRenderer(await pressPdf());
  try {
    const spots = await r.spots();
    eq(spots.map((s) => [s.name, s.pages]), [["Spot A", [0, 1]], ["Spot B", [1]]]);
    spots[0].cmyk.forEach((v, i) => near(v, [0, 0.5, 1, 0][i], 1e-3, "Spot A's look"));
    const strip = async () => {
      const ink = await r.render(1, whole, H, 0, { mode: "ink", cache: false });
      return { b: inkAt(ink, 50, 90), a: inkAt(ink, 150, 90), image: inkAt(ink, 250, 90) };
    };
    const all = await strip();
    ok(all.a.some((v) => v > 0) && all.b.some((v) => v > 0), "both spots drawn");
    eq(all.image, all.a, "the image in Spot A: the same ink as the fill");
    r.setSpotsOff(["Spot A"]);
    const without = await strip();
    eq(without.a, [0, 0, 0, 0], "Spot A left out: paper");
    // (MuPDF drew it through its alternate colour space: tools/mupdf/separation-disabled-images.patch.)
    eq(without.image, [0, 0, 0, 0], "Spot A left out of the image too");
    eq(without.b, all.b, "Spot B as it was");
    r.setSpotsOff([]);
    eq((await strip()).a, all.a, "Spot A back");
  } finally {
    r.destroy();
  }
});

test("RESTART: a render thread that fails is replaced, its render tried again there, the others carry on", async () => {
  const r = await createRenderer(await pressPdf(), await eci());
  try {
    const threads = r.workers.length;
    const asked = r.render(0, whole, H, 0, { mode: "ink", cache: false });
    const slot = r.workers.find((s) => s.job);
    ok(slot, "a thread drawing");
    const failed = slot.worker;
    failed.dispatchEvent(new ErrorEvent("error", { message: "test: the thread failed" })); // as an uncaught error in it
    const ink = await asked;
    eq(inkAt(ink, 50, 20), [0, 0, 0, 255], "drawn all the same, with the profile");
    eq(r.workers.length, threads, "as many threads");
    ok(slot.worker !== failed, "a new thread in its place");
    eq(r.restarts, 1);
    const again = await r.render(1, whole, H, 0, { mode: "ink", cache: false, slot });
    ok(again.width > 0, "the new thread draws");
  } finally {
    r.destroy();
  }
});
