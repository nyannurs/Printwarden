// Wires the pieces together: import a PDF, analyse it, show it in 3D and in the
// timeline, export it imposed. Heavy work (reading, rendering, writing PDFs) runs in
// background threads; this file only coordinates.

import { analyse, defaultSetup } from "../core/analysis.js";
import { WIRE_COLORS } from "../core/binding.js";
import { coverOf, PAPER_FINISHES, paperThicknessMm, showThrough } from "../core/paper.js";
import { openingOf } from "../core/pairing.js";
import { planSheets } from "../core/sheets.js";
import { coverMmFor, hasSpine, paperForSpine } from "../core/spine.js";
import { openForRendering, openPdf, writeImposed } from "../pdf/load.js";
import { createRenderer, prepareSpareWorkers } from "../pdf/render.js";
import { makeSamplePdf } from "../pdf/sample.js";
import { APP_NAME, APP_VERSION, canQuit, latestRelease, onMenuCommand, openReleases, quit, savePdf } from "../platform.js";
import { BookScene } from "../viewer/scene.js";
import { prepareCaptureTile, renderScreenshot, renderVideo } from "./capture.js";
import { colourOptions, profileBytes, setColourProfile } from "./colour.js";
import { makeCompass } from "./compass.js";
import { aboutDialog, exportDialog, importDialog } from "./dialogs.js";
import { $, addScrollbar, fitPill, showLoad, snapToPixels, toast } from "./dom.js";
import { Filmstrip } from "./filmstrip.js";
import { importFinish, openFinishDialog } from "./finish.js";
import { Inspector } from "./inspector.js";
import { forgetThumbnails, isSharp, loadAllTextures, sharpen, thumbnail, warmVisiblePages } from "./pages.js";
import { applySpine, importSpineArt, openSpinePanel, updateSpinePanel } from "./spine-panel.js";
import { initView, setBackground, showZoom } from "./view.js";

const app = $("app");
document.title = APP_NAME;

export const state = {
  name: "",
  bytes: null, // the source PDF, kept for export
  pages: null, // SourcePage[]
  renderer: null, // set once the render workers are up
  rendererReady: null, // Promise of the renderer
  setup: defaultSetup(),
  analysis: null,
  generation: 0, // bumps on every re-analysis; stale renders are dropped
  // folio -> {key, height, edge, blank}: which image each page has (it is on the GPU only;
  // a cover keeps its colour along the spine, see coverEdge)
  textures: new Map(),
  details: new Map(), // folio -> strips on screen: [{region, pxPerMm}]
  colour: { options: [], choice: "builtin" }, // CMYK profile options for this document
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
  onViewSettled: () => sharpen(),
  // Moving: what was being sharpened for the view that was is no longer wanted.
  onViewMoving: () => state.renderer?.cancel(isSharp),
  onZoom: (percent) => showZoom(percent),
  onCamera: (camera) => updateCompass(camera),
});

export const filmstrip = new Filmstrip($("filmstrip"), {
  onSelect: (opening) => scene.goTo(opening),
  thumbnail: (folio) => thumbnail(folio),
  toggleHost: $("view-toggle"),
});
addScrollbar($("inspector"));

export const inspector = new Inspector($("inspector"), {
  onSetup: (patch) => updateSetup(patch),
  onGoToFolio: (folio) => scene.goTo(openingOf(folio)),
  // Live while picking: the pages' or the cover's colour.
  onPaperPreview: ({ color, coverColor }) => scene.setPaper(color ? { color } : { cover: { color: coverColor } }),
  onWirePreview: (color) => setWire(color),
  onSpine: () => openSpinePanel(),
  onFinish: () => openFinishDialog(),
  onColourProfile: (id) => setColourProfile(id),
  onBackground: (color, commit) => setBackground(color, commit),
  background: () => state.background,
});

// --- import ------------------------------------------------------------------------

export async function startImport(file = null) {
  const choice = await importDialog(file);
  if (choice) openDocument(choice);
}

