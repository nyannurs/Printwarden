// Integration with real PDFs: generate with pdf-lib, read back, impose, fold back.

import { analyse } from "../app/core/analysis.js";
import { defaultExportOptions, planSheets } from "../app/core/sheets.js";
import { rectSize } from "../app/core/units.js";
import { writeImposedPdf } from "../app/impose/writer.js";
import { openPdf, writeImposed } from "../app/pdf/load.js";
import { InkDocument } from "../app/pdf/mupdf-render.js";
import { createRenderer, MainThreadRenderer } from "../app/pdf/render.js";
import { LUT_ENTRIES, lutIndex } from "../app/viewer/inklut.js";
import { makeSamplePdf } from "../app/pdf/sample.js";
import { readStructure } from "../app/pdf/structure.js";
import { eq, near, ok, test } from "./harness.js";

test("sample PDF round-trips: trim, bleed and slug read back from the boxes", async () => {
  const bytes = await makeSamplePdf({ pages: 8, bleed: 3, slug: 6 });
  const { pages } = await readStructure(bytes);
  eq(pages.length, 8);
  const trim = rectSize(pages[0].trimBox);
  near(trim.width, 148, 0.01);
  near(trim.height, 210, 0.01);
  const a = analyse({ pages });
  eq([a.setup.page.width, a.setup.page.height, a.setup.page.bleed.outside, a.setup.page.slug.top], [148, 210, 3, 6]);
  ok(!a.hasErrors, JSON.stringify(a.findings));
});

test("page labels: InDesign-style section numbering read from the PDF", async () => {
  const { PDFDocument, PDFName, PDFString } = await import("../vendor/pdf-lib.esm.js");
  const doc = await PDFDocument.load(await makeSamplePdf({ pages: 6 }));
  // Pages 1-2: "i", "ii"; from page 3: "A-33", "A-34", … (prefix, start 33).
  const nums = doc.context.obj([
    0, doc.context.obj({ S: PDFName.of("r") }),
    2, doc.context.obj({ S: PDFName.of("D"), P: PDFString.of("A-"), St: 33 }),
  ]);
  doc.catalog.set(PDFName.of("PageLabels"), doc.context.obj({ Nums: nums }));
  const { pages } = await readStructure(await doc.save());
  eq(pages.map((p) => p.label), ["i", "ii", "A-33", "A-34", "A-35", "A-36"]);
  const plain = await readStructure(await makeSamplePdf({ pages: 2 }));
  eq(plain.pages.map((p) => p.label ?? null), [null, null]);
});

test("background threads: structure read and export produce the same results", async () => {
  const bytes = await makeSamplePdf({ pages: 8 });
  const inWorker = await openPdf(bytes);
  const direct = await readStructure(bytes);
  eq(inWorker.pages, direct.pages);
  const a = analyse({ pages: direct.pages });
  const out = await writeImposed(bytes, a, planSheets(a, defaultExportOptions()), { fileName: "s.pdf", appName: "t" });
  eq((await readStructure(out)).pages.length, 4);
});

test("background threads: render workers start and draw a page", async () => {
  const bytes = await makeSamplePdf({ pages: 4 });
  const r = await createRenderer(bytes, () => { throw new Error("fell back to the main thread"); });
  ok(r.workers?.length >= 2, "worker pool");
  const img = await r.render(0, { x0: 9, y0: 9, x1: 157, y1: 219 }, 300);
  eq([img.width, img.height], [211, 300]);
  r.destroy();
});

test("INKS: a page drawn as its inks, C M Y K a byte each; the ink table from a profile, paper white", async () => {
  const bytes = await makeSamplePdf({ pages: 2 });
  const r = await createRenderer(bytes, () => { throw new Error("fell back to the main thread"); });
  const ink = await r.render(0, { x0: 9, y0: 9, x1: 157, y1: 219 }, 300, 10, { mode: "ink", cache: false });
  eq([ink.width, ink.height, ink.n, ink.data.length], [211, 300, 4, 211 * 300 * 4]);
  ok(ink.data instanceof Uint8Array && !(ink.data instanceof Uint8ClampedArray), "raw bytes");
  let total = 0;
  for (let i = 0; i < ink.data.length; i++) total += ink.data[i];
  ok(total > 0, "ink on the page");
  const profile = new Uint8Array(await (await fetch("../vendor/icc/ISOcoated_v2_eci.icc")).arrayBuffer());
  const lut = await r.inkLut(profile);
  eq(lut.length, LUT_ENTRIES * 4);
  eq([...lut.slice(0, 4)], [255, 255, 255, 255]); // no ink: paper, white
  const at = (c, m, y, k) => [...lut.subarray(4 * lutIndex(c, m, y, k), 4 * lutIndex(c, m, y, k) + 3)];
  const solidC = at(16, 0, 0, 0);
  ok(solidC[0] < 40 && solidC[2] > 200, `solid Cyan through ISO Coated v2: ${solidC}`);
  const solidK = at(0, 0, 0, 16);
  ok(solidK.every((v) => v < 60), `solid Black: ${solidK}`);
  const own = await r.inkLut(null); // MuPDF's own CMYK
  eq([...own.slice(0, 4)], [255, 255, 255, 255]);
  r.destroy();
});

/**
 * The verification the tool exists for: impose, re-import the output as imposed sheets,
 * fold it back, and check every page against the original, pixel for pixel (at low
 * resolution, which is plenty to catch misplaced, swapped or rotated pages).
 */
