// Wires the pieces together: import a PDF, analyse it, show it in 3D and in the
// timeline, export it imposed. Heavy work (reading, rendering, writing PDFs) runs in
// background threads; this file only coordinates.

import { analyse, defaultSetup, pageSizeOf } from "../core/analysis.js";
import { sideGlueMm, wireIsMetal } from "../core/binding.js";
import { COVER_BASE } from "../core/document.js";
import { coverOf, PAPER_FINISHES, paperThicknessMm, showThrough } from "../core/paper.js";
import { openingOf } from "../core/pairing.js";
import { planSheets } from "../core/sheets.js";
import { coverMmFor, hasSpine, paperForSpine } from "../core/spine.js";
import { openPdf, writeImposed } from "../pdf/load.js";
import { createRenderer, prepareSpareWorkers, routedRenderer } from "../pdf/render.js";
import { makeSamplePdf } from "../pdf/sample.js";
import { APP_NAME, APP_VERSION, canQuit, latestRelease, onMenuCommand, openReleases, quit, savePdf, SYSTEM_MEMORY } from "../platform.js";
import { tileBudget } from "../viewer/tiles.js";
import { BookScene } from "../viewer/scene.js";
import { prepareCaptureTile, renderScreenshot, renderVideo } from "./capture.js";
import { buildClientHtml, exportClientViewer } from "./client.js";
import { applyProfile, colourOptions, profileBytes, setColourProfile, setPlates } from "./colour.js";
import { InkView } from "./inkview.js";
import { makeCompass } from "./compass.js";
import { aboutDialog, exportChoiceDialog, exportDialog, importDialog } from "./dialogs.js";
import { $, addScrollbar, fitPill, showLoad, snapToPixels, toast } from "./dom.js";
import { Filmstrip } from "./filmstrip.js";
import { importFinish, openFinishDialog } from "./finish.js";
import { Inspector } from "./inspector.js";
import { forgetThumbnails, loadAllTextures, thumbnail } from "./pages.js";
import { initPlates, refreshPlates, resetPlates } from "./plates.js";
import { applySpine, importSpineArt, openSpinePanel, renderSpineArt, updateSpinePanel } from "./spine-panel.js";
import { initView, setBackground, showZoom } from "./view.js";
import { resetTiles, tileStats, updateTiles } from "./tiles.js";

const app = $("app");
document.title = APP_NAME;

export const state = {
  name: "",
  bytes: null, // the source PDF, kept for export
  pages: null, // SourcePage[]
  cover: null, // a separate cover file: {name, bytes, pages}, or null (see coverPages in analysis.js)
  spineArt: null, // spine artwork from a PDF: {name, bytes, box, sizeMm, image}, or null (spine-panel.js)
  finish: null, // a spot finish: {name, pages, kind, images}, or null (finish.js)
  pendingFinishKind: null, // the finish chosen before a finish PDF was imported
  capturing: false, // a screenshot or video is being rendered (capture.js)
  renderer: null, // set once the render workers are up
  rendererReady: null, // Promise of the renderer
  setup: defaultSetup(),
  analysis: null,
  generation: 0, // bumps on every re-analysis; stale renders are dropped
  // folio -> {key, height, edge, blank}: which image each page has (it is on the GPU only;
  // a cover keeps its colour along the spine, see coverEdge)
  textures: new Map(),
  details: new Map(), // folio -> strips on screen: [{region, pxPerMm}]
  colour: { options: [], choice: "builtin", inks: [true, true, true, true] }, // CMYK profile options for this document, the plates that print
  inkLut: null, // the chosen profile as the ink table (viewer/inklut.js), once the renderer made it
  flapKey: "", // which flap images the 3D covers show (see applyCoverExtras)
  background: "#56575b", // 3D backdrop colour, remembered between launches
  bookKey: "",
  stripKey: "",
  exportOptions: null, // remembered between exports
};

const updateCompass = makeCompass($("compass"));

export const scene = new BookScene($("viewport"), {
  onTurnRequest: (delta) => scene.goTo(scene.opening + delta),
  onOpenRequest: () => scene.open(),
  onChange: () => onOpeningChanged(),
  // The tiles the view needs (ui/tiles.js): as it moves, and once more at rest (the next finer level too).
  onViewFrame: (time) => updateTiles(time),
  onViewSettled: (time) => updateTiles(time, { settled: true }),
  onZoom: (percent) => showZoom(percent),
  onCamera: (camera) => updateCompass(camera),
});
scene.tiles.setBudget(tileBudget(SYSTEM_MEMORY));

