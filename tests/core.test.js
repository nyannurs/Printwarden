import { analyse } from "../app/core/analysis.js";
import { Binding, pagesToAdd, ruleFor } from "../app/core/binding.js";
import { buildBook, isRecto, label } from "../app/core/book.js";
import { detectSpreads, SpreadMode, SpreadPattern } from "../app/core/detect.js";
import { scheme } from "../app/core/folding.js";
import { creepMm, layoutFor, saddleStitchLayout, signatureLayout } from "../app/core/imposition.js";
import { centreSpread, facingPairs, pairNumbers, partnerMap } from "../app/core/pairing.js";
import { expectedMediaSize, manualSetup, setupFromPdf, sides, trimRectFor } from "../app/core/setup.js";
import { caliperUm, coverOf, defaultPaper, paperThicknessMm } from "../app/core/paper.js";
import { bookThicknessMm, calculatedSpine, defaultSpine } from "../app/core/spine.js";
import { rect, rectSize } from "../app/core/units.js";
import { eq, near, ok, test, throws } from "./harness.js";

// --- fixtures: SourcePages built directly, no PDF involved --------------------------

const A5 = [148, 210];
const A5_SPREAD = [296, 210];

function pagesOf(sizes, { bleed = 0, slug = 0, boxes = true } = {}) {
  return sizes.map(([w, h], index) => {
    const o = bleed + slug;
    const media = rect(0, 0, w + 2 * o, h + 2 * o);
    return {
      index,
      mediaBox: media,
      trimBox: boxes && o ? rect(o, o, o + w, o + h) : null,
      bleedBox: boxes && o ? rect(slug, slug, w + 2 * bleed + slug, h + 2 * bleed + slug) : null,
      rotation: 0,
    };
  });
}
const singles = (n, opts) => pagesOf(Array(n).fill(A5), opts);
const codes = (a, sev) => new Set(a.findings.filter((f) => !sev || f.severity === sev).map((f) => f.code));

// --- pairing -------------------------------------------------------------------------

test("pair numbers, small cases", () => {
  eq(pairNumbers(0), []);
  eq(pairNumbers(1), [[null, 1]]);
  eq(pairNumbers(2), [[null, 1], [2, null]]);
  eq(pairNumbers(3), [[null, 1], [2, 3]]);
  eq(pairNumbers(8), [[null, 1], [2, 3], [4, 5], [6, 7], [8, null]]);
});

test("parity invariant: odd folios recto, even verso, for N = 1…100", () => {
  for (let n = 1; n <= 100; n++) {
    const seen = [];
    for (const [l, r] of pairNumbers(n)) {
      if (l !== null) { ok(!isRecto(l)); seen.push(l); }
      if (r !== null) { ok(isRecto(r)); seen.push(r); }
    }
    eq(seen, Array.from({ length: n }, (_, i) => i + 1), `N=${n}`);
  }
});

test("centre spread", () => {
  eq(centreSpread(44), [22, 23]);
  eq(centreSpread(42), null);
  const book = buildBook(singles(44), Array(44).fill(false));
  eq(facingPairs(book).filter((p) => p.isCentreSpread).map((p) => p.numbers), [[22, 23]]);
});

const partnerships = (book) =>
  new Set([...partnerMap(book)].filter(([, b]) => b).map(([a, b]) => [a, b].sort().join("~")));

test("REGRESSION: +2 pages at the front preserves every facing pair", () => {
  const pages = singles(40);
  const before = partnerships(buildBook(pages, Array(40).fill(false)));
  const after = partnerships(buildBook(pages, Array(40).fill(false), [{ after: 0, count: 2 }]));
  eq([...after].sort(), [...before].sort());
  eq(before.size, 19);
});