test("export: a file name the standard font can't write doesn't stop it", async () => {
  const bytes = await makeSamplePdf({ pages: 8, bleed: 3, slug: 6 });
  const a = analyse({ pages: (await readStructure(bytes)).pages }, { binding: "saddle" });
  const out = await writeImposedPdf(bytes, a, planSheets(a, defaultExportOptions()), { fileName: "Bericht ő ★ 漢字.pdf", appName: "test" });
  eq((await readStructure(out)).pages.length, 4);
});

// A folding scheme: every cell of every sheet side holds its page, the upper row upside
// down, where the plan says. (Such a file is not folded back on import; checked by cells.)
test("FOLDING SCHEME (sewn, 16 pages a sheet): every cell of the sheets is its page, the upper row upside down", async () => {
  const bytes = await makeSamplePdf({ pages: 20, bleed: 3, slug: 6 });
  const src = await readStructure(bytes);
  const a = analyse({ pages: src.pages }, { binding: "sewn", signaturePages: 16, sheetPages: 16 });
  ok(!a.hasErrors, JSON.stringify(a.findings));
  eq(a.layout.sheetCount, 2); // one sheet of 16, then the cover
  const plan = planSheets(a, defaultExportOptions());
  ok(!plan.errors.length, plan.errors.join("; "));
  const out = await writeImposedPdf(bytes, a, plan, { fileName: "sample.pdf", appName: "test" });
  const back = await readStructure(out);
  eq(back.pages.length, 4);
  eq(back.imposition?.sheetPages, 16);
  const r1 = new MainThreadRenderer(new InkDocument(bytes));
  const r2 = new MainThreadRenderer(new InkDocument(out));
  const turnedOver = (image) => {
    const c = document.createElement("canvas");
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext("2d");
    ctx.translate(c.width, c.height);
    ctx.rotate(Math.PI);
    ctx.drawImage(image, 0, 0);
    return c;
  };
  let checked = 0;
  for (const [i, side] of plan.sides.entries()) {
    for (const p of side.placements) {
      const page = a.book.pages[p.folio - 1];
      const original = await r1.render(page.source.index, a.geometry[p.folio - 1].trim, 60);
      const cell = await r2.render(i, p.trim, 60);
      const seen = p.turned ? turnedOver(cell) : cell;
      const diff = meanDifference(original, seen);
      ok(diff < 6, `sheet ${side.sheet} ${side.side}, folio ${p.folio}${p.turned ? " (turned)" : ""}: differs from the original by ${diff.toFixed(1)}`);
      if (p.turned) ok(meanDifference(original, cell) > diff + 3, `folio ${p.folio}: not turned on the sheet`);
      checked++;
    }
  }
  eq(checked, 20);
});

for (const [binding, pages, sides] of [["saddle", 16, 8], ["hardcover", 20, 10]]) {
  test(`ROUND TRIP (${binding}): export imposed, re-import, every folded page matches its original`, async () => {
    const bytes = await makeSamplePdf({ pages, bleed: 3, slug: 6 });
    const src = await readStructure(bytes);
    const a = analyse({ pages: src.pages }, { binding });
    ok(!a.hasErrors, JSON.stringify(a.findings));
    const plan = planSheets(a, defaultExportOptions());
    const out = await writeImposedPdf(bytes, a, plan, { fileName: "sample.pdf", appName: "test" });

    const back = await readStructure(out);
    eq(back.pages.length, sides); // hardcover: 2 sheets of the block, then the cover's own
    eq(back.imposition?.binding, binding);
    eq(back.imposition?.version, 3); // 3: sheetPages (folding schemes)
    const b = analyse({ pages: back.pages }, { source: "imposed", binding, signaturePages: back.imposition.signaturePages });
    ok(!b.hasErrors, JSON.stringify(b.findings));
    eq(b.book.pages.length, pages);

    const r1 = new MainThreadRenderer(new InkDocument(bytes));
    const r2 = new MainThreadRenderer(new InkDocument(out));
    // The printed pages, in order (a hardcover's book has its endpaper leaves too, unprinted
    // and not on the sheets: the re-import has 20 pages to the original book's 24).
    const printed = a.book.pages.map((page, i) => ({ page, i })).filter(({ page }) => !page.endpaper);
    eq(printed.length, pages);
    const originalOf = ({ page, i }) => r1.render(page.source.index, a.geometry[i].trim, 60);
    for (let folio = 1; folio <= pages; folio++) {
      const original = await originalOf(printed[folio - 1]);
      const folded = await r2.render(b.book.pages[folio - 1].source.index, b.geometry[folio - 1].trim, 60);
      const diff = meanDifference(original, folded);
      ok(diff < 6, `folio ${folio}: differs from the original by ${diff.toFixed(1)}`);
      if (folio > 1) {
        // And it must not match its neighbour: the check can tell pages apart.
        const other = await originalOf(printed[folio - 2]);
        ok(meanDifference(other, folded) > diff + 3, `folio ${folio} is indistinguishable from folio ${folio - 1}`);
      }
    }
    r1.destroy();
    r2.destroy();
  });
}

function pixels(image, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}

function meanDifference(c1, c2) {
  const w = Math.min(c1.width, c2.width);
  const h = Math.min(c1.height, c2.height);
  const d1 = pixels(c1, w, h);
  const d2 = pixels(c2, w, h);
  let sum = 0;
  for (let i = 0; i < d1.length; i += 4) {
    sum += Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]);
  }
  return sum / (w * h * 3);
}