/** The timeline's thumbnails from their inks (the profile and the plates as the 3D view has them). */
export const inkView = new InkView();
export const filmstrip = new Filmstrip($("filmstrip"), {
  onSelect: (opening) => scene.goTo(opening),
  thumbnail: (folio) => thumbnail(folio),
  ink: inkView,
  toggleHost: $("view-toggle"),
});
addScrollbar($("inspector"));

export const inspector = new Inspector($("inspector"), {
  onSetup: (patch) => updateSetup(patch),
  onGoToFolio: (folio) => scene.goTo(openingOf(folio)),
  // Live while picking: the pages', the cover's or the endpapers' colour.
  onPaperPreview: ({ color, coverColor, endpaperColor }) => scene.setPaper(color ? { color } : coverColor ? { cover: { color: coverColor } } : { endpaperColor }),
  onWirePreview: (color) => setWire(color),
  onHeadbandPreview: (color) => scene.setHeadband(color),
  onSpine: () => openSpinePanel(),
  onFinish: () => openFinishDialog(),
  onColourProfile: (id) => setColourProfile(id),
  onBackground: (color, commit) => setBackground(color, commit),
  background: () => state.background,
  onAbout: () => aboutDialog({ name: APP_NAME, version: APP_VERSION }),
});

// --- import ------------------------------------------------------------------------

export async function startImport(file = null) {
  const choice = await importDialog(file);
  if (choice) openDocument(choice);
}

/**
 * The render threads for the open document: the pages' file and, if there is one, the cover
 * file's, as one renderer (routedRenderer). `profile`: the CMYK profile's bytes, or a promise
 * of them. Used on import, and again when the profile changes (colour.js).
 * @param {{bytes: Uint8Array, cover?: {bytes: Uint8Array} | null}} files
 */
export function startRenderers(files, profile) {
  const main = createRenderer(files.bytes, null, profile);
  const cover = files.cover ? createRenderer(files.cover.bytes, null, profile) : null;
  return Promise.all([main, cover]).then(([m, c]) => routedRenderer(m, c));
}

/**
 * @param {{file: {name: string, bytes: Uint8Array}, source: "pages" | "imposed", binding?: string|null, signaturePages?: number|null,
 *          coverSheet?: boolean, cover?: {name: string, bytes: Uint8Array} | null}} choice
 *   cover: a separate cover file (the outside as one spread with its spine, the inside on a second page): see coverPages in analysis.js
 */
async function openDocument({ file, source, binding = null, signaturePages = null, coverSheet = true, cover = null }) {
  app.dataset.state = state.pages ? "reloading" : "loading";
  showLoad(0);
  let rendererReady = null;
  try {
    // Start the render workers while the structure is read: the book appears as soon as
    // its shape is known, and pages fill in as the workers come online. The workers wait
    // only for the CMYK profile, which depends on the PDF's output intent.
    const structure = openPdf(file.bytes);
    const coverStructure = cover && source === "pages" ? openPdf(cover.bytes) : null;
    const colour = structure.then((s) => colourOptions(s.outputIntent));
    colour.catch(() => {}); // a file that can't be read: reported below, from `structure`
    rendererReady = startRenderers({ bytes: file.bytes, cover: coverStructure ? cover : null }, colour.then((c) => profileBytes(c, c.choice)));
    const { pages } = await structure;
    const coverPages = coverStructure ? (await coverStructure).pages : null;
    const colourOptionsOfFile = await colour;
    if (!pages.length) throw new Error("This PDF has no pages.");
    if (coverPages && !coverPages.length) throw new Error(`The cover file ${cover.name} has no pages.`);
    state.colour = colourOptionsOfFile;
    state.renderer?.destroy();
    state.renderer = null;
    state.rendererReady = rendererReady;
    rendererReady.then((r) => {
      if (state.rendererReady !== rendererReady) return r.destroy();
      state.renderer = r;
      refreshPlates(); // the Separations window's rows: usable now
      applyProfile().catch((err) => console.error(err)); // the ink table for the 3D view and the timeline
    });
    state.bytes = file.bytes;
    state.pages = pages;
    state.name = file.name;
    state.cover = coverPages ? { name: cover.name, bytes: cover.bytes, pages: coverPages } : null;
    // Paper and wire are choices about the print job, not the file: they carry over.
    state.setup = { ...defaultSetup(), paper: state.setup.paper, wire: state.setup.wire, source };
    state.spineArt?.image?.close(); // spine artwork belongs to a document
    state.spineArt = null;
    for (const image of state.finish?.images.values() ?? []) image.close(); // so does a finish
    state.finish = null;
    scene.setFinish({ kind: 0, images: new Map() });
    if (binding) state.setup.binding = binding;
    if (signaturePages) state.setup.signaturePages = signaturePages;
    if (!coverSheet) state.setup.coverSheet = false; // an imposed file from before covers had their own sheet
    state.bookKey = "";
    state.stripKey = "";
    state.textures.clear();
    scene.clearPages();
    resetTiles();
    state.details.clear();
    forgetThumbnails();
    resetPlates(); // every plate prints again with a new file
    $("doc-name").textContent = file.name;
    fitPill($("doc-name"), 2, 6);
    document.title = `${file.name} – ${APP_NAME}`;
    app.dataset.state = "ready";
    reanalyse(0); // at the front cover: closed, front up (open it with the button)
    if (state.cover) await adoptCover();
  } catch (err) {
    console.error(err);
    // Its render threads, already starting, aren't wanted.
    if (rendererReady && state.rendererReady !== rendererReady) rendererReady.then((r) => r.destroy(), () => {});
    app.dataset.state = state.pages ? "ready" : "empty";
    showLoad(null);
    toast(`Couldn't open ${file.name}: ${err.message}`, "error");
  }
}