test("REGRESSION: +1 page re-pairs everything from the insertion point on", () => {
  const pages = singles(40);
  const before = partnerMap(buildBook(pages, Array(40).fill(false)));
  const after = partnerMap(buildBook(pages, Array(40).fill(false), [{ after: 20, count: 1 }]));
  const changed = [...before.keys()].filter((k) => before.get(k) !== after.get(k)).map((k) => parseInt(k) + 1);
  eq(changed.sort((a, b) => a - b), Array.from({ length: 21 }, (_, i) => i + 20));
});

// --- imposition ----------------------------------------------------------------------

test("saddle sheet counts", () => {
  for (const [n, sheets] of [[4, 1], [8, 2], [40, 10], [44, 11]]) eq(saddleStitchLayout(n).sheetCount, sheets);
});

test("saddle 44 matches the spec table", () => {
  const s = saddleStitchLayout(44).sides;
  eq([s[0].left, s[0].right, s[1].left, s[1].right], [44, 1, 2, 43]);
  eq([s[2].left, s[2].right, s[3].left, s[3].right], [42, 3, 4, 41]);
  eq([s[20].left, s[20].right, s[21].left, s[21].right], [24, 21, 22, 23]);
});

test("every folio placed exactly once", () => {
  for (const [n, sig] of [[4, 4], [8, 8], [44, 44], [48, 4], [48, 16], [32, 8]]) {
    const folios = signatureLayout(n, sig).sides.flatMap((s) => [s.left, s.right]).sort((a, b) => a - b);
    eq(folios, Array.from({ length: n }, (_, i) => i + 1), `n=${n} sig=${sig}`);
  }
});

test("back is behind front: each leaf carries a recto and the next verso", () => {
  for (const [n, sig] of [[44, 44], [48, 4], [48, 16]]) {
    const s = signatureLayout(n, sig).sides;
    for (let i = 0; i < s.length; i += 2) {
      const [front, back] = [s[i], s[i + 1]];
      eq(back.left, front.right + 1);
      eq(front.left, back.right + 1);
    }
  }
});

test("perfect binding: stacked 4-page signatures between the covers, the cover on its own sheet", () => {
  const layout = layoutFor(ruleFor(Binding.PERFECT), 16);
  eq(layout.sides.slice(0, 4).map((s) => [s.side, s.left, s.right]),
    [["front", 6, 3], ["back", 4, 5], ["front", 10, 7], ["back", 8, 9]]);
  ok(layout.sides.every((s) => s.depth === 0));
  eq(layout.sides.slice(-2).map((s) => [s.side, s.left, s.right, s.cover]),
    [["front", 16, 1, true], ["back", 2, 15, true]]);
  eq(layout.sheetCount, 4);
});

test("sewn and hardcover: signatures count the pages between the covers", () => {
  for (const binding of [Binding.SEWN, Binding.HARDCOVER]) {
    const rule = ruleFor(binding);
    eq(layoutFor(rule, 48), null, "48 in all is 44 between the covers");
    const layout = layoutFor(rule, 52);
    const folios = layout.sides.flatMap((s) => [s.left, s.right]).sort((a, b) => a - b);
    eq(folios, Array.from({ length: 52 }, (_, i) => i + 1), "every page once");
    eq(layout.sides.filter((s) => !s.cover).length, 24, "3 signatures of 16: 12 sheets");
    // Each leaf still carries a recto and the next verso, the cover's too.
    for (let i = 0; i < layout.sides.length; i += 2) {
      const [front, back] = [layout.sides[i], layout.sides[i + 1]];
      eq(back.left, front.right + 1);
      eq(front.left, back.right + 1);
    }
  }
  // Staple binding keeps its cover on the outer sheet.
  eq(layoutFor(ruleFor(Binding.SADDLE), 48).sides[0].left, 48);
});

test("creep is zero on the outermost sheet and grows inward", () => {
  const depths = saddleStitchLayout(16).sides.filter((s) => s.side === "front").map((s) => s.depth);
  eq(depths, [0, 1, 2, 3]);
  eq(creepMm(0, 0.1), 0);
  near(creepMm(3, 0.1), 0.3);
});

