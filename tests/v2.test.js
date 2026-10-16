// Setup hardening, imposed files, sheet plans and the 3D book model.

import { analyse } from "../app/core/analysis.js";
import { ruleFor } from "../app/core/binding.js";
import { buildImposedBook, label } from "../app/core/book.js";
import { saddleStitchLayout } from "../app/core/imposition.js";
import { defaultExportOptions, planSheets } from "../app/core/sheets.js";
import { setupFromPdf, sheetAreaFor, snap } from "../app/core/setup.js";
import { rect, rectSize } from "../app/core/units.js";
import { HOLE_OFFSET_MM, layoutBook, leafProfile, makeBook, restingAngle, samples, turnCurl } from "../app/viewer/model.js";
import { eq, near, ok, test } from "./harness.js";
import { calculatedSpine, hasSpine, paperForSpine, spineTakesArtwork } from "../app/core/spine.js";

const page = (index, w, h, { bleed = 0, slug = 0, trim = true } = {}) => {
  const o = bleed + slug;
  return {
    index,
    mediaBox: rect(0, 0, w + 2 * o, h + 2 * o),
    trimBox: trim && o ? rect(o, o, o + w, o + h) : null,
    bleedBox: trim && o ? rect(slug, slug, w + 2 * bleed + slug, h + 2 * bleed + slug) : null,
    rotation: 0,
  };
};

// --- setup detection on awkward files ---------------------------------------------

test("non-DIN sizes are taken as they are", () => {
  const s = setupFromPdf([page(0, 170, 240, { bleed: 5 }), page(1, 170, 240, { bleed: 5 })], [false, false]);
  eq([s.width, s.height, s.bleed.top], [170, 240, 5]);
});

test("InDesign's pt rounding is snapped to clean millimetres", () => {
  eq(snap(147.99992977), 148);
  eq(snap(209.9999), 210);
  eq(snap(3.1749), 3.17);
  eq(snap(12.51), 12.5);
});

test("median over pages: one odd cover doesn't skew the setup", () => {
  const pages = [page(0, 200, 200, { bleed: 1 }), ...Array.from({ length: 7 }, (_, i) => page(i + 1, 148, 210, { bleed: 3 }))];
  const s = setupFromPdf(pages, pages.map(() => false));
  eq([s.width, s.height, s.bleed.outside], [148, 210, 3]);
});

test("asymmetric bleed: inside and outside are told apart via recto/verso", () => {
  // Recto (pdf 1): 0 mm left (inside), 3 mm right. Verso (pdf 2): 3 mm left, 0 mm right.
  const recto = { index: 0, mediaBox: rect(0, 0, 151, 216), trimBox: rect(0, 3, 148, 213), bleedBox: null, rotation: 0 };
  const verso = { index: 1, mediaBox: rect(0, 0, 151, 216), trimBox: rect(3, 3, 151, 213), bleedBox: null, rotation: 0 };
  const s = setupFromPdf([recto, verso], [false, false]);
  eq([s.bleed.inside, s.bleed.outside, s.bleed.top], [0, 3, 3]);
});

test("spreads: width is half the spread; inside assumed equal to outside", () => {
  const spread = { index: 0, mediaBox: rect(0, 0, 302, 216), trimBox: rect(3, 3, 299, 213), bleedBox: rect(0, 0, 302, 216), rotation: 0 };
  const s = setupFromPdf([spread], [true]);
  eq([s.width, s.bleed.outside, s.bleed.inside], [148, 3, 3]);
});

test("area outside the bleed box is reported as slug (could be marks)", () => {
  const s = setupFromPdf([page(0, 148, 210, { bleed: 3, slug: 12 })], [false]);
  eq([s.bleed.top, s.slug.top], [3, 12]);
});

// --- imposed files -------------------------------------------------------------------