/**
 * What the covers carry besides their pages: side glue and the hinge score (perfect and
 * sewn: the first and last page glued to the cover for `glueMm` from the spine, C2 and
 * page 1, the last page and C3; the score outside on C1 and C4), and a cover file's flaps,
 * folded in over C2 and C3 (their images rendered from the cover file's outside page).
 */
function applyCoverExtras(a) {
  const n = a.book.pages.length;
  const glued = sideGlueMm(a.setup.binding, a.setup.glueMm, n);
  for (const f of [2, 3, n - 2, n - 1]) scene.setPageGlue(f, glued);
  for (const f of [1, n]) scene.setCoverScore(f, glued);
  const flap = a.coverFile && a.coverFile.flapMm > 0.5 && a.coverFile.frontFlapRect ? a.coverFile : null;
  const key = flap ? `${state.name}|${state.cover?.name}|${flap.flapMm.toFixed(2)}|${n}` : "";
  if (key === state.flapKey) return;
  state.flapKey = key;
  if (!flap) {
    scene.setPageFlap(2, null);
    scene.setPageFlap(n - 1, null);
    return;
  }
  const reach = flap.flapMm;
  state.rendererReady.then(async (r) => {
    const [front, back] = await Promise.all([
      r.render(COVER_BASE, flap.frontFlapRect, 1600, 50, { mode: "ink", cache: false }),
      r.render(COVER_BASE, flap.backFlapRect, 1600, 50, { mode: "ink", cache: false }),
    ]);
    if (state.flapKey !== key) { // another book since
      front?.close?.();
      back?.close?.();
      return;
    }
    scene.setPageFlap(2, front, reach, false);
    scene.setPageFlap(n - 1, back, reach, true); // the back flap's fold is at its right end
  }).catch((err) => console.error(err));
}

/**
 * A cover file's spine: its width becomes the spine's (so the 3D block is as thick as the
 * cover was made for), its strip the spine's artwork. After the first analysis, which finds
 * them (coverPages in analysis.js).
 */
async function adoptCover() {
  const cover = state.cover;
  const cf = state.analysis?.coverFile;
  if (!cover || !cf || cf.error) return;
  if (cf.spineMm > 0.05 && cf.flapMm === 0 && !cf.caseWrap) { // a case wrap's spine is the case's: the block is the paper's
    state.setup = { ...state.setup, spine: { ...state.setup.spine, widthMm: Math.round(cf.spineMm * 100) / 100 } };
    reanalyse(0);
  }
  const rect = state.analysis.coverFile?.spineRect;
  if (!rect) return;
  const art = { name: cover.name, bytes: cover.bytes, box: rect, sizeMm: { width: rect.x1 - rect.x0, height: rect.y1 - rect.y0 } };
  art.image = await renderSpineArt(art);
  if (state.cover !== cover) { // another file since
    art.image.close();
    return;
  }
  state.spineArt?.image?.close();
  state.spineArt = art;
  state.setup.spine.rotation = 0;
  applySpine();
}

// --- export ------------------------------------------------------------------------

/** The Export button: the imposed PDF or the client viewer (one button for both, the author's call). */
async function startExport() {
  if (!state.analysis) return;
  const choice = await exportChoiceDialog(!state.analysis.imposed);
  if (choice === "imposed") await exportImposed();
  else if (choice === "viewer") await exportClientViewer();
}

