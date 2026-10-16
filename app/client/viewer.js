// The client viewer: one HTML file a designer sends a client, with the 3D book in it (the
// viewer's own modules and three.js inside, the pages as images, no PDF, nothing fetched),
// opened in any browser, from disk or hosted. Built by app/ui/client.js, which embeds this
// module and everything it imports. This runs in the client's browser: it builds the book
// from the embedded description and puts a few controls round it.

import { BookScene } from "../viewer/scene.js";
import { CAMERA_PRESETS } from "../viewer/camera.js";

/**
 * @typedef {{
 *   title: string, version: string,
 *   book: Parameters<BookScene["setBook"]>[0],    // the scene's setBook spec (paper included)
 *   background: string,
 *   spine: {color: string, artwork: string | null, frontEdge: string, backEdge: string},
 *   wire: {hex: string, metal: boolean} | null, headband: string | null,
 *   glue: {folios: number[], mm: number}, score: {folios: number[], mm: number},
 *   labels: string[],                              // one per folio
 *   pages: (string | null)[],                      // one data URL per folio, null for a blank
 *   baseHeight?: number,                           // every page's image while not in view (px tall), as the app has them
 * }} ClientBook
 */

// Drawn at most this many device pixels: about what the app's 3D view has on a Retina
// laptop (the viewer fills the window, the app's view sits beside its panel and timeline).
const PIXEL_BUDGET = 3.5e6;

/**
 * Show the book in `root`.
 * @param {ClientBook} data
 * @param {HTMLElement} root
 */
export async function start(data, root) {
  root.innerHTML = "";
  const view = el("div", "view");
  const bar = el("div", "bar");
  const title = el("div", "pill label", data.title);
  const readout = el("div", "pill label", "");
  const prev = el("button", "pill", "Previous");
  const next = el("button", "pill", "Next");
  const openClose = el("button", "pill", "Open book");
  const camera = document.createElement("select");
  camera.className = "pill";
  for (const [id, preset] of Object.entries(CAMERA_PRESETS)) camera.append(new Option(preset.label, id));
  bar.append(prev, next, openClose, camera, readout);
  const made = el("div", "pill label made", `Made with Printwarden ${data.version}`);
  root.append(view, el("div", "top", [title]), bar, made);

  const scene = new BookScene(view, {
    onTurnRequest: (delta) => scene.goTo(scene.opening + delta),
    onOpenRequest: () => scene.open(),
    onChange: () => sync(),
    onViewSettled: () => pages.sharpen(),
  });
  const pages = pageLoader(scene, data);
  scene.setPixelBudget(PIXEL_BUDGET);
  scene.setBackground(data.background);
  scene.setBook(data.book);
  const artwork = data.spine.artwork ? await loadCanvas(data.spine.artwork) : null;
  scene.setSpine({ color: data.spine.color, artwork, frontEdge: data.spine.frontEdge, backEdge: data.spine.backEdge });
  if (data.wire) scene.setWire(data.wire.hex, { metal: data.wire.metal });
  if (data.headband) scene.setHeadband(data.headband);
  for (const f of data.glue.folios) scene.setPageGlue(f, data.glue.mm);
  for (const f of data.score.folios) scene.setCoverScore(f, data.score.mm);
  scene.goTo(0, { animate: false });

  const sync = () => {
    pages.want(scene.opening);
    const shown = scene.shownFolios.map((f) => data.labels[f - 1] ?? String(f));
    readout.textContent = shown.join(" • ");
    openClose.textContent = scene.isClosed ? "Open book" : "Close book";
    prev.disabled = scene.opening <= 0;
    next.disabled = scene.opening >= Math.ceil(data.book.pageCount / 2);
  };
  prev.addEventListener("click", () => scene.goTo(scene.opening - 1));
  next.addEventListener("click", () => scene.goTo(scene.opening + 1));
  openClose.addEventListener("click", () => (scene.isClosed ? scene.open() : scene.close()));
  camera.addEventListener("change", () => scene.setPreset(camera.value));
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLSelectElement) return;
    if (e.key === "ArrowRight" || e.key === "PageDown") scene.goTo(scene.opening + 1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") scene.goTo(scene.opening - 1);
    else if (e.key === "Home") scene.goTo(0);
    else if (e.key === "End") scene.goTo(Math.ceil(data.book.pageCount / 2));
    else return;
    e.preventDefault();
  });
  sync();
  await pages.loaded;
  pages.sharpen(); // the view may have come to rest before every page was in
  return scene;
}

/**
 * The pages' images, as the app handles its own: every page small (`baseHeight`, decoded
 * from its image, nearest the open spread first, so the book shows at once and fills in),
 * and at the exported size only the spreads around the one open, once the book has come to
 * rest, one image a frame (a large texture's upload is a frame's work: all at once, turning
 * stuttered). All pages at full size were as much texture memory as the app's at their most,
 * twice as much at 2048 px.
 */
function pageLoader(scene, data) {
  const n = data.pages.length;
  const blobs = new Map(); // folio -> its image, as a Blob (decoded when needed)
  const blobOf = async (folio) => {
    if (!blobs.has(folio)) blobs.set(folio, fetch(data.pages[folio - 1]).then((r) => r.blob()));
    return blobs.get(folio);
  };
  const base = data.baseHeight ?? 1024;
  let opening = 0;
  const sharp = new Map(); // folio -> its full-size image shown
  let run = 0;
  const near = () => Array.from({ length: n }, (_, k) => k + 1)
    .sort((a, b) => Math.abs(a - 2 * opening - 0.5) - Math.abs(b - 2 * opening - 0.5));
  const loaded = (async () => {
    for (const folio of near()) {
      if (!data.pages[folio - 1]) continue;
      const image = await createImageBitmap(await blobOf(folio), { resizeHeight: base, resizeQuality: "high" });
      scene.setPageTexture(folio, image, null);
    }
  })();
  return {
    loaded,
    /** The open spread changed: its neighbours first from now on. */
    want(o) {
      opening = o;
    },
    /** At rest: the spread before, the open one and the next at full size; the rest let go. */
    async sharpen() {
      const mine = ++run;
      const want = new Set(Array.from({ length: 6 }, (_, k) => 2 * opening - 2 + k).filter((f) => f >= 1 && f <= n && data.pages[f - 1]));
      for (const [folio, image] of sharp) {
        if (want.has(folio)) continue;
        scene.showPageImage(folio, null);
        image.close();
        sharp.delete(folio);
      }
      // The spread in view first.
      const order = [...want].sort((a, b) => Math.abs(a - 2 * opening - 0.5) - Math.abs(b - 2 * opening - 0.5));
      for (const folio of order) {
        if (sharp.has(folio)) continue;
        const image = await createImageBitmap(await blobOf(folio));
        if (mine !== run) return image.close(); // turned meanwhile: the next rest decides
        await new Promise((r) => requestAnimationFrame(r));
        sharp.set(folio, image);
        scene.showPageImage(folio, image);
      }
    },
  };
}

/** @param {string | Node[]} [children] */
function el(tag, className, children = []) {
  const node = document.createElement(tag);
  node.className = className;
  if (typeof children === "string") node.textContent = children;
  else node.append(...children);
  return node;
}

/** A data URL as a canvas (the spine face is drawn from one). */
async function loadCanvas(src) {
  const image = await createImageBitmap(await (await fetch(src)).blob());
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext("2d").drawImage(image, 0, 0);
  image.close();
  return canvas;
}
