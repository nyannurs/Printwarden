// Rule checks. Every error says what to change in the document (pages are added or removed
// in InDesign, never here).

import { Binding, BINDING_LABELS, foldedPages, pagesToAdd } from "./binding.js";
import { isRecto, label } from "./book.js";
import { mediaSize } from "./document.js";
import { SpreadMode, SpreadPattern } from "./detect.js";
import { centreSpread } from "./pairing.js";
import { expectedMediaSize } from "./setup.js";
import { bookThicknessMm } from "./spine.js";
import { approxEqual, formatMm, formatSize, isLandscape, isPortrait } from "./units.js";

const ORDER = { error: 0, warning: 1, info: 2 };
const TOLERANCE_MM = 1;

/**
 * @typedef {{severity: string, code: string, message: string, folios: number[]}} Finding
 */
const finding = (severity, code, message, extra = {}) => ({
  severity, code, message, folios: [], ...extra,
});

/** @returns {Finding[]} */
export function validate(a) {
  if (a.document.pages.length === 0) return [finding("error", "empty", "The document has no pages.")];
  const out = [
    ...(a.imposed ? checkImposed(a) : checkDetection(a)),
    ...checkSetup(a),
    ...(a.imposed ? [] : checkSpreadParity(a)),
    ...checkSizes(a),
    ...checkCoverFile(a),
    ...checkPageCount(a),
    ...checkBindingHints(a),
    ...checkFolioStart(a),
    ...reportLayout(a),
  ];
  return out.sort((x, y) => ORDER[x.severity] - ORDER[y.severity]);
}

function* checkDetection({ document: doc, detection }) {
  const how = detection.mode === SpreadMode.AUTO ? "auto-detected" : detection.note;
  if (detection.pattern === SpreadPattern.MIXED) {
    const spreads = doc.pages.filter((_, i) => detection.isSpread[i]).map((p) => p.index + 1);
    yield finding("error", "mixed-spreads",
      `Mixed spreads and single pages: pdf pages ${ranges(spreads)} are spreads, the rest are single. ` +
      "This usually means the file was exported wrongly.");
  } else if (detection.pattern === SpreadPattern.SPREADS_WITH_SINGLE_COVERS) {
    yield finding("info", "spreads",
      `Exported as spreads: ${detection.spreadCount} spreads between single cover pages, ` +
      `split into ${detection.spreadCount * 2} pages (${how}).`);
  } else if (detection.pattern === SpreadPattern.ALL_SPREADS) {
    yield finding("info", "spreads",
      `${detection.spreadCount} spreads, split into ${detection.spreadCount * 2} pages (${how}).`);
  } else if (detection.note && detection.mode === SpreadMode.AUTO) {
    yield finding("info", "detection", capitalise(detection.note) + ".");
  }
}

function* checkImposed({ document: doc, rule, layout, book }) {
  const sides = doc.pages.length;
  if (!rule.signaturePages && rule.binding !== Binding.SADDLE) {
    yield finding("error", "imposed-binding",
      `An imposed file can't be folded as ${BINDING_LABELS[rule.binding].toLowerCase()}. ` +
      "Choose staple binding or perfect binding under Binding.");
  } else if (sides % 2) {
    yield finding("error", "imposed-odd",
      `The file has ${sides} sheet sides, an odd number: one sheet is missing its back. ` +
      "Pages are shown in file order.");
  } else if (!layout) {
    yield finding("error", "imposed-count",
      `${sides} sheet sides hold ${sides * 2} pages, which doesn't fit ` +
      `${BINDING_LABELS[rule.binding].toLowerCase()} (needs a multiple of ${rule.pageMultiple}). ` +
      "Check the binding and signature size. Pages are shown in file order.");
  } else {
    yield finding("info", "imposed",
      `Imposed file: ${sides / 2} sheets printed both sides, folded into ${book.pages.length} pages. ` +
      "Flip through the book: any page out of place means the imposition is wrong.");
  }
}