/** @param {{file: {name: string, bytes: Uint8Array}, source: "pages" | "imposed", binding?: string|null, signaturePages?: number|null, coverSheet?: boolean}} choice */
async function openDocument({ file, source, binding = null, signaturePages = null, coverSheet = true }) {
  app.dataset.state = state.pages ? "reloading" : "loading";
  showLoad(0);
  let rendererReady = null;
  try {
    // Start the render workers while the structure is read: the book appears as soon as
    // its shape is known, and pages fill in as the workers come online. The workers wait
    // only for the CMYK profile, which depends on the PDF's output intent.
    const structure = openPdf(file.bytes);
    const colour = structure.then((s) => colourOptions(s.outputIntent));
    colour.catch(() => {}); // a file that can't be read: reported below, from `structure`
    rendererReady = createRenderer(file.bytes, () => openForRendering(file.bytes),
      colour.then((c) => profileBytes(c, c.choice)));
    const { pages } = await structure;
    const colourOptionsOfFile = await colour;
    if (!pages.length) throw new Error("This PDF has no pages.");
    state.colour = colourOptionsOfFile;
    state.renderer?.destroy();
    state.renderer = null;
    state.rendererReady = rendererReady;
    rendererReady.then((r) => {
      if (state.rendererReady !== rendererReady) return r.destroy();
      state.renderer = r;
      warmVisiblePages();
    });
    state.bytes = file.bytes;
    state.pages = pages;
    state.name = file.name;
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
    state.details.clear();
    forgetThumbnails();
    $("doc-name").textContent = file.name;
    fitPill($("doc-name"), 2, 6);
    document.title = `${file.name} – ${APP_NAME}`;
    app.dataset.state = "ready";
    reanalyse(0); // at the front cover: closed, front up (open it with the button)
  } catch (err) {
    console.error(err);
    // Its render threads, already starting, aren't wanted.
    if (rendererReady && state.rendererReady !== rendererReady) rendererReady.then((r) => r.destroy(), () => {});
    app.dataset.state = state.pages ? "ready" : "empty";
    showLoad(null);
    toast(`Couldn't open ${file.name}: ${err.message}`, "error");
  }
}

// --- export ------------------------------------------------------------------------

async function startExport() {
  const a = state.analysis;
  if (!a) return;
  const opts = await exportDialog(a, state.exportOptions);
  if (!opts) return;
  state.exportOptions = opts;
  try {
    const plan = planSheets(a, opts);
    const base = state.name.replace(/\.pdf$/i, "");
    const bytes = await writeImposed(state.bytes, a, plan, { fileName: state.name, appName: APP_NAME });
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
    analysis = analyse({ pages: state.pages }, state.setup);
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  state.analysis = analysis;
  state.generation++;
  const { setup, book } = analysis;
  const size = analysis.geometry.find(Boolean)?.size ?? { width: 148, height: 210 };
  const paper = scenePaper(setup.paper, setup, book.pages.length);

  const bookKey = [book.pages.length, size.width.toFixed(1), size.height.toFixed(1), setup.binding,
    analysis.rule.signaturePages, paper.thickness.toFixed(3), paper.coverThickness.toFixed(3), paper.gsm, paper.finish].join("|");
  if (bookKey !== state.bookKey) {
    state.bookKey = bookKey;
    state.details.clear(); // detail images are freed with the old book
    scene.setBook({
      pageCount: book.pages.length, pageSize: size, binding: setup.binding,
      signaturePages: analysis.rule.signaturePages, paper,
    }); // (the page images stay: see BookScene.setPageTexture)
  } else {
    scene.setPaper(paper); // colour, finish: instant
  }
  setWire(setup.wire);
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
  /** @type {HTMLButtonElement} */ ($("export-btn")).disabled = analysis.imposed;
  scene.goTo(Math.min(opening, book.pages.length >> 1), { animate: false });
  onOpeningChanged();
  loadAllTextures();
}

/** Wire colour in the 3D view: the presets' own finish, coated for custom colours. */
function setWire(hex) {
  scene.setWire(hex, { metal: WIRE_COLORS.find((w) => w.hex === hex.toLowerCase())?.metal ?? false });
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
  const coverThickness = coverMmFor(setup.binding, paper); // a hardcover's boards
  const fromSpine = hasSpine(setup.binding) && setup.spine.widthMm
    ? paperForSpine(setup.spine.widthMm, pageCount, coverThickness) : null;
  return {
    ...look(paper.color, paper.gsm, paper.finish),
    cover: look(cover.color, cover.gsm, cover.finish),
    thickness: fromSpine ?? paperThicknessMm(paper.gsm, paper.finish),
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
$("about-btn").addEventListener("click", () => aboutDialog({ name: APP_NAME, version: APP_VERSION }));
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
  if (e.target instanceof HTMLDialogElement && e.target.open && !e.target.classList.contains("floating")) snapToPixels([e.target]);
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

// Load the render workers while the app sits idle: the first import starts instantly.
prepareSpareWorkers(300);

// For debugging from the developer console.
window.app = {
  state, scene, openDocument, updateSetup, sharpen, setColourProfile, prepareCaptureTile, openSpinePanel, importSpineArt, renderVideo, importFinish, openFinishDialog,
};
