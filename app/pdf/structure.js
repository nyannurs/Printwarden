// Read a PDF's page boxes, page labels and embedded settings with pdf-lib (the boxes are read
// as the file states them, no rendering library needed). No DOM: runs in a worker (tasks-worker.js) or directly in tests.

import {
  decodePDFRawStream, ParseSpeeds, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream,
} from "../../vendor/pdf-lib.esm.js";
import { ptToMm, rect } from "../core/units.js";
import { iccInfo } from "./icc.js";

export const METADATA_KEY = "BookViewImposition";

/**
 * @returns {Promise<{pages: import("../core/document.js").SourcePage[], imposition: object | null,
 *                     outputIntent: {name: string, profile: Uint8Array} | null}>}
 */
export async function readStructure(bytes) {
  // Fastest: pdf-lib otherwise pauses every 100 objects to keep a UI responsive; this runs
  // in a background thread, so there is no UI to protect.
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
  /** @type {import("../core/document.js").SourcePage[]} */
  const pages = doc.getPages().map((page, index) => {
    const has = (key) => page.node.lookupMaybe(PDFName.of(key), PDFArray) !== undefined;
    return {
      index,
      mediaBox: toMm(page.getMediaBox()),
      trimBox: has("TrimBox") ? toMm(page.getTrimBox()) : null,
      bleedBox: has("BleedBox") ? toMm(page.getBleedBox()) : null,
      rotation: ((page.getRotation().angle % 360) + 360) % 360,
    };
  });
  const labels = pageLabelsOf(doc, pages.length);
  if (labels) pages.forEach((p, i) => { p.label = labels[i]; });
  return { pages, imposition: impositionOf(doc), outputIntent: outputIntentOf(doc) };
}

/**
 * The page labels the PDF defines (/PageLabels: what InDesign writes from Numbering &
 * Section Options), one per page, or null if it defines none. Styles: decimal, roman,
 * letters, with prefix and start number, as the PDF reference describes.
 */
function pageLabelsOf(doc, count) {
  try {
    const tree = doc.catalog.lookupMaybe(PDFName.of("PageLabels"), PDFDict);
    if (!tree) return null;
    const ranges = []; // [first page index, label dict]
    const walk = (node, depth) => {
      if (depth > 32) return;
      const nums = node.lookupMaybe(PDFName.of("Nums"), PDFArray);
      for (let i = 0; nums && i + 1 < nums.size(); i += 2) {
        const start = nums.lookup(i)?.asNumber?.();
        const dict = nums.lookup(i + 1);
        if (dict instanceof PDFDict && Number.isInteger(start) && start >= 0) ranges.push([start, dict]);
      }
      const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
      for (let i = 0; kids && i < kids.size(); i++) {
        const kid = kids.lookup(i);
        if (kid instanceof PDFDict) walk(kid, depth + 1);
      }
    };
    walk(tree, 0);
    if (!ranges.length) return null;
    ranges.sort((a, b) => a[0] - b[0]);
    const labels = [];
    for (let page = 0; page < count; page++) {
      let r = -1;
      while (r + 1 < ranges.length && ranges[r + 1][0] <= page) r++;
      if (r < 0) {
        labels.push(null);
        continue;
      }
      const [first, dict] = ranges[r];
      const style = dict.lookup(PDFName.of("S"))?.decodeText?.() ?? null;
      const prefix = dict.lookup(PDFName.of("P"))?.decodeText?.() ?? "";
      const start = dict.lookup(PDFName.of("St"))?.asNumber?.() ?? 1;
      labels.push(prefix + labelNumber(style, start + page - first));
    }
    return labels;
  } catch {
    return null;
  }
}

function labelNumber(style, n) {
  if (style === "D") return String(n);
  if (style === "R" || style === "r") {
    const roman = romanNumeral(n);
    return style === "R" ? roman : roman.toLowerCase();
  }
  if (style === "A" || style === "a") {
    // A–Z, then AA–ZZ, AAA…, as the PDF reference specifies.
    const text = String.fromCharCode(65 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
    return style === "A" ? text : text.toLowerCase();
  }
  return ""; // no style: the prefix alone
}

function romanNumeral(n) {
  if (n < 1 || n > 3999) return String(n);
  /** @type {[number, string][]} */
  const table = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [value, text] of table) {
    while (n >= value) {
      out += text;
      n -= value;
    }
  }
  return out;
}

/** Imposition settings an export from this app left in the file, or null. */
export async function readImposition(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
  return impositionOf(doc);
}

function impositionOf(doc) {
  try {
    const value = doc.getInfoDict().lookup(PDFName.of(METADATA_KEY));
    return value ? JSON.parse(value.decodeText()) : null;
  } catch {
    return null;
  }
}

/**
 * The CMYK profile the PDF was made for (its OutputIntent, e.g. from a PDF/X export).
 * Acrobat converts plain CMYK through it; so do we.
 */
function outputIntentOf(doc) {
  try {
    const intents = doc.catalog.lookupMaybe(PDFName.of("OutputIntents"), PDFArray);
    for (let i = 0; i < (intents?.size() ?? 0); i++) {
      const intent = intents.lookup(i, PDFDict);
      const stream = intent.lookup(PDFName.of("DestOutputProfile"));
      if (!(stream instanceof PDFRawStream)) continue;
      const profile = decodePDFRawStream(stream).decode();
      const info = iccInfo(profile);
      if (info?.colorSpace !== "CMYK") continue;
      // Named as the PDF names the condition (/Info, what InDesign writes: "Coated FOGRA39
      // (ISO 12647-2:2004)"), else by the profile's own description, else the identifier.
      // (The profile's description first, to 0.17.84: pdf.js's compact CGATS profile calls
      // itself "uCMY".)
      const text = (key) => intent.lookup(PDFName.of(key))?.decodeText?.()?.trim();
      const name = text("Info") || info.name || text("OutputConditionIdentifier") || "Output intent";
      return { name, profile };
    }
  } catch {
    // A damaged output intent is ignored: colours fall back to the default profile.
  }
  return null;
}

const toMm = (b) => rect(ptToMm(b.x), ptToMm(b.y), ptToMm(b.x + b.width), ptToMm(b.y + b.height));