test("invalid counts", () => {
  throws(() => saddleStitchLayout(42));
  throws(() => signatureLayout(16, 6));
  eq(layoutFor(ruleFor(Binding.SADDLE), 42), null);
  eq(layoutFor(ruleFor(Binding.SPIRAL), 42), null);
});

test("folding schemes: the 16-page sheet folds to the classic table, the 8-page one the same way", () => {
  const show = (g) => g.map((row) => row.map((c) => c.page + (c.turned ? "t" : "")).join(" ")).join(" / ");
  const s16 = scheme(16);
  eq(show(s16.front), "5t 12t 9t 8t / 4 13 16 1");
  eq(show(s16.back), "7t 10t 11t 6t / 2 15 14 3");
  const s8 = scheme(8);
  eq(show(s8.front), "5t 8t / 4 1");
  eq(show(s8.back), "7t 6t / 2 3");
  for (const s of [s8, s16]) {
    // Every page once; a panel's back (the mirrored column, short-edge turn) is its other page.
    const all = [...s.front.flat(), ...s.back.flat()].map((c) => c.page).sort((a, b) => a - b);
    eq(all, Array.from({ length: s.pages }, (_, i) => i + 1));
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const front = s.front[r][c];
        const back = s.back[r][s.cols - 1 - c];
        eq(Math.min(front.page, back.page) % 2, 1); // a leaf: an odd page and the even one after it
        eq(Math.abs(front.page - back.page), 1);
        eq(front.turned, back.turned);
      }
    }
  }
});

test("folding schemes: a signature's sheets nested, the leaf depth for creep, the cover's sheet, what doesn't fold", () => {
  const l = signatureLayout(32, 32, 16);
  eq(l.sheetCount, 2);
  eq(l.sheetPages, 16);
  const pagesOf = (...sides) => sides.flatMap((s) => s.cells.flat().map((c) => c.page)).sort((a, b) => a - b);
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  eq(pagesOf(l.sides[0], l.sides[1]), [...range(1, 8), ...range(25, 32)]); // the outer sheet
  eq(pagesOf(l.sides[2], l.sides[3]), range(9, 24)); // the inner
  const cell = (page) => l.sides.flatMap((s) => s.cells.flat()).find((c) => c.page === page);
  eq([cell(1).depth, cell(2).depth, cell(9).depth, cell(16).depth, cell(17).depth, cell(32).depth], [0, 0, 4, 7, 7, 0]);
  eq([l.sides[0].left, l.sides[0].right], [1, 32]);
  const withCover = layoutFor(ruleFor(Binding.SEWN, 16), 36, 16); // 32 between the covers: two sheets, then the cover
  eq(withCover.sheetCount, 3);
  ok(withCover.sides.slice(0, 4).every((s) => s.cells.flat().every((c) => c.page >= 3 && c.page <= 34)));
  eq([withCover.sides[4].left, withCover.sides[4].right, withCover.sides[4].cover], [36, 1, true]);
  eq(layoutFor(ruleFor(Binding.SEWN, 12), 28, 16), null); // 12-page signatures don't fold from 16-page sheets
  eq(layoutFor(ruleFor(Binding.SEWN, 12), 28, 2).sheetCount, 7);
  eq(layoutFor(ruleFor(Binding.SADDLE), 16, 16).sheetCount, 1);
  eq(layoutFor(ruleFor(Binding.SADDLE), 12, 8), null);
  const a = analyse({ pages: singles(28) }, { binding: Binding.SEWN, signaturePages: 12, sheetPages: 16 });
  ok(a.findings.some((f) => f.code === "sheet-pages"));
  eq(a.layout, null);
});

