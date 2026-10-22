// The test documents in testfiles/ (made by tools/make-testfiles.mjs) through the app's own
// import path: the structure read in a background thread, the analysis with a cover file,
// and the render workers drawing a page with and without overprint. What the designer
// checks by eye with these files, settled by numbers where numbers can (0.17.85).

import { analyse } from "../app/core/analysis.js";
import { openPdf } from "../app/pdf/load.js";
import { createRenderer } from "../app/pdf/render.js";
import { eq, near, ok, test } from "./harness.js";

const bytesOf = async (name) => {
  const r = await fetch(`../testfiles/${name}`);
  ok(r.ok, `${name}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};
const cache = new Map();
/** The structure of a test file, read once. */
async function open(name) {
  if (!cache.has(name)) cache.set(name, bytesOf(name).then(async (bytes) => ({ bytes, ...(await openPdf(bytes)) })));
  return cache.get(name);
}
/** book-36 analysed with a cover file. */
async function withCover(coverName, setup) {
  const book = await open("book-36.pdf");
  const cover = await open(coverName);
  return analyse({ pages: book.pages, cover: { name: coverName, pages: cover.pages } }, setup);
}
const labels = (a) => a.book.pages.map((p) => p.label);

test("fixtures: book-36 with cover-36: C1 to C4 round the 36 pages, the spine 3 mm, no cover warning", async () => {
  const a = await withCover("cover-36.pdf", { binding: "perfect" });
  eq(a.book.pages.length, 40);
  eq(labels(a).slice(0, 2), ["C1", "C2"]);
  eq(labels(a).slice(-2), ["C3", "C4"]);
  near(a.coverFile.spineMm, 3, 0.05, "the cover's spine: 40 pages of the default paper");
  near(a.coverFile.calculatedSpineMm, 3, 0.05);
  eq(a.coverFile.error, null);
  ok(!a.findings.some((f) => f.code === "cover-spine"), "no spine warning");
  ok(!a.hasErrors, JSON.stringify(a.findings.filter((f) => f.severity === "error")));
  ok(a.coverFile.spineRect && a.coverFile.spineRect.x1 - a.coverFile.spineRect.x0 > 2.9, "the spine strip for its artwork");
});

test("fixtures: cover-36-wrong-spine (6 mm) warns, cover-36-flaps has 80 mm flaps, cover-36-outside-only has no inside", async () => {
  const wrong = await withCover("cover-36-wrong-spine.pdf", { binding: "perfect" });
  near(wrong.coverFile.spineMm, 6, 0.05);
  const warning = wrong.findings.find((f) => f.code === "cover-spine");
  ok(warning, "the cover-spine warning");
  ok(/6(\.0)? mm/.test(warning.message) && /\b3(\.0)? mm/.test(warning.message), `names both figures: ${warning.message}`);
  const flaps = await withCover("cover-36-flaps.pdf", { binding: "perfect" });
  ok(flaps.coverFile.flapMm > 79 && flaps.coverFile.flapMm < 81, `flaps ${flaps.coverFile.flapMm}`);
  ok(flaps.findings.some((f) => f.code === "cover-flaps"));
  const outside = await withCover("cover-36-outside-only.pdf", { binding: "perfect" });
  eq(outside.coverFile.pageCount, 1);
  eq(outside.coverFile.inside, false, "C2 and C3 unprinted");
  eq(outside.geometry[1], null, "C2 has no artwork");
});

test("fixtures: cover-36-hardcover on a hardcover: 8 mm spine (36 pages, 4 endpapers, 2.5 mm boards), taller is allowed, endpapers E1 to E4", async () => {
  // 36 pages between the cover file's covers: 12-page signatures (16 don't divide 36: preflight's page-count error).
  const bad = await withCover("cover-36-hardcover.pdf", { binding: "hardcover" });
  ok(bad.findings.some((f) => f.code === "page-count" && /multiple of 16/.test(f.message)), "16-page signatures: 36 don't fit, and it says so");
  const a = await withCover("cover-36-hardcover.pdf", { binding: "hardcover", signaturePages: 12 });
  eq(a.book.pages.length, 44);
  eq(labels(a).filter((l) => /^E/.test(l)), ["E1", "E2", "E3", "E4"]);
  near(a.coverFile.spineMm, 8, 0.05);
  near(a.coverFile.calculatedSpineMm, 8, 0.05, "the app's own figure agrees with the file");
  ok(a.coverFile.heightMm > a.coverFile.pageHeightMm + 5, "the case is taller than the pages");
  ok(!a.hasErrors, JSON.stringify(a.findings.filter((f) => f.severity === "error")));
});

test("fixtures: spine-36 is 2.7 mm wide, spine-36-too-wide 12; the booklets impose on 4 and 11 sheets; book-36 sewn in two signatures", async () => {
  const spine = await open("spine-36.pdf");
  const t = spine.pages[0].trimBox ?? spine.pages[0].mediaBox;
  near(t.x1 - t.x0, 2.7, 0.05);
  near(t.y1 - t.y0, 210, 0.05);
  const wide = await open("spine-36-too-wide.pdf");
  const w = wide.pages[0].trimBox ?? wide.pages[0].mediaBox;
  near(w.x1 - w.x0, 12, 0.05);
  const b16 = analyse({ pages: (await open("booklet-16.pdf")).pages }, { binding: "saddle" });
  ok(!b16.hasErrors);
  eq(b16.layout.sheetCount, 4);
  const b44 = analyse({ pages: (await open("booklet-44.pdf")).pages }, { binding: "saddle" });
  ok(!b44.hasErrors);
  eq(b44.layout.sheetCount, 11);
  ok(b44.findings.some((f) => f.code === "creep" || /creep|fold/i.test(f.message)), "the fold's creep is noted");
  const sewn = analyse({ pages: (await open("book-36.pdf")).pages }, { binding: "sewn", signaturePages: 16 });
  ok(!sewn.hasErrors);
  eq(sewn.rule.signaturePages, 16);
});

test("fixtures: colour-profiles-intent carries an output intent (From PDF), colour-profiles none", async () => {
  const intent = await open("colour-profiles-intent.pdf");
  ok(intent.outputIntent, "an output intent");
  ok(/CGATS/i.test(intent.outputIntent.name), intent.outputIntent.name);
  ok(intent.outputIntent.profile?.length > 1000, "with its profile");
  eq((await open("colour-profiles.pdf")).outputIntent, null);
});

/** A page of a test file drawn by the render workers, at 2 px/mm, as RGBA. */
async function draw(name, pageIndex, overprint) {
  const { bytes, pages } = await open(name);
  const r = await createRenderer(bytes, () => { throw new Error("fell back to the main thread"); }, null, overprint);
  try {
    const m = pages[pageIndex].trimBox ?? pages[pageIndex].mediaBox;
    const img = await r.render(pageIndex, m, Math.round(2 * (m.y1 - m.y0)));
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    img.close?.();
    return { data: ctx.getImageData(0, 0, c.width, c.height).data, width: c.width, height: c.height };
  } finally {
    r.destroy();
  }
}
const px = (f, xMm, yMmFromTop) => {
  const k = 4 * (Math.round(yMmFromTop * 2) * f.width + Math.round(xMm * 2));
  return [f.data[k], f.data[k + 1], f.data[k + 2]];
};

test("fixtures: spot-image.pdf: an image in a spot ink is drawn as the ink, as bright as the flat fill beside it", async () => {
  const f = await draw("spot-image.pdf", 0, false);
  const [fr, fg, fb] = px(f, 40, 210 - 110);
  const [ir, ig, ib] = px(f, 108, 210 - 110);
  ok(fr > 200 && fg < 130, `the flat fill is pink (${fr}, ${fg}, ${fb})`);
  ok(Math.abs(ir - fr) <= 3 && Math.abs(ig - fg) <= 3 && Math.abs(ib - fb) <= 3, `the image the same (${ir}, ${ig}, ${ib}), not the tint transform's mauve`);
});

test("fixtures: overprint.pdf: the overprinting yellow box turns green on the cyan panel, the knockout box stays yellow (overprint as the press prints it)", async () => {
  const f = await draw("overprint.pdf", 0, true);
  // The yellow boxes: 50 × 28 mm from x 16 (knockout) and x 80 (overprint), y 108 to 136 from the foot.
  const knock = [41, 210 - 122];
  const over = [105, 210 - 122];
  const cyan = [41, 210 - 70]; // the panel alone, beside the black text row
  const [r, g, b] = px(f, ...knock);
  ok(r > 200 && g > 180 && b < 90, `the knockout box is yellow (${r}, ${g}, ${b})`);
  const [cr, , cb] = px(f, ...cyan);
  ok(cr < 90 && cb > 160, `the panel is cyan (${cr}, ${cb})`);
  const [sr, sg, sb] = px(f, ...over);
  ok(sr < 110 && sg > 120 && sb < 110, `the overprinting box is green (${sr}, ${sg}, ${sb})`);
});