test("imposed file folds back into reading order", () => {
  const sheets = Array.from({ length: 4 }, (_, i) => ({ index: i, mediaBox: rect(0, 0, 296, 210), trimBox: null, bleedBox: null, rotation: 0 }));
  const book = buildImposedBook(sheets, saddleStitchLayout(8));
  // sheet 1 front = 8 | 1: folio 1 is the right half of pdf page 1, folio 8 the left half.
  eq([book.pages[0].source.index, book.pages[0].half], [0, "right"]);
  eq([book.pages[7].source.index, book.pages[7].half], [0, "left"]);
  eq([book.pages[1].source.index, book.pages[1].half], [1, "left"]); // back: 2 | 7
  eq(book.pages.map((p) => p.number), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("imposed analysis: halves of the trim box; count errors are explained", () => {
  const sheets = Array.from({ length: 4 }, (_, i) => page(i, 296, 210, { bleed: 3 }));
  const a = analyse({ pages: sheets }, { source: "imposed" });
  ok(!a.hasErrors, JSON.stringify(a.findings));
  eq(a.book.pages.length, 8);
  eq(rectSize(a.geometry[0].trim), { width: 148, height: 210 });
  const odd = analyse({ pages: sheets.slice(0, 3) }, { source: "imposed" });
  ok(odd.findings.some((f) => f.code === "imposed-odd"));
});

test("imposed sheets with a marks margin: page area centred from the setup", () => {
  const sheet = { index: 0, mediaBox: rect(0, 0, 340, 250), trimBox: null, bleedBox: null, rotation: 0 };
  const area = sheetAreaFor(sheet, { mode: "manual", width: 148, height: 210 });
  eq(area, rect(22, 20, 318, 230));
});

// --- sheet plan ------------------------------------------------------------------------

const singles = (n) => Array.from({ length: n }, (_, i) => page(i, 148, 210, { bleed: 3 }));

test("auto sheet fits two pages, bleed and marks", () => {
  const a = analyse({ pages: singles(8) });
  const plan = planSheets(a, defaultExportOptions());
  eq(plan.errors, []);
  const m = 3 + 5 + 4; // offset + mark length + info line
  near(plan.sheetSize.width, 296 + 2 * m);
  near(plan.sheetSize.height, 210 + 2 * m);
  eq(plan.sides.length, 4);
  eq(plan.sides[0].placements.map((p) => p.folio), [8, 1]);
});

test("spine side is cut at the fold; outer sides keep bleed", () => {
  const plan = planSheets(analyse({ pages: singles(8) }), defaultExportOptions());
  const [left, right] = plan.sides[0].placements;
  const cx = plan.sheetSize.width / 2;
  eq([left.clip.x1, right.clip.x0], [cx, cx]);
  near(left.trim.x0 - left.clip.x0, 3);
  near(right.clip.x1 - right.trim.x1, 3);
});

test("creep: zero on the outer sheet, grows inward, toward the spine", () => {
  const a = analyse({ pages: singles(16) });
  const plan = planSheets(a, { ...defaultExportOptions(), creep: true });
  const t = a.setup.paperThicknessMm;
  const fronts = plan.sides.filter((s) => s.side === "front");
  eq(fronts.map((s) => s.placements[0].creepMm.toFixed(4)), [0, 1, 2, 3].map((d) => (d * t).toFixed(4)));
  const inner = fronts[3].placements;
  const cx = plan.sheetSize.width / 2;
  near(inner[0].trim.x1 - cx, 3 * t); // left page shifted right
  near(cx - inner[1].trim.x0, 3 * t); // right page shifted left
});

test("a sheet that is too small is refused with the size needed", () => {
  const plan = planSheets(analyse({ pages: singles(8) }), { ...defaultExportOptions(), sheet: { width: 297, height: 210 } });
  ok(plan.errors.some((e) => e.includes("too small")), plan.errors.join());
});

test("A4 sheet for A5 without bleed or marks: fits exactly", () => {
  const plain = Array.from({ length: 8 }, (_, i) => page(i, 148, 210));
  const opts = { ...defaultExportOptions(), sheet: { width: 210, height: 297 }, bleed: false, marks: { crop: false, fold: false, info: false } };
  const plan = planSheets(analyse({ pages: plain }), opts);
  // The A4 is turned landscape: 297 × 210 holds two 148 × 210 pages.
  eq(plan.errors, []);
  eq(plan.sheetSize, { width: 297, height: 210 });
});

// --- 3D model ----------------------------------------------------------------------------

test("closed book: leaves stack flat with the cover on top, thickness adds up", () => {
  const book = makeBook({ pageCount: 44, binding: "perfect", thickness: 0.15, coverThickness: 0.3, width: 148, height: 210 });
  near(book.total, 20 * 0.15 + 2 * 0.3);
  const s = samples(148);
  const top = leafProfile(book, 0, 90, 1, 0, 0, s);
  const bottom = leafProfile(book, 21, 90, 1, 0, 0, s);
  ok(top.y[0] > bottom.y[0]);
  near(top.y[s.length - 1], top.y[0], 1e-3); // flat
  near(top.x[s.length - 1] - top.x[0], 148, 0.01); // full width
});

test("closed at the back cover: back cover on top, lying left of the spine", () => {
  const book = makeBook({ pageCount: 44, binding: "saddle", thickness: 0.15, coverThickness: 0.3, width: 148, height: 210 });
  const s = samples(148);
  const n = s.length - 1;
  const top = leafProfile(book, book.leafCount - 1, -62, 1, 0, 0, s, undefined, -1); // back cover
  const bottom = leafProfile(book, 0, -62, 1, 0, 0, s, undefined, -1); // front cover
  ok(top.y[n] > bottom.y[n], "the back cover is on top");
  near(top.x[n], -148, 0.5, "fore-edge to the left:");
  near(Math.abs(bottom.phi[n] * 180 / Math.PI), 90, 1e-4, "bottom flat:"); // stored as 32-bit floats
});

test("open book: turned leaves on the left, visible pages on top of their piles", () => {
  const book = makeBook({ pageCount: 44, binding: "saddle", thickness: 0.15, coverThickness: 0.15, width: 148, height: 210 });
  eq(Math.sign(restingAngle(book, 3, 5)), -1);
  eq(Math.sign(restingAngle(book, 5, 5)), 1);
  const s = samples(148);
  const leaves = book.thickness.map((_, i) => ({ theta: restingAngle(book, i, 5), curl: 0, s, profile: leafProfile(book, i, 90, 0, 0, 0, s) }));
  layoutBook(book, leaves, { closed: 0, side: 1, opening: 5 });
  const mid = s.length >> 1;
  ok(leaves[5].profile.y[mid] > leaves[10].profile.y[mid], "the visible right page above the ones beneath");
  ok(leaves[4].profile.y[mid] > leaves[0].profile.y[mid], "the visible left page above the ones beneath");
});

test("coil: a page's hole sits on the wire, open or closed; gutter strips don't overlap", () => {
  for (const binding of ["wire-o", "spiral"]) {
    const book = makeBook({ pageCount: 44, binding, thickness: 0.15, coverThickness: 0.15, width: 148, height: 210 });
    const s = samples(148);
    const right = leafProfile(book, 12, 88.5, 0, book.cum[11] + 0.075, 0, s, { psi: 0 });
    const left = leafProfile(book, 10, -88.5, 0, book.cum[11] + 0.075, 0, s, { psi: 0 });
    // Hole centre: HOLE_OFFSET_MM along the leaf from its spine edge.
    const hole = (p) => {
      const d = [Math.sin(p.phi[0]), Math.cos(p.phi[0])];
      return [p.x[0] + d[0] * HOLE_OFFSET_MM, p.y[0] + d[1] * HOLE_OFFSET_MM];
    };
    const onRing = ([x, y], c) => Math.abs(Math.hypot(x - c.x, y - c.y) - book.coilRadius);
    ok(onRing(hole(right), book.coilOpen) < 0.3, `${binding} right hole off the wire`);
    ok(onRing(hole(left), book.coilOpen) < 0.3, `${binding} left hole off the wire`);
    ok(right.x[0] > 0 && left.x[0] < 0, `${binding} strips overlap in the gutter`);
    const top = leafProfile(book, 0, 90, 1, 0, 0, s, { psi: 0 });
    ok(onRing(hole(top), book.coilClosed) < 0.3, `${binding} closed: top hole off the wire`);
  }
});

test("page turn: fore-edge leads while lifting, trails while settling", () => {
  // Turning right to left (62 -> -62): leading means a smaller angle at the fore-edge.
  ok(turnCurl(62, -62, 0.25) < 0);
  ok(turnCurl(62, -62, 0.75) > 0);
  eq(turnCurl(62, -62, 0), 0);
});

// --- colour management -----------------------------------------------------------------

test("output intent: a PDF/X-style CMYK profile is found and named", async () => {
  const { PDFDocument, PDFName } = await import("../vendor/pdf-lib.esm.js");
  const { readStructure } = await import("../app/pdf/structure.js");
  const icc = new Uint8Array(await (await fetch("../vendor/pdf-iccs/CGATS001Compat-v2-micro.icc")).arrayBuffer());
  const doc = await PDFDocument.create();
  doc.addPage([420, 595]);
  const profile = doc.context.flateStream(icc, { N: 4 });
  const intent = doc.context.obj({
    Type: "OutputIntent", S: "GTS_PDFX", OutputConditionIdentifier: "CGATS TR 001",
    DestOutputProfile: doc.context.register(profile),
  });
  doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([intent]));
  const found = (await readStructure(await doc.save())).outputIntent;
  ok(found, "no output intent found");
  eq(found.profile.length, icc.length);
  ok(found.name.length > 0);
});

test("coil: the wire crosses every page only inside its hole (both stacks, thick book)", () => {
  for (const binding of ["wire-o", "spiral"]) {
    const book = makeBook({ pageCount: 96, binding, thickness: 0.15, coverThickness: 0.3, width: 148, height: 210 });
    const s = samples(148);
    const opening = 17;
    const split = book.cum[opening - 1] + book.thickness[opening - 1] / 2;
    const R = book.coilRadius;
    const C = book.coilOpen;
    for (let i = 0; i < book.leafCount; i++) {
      const p = leafProfile(book, i, restingAngle(book, i, opening), 0, split, 0, s, { psi: 0 });
      const n = s.length - 1;
      const len = Math.hypot(p.x[n] - p.x[0], p.y[n] - p.y[0]);
      const d = [(p.x[n] - p.x[0]) / len, (p.y[n] - p.y[0]) / len];
      const hole = [p.x[0] + d[0] * HOLE_OFFSET_MM, p.y[0] + d[1] * HOLE_OFFSET_MM];
      // Where does the ring cross this page? |P0 + t d - C| = R
      const fx = p.x[0] - C.x;
      const fy = p.y[0] - C.y;
      const b = fx * d[0] + fy * d[1];
      const disc = b * b - (fx * fx + fy * fy - R * R);
      if (disc < 0) continue;
      for (const t of [-b - Math.sqrt(disc), -b + Math.sqrt(disc)]) {
        if (t < 0 || t > len) continue;
        const miss = Math.hypot(p.x[0] + d[0] * t - hole[0], p.y[0] + d[1] * t - hole[1]);
        ok(miss < book.style.holeRadius, `${binding}: leaf ${i} pierced ${miss.toFixed(2)} mm from its hole`);
      }
      ok(p.y[0] > book.ground - 0.01 && p.y[n] > book.ground - 0.5, `${binding}: leaf ${i} below the table`);
    }
  }
});

// --- sharp strips ---------------------------------------------------------------------

test("detail plan: a tilted page gets strips, sharper where it's nearer", async () => {
  const { planDetail } = await import("../app/viewer/detail.js");
  // Seen at an angle: density rises from 5 px/mm at the head (v = 0) to 40 at the foot.
  const samples = [];
  for (let v = 0; v <= 1; v += 0.1) for (let u = 0; u <= 1; u += 0.25) samples.push({ u, v, pxPerMm: 5 + 35 * v });
  const plan = planDetail({ region: { u0: 0, v0: 0, u1: 1, v1: 1 }, samples }, { width: 148, height: 210 },
    { supersample: 2, maxTiles: 6, maxSide: 1e6, maxPixels: 1e12 });
  eq(plan.length, 6);
  ok(plan.every((t, i) => i === 0 || t.region.v0 > plan[i - 1].region.v0), "strips run along v");
  ok(plan[5].pxPerMm > plan[0].pxPerMm * 2.5, "near strip much denser");
  ok(plan[5].pxPerMm >= 2 * 40 * 0.999, "near strip meets the need, supersampled");
  eq([plan[0].region.v0, plan[5].region.v1], [0, 1]); // covers the whole region
});

test("detail plan: limits are respected, flat view needs one strip", async () => {
  const { planDetail } = await import("../app/viewer/detail.js");
  const flat = [{ u: 0, v: 0, pxPerMm: 20 }, { u: 1, v: 1, pxPerMm: 20.5 }];
  const one = planDetail({ region: { u0: 0, v0: 0, u1: 1, v1: 1 }, samples: flat }, { width: 148, height: 210 },
    { supersample: 2, maxSide: 4096, maxPixels: 8e6 });
  eq(one.length, 1);
  ok(one[0].heightPx <= 4096 && one[0].widthPx <= 4096, "max side");
  ok(one[0].widthPx * one[0].heightPx <= 8e6 * 1.01, "max pixels");
});

// --- book spine --------------------------------------------------------------------------

test("spine: which bindings have one, and which take artwork", () => {
  eq(["saddle", "perfect", "sewn", "hardcover", "spiral", "wire-o"].map(hasSpine), [false, true, true, true, false, false]); // a stitched fold shows its cover
  eq(["saddle", "perfect", "sewn"].map(spineTakesArtwork), [false, true, true]);
});

test("spine: calculated width is every leaf's thickness, covers included", () => {
  const s = calculatedSpine(44, { gsm: 120, finish: "uncoated", coverGsm: 300 });
  eq([s.leaves, s.inner, s.covers], [22, 20, 2]);
  near(s.widthMm, 20 * 0.12 * 1.25 + 2 * 0.3 * 1.25, 1e-9);
});

test("spine: a printer's width gives the paper thickness that adds up to it", () => {
  const t = paperForSpine(10, 44, 0.3);
  near(20 * t + 2 * 0.3, 10, 1e-9);
  eq(paperForSpine(0.5, 44, 0.3), null, "thinner than the covers");
  eq(paperForSpine(10, 4, 0.3), null, "covers only");
});

test("hardcover: boards overhang, square back, sewn rule", () => {
  eq(ruleFor("hardcover").signaturePages, 16);
  const book = makeBook({ pageCount: 44, binding: "hardcover", thickness: 0.1, coverThickness: 0.3, width: 148, height: 210 });
  eq(book.thickness[0], 2.5, "boards, not cover stock");
  const s = samples(148);
  const closed = (i) => leafProfile(book, i, 90, 1, 0, 0, s);
  // Closed: the board's spine edge a joint in from the spine; the block's spine square.
  near(closed(0).x[0], book.style.joint, 1e-6);
  near(closed(Math.floor(book.leafCount / 2)).x[0], closed(1).x[0], 1e-6, "square back:");
});

// --- a separate cover file ---------------------------------------------------------------

const coverCase = (coverWidth, coverPageCount, setup = { binding: "perfect", signaturePages: 4 }) => {
  const r = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });
  const page = (index, w, h, l = null) => ({ index, mediaBox: r(0, 0, w, h), trimBox: r(0, 0, w, h), bleedBox: null, rotation: 0, label: l });
  const inner = Array.from({ length: 16 }, (_, i) => page(i, 148, 210, String(i + 1)));
  const cover = { name: "cover.pdf", pages: Array.from({ length: coverPageCount }, (_, i) => page(i, coverWidth, 210)) };
  return analyse({ pages: inner, cover }, setup);
};

