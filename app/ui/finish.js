// Spot finish: a gloss varnish or a foil, from a PDF of its own (the finish's layer alone),
// shown on the 3D pages.

import { openPdf } from "../pdf/load.js";
import { renderMany } from "../pdf/render.js";
import { pickPdf } from "../platform.js";
import { scene, state } from "./app.js";
import { profileBytes } from "./colour.js";
import { finishDialog } from "./dialogs.js";
import { toast } from "./dom.js";

const FINISH_KINDS = { gloss: 1, gold: 2, silver: 3, copper: 4 };
export const FINISH_HEIGHT = 1600; // px per page: masks are soft-edged shapes, not type

/**
 * A finish PDF (the varnish or foil layer on its own): its pages render as masks, in the
 * same page geometry as the document's (spreads split alike), or onto the covers when it
 * has one or two pages. Belongs to the document (reset on import).
 */
export async function importFinish(file = null) {
  file ??= await pickPdf();
  if (!file) return;
  try {
    const a = state.analysis;
    const { pages } = await openPdf(file.bytes);
    const n = a.book.pages.length;
    let jobs;
    if (pages.length === a.document.pages.length) {
      // The document's own pages (a cover file's, C1 to C4, aren't in the finish PDF: their
      // index is the cover file's, which would ask the finish file for a page it hasn't).
      jobs = a.book.pages
        .map((p, k) => (p.source && p.source.file !== "cover" && a.geometry[k] ? { folio: k + 1, index: p.source.index, rectMm: a.geometry[k].trim } : null))
        .filter(Boolean);
    } else if (pages.length <= 2) {
      const box = (i) => pages[i].trimBox ?? pages[i].mediaBox;
      jobs = [{ folio: 1, index: 0, rectMm: box(0) }];
      if (pages.length === 2) jobs.push({ folio: n, index: 1, rectMm: box(1) });
    } else {
      throw new Error(`it has ${pages.length} pages: it needs as many as the document (${a.document.pages.length}), or one or two for the covers`);
    }
    const profile = await profileBytes(state.colour, state.colour.choice);
    const images = await renderMany(file.bytes, jobs.map((j) => ({ ...j, height: FINISH_HEIGHT })), profile);
    for (const image of state.finish?.images.values() ?? []) image.close();
    // Its bytes and jobs kept: a capture draws a page's mask again at its own resolution (finishAt).
    state.finish = { name: file.name, pages: pages.length, kind: state.finish?.kind ?? state.pendingFinishKind ?? "gloss", images: new Map(jobs.map((j, k) => [j.folio, images[k]])), bytes: file.bytes, jobs };
    applyFinish();
  } catch (err) {
    console.error(err);
    toast(`Couldn't use ${file.name} as the finish: ${err.message}`, "error");
  }
}

/**
 * The finish's masks of some pages (`heights`: folio -> px) drawn again at that height, for a
 * capture (ui/capture.js): shown in place of the screen's until applyFinish puts those back.
 * The images are the caller's to close. Resolves to them (folio -> image).
 * @param {Map<number, number>} heights
 */
export async function finishAt(heights) {
  const f = state.finish;
  if (!f?.bytes) return new Map();
  const jobs = f.jobs.filter((j) => heights.has(j.folio)).map((j) => ({ ...j, height: heights.get(j.folio) }));
  if (!jobs.length) return new Map();
  const profile = await profileBytes(state.colour, state.colour.choice);
  const images = await renderMany(f.bytes, jobs, profile);
  const sharp = new Map(jobs.map((j, k) => [j.folio, images[k]]));
  scene.setFinish({ kind: FINISH_KINDS[f.kind], images: new Map([...f.images, ...sharp]) });
  return sharp;
}

export function applyFinish() {
  const f = state.finish;
  scene.setFinish({ kind: f ? FINISH_KINDS[f.kind] : 0, images: f?.images ?? new Map() });
}

export function openFinishDialog() {
  if (!state.analysis) return;
  finishDialog({
    info: () => ({ name: state.finish?.name ?? null, pages: state.finish?.pages ?? 0, kind: state.finish?.kind ?? state.pendingFinishKind ?? "gloss" }),
    importPdf: () => importFinish(),
    setKind: (kind) => {
      if (state.finish) {
        state.finish.kind = kind;
        applyFinish();
      } else state.pendingFinishKind = kind;
    },
    remove: () => {
      for (const image of state.finish?.images.values() ?? []) image.close();
      state.finish = null;
      applyFinish();
    },
  });
}