test("pages to add, and the closed book's thickness", () => {
  eq([pagesToAdd(46, 4), pagesToAdd(44, 4), pagesToAdd(45, 4), pagesToAdd(41, 16)], [2, 0, 3, 7]);
  // One figure everywhere (side panel, preflight): covers and boards included, or the
  // printer's width where the covers fit in it.
  const setup = { binding: Binding.HARDCOVER, paper: defaultPaper(), spine: defaultSpine() };
  const calc = calculatedSpine(36, setup.paper, setup.binding);
  near(bookThicknessMm(setup, 36), calc.widthMm);
  near(calc.widthMm, 16 * calc.paperMm + 2 * 2.5); // 16 leaves between two 2.5 mm boards
  near(bookThicknessMm({ ...setup, spine: { ...setup.spine, widthMm: 9.4 } }, 36), 9.4);
  near(bookThicknessMm({ ...setup, spine: { ...setup.spine, widthMm: 3 } }, 36), calc.widthMm); // thinner than the boards
  const a = analyse({ pages: singles(36) }, { binding: Binding.HARDCOVER }); // 32 between the covers: two signatures
  // A hardcover's book has its two endpaper leaves as well (40 pages): the figure counts them.
  eq(a.book.pages.length, 40);
  const whole = calculatedSpine(40, setup.paper, setup.binding);
  near(whole.widthMm, 18 * calc.paperMm + 2 * 2.5);
  ok(a.findings.some((f) => f.code === "sheets" && f.message.includes(`Spine about ${whole.widthMm.toFixed(1)} mm`)), "preflight states the same figure");
});

// --- detection -----------------------------------------------------------------------

test("uniform single pages", () => {
  const d = detectSpreads(pagesOf(Array(8).fill(A5)));
  eq(d.pattern, SpreadPattern.ALL_SINGLE);
});

test("InDesign export-as-spreads is recognised", () => {
  const d = detectSpreads(pagesOf([A5, A5_SPREAD, A5_SPREAD, A5_SPREAD, A5]));
  eq(d.isSpread, [false, true, true, true, false]);
  eq(d.pattern, SpreadPattern.SPREADS_WITH_SINGLE_COVERS);
});

test("spreads detected from media box when bleed skews the ratio", () => {
  const d = detectSpreads([
    { index: 0, mediaBox: rect(0, 0, 154, 216), trimBox: null, bleedBox: null, rotation: 0 },
    { index: 1, mediaBox: rect(0, 0, 302, 216), trimBox: null, bleedBox: null, rotation: 0 },
    { index: 2, mediaBox: rect(0, 0, 154, 216), trimBox: null, bleedBox: null, rotation: 0 },
  ]);
  eq(d.isSpread, [false, true, false]);
});

test("mixed spreads flagged; forcing overrides", () => {
  eq(detectSpreads(pagesOf([A5, A5, A5_SPREAD, A5, A5_SPREAD, A5])).pattern, SpreadPattern.MIXED);
  eq(detectSpreads(pagesOf([A5, A5_SPREAD, A5]), SpreadMode.SINGLE).isSpread, [false, false, false]);
  eq(detectSpreads(pagesOf([A5, A5_SPREAD, A5_SPREAD, A5]), SpreadMode.SPREADS).isSpread, [false, true, true, false]);
  ok(detectSpreads(pagesOf(Array(4).fill(A5_SPREAD)), SpreadMode.SPREADS).isSpread.every(Boolean));
});

test("manual setup detects spreads exactly, including slug", () => {
  const setup = manualSetup(148, 210, 3, 5);
  const pages = [
    { index: 0, mediaBox: rect(0, 0, 164, 226), trimBox: null, bleedBox: null, rotation: 0 },
    { index: 1, mediaBox: rect(0, 0, 312, 226), trimBox: null, bleedBox: null, rotation: 0 },
  ];
  eq(detectSpreads(pages, SpreadMode.AUTO, setup).isSpread, [false, true]);
});

// --- document setup: bleed and slug ----------------------------------------------------