function* checkSetup({ document: doc, detection, setup, imposed }) {
  const page = setup.page;
  if (page.mode === "manual" && imposed) {
    const tooSmall = doc.pages.filter((p) => {
      const m = mediaSize(p);
      return m.width + TOLERANCE_MM < 2 * page.width || m.height + TOLERANCE_MM < page.height;
    });
    if (tooSmall.length) {
      yield finding("error", "setup-mismatch",
        `${tooSmall.length} sheet(s) are smaller than two pages of ${formatMm(page.width)} × ${formatMm(page.height)} mm. ` +
        "Check the page size.");
    }
  } else if (page.mode === "manual") {
    const off = [];
    doc.pages.forEach((p, i) => {
      const expected = expectedMediaSize(page, detection.isSpread[i]);
      if (!approxEqual(mediaSize(p), expected, TOLERANCE_MM)) off.push([p, expected]);
    });
    if (off.length) {
      // The page made another size round the content (resizePage, setup.js): said, not an error.
      const [p, expected] = off[0];
      const pdf = mediaSize(p);
      const own = { width: pdf.width - (expected.width - page.width * (detection.isSpread[p.index] ? 2 : 1)), height: pdf.height - (expected.height - page.height) };
      yield finding("info", "page-resized",
        `Page size ${formatMm(page.width)} × ${formatMm(page.height)} mm, the PDF's ` +
        `${formatSize({ width: own.width / (detection.isSpread[p.index] ? 2 : 1), height: own.height })}: not scaled.`);
    }
  } else if (!doc.pages.some((p) => p.trimBox)) {
    yield finding("info", "no-trimbox",
      "The PDF doesn't record its trim size, so each page is taken as-is with no bleed. " +
      "If the export includes bleed or slug, enter them in Document setup.");
  }

  const b = page.bleed;
  const minBleed = Math.min(b.top, b.bottom, b.inside, b.outside);
  if (Math.max(b.top, b.bottom, b.inside, b.outside) === 0) {
    yield finding("warning", "no-bleed",
      "No bleed. Anything printed to the page edge will show a white sliver after trimming.");
  } else if (minBleed < 3) {
    yield finding("info", "thin-bleed", `Bleed is ${formatMm(minBleed)} mm on at least one side; most printers ask for 3 mm.`);
  }
  const s = page.slug;
  if (Math.max(s.top, s.bottom, s.inside, s.outside) > 0) {
    yield finding("info", "slug", "Slug area present. It is trimmed off, so the book view doesn't show it.");
  }
}

function* checkSpreadParity({ book }) {
  const broken = book.pages.filter((p) => p.half === "left" && isRecto(p.number));
  if (broken.length) {
    const sources = [...new Set(broken.map((p) => p.source.index + 1))];
    yield finding("error", "spread-split",
      `The spreads on pdf pages ${ranges(sources)} would be torn apart: their halves land on different openings.`,
      { folios: broken.map((p) => p.number) });
  }
}

function* checkSizes({ book, geometry }) {
  const groups = [];
  for (const page of book.pages) {
    const g = geometry[page.number - 1];
    if (!g || page.source?.file === "cover") continue; // a cover file's pages may be taller (a case's)
    const group = groups.find((x) => approxEqual(x.size, g.size, TOLERANCE_MM));
    if (group) group.pages.push(page.number);
    else groups.push({ size: g.size, pages: [page.number] });
  }
  if (groups.length > 1) {
    const orientations = new Set(groups.map((x) => `${isLandscape(x.size)}${isPortrait(x.size)}`));
    const [code, head] = orientations.size > 1
      ? ["mixed-orientation", "Mixed page orientation"]
      : ["mixed-sizes", "Mixed page sizes"];
    const parts = groups.map((x) => `${formatSize(x.size)} (pages ${ranges(x.pages)})`);
    yield finding("error", code, `${head}: ${parts.join("; ")}. Every page must share one size.`,
      { folios: groups.slice(1).flatMap((x) => x.pages) });
  }
}

/** The pages that go to press: a hardcover's endpapers are stock, not pages to print. */
const imposedCount = (book) => book.pages.length - book.pages.filter((p) => p.endpaper).length;

function* checkPageCount({ book, rule, imposed }) {
  if (imposed) return; // checkImposed covers it
  const n = imposedCount(book);
  const name = BINDING_LABELS[rule.binding].toLowerCase();
  if (rule.coverPages) {
    // The cover is made apart: only the pages between the covers fold into signatures.
    const inner = foldedPages(rule, n);
    if (inner <= 0) {
      yield finding("error", "page-count", `${n} pages is only a cover: ${name} needs pages between the covers.`);
      return;
    }
    const needed = pagesToAdd(inner, rule.pageMultiple);
    if (needed) {
      yield finding("error", "page-count",
        `${inner} pages between the covers doesn't work for ${name}: it needs a multiple of ${rule.pageMultiple}. ` +
        `Add ${needed} page${needed > 1 ? "s" : ""} between the covers in InDesign, to reach ${n + needed} in all.`);
    }
    return;
  }
  const needed = pagesToAdd(n, rule.pageMultiple);
  if (needed) {
    yield finding("error", "page-count",
      `${n} pages doesn't work for ${name}: it needs a multiple of ${rule.pageMultiple}. ` +
      `Add ${needed} page${needed > 1 ? "s" : ""} in InDesign, to reach ${n + needed}.`);
  }
}

