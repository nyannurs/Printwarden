// One call from a loaded document plus settings to everything the UI displays.

import { Binding, ruleFor, WIRE_COLORS } from "./binding.js";
import { buildBook, buildImposedBook, isRecto } from "./book.js";
import { detectSpreads, SpreadMode, SpreadPattern } from "./detect.js";
import { layoutFor } from "./imposition.js";
import { facingPairs } from "./pairing.js";
import { defaultPaper, paperThicknessMm } from "./paper.js";
import { defaultSpine } from "./spine.js";
import { bleedRectFor, setupFromPdf, trimRectFor } from "./setup.js";
import { rectSize, rotated } from "./units.js";
import { validate } from "./validate.js";

/**
 * @typedef {{
 *   source: "pages" | "imposed",   // how the PDF is laid out
 *   binding: string, spreadMode: string, signaturePages: number | null,
 *   blanks: import("./book.js").BlankInsertion[],
 *   paper: import("./paper.js").Paper,
 *   wire: string,                  // wire colour (spiral, wire-o), hex
 *   spine: import("./spine.js").Spine,
 *   page: import("./setup.js").PageSetup | null,   // null = derive from the PDF
 *   coverSheet?: boolean,          // imposed files: false for those made before covers had a sheet of their own
 * }} Setup
 */

/** @returns {Setup} */
export const defaultSetup = () => ({
  source: "pages",
  binding: Binding.SADDLE,
  spreadMode: SpreadMode.AUTO,
  signaturePages: null,
  blanks: [],
  paper: defaultPaper(),
  wire: WIRE_COLORS[0].hex,
  spine: defaultSpine(),
  page: null,
});

/**
 * @param {{pages: import("./document.js").SourcePage[], name?: string}} doc
 * @param {Partial<Setup>} partial
 */
export function analyse(doc, partial = {}) {
  const input = { ...defaultSetup(), ...partial };
  const paper = { ...defaultPaper(), ...input.paper };
  const manual = input.page?.mode === "manual" ? input.page : null;
  const imposed = input.source === "imposed";
  // An imposed file from before covers had a sheet of their own folds them in.
  const rule = { ...ruleFor(input.binding, input.signaturePages), ...(imposed && input.coverSheet === false ? { coverPages: 0 } : {}) };

  let detection;
  let book;
  let layout;
  if (imposed) {
    const all = doc.pages.map(() => true);
    detection = { isSpread: all, mode: SpreadMode.AUTO, pattern: SpreadPattern.IMPOSED, note: "", spreadCount: all.length };
    layout = layoutFor(rule, doc.pages.length * 2);
    // If the sheets can't be folded with this binding, show them in file order instead
    // (validate reports why), so there is still something to look at.
    book = layout && layout.sides.length === doc.pages.length
      ? buildImposedBook(doc.pages, layout)
      : { ...buildBook(doc.pages, all, []), folioStart: 1, labelled: false };
  } else {
    detection = detectSpreads(doc.pages, input.spreadMode, manual);
  }
  const page = manual ?? setupFromPdf(doc.pages, detection.isSpread);
  const setup = {
    ...input,
    paper,
    page,
    blanks: imposed ? [] : input.blanks,
    paperThicknessMm: paperThicknessMm(paper.gsm, paper.finish, paper.volume ?? null),
  };
  if (!imposed) {
    book = buildBook(doc.pages, detection.isSpread, setup.blanks);
    layout = layoutFor(rule, book.pages.length);
  }
  const geometry = book.pages.map((p) => pageGeometry(p, page, imposed));
  const result = { document: doc, setup, rule, detection, book, geometry, pairs: facingPairs(book), layout, imposed };
  const findings = validate(result);
  return { ...result, findings, hasErrors: findings.some((f) => f.severity === "error") };
}

/**
 * Where a finished page sits on its source page (PDF user space, mm), and its size.
 * null for inserted blanks.
 */
function pageGeometry(bookPage, pageSetup, imposed = false) {
  const src = bookPage.source;
  if (!src) return null;
  const recto = isRecto(bookPage.number);
  const trim = trimRectFor(src, bookPage.half, recto, pageSetup, imposed);
  const bleed = bleedRectFor(src, bookPage.half, recto, pageSetup, trim, imposed);
  const s = rectSize(trim);
  return { trim, bleed, size: src.rotation % 180 ? rotated(s) : s };
}