test("setup is read from the PDF boxes, bleed and slug separated", () => {
  const s = setupFromPdf(singles(4, { bleed: 3, slug: 5 }), [false, false, false, false]);
  eq([s.width, s.height], [148, 210]);
  eq(s.bleed, sides(3));
  eq(s.slug, sides(5));
  ok(s.fromBoxes);
});

test("no TrimBox: trim = media, no bleed", () => {
  const s = setupFromPdf(pagesOf([A5, A5]), [false, false]);
  eq([s.width, s.height, s.bleed.top], [148, 210, 0]);
  ok(!s.fromBoxes);
});

test("expected media size adds bleed and slug; spreads only get outside edges", () => {
  const setup = manualSetup(148, 210, { top: 3, bottom: 3, inside: 0, outside: 3 }, 5);
  eq(expectedMediaSize(setup, false), { width: 148 + 3 + 10, height: 226 });
  eq(expectedMediaSize(setup, true), { width: 296 + 16, height: 226 });
});

test("manual trim insets by inside/outside depending on recto/verso", () => {
  const setup = manualSetup(148, 210, { top: 3, bottom: 3, inside: 0, outside: 3 }, 0);
  const media = { index: 0, mediaBox: rect(0, 0, 151, 216), trimBox: null, bleedBox: null, rotation: 0 };
  eq(trimRectFor(media, "full", true, setup), rect(0, 3, 148, 213)); // recto: inside is left
  eq(trimRectFor(media, "full", false, setup), rect(3, 3, 151, 213)); // verso: inside is right
});

test("spread halves split at the trim centre, not the media centre", () => {
  const spread = { index: 0, mediaBox: rect(0, 0, 310, 216), trimBox: rect(3, 3, 299, 213), bleedBox: null, rotation: 0 };
  const setup = { ...manualSetup(148, 210), mode: "auto" };
  eq(trimRectFor(spread, "left", false, setup), rect(3, 3, 151, 213));
  eq(trimRectFor(spread, "right", true, setup), rect(151, 3, 299, 213));
});

test("manual page size other than the PDF's: said, not an error; the page resized, not scaled", () => {
  const a = analyse({ pages: singles(8, { bleed: 3 }) }, { page: manualSetup(200, 210, 3, 0) });
  ok(codes(a, "info").has("page-resized"));
  ok(!a.hasErrors);
  eq(rectSize(a.geometry[0].trim), { width: 200, height: 210 });
  const good = analyse({ pages: singles(8, { bleed: 3 }) }, { page: manualSetup(148, 210, 3, 0) });
  ok(!codes(good).has("page-resized"));
  eq(rectSize(good.geometry[0].trim), { width: 148, height: 210 });
});

test("manual setup: spreads told apart with its bleed and slug taken off (a PDF without a TrimBox)", () => {
  // 3 mm bleed and 6 mm slug: by the whole media box, a spread is 5 % short of twice a page.
  const pages = pagesOf([A5, A5_SPREAD, A5_SPREAD, A5], { bleed: 3, slug: 6, boxes: false });
  const a = analyse({ pages }, { page: manualSetup(148, 210, 3, 6) });
  eq(a.detection.pattern, SpreadPattern.SPREADS_WITH_SINGLE_COVERS);
  eq(a.book.pages.length, 6);
});

test("a resized page grows away from the spine, evenly up and down; a spread about its fold", () => {
  const setup = manualSetup(160, 200, 0, 0);
  const page = { index: 0, mediaBox: rect(0, 0, 148, 210), trimBox: null, bleedBox: null, rotation: 0 };
  eq(trimRectFor(page, "full", true, setup), rect(0, 5, 160, 205), "right-hand page: its left (spine) edge stays");
  eq(trimRectFor(page, "full", false, setup), rect(-12, 5, 148, 205), "left-hand page: its right edge stays");
  const spread = { index: 0, mediaBox: rect(0, 0, 296, 210), trimBox: null, bleedBox: null, rotation: 0 };
  eq(trimRectFor(spread, "left", false, setup), rect(-12, 5, 148, 205), "the fold stays");
  eq(trimRectFor(spread, "right", true, setup), rect(148, 5, 308, 205));
});

