// Pages drawn for a press (tools/mupdf/printwarden.c, pdf/mupdf-render.js): plain CMYK taken as
// it is in the chosen profile, RGB content converted through it, however the PDF sets its
// colour spaces; the spot colours listed, drawn as channels of their own and mixed in as MuPDF
// composites them, left out by name; a render thread that fails replaced (pdf/render.js).

import * as mupdf from "../vendor/mupdf/mupdf.js";
import { InkDocument } from "../app/pdf/mupdf-render.js";
import { createRenderer } from "../app/pdf/render.js";
import { mixImage } from "../app/viewer/inklut.js";
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
 * "Spot A" (as Photoshop exports a spot channel). Page 3, overprint: cyan all over; Spot A
 * overprinting it, Spot B knocking it out, and 50 % black overprinting Spot A. Page 4: five
 * spots side by side (one more than an ink image has channels for). `intent`: an output
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
  const p3 = doc.addPage([W, H]);
  p3.node.Resources().set(PDFName.of("ColorSpace"), ctx.obj({ B: b, A: a }));
  p3.node.Resources().set(PDFName.of("ExtGState"), ctx.obj({ OP: ctx.obj({ OP: true, op: true, OPM: 1 }) }));
  const n = (...v) => v.map((x) => PDFNumber.of(x));
  p3.pushOperators(
    PDFOperator.of("k", n(1, 0, 0, 0)), PDFOperator.of("re", n(0, 0, W, H)), PDFOperator.of("f"),
    PDFOperator.of("q"), PDFOperator.of("gs", [PDFName.of("OP")]), ...fill("A", 0), PDFOperator.of("Q"),
    ...fill("B", 100),
    PDFOperator.of("q"), PDFOperator.of("gs", [PDFName.of("OP")]), PDFOperator.of("k", n(0, 0, 0, 0.5)),
    PDFOperator.of("re", n(50, 10, 100, 60)), PDFOperator.of("f"), PDFOperator.of("Q"),
  );
  const p4 = doc.addPage([W, H]);
  const five = ["S1", "S2", "S3", "S4", "S5"];
  p4.node.Resources().set(PDFName.of("ColorSpace"), ctx.obj(Object.fromEntries(five.map((name, i) => [name, spot(name, [0.2 * i, 0.1, 0, 0.1])]))));
  p4.pushOperators(...five.flatMap((name, i) => [
    PDFOperator.of("q"), PDFOperator.of("cs", [PDFName.of(name)]), PDFOperator.of("scn", n(1)),
    PDFOperator.of("re", n(60 * i, 0, 60, H)), PDFOperator.of("f"), PDFOperator.of("Q"),
  ]));
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

/**
 * Page `index` of `bytes` as MuPDF composites it (every spot into the process inks, or left out:
 * `off`), in `profile`: the reference the views' mixing is held to. Drawn with the renderer's own
 * calls on the main thread, every spot set to be composited.
 */
function composited(bytes, index, profile, off = []) {
  const lib = mupdf.libmupdfModule;
  const doc = new InkDocument(bytes);
  try {
    doc.setProfile(profile);
    doc.setSpotsOff(off);
    const p = doc.page(index);
    const channels = p.spots.length; // the ink image's would-be channels: composited instead
    p.spots.forEach((name, i) => lib._wasm_pw_set_separation_behavior(p.seps, i, off.includes(name) ? 2 : 0));
    const scale = H / (p.page.getBounds()[3] - p.page.getBounds()[1]);
    const at = (floats) => {
      const ptr = lib._wasm_malloc(4 * floats.length);
      lib.HEAPF32.set(floats, ptr >> 2);
      return ptr;
    };
    const pix = new mupdf.Pixmap(lib._wasm_pw_new_pixmap_from_page(p.page.pointer, at([scale, 0, 0, scale, 0, 0]),
      at([0, 0, W, H]), doc.profile.pointer, p.seps, 0, doc.profile.pointer));
    const data = pix.getPixels().slice();
    pix.destroy();
    ok(channels > 0 && data.length === W * H * 4, "composited: the four process inks only");
    return data;
  } finally {
    doc.destroy();
  }
}

