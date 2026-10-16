// Execute a sheet plan against the source PDF with pdf-lib. Pages are placed as form
// XObjects (vectors, fonts and colour untouched), never rasterised. Each source page is
// embedded once and clipped per placement, so spread halves share their resources.

import {
  clip, cmyk, endPath, ParseSpeeds, PDFDocument, PDFName, PDFObjectCopier, PDFString, popGraphicsState,
  pushGraphicsState, rectangle, StandardFonts,
} from "../../vendor/pdf-lib.esm.js";
import { mmToPt } from "../core/units.js";
import { COVER_BASE } from "../core/document.js";
import { METADATA_KEY } from "../pdf/structure.js";
const REGISTRATION = cmyk(1, 1, 1, 1);
const HAIRLINE_PT = 0.25;

/**
 * @param {Uint8Array} sourceBytes
 * @param {ReturnType<typeof import("../core/analysis.js").analyse>} analysis
 * @param {ReturnType<typeof import("../core/sheets.js").planSheets>} plan
 * @param {{fileName: string, appName: string}} info
 * @returns {Promise<Uint8Array>}
 */
export async function writeImposedPdf(sourceBytes, analysis, plan, info, coverBytes = null) {
  if (plan.errors.length) throw new Error(plan.errors[0]);
  // Full speed: pdf-lib otherwise pauses every 100 objects for a UI, and this runs in a background thread.
  const src = await PDFDocument.load(sourceBytes, { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
  const out = await PDFDocument.create();
  out.setTitle(`${info.fileName} (imposed)`);
  out.setCreator(info.appName);
  out.setProducer(info.appName);
  copyOutputIntents(src, out);

  // Embed every source page that is placed, once: the pages' file's, and a cover file's
  // (a stitched booklet's cover sheet; see COVER_BASE).
  const placed = new Set(plan.sides.flatMap((side) => side.placements.map((p) => p.folio)));
  const used = [...new Set(analysis.book.pages.filter((p) => p.source && placed.has(p.number)).map((p) => p.source.index))];
  const embedded = new Map();
  const ownPages = used.filter((i) => i < COVER_BASE);
  const forms = await out.embedPdf(src, ownPages);
  ownPages.forEach((index, i) => embedded.set(index, forms[i]));
  const coverPages = used.filter((i) => i >= COVER_BASE);
  if (coverPages.length) {
    if (!coverBytes) throw new Error("The cover file is missing.");
    const coverDoc = await PDFDocument.load(coverBytes, { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
    const coverForms = await out.embedPdf(coverDoc, coverPages.map((i) => i - COVER_BASE));
    coverPages.forEach((index, i) => embedded.set(index, coverForms[i]));
  }

  const font = await out.embedFont(StandardFonts.Helvetica);
  const W = mmToPt(plan.sheetSize.width);
  const H = mmToPt(plan.sheetSize.height);
  const date = new Date().toISOString().slice(0, 10);

  for (const side of plan.sides) {
    const page = out.addPage([W, H]);
    // Printer-spread boxes: re-importing this file finds both pages from the TrimBox.
    const a = plan.area;
    const b = plan.marks.bleed;
    page.setTrimBox(pt(a.x0), pt(a.y0), pt(a.x1 - a.x0), pt(a.y1 - a.y0));
    page.setBleedBox(pt(a.x0 - b.outside), pt(a.y0 - b.bottom), pt(a.x1 - a.x0 + 2 * b.outside), pt(a.y1 - a.y0 + b.top + b.bottom));

    for (const placement of side.placements) {
      const bookPage = analysis.book.pages[placement.folio - 1];
      if (!bookPage.source) continue; // inserted blank: the sheet area stays empty
      const g = analysis.geometry[placement.folio - 1];
      const form = embedded.get(bookPage.source.index);
      const media = bookPage.source.mediaBox;
      const c = placement.clip;
      page.pushOperators(
        pushGraphicsState(),
        rectangle(pt(c.x0), pt(c.y0), pt(c.x1 - c.x0), pt(c.y1 - c.y0)),
        clip(),
        endPath(),
      );
      // The form's origin is the media box's lower-left corner; move the trim into place.
      page.drawPage(form, {
        x: pt(placement.trim.x0 - (g.trim.x0 - media.x0)),
        y: pt(placement.trim.y0 - (g.trim.y0 - media.y0)),
      });
      page.pushOperators(popGraphicsState());
    }
    const where = side.cover ? `cover ${side.side}` : `sheet ${side.sheet} ${side.side}`;
    drawMarks(page, plan, side, font, `${info.fileName}  •  ${where}  •  ${date}`);
  }

  // @ts-expect-error -- private in pdf-lib, and the only way to a key of our own in the info
  out.getInfoDict().set(PDFName.of(METADATA_KEY), PDFString.of(JSON.stringify({
    version: 2, // 2: the cover on a sheet of its own where it is made apart (perfect, sewn, hardcover)
    binding: analysis.setup.binding,
    signaturePages: analysis.layout.signaturePages,
    pageWidth: analysis.setup.page.width,
    pageHeight: analysis.setup.page.height,
    sheetSides: plan.sides.length,
  })));
  return out.save();
}

function drawMarks(page, plan, side, font, text) {
  const { area, marks } = plan;
  const s = marks.start;
  const e = marks.end;
  const line = (x0, y0, x1, y1, dash) => page.drawLine({
    start: { x: pt(x0), y: pt(y0) },
    end: { x: pt(x1), y: pt(y1) },
    thickness: HAIRLINE_PT,
    color: REGISTRATION,
    dashArray: dash,
  });
  if (marks.crop) {
    for (const x of [area.x0, area.x1]) {
      const dir = x === area.x0 ? -1 : 1;
      for (const y of [area.y0, area.y1]) {
        const vdir = y === area.y0 ? -1 : 1;
        line(x + dir * s, y, x + dir * e, y); // horizontal
        line(x, y + vdir * s, x, y + vdir * e); // vertical
      }
    }
  }
  if (marks.fold) {
    const cx = (area.x0 + area.x1) / 2;
    line(cx, area.y1 + s, cx, area.y1 + e, [2, 2]);
    line(cx, area.y0 - s, cx, area.y0 - e, [2, 2]);
  }
  if (marks.info) {
    // The standard font writes Western European characters only (WinAnsi): any other in the
    // file's name stopped the whole export. Those show as "?" instead.
    const writable = new Set(font.getCharacterSet());
    const shown = [...text].map((ch) => (writable.has(ch.codePointAt(0)) ? ch : "?")).join("");
    page.drawText(shown, { x: pt(area.x0 + e), y: pt(area.y0 - e - 2), size: 6, font, color: REGISTRATION });
  }
}

/** Keep PDF/X output intents, so colour-managed workflows survive imposition. */
function copyOutputIntents(src, out) {
  const intents = src.catalog.lookup(PDFName.of("OutputIntents"));
  if (!intents) return;
  const copier = PDFObjectCopier.for(src.context, out.context);
  out.catalog.set(PDFName.of("OutputIntents"), copier.copy(intents));
}

const pt = mmToPt;