async function exportImposed() {
  if (!state.analysis) return;
  const chosen = await exportDialog(state.analysis, state.exportOptions, async (sheetPages) => {
    await updateSetup({ sheetPages });
    return state.analysis;
  });
  if (!chosen) return;
  // The analysis the dialog ended on: a sheet layout chosen in it made a new one.
  const { options: opts, analysis: a } = chosen;
  state.exportOptions = opts;
  try {
    const plan = planSheets(a, opts);
    const base = state.name.replace(/\.pdf$/i, "");
    const bytes = await writeImposed(state.bytes, a, plan, { fileName: state.name, appName: APP_NAME }, state.cover?.bytes ?? null);
    const saved = await savePdf(`${base}_imposed.pdf`, bytes);
    if (saved) toast(`Exported ${saved}. Import it as Imposed sheets to check it in 3D.`, "ok");
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message}`, "error");
  }
}

// --- analysis ------------------------------------------------------------------------

export function updateSetup(patch) {
  state.setup = { ...state.setup, ...patch };
  reanalyse();
}

function reanalyse(opening = scene.opening) {
  let analysis;
  try {
    analysis = analyse({ pages: state.pages, cover: state.cover ? { name: state.cover.name, pages: state.cover.pages } : null }, state.setup);
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  state.analysis = analysis;
  state.generation++;
  const { setup, book } = analysis;
  const size = pageSizeOf(analysis) ?? { width: 148, height: 210 };
  const paper = scenePaper(setup.paper, setup, book.pages.length);

  const endpapers = book.pages.some((p) => p.endpaper);
  const roundSpine = setup.spineShape === "round";
  const glueMm = sideGlueMm(setup.binding, setup.glueMm, book.pages.length); // the covers hinge at its end (model.js glueCovers)
  const caseWrap = !!analysis.coverFile?.caseWrap && !analysis.coverFile.error; // the boards show the wrap's faces, the case its spine
  const bookKey = [book.pages.length, size.width.toFixed(1), size.height.toFixed(1), setup.binding,
    analysis.rule.signaturePages, paper.thickness.toFixed(3), paper.coverThickness.toFixed(3), paper.gsm, paper.finish, endpapers, roundSpine, glueMm, caseWrap].join("|");
  if (bookKey !== state.bookKey) {
    state.bookKey = bookKey;
    state.details.clear(); // detail images are freed with the old book
    state.flapKey = ""; // new leaves: the flaps are shown again
    scene.setBook({
      pageCount: book.pages.length, pageSize: size, binding: setup.binding,
      signaturePages: analysis.rule.signaturePages, paper, boardMm: setup.boardMm, endpapers, roundSpine, glueMm, caseWrap,
    }); // (the page images stay: see BookScene.setPageTexture)
  } else {
    scene.setPaper(paper); // colour, finish: instant
  }
  applyCoverExtras(analysis);
  setWire(setup.wire);
  scene.setHeadband(setup.headband);
  applySpine();
  updateSpinePanel(setup.binding);

  // The timeline only changes when pages, sizes, layout or errors do: not for paper.
  const stripKey = JSON.stringify([bookKey, book.pages.map((p) => p.source ? `${p.source.index}${p.half}` : "-"),
    analysis.layout?.sheetCount, analysis.findings.filter((f) => f.severity === "error").map((f) => f.folios)]);
  if (stripKey !== state.stripKey) {
    state.stripKey = stripKey;
    filmstrip.render(analysis, size);
  }
  inspector.render(analysis, state.name, state.colour);
  /** @type {HTMLButtonElement} */ ($("export-btn")).disabled = false; // an imposed file: the viewer only (exportChoiceDialog)
  scene.goTo(Math.min(opening, book.pages.length >> 1), { animate: false });
  onOpeningChanged();
  loadAllTextures();
}

/** Wire colour in the 3D view: the presets' own finish, coated for custom colours. */
function setWire(hex) {
  scene.setWire(hex, { metal: wireIsMetal(hex) });
}

/**
 * The paper as the 3D view needs it: the pages' stock, and the cover's (its own colour,
 * finish and weight). A printer's spine width sets the pages' thickness.
 */
function scenePaper(paper, setup, pageCount) {
  const look = (color, gsm, finishId) => {
    const finish = PAPER_FINISHES[finishId] ?? PAPER_FINISHES.uncoated;
    return { color, roughness: finish.roughness, specular: finish.specular, clearcoat: finish.clearcoat, show: showThrough(gsm, finishId) };
  };
  const cover = coverOf(paper);
  const coverThickness = coverMmFor(setup.binding, paper, setup.boardMm); // a hardcover's boards
  const fromSpine = hasSpine(setup.binding) && setup.spine.widthMm
    ? paperForSpine(setup.spine.widthMm, pageCount, coverThickness) : null;
  return {
    ...look(paper.color, paper.gsm, paper.finish),
    cover: look(cover.color, cover.gsm, cover.finish),
    endpaperColor: paper.endpaperColor ?? null,
    thickness: fromSpine ?? paperThicknessMm(paper.gsm, paper.finish, paper.volume ?? null),
    coverThickness,
    gsm: paper.gsm, // with the finish, how stiff the pages are: the shape of an open book
    finish: paper.finish,
  };
}

// --- view --------------------------------------------------------------------------

export function onOpeningChanged() {
  if (state.capturing) return; // a video turning pages: the window stays as it was
  showIcon($("close-btn"), scene.isClosed || scene.atCover ? "open" : "close");
  showFocus();
  if (state.analysis) filmstrip.setActive(scene.opening);
}

/** An icon pill (styles.css, app/icons/) shows `icon`: its picture and its name for screen readers. */
const ICON_NAMES = { open: "Open", close: "Close", "left-page": "Left page", spread: "Spread", "right-page": "Right page" };
function showIcon(button, icon) {
  button.dataset.icon = icon;
  button.setAttribute("aria-label", ICON_NAMES[icon]);
}

// The view's center, in turn: the spread, the left page, the right page. The pill shows the
// next; closed or at a cover (one page showing) it has nothing to do.
const NEXT_FOCUS = new Map([[0, -1], [-1, 1], [1, 0]]);
const FOCUS_ICON = new Map([[-1, "left-page"], [0, "spread"], [1, "right-page"]]);
function showFocus() {
  showIcon($("focus-btn"), FOCUS_ICON.get(NEXT_FOCUS.get(scene.focus)));
  /** @type {HTMLButtonElement} */ ($("focus-btn")).disabled = scene.isClosed || scene.atCover;
}

$("import-btn").addEventListener("click", () => startImport());
$("empty-import").addEventListener("click", () => startImport());
$("export-btn").addEventListener("click", startExport);
$("sample-btn").addEventListener("click", async () => {
  openDocument({ file: { name: "sample.pdf", bytes: await makeSamplePdf() }, source: "pages" });
});
$("shot-btn").addEventListener("click", renderScreenshot);
$("video-btn").addEventListener("click", () => renderVideo());
// The welcome screen: the name, About, Quit (desktop only).
$("welcome").textContent = `Welcome to ${APP_NAME}`;
$("empty-about").addEventListener("click", () => aboutDialog({ name: APP_NAME, version: APP_VERSION }));
$("quit-btn").hidden = !canQuit;
$("quit-btn").addEventListener("click", quit);
// On whole pixels (dom.js): the welcome, centred in the window; every dialog as it opens.
{
  const card = document.querySelector(".empty-card");
  snapToPixels([card], { width: true }); // as wide as "Try out sample": whole pixels, even
  snapToPixels([card.querySelector(".welcome-glyph")], { height: true }); // its height from that width
  snapToPixels([...card.children]);
}
document.addEventListener("toggle", (e) => {
  if (e.target instanceof HTMLDialogElement && e.target.open && !e.target.classList.contains("floating")) snapToPixels([e.target], { centre: true });
}, true);
// A newer release on GitHub: "Update available" under the welcome's buttons, opening the
// releases page (the check: once a start, see platform.js).
$("update-link").addEventListener("click", (e) => {
  e.preventDefault();
  openReleases();
});
latestRelease().then((latest) => {
  if (latest?.newer) $("update-link").hidden = false;
});
$("focus-btn").addEventListener("click", () => scene.setFocus(NEXT_FOCUS.get(scene.focus)));
$("close-btn").addEventListener("click", () => {
  if (scene.isClosed || scene.atCover) scene.open();
  else scene.close(); // turns back to the first page, then closes
});

onMenuCommand((command) => {
  if (command === "about") aboutDialog({ name: APP_NAME, version: APP_VERSION }); // the app menu's About (macOS)
  if (command === "import") startImport();
  if (command === "export" && state.analysis && !state.analysis.imposed) startExport();
});

initView();
initPlates();
scene.setPageKind("ink"); // the pages' textures are their inks (pdf/mupdf-render.js), before any book

// Load the render workers while the app sits idle: the first import starts instantly.
prepareSpareWorkers(300);

// For debugging from the developer console.
window.app = {
  state, scene, openDocument, updateSetup, updateTiles, tileStats, setColourProfile, setPlates, prepareCaptureTile, buildClientHtml, openSpinePanel, importSpineArt, renderVideo, importFinish, openFinishDialog,
};