test("no bleed warns, slug is reported", () => {
  ok(codes(analyse({ pages: singles(8) }), "warning").has("no-bleed"));
  const a = analyse({ pages: singles(8, { bleed: 3, slug: 6 }) });
  ok(!codes(a).has("no-bleed"));
  ok(codes(a).has("slug"));
});

test("bleed rect excludes the spine side", () => {
  const a = analyse({ pages: singles(4, { bleed: 3 }) });
  const [p1, p2] = a.geometry; // folio 1 recto (spine left), folio 2 verso (spine right)
  eq(p1.bleed, rect(3, 0, 154, 216));
  eq(p2.bleed, rect(0, 0, 151, 216));
});

// --- validation ------------------------------------------------------------------------

test("valid saddle: no errors, centre spread reported", () => {
  const a = analyse({ pages: singles(44, { bleed: 3 }) });
  ok(!a.hasErrors, JSON.stringify(a.findings));
  ok(codes(a, "info").has("centre-spread"));
  eq(a.layout.sheetCount, 11);
});

test("invalid count says what to change in InDesign", () => {
  const a = analyse({ pages: singles(46, { bleed: 3 }) });
  const f = a.findings.find((x) => x.code === "page-count");
  ok(f.message.includes("Add 2 pages in InDesign, to reach 48"), f.message);
  eq(a.layout, null);
  // Hardcover: the cover is made apart, so the pages between the covers count.
  const h = analyse({ pages: singles(44, { bleed: 3 }) }, { binding: Binding.HARDCOVER });
  const g = h.findings.find((x) => x.code === "page-count");
  ok(g.message.includes("40 pages between the covers") && g.message.includes("Add 8 pages between the covers in InDesign, to reach 52"), g.message);
  ok(!analyse({ pages: singles(52, { bleed: 3 }) }, { binding: Binding.HARDCOVER }).findings.some((x) => x.code === "page-count"));
});

test("binding rules", () => {
  ok(codes(analyse({ pages: singles(42) }, { binding: Binding.PERFECT })).has("page-count"));
  ok(!codes(analyse({ pages: singles(44) }, { binding: Binding.PERFECT })).has("page-count"));
  ok(codes(analyse({ pages: singles(44) }, { binding: Binding.PERFECT, signaturePages: 16 })).has("page-count"));
  const spiral = analyse({ pages: singles(43) }, { binding: Binding.SPIRAL });
  ok(!spiral.hasErrors && codes(spiral).has("punch"));
});

test("mixed sizes and orientation rejected", () => {
  ok(codes(analyse({ pages: pagesOf([...Array(4).fill(A5), ...Array(4).fill([176, 250])]) }), "error").has("mixed-sizes"));
  ok(codes(analyse({ pages: pagesOf([...Array(4).fill(A5), ...Array(4).fill([210, 148])]) }, { spreadMode: SpreadMode.SINGLE }), "error").has("mixed-orientation"));
});

test("spread export is fine; an odd blank tears the spreads", () => {
  const pages = pagesOf([A5, ...Array(21).fill(A5_SPREAD), A5]);
  const a = analyse({ pages });
  ok(!a.hasErrors, JSON.stringify(a.findings));
  eq(a.book.pages.length, 44);
  ok(codes(analyse({ pages }, { blanks: [{ after: 1, count: 1 }] }), "error").has("spread-split"));
});