test("cover file: four pages cut from it round the block, named C1 to C4, the spine from its width", () => {
  const a = coverCase(304, 2); // two pages and an 8 mm spine
  eq(a.book.pages.length, 20);
  eq([1, 2, 3, 18, 19, 20].map((f) => label(a.book, f)), ["C1", "C2", "1", "16", "C3", "C4"]);
  eq(a.coverFile.spineMm, 8);
  eq(a.coverFile.flapMm, 0);
  eq(a.coverFile.error, null);
  // C1 is the front cover: the right part of the outside page; C4 the back: its left part.
  eq([a.geometry[0].trim.x0, a.geometry[0].trim.x1], [156, 304]);
  eq([a.geometry[19].trim.x0, a.geometry[19].trim.x1], [0, 148]);
  // The inside page, turned over: C2 (inside front) on its left, C3 on its right.
  eq([a.geometry[1].trim.x0, a.geometry[18].trim.x0], [0, 156]);
  eq(a.book.pages[0].source.index, 100000, "the cover file's pages are numbered from COVER_BASE");
  eq(a.book.pages[1].source.index, 100001);
  eq(a.book.pages[2].source.index, 0, "the block's first page");
  ok(a.coverFile.spineRect && a.coverFile.spineRect.x0 === 148 && a.coverFile.spineRect.x1 === 156, "the spine's strip, for its artwork");
  ok(!a.layout.sides.some((s) => s.cover), "the cover file isn't imposed: no cover sheet");
  eq(a.layout.sheetCount, 4);
  ok(a.findings.some((f) => f.code === "cover-spine"), "an 8 mm spine for a 1.5 mm block: said");
  ok(!a.findings.some((f) => f.code === "mixed-sizes"), "the cover's pages are left out of the size check");
});