/** The cover file against the block: its spine, its height, what it lacks. */
function* checkCoverFile({ coverFile: c, setup }) {
  if (!c) return;
  if (c.error) {
    yield finding("error", "cover-file", c.error);
    return;
  }
  const off = c.spineMm - c.calculatedSpineMm;
  if (c.spineMm > 0.05 && Math.abs(off) > 0.5) {
    yield finding("warning", "cover-spine",
      `The cover file's spine is ${formatMm(c.spineMm)} mm; the pages and paper add up to ${formatMm(c.calculatedSpineMm)} mm. ` +
      "Set the paper thickness to the printer's, or build the cover for the printer's spine width.");
  }
  if (setup.binding !== Binding.HARDCOVER && Math.abs(c.heightMm - c.pageHeightMm) > 0.5) {
    yield finding("warning", "cover-height", `The cover is ${formatMm(c.heightMm)} mm tall, the pages ${formatMm(c.pageHeightMm)} mm.`);
  }
  if (c.flapMm > 0.5) yield finding("info", "cover-flaps", `Flaps of ${formatMm(c.flapMm)} mm, folded in over the inside of the cover.`);
  if (!c.inside) yield finding("info", "cover-inside", "The cover file has one page: the inside of the cover is shown unprinted.");
  if (c.spineMm > 0.05) yield finding("info", "cover-spine-art", `The spine is shown from the cover file (${formatMm(c.spineMm)} mm).`);
}

function* checkBindingHints({ book, rule, setup }) {
  const n = book.pages.length;
  const thicknessMm = bookThicknessMm(setup, n);
  const name = BINDING_LABELS[rule.binding].toLowerCase();
  if (rule.maxPagesHint && n > rule.maxPagesHint) {
    yield finding("warning", "too-thick",
      `${n} pages is a lot for ${name} (practical limit ~${rule.maxPagesHint}, depending on paper). Ask your printer.`);
  }
  if (rule.minPagesHint && n < rule.minPagesHint) {
    yield finding("warning", "too-thin", `${n} pages may be too few for a ${name} spine (usually ${rule.minPagesHint}+).`);
  }
  if (rule.maxThicknessMm && thicknessMm > rule.maxThicknessMm) {
    yield finding("warning", "too-thick",
      `The block is about ${formatMm(thicknessMm)} mm thick: the largest coil made for ${name} takes about ${rule.maxThicknessMm} mm. ` +
      "Ask your printer, or split the book.");
  }
  if (rule.innerEdgeLossMm) {
    yield finding("info", "punch", `The punch for ${name} takes ~${rule.innerEdgeLossMm} mm of the inner edge.`);
  }
  if ((rule.binding === Binding.PERFECT || rule.binding === Binding.SEWN) && setup.glueMm > 0 && n >= 6) {
    // Side glue: the cover is glued to the first and last page along the spine, so they can't
    // open there, and what is printed in that strip faces the cover.
    yield finding("info", "side-glue",
      `Side glue: the first and last page are glued to the cover for ${formatMm(setup.glueMm)} mm from the spine. Nothing printed there can be seen.`);
  }
  if (rule.binding === Binding.SADDLE && n >= 8) {
    // The fold takes paper from the outer sheets (a quarter turn round the block), and the trim
    // takes the same off the inner pages' fore-edge: creep (see leafShape, and the export's compensation).
    const fold = (Math.PI / 4) * thicknessMm;
    yield finding("info", "fold",
      `The fold takes about ${formatMm(fold)} mm of the cover's inner margin, and trimming up to that much off the innermost pages' outer edge (creep).`);
  }
}

function* checkFolioStart({ book }) {
  if (book.folioStart % 2 === 0) {
    yield finding("warning", "folio-parity",
      `The PDF numbers its first page ${book.folioStart}, an even number, but a book's first page is always a ` +
      "right-hand page. Every right-hand page would carry an even number.");
  }
}

function* reportLayout({ book, layout, setup }) {
  if (!layout) return;
  const n = book.pages.length;
  const centre = centreSpread(n);
  if (layout.signaturePages === n && centre) {
    yield finding("info", "centre-spread",
      `Center spread is pages ${label(book, centre[0])} • ${label(book, centre[1])}.`, { folios: centre });
  }
  const folded = layout.coverSheet ? imposedCount(book) - 4 : n;
  if (imposedCount(book) < n) {
    yield finding("info", "endpapers",
      "Endpapers: an unprinted leaf at each end of the block (E1 to E4), as every case binding has; " +
      "they are stock, not pages to print, so the sheets leave them out.");
  }
  const sigs = folded / layout.signaturePages;
  const sheets = layout.coverSheet ? layout.sheetCount - 1 : layout.sheetCount;
  const msg = `${sheets} sheet${sheets > 1 ? "s" : ""}, printed both sides` +
    (sigs > 1 ? `, in ${sigs} signatures of ${layout.signaturePages} pages` : "") +
    (layout.coverSheet ? ", and the cover on a sheet of its own." : ".") +
    // The same figure as the side panel's: covers, boards and a printer's width included.
    ` Spine about ${bookThicknessMm(setup, n).toFixed(1)} mm.`;
  yield finding("info", "sheets", msg);
}

/** [1,2,3,7,9,10] -> "1–3, 7, 9–10" */
export function ranges(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return parts.join(", ");
}

const capitalise = (s) => s[0].toUpperCase() + s.slice(1);