test("page labels: from the PDF; an even first number warns", () => {
  const labelled = (first) => singles(8).map((p, i) => ({ ...p, label: String(first + i) }));
  ok(codes(analyse({ pages: labelled(2) }), "warning").has("folio-parity"));
  const a = analyse({ pages: labelled(33) });
  ok(!codes(a).has("folio-parity"));
  eq([1, 8].map((f) => label(a.book, f)), ["33", "40"]);
  // Roman front matter, then arabic; a spread's right half takes the next number.
  const roman = singles(4).map((p, i) => ({ ...p, label: ["i", "ii", "1", "2"][i] }));
  eq([1, 2, 3, 4].map((f) => label(analyse({ pages: roman }).book, f)), ["i", "ii", "1", "2"]);
  const spreads = pagesOf([A5, A5_SPREAD, A5]).map((p, i) => ({ ...p, label: ["1", "2", "4"][i] }));
  eq([1, 2, 3, 4].map((f) => label(analyse({ pages: spreads }).book, f)), ["1", "2", "3", "4"]);
  // No labels: counted from 1.
  eq(label(analyse({ pages: singles(4) }).book, 3), "3");
});

test("empty document", () => {
  eq([...codes(analyse({ pages: [] }))], ["empty"]);
});

test("architecture: core/ imports nothing but core/", async () => {
  const files = ["units", "setup", "document", "detect", "book", "pairing", "binding", "imposition", "validate", "analysis", "sheets", "paper"];
  for (const f of files) {
    const src = await (await fetch(`../app/core/${f}.js`)).text();
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    ok(imports.every((i) => /^\.\/[a-z]+\.js$/.test(i)), `${f}.js imports ${imports.join(", ")}`);
    // Strip imports, comments and string literals before looking for DOM access.
    const code = src.replace(/^import[^\n]*$|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"[^"\n]*"|`[^`]*`/gm, "");
    ok(!/(?<![.\w])(document|window|THREE)\./.test(code), `${f}.js touches the DOM`);
  }
});

test("ICC header reader: CMYK profile recognised", async () => {
  const { iccInfo } = await import("../app/pdf/icc.js");
  const icc = new Uint8Array(await (await fetch("../vendor/pdf-iccs/CGATS001Compat-v2-micro.icc")).arrayBuffer());
  const info = iccInfo(icc);
  eq(info.colorSpace, "CMYK");
  eq(iccInfo(new Uint8Array(200)), null);
});

test("paper: the cover's color and finish start as their own: the pages' don't change them", () => {
  const cover = coverOf({ ...defaultPaper(), color: "#f4efe2", finish: "gloss" });
  eq([cover.color, cover.finish], ["#ffffff", "uncoated"]);
});

test("paper: the cover weight starts as its own; a null one (older setups) is the pages'", () => {
  const paper = { ...defaultPaper(), gsm: 150 };
  eq(coverOf(paper).gsm, 120, "its own");
  eq(coverOf({ ...paper, coverGsm: null }).gsm, 150, "null: the pages'");
});

test("paper: a set volume (a printer's caliper) sets the thickness, and the spine with it", () => {
  near(paperThicknessMm(120, "uncoated"), 0.15, 1e-9, "120 gsm uncoated: the finish's bulk, 1.25");
  near(paperThicknessMm(120, "uncoated", 1.0), 0.12, 1e-9, "a volume of 1.0: 120 µm");
  eq(caliperUm({ gsm: 120, finish: "gloss", volume: null }), 108, "gloss: 0.9");
  eq(caliperUm({ gsm: 120, finish: "gloss", volume: 1.5 }), 180, "its own volume wins");
  eq(coverOf({ ...defaultPaper(), coverVolume: 2 }).volume, 2, "the cover's own");
  eq(coverOf(defaultPaper()).volume, null, "none set: the finish's");
  const thin = calculatedSpine(44, { ...defaultPaper(), volume: 1.0, coverVolume: 1.0 });
  const bulky = calculatedSpine(44, { ...defaultPaper(), volume: 2.0, coverVolume: 2.0 });
  near(bulky.widthMm / thin.widthMm, 2, 1e-9, "twice the volume: twice the spine");
});