test("SPOTS: the document's spots by name, their look and pages; each page's (up to four) as channels of their own", async () => {
  const bytes = await pressPdf();
  const r = await createRenderer(bytes);
  try {
    const spots = await r.spots();
    const byName = new Map(spots.map((s) => [s.name, s]));
    eq(byName.get("Spot A").pages, [0, 1, 2]);
    eq(byName.get("Spot B").pages, [1, 2]);
    byName.get("Spot A").cmyk.forEach((v, i) => near(v, [0, 0.5, 1, 0][i], 1e-3, "Spot A's look"));
    // Page 4's five: four as channels, one composited (which one is the page's own order).
    const five = ["S1", "S2", "S3", "S4", "S5"].map((name) => byName.get(name));
    eq(five.map((s) => s.pages), [[3], [3], [3], [3], [3]]);
    eq(five.filter((s) => s.composited.length).map((s) => s.composited), [[3]], "one of five composited");
    // Page 2: Spot A in a channel of its own, fill and image alike; no process ink under it.
    const ink = await r.render(1, whole, H, 0, { mode: "ink", cache: false });
    const ch = ink.spotNames.indexOf("Spot A");
    ok(ch >= 0 && ink.spotNames.includes("Spot B"), `its spots' channels: ${ink.spotNames}`);
    const spotAt = (x, y = 90) => ink.spots[(y * ink.width + x) * 4 + ch];
    eq([inkAt(ink, 150, 90), spotAt(150)], [[0, 0, 0, 0], 255], "the fill: Spot A at full tint, no CMYK");
    eq([inkAt(ink, 250, 90), spotAt(250)], [[0, 0, 0, 0], 255], "the image in Spot A: the same");
  } finally {
    r.destroy();
  }
});

// (MuPDF's composite with a spot left out knocked out what an overprinting fill in it lay on:
// tools/mupdf/overprint-disabled-separations.patch.)
test("SPOTS MIXED: the channels mixed in as the views do (CMYK + tint × look) are MuPDF's composite, overprint and a spot left out included", async () => {
  const bytes = await pressPdf();
  const profile = await eci();
  const r = await createRenderer(bytes, profile);
  try {
    const looks = new Map((await r.spots()).map((s) => [s.name, s.cmyk]));
    for (const off of [[], ["Spot A"], ["Spot B", "S2"]]) {
      r.setSpotsOff(off); // (the composited fifth on page 4, if it is one of these)
      const printing = new Map([...looks].filter(([name]) => !off.includes(name)));
      for (const index of [0, 1, 2, 3]) {
        const ink = await r.render(index, whole, H, 0, { mode: "ink", cache: false });
        const mixed = mixImage(ink, [true, true, true, true], printing);
        const reference = composited(bytes, index, profile, off);
        let worst = 0;
        for (let i = 0; i < mixed.length; i++) worst = Math.max(worst, Math.abs(mixed[i] - reference[i]));
        ok(worst <= 1, `page ${index + 1}, ${off.join(", ") || "every spot"} printing: off by ${worst} of 255 at most`);
      }
    }
    // What a plate left out means on page 3: its ink isn't there, the others are as printed.
    const page3 = await r.render(2, whole, H, 0, { mode: "ink", cache: false });
    const mixedAt = (off, x, y) => {
      const m = mixImage(page3, [true, true, true, true], new Map([...looks].filter(([name]) => !off.includes(name))));
      return [...m.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)];
    };
    eq(mixedAt(["Spot A"], 50, 90), [255, 0, 0, 0], "Spot A overprinting cyan, left out: the cyan under it");
    eq(mixedAt(["Spot B"], 150, 90), [0, 0, 0, 0], "Spot B knocking cyan out, left out: paper");
    eq(mixedAt(["Spot A"], 100, 60), [255, 0, 0, 127], "black overprinting Spot A, Spot A left out: cyan and black");
  } finally {
    r.destroy();
  }
});

test("SPOTS LEFT OUT: a spot left out by name isn't drawn in sRGB images (fills and images in it), nor where composited", async () => {
  const bytes = await pressPdf();
  const r = await createRenderer(bytes);
  try {
    const shot = async (index) => {
      const img = await r.render(index, whole, H, 0, { cache: false });
      const c = new OffscreenCanvas(img.width, img.height).getContext("2d");
      c.drawImage(img, 0, 0);
      return (x, y = 90) => [...c.getImageData(x, y, 1, 1).data.slice(0, 3)];
    };
    const before = await shot(1);
    ok(before(150).some((v) => v < 200), "Spot A drawn");
    r.setSpotsOff(["Spot A"]);
    const after = await shot(1);
    eq(after(150), [255, 255, 255], "the fill: paper");
    // (MuPDF drew it through its alternate colour space: tools/mupdf/separation-disabled-images.patch.)
    eq(after(250), [255, 255, 255], "the image in it: paper");
    eq(after(50), before(50), "Spot B as it was");
    const fifth = (await r.spots()).find((s) => s.composited.length).name;
    const strip = 60 * ["S1", "S2", "S3", "S4", "S5"].indexOf(fifth) + 30;
    const withIt = await r.render(3, whole, H, 0, { mode: "ink", cache: false });
    ok(inkAt(withIt, strip).some((v) => v > 0), "the composited spot in the process inks");
    r.setSpotsOff([fifth]);
    eq(inkAt(await r.render(3, whole, H, 0, { mode: "ink", cache: false }), strip), [0, 0, 0, 0], "left out: paper");
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