test("cover file: more than a spine's width beyond two pages is flaps", () => {
  const a = coverCase(464, 2); // 2 x 148 + a spine + 2 flaps
  ok(a.coverFile.flapMm > 80 && a.coverFile.flapMm < 84, `flaps ${a.coverFile.flapMm}`);
  near(a.coverFile.spineMm, a.coverFile.calculatedSpineMm, 1e-9, "the spine calculated, no width set");
  ok(a.findings.some((f) => f.code === "cover-flaps"));
  // With the printer's spine width set, the flaps are what is left.
  const b = coverCase(464, 2, { binding: "perfect", signaturePages: 4, spine: { color: "front", widthMm: 10, rotation: 0 } });
  eq(b.coverFile.spineMm, 10);
  near(b.coverFile.flapMm, (464 - 296 - 10) / 2, 1e-9);
  // The flaps' regions on the outside page: beyond each cover, as wide as a flap.
  const f = b.coverFile;
  eq([f.backFlapRect.x0, f.backFlapRect.x1], [0, f.flapMm]);
  near(f.frontFlapRect.x0, f.flapMm + 2 * 148 + 10, 1e-9);
  near(f.frontFlapRect.x1, 464, 1e-9);
  eq(coverCase(304, 2).coverFile.frontFlapRect, null, "no flaps: none");
  eq(analyse({ pages: [], cover: null }, {}).setup.glueMm, 6, "side glue, 6 mm by default");
});

test("cover file: one page means an unprinted inside; too narrow is an error; a stitched cover keeps its sheet", () => {
  const one = coverCase(304, 1);
  eq([one.book.pages[1].source, one.book.pages[18].source], [null, null], "C2 and C3 blank");
  eq([label(one.book, 2), label(one.book, 19)], ["C2", "C3"], "still named");
  ok(one.findings.some((f) => f.code === "cover-inside"));
  const narrow = coverCase(200, 2);
  ok(narrow.hasErrors && narrow.findings.some((f) => f.code === "cover-file"));
  const stitched = coverCase(296, 2, { binding: "saddle" });
  eq(stitched.layout.sheetCount, 5, "the cover folds round the block: its sheet stays");
  eq([stitched.layout.sides[0].left, stitched.layout.sides[0].right], [20, 1]);
});
