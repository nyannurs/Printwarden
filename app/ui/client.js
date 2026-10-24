// The client viewer export: one HTML file with the book in it, for a designer to send a
// client (see app/client/viewer.js, which runs inside it). The file carries the viewer's own
// modules and three.js, the pages as JPEG images at the height chosen, and the book as
// shown here (binding, paper, spine, wire, headband, side glue); no PDF, nothing fetched,
// so it opens from disk or hosted.
//
// The modules go in as text and are loaded through an import map of blob URLs: every
// import between them is rewritten to a key (viewer/scene.js, three, three/addons/...),
// resolved from the app's own files (see client/bundle.js).

import { bundleModules, CLIENT_ENTRY } from "../client/bundle.js";
import { hasWire, sideGlueMm, wireIsMetal } from "../core/binding.js";
import { label } from "../core/book.js";
import { baseHeight } from "../pdf/render.js";
import { APP_VERSION, chooseSaveLocation } from "../platform.js";
import { scene, state } from "./app.js";
import { clientViewerDialog } from "./dialogs.js";
import { showBusy, toast } from "./dom.js";
import { pageImage } from "./pages.js";

const JPEG_QUALITY = 0.86;

/** Ask, build and save the viewer (Export, then Export as HTML file). */
export async function exportClientViewer() {
  const a = state.analysis;
  if (!a) return;
  const choice = await clientViewerDialog(a);
  if (!choice) return;
  const base = state.name.replace(/\.pdf$/i, "");
  const target = await chooseSaveLocation(`${base} viewer.html`, { name: "HTML", extensions: ["html"], mime: "text/html" });
  if (!target) return;
  const busy = showBusy("Building the viewer…");
  try {
    const html = await buildClientHtml(a, choice.heightPx, (done, total) => busy.progress(done / total));
    busy.title("Saving…");
    const saved = await target.write(new TextEncoder().encode(html));
    toast(`Saved ${saved}`, "info");
  } catch (err) {
    toast(`Viewer export failed: ${err.message}`, "error");
  } finally {
    busy.remove();
  }
}

/**
 * The viewer as one HTML document.
 * @param {ReturnType<typeof import("../core/analysis.js").analyse>} analysis
 * @param {number} heightPx the page images' height
 * @param {(done: number, total: number) => void} [progress]
 */
export async function buildClientHtml(analysis, heightPx, progress = () => {}) {
  const modules = await bundleModules(CLIENT_ENTRY);
  const data = await clientBook(analysis, heightPx, progress);
  const json = (v) => JSON.stringify(v).replace(/<\//g, "<\\/"); // never closes its script
  const title = escapeHtml(data.title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style>${CLIENT_CSS}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="modules">${json(modules)}</script>
<script type="application/json" id="book">${json(data)}</script>
<script>
(() => {
  const modules = JSON.parse(document.getElementById("modules").textContent);
  const imports = {};
  for (const [key, text] of Object.entries(modules)) imports[key] = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  const map = document.createElement("script");
  map.type = "importmap";
  map.textContent = JSON.stringify({ imports });
  document.head.append(map);
  const main = document.createElement("script");
  main.type = "module";
  main.textContent = 'import { start } from "${CLIENT_ENTRY}"; start(JSON.parse(document.getElementById("book").textContent), document.getElementById("root"))'
    + '.then((scene) => { window.viewer = scene; }, (e) => { document.getElementById("root").textContent = "The viewer could not start: " + e.message; });';
  document.body.append(main);
})();
</script>
</body>
</html>
`;
}

/**
 * The book as the viewer needs it (see ClientBook in client/viewer.js): the scene's own
 * spec and look as they stand, and the pages rendered as JPEGs.
 * @returns {Promise<import("../client/viewer.js").ClientBook>}
 */
async function clientBook(analysis, heightPx, progress) {
  const m = scene.model;
  const { book, setup } = analysis;
  const n = book.pages.length;
  const hex = (c) => `#${c.getHexString()}`;
  const spineImage = scene.spineMat.map?.image;
  const glued = sideGlueMm(setup.binding, setup.glueMm, n);
  const pages = [];
  for (let folio = 1; folio <= n; folio++) {
    progress(folio - 1, n);
    const page = book.pages[folio - 1];
    if (!page.source) {
      pages.push(null);
      continue;
    }
    const image = await pageImage(folio, heightPx, 0, { cache: false });
    pages.push(image ? await toDataUrl(image, "image/jpeg", JPEG_QUALITY) : null);
    image?.close?.();
  }
  progress(n, n);
  return {
    title: state.name.replace(/\.pdf$/i, ""),
    version: APP_VERSION,
    book: {
      pageCount: n,
      pageSize: { width: m.width, height: m.height },
      binding: m.binding,
      signaturePages: m.signaturePages ?? null,
      boardMm: m.boardMm ?? null,
      endpapers: !!m.endpapers,
      roundSpine: !!m.roundSpine,
      glueMm: m.glueMm ?? 0,
      caseWrap: !!m.caseWrap,
      paper: {
        ...scene.paper,
        thickness: m.thickness.find((_, i) => i > 0 && i < m.leafCount - 1) ?? m.thickness[0],
        coverThickness: m.coverThickness,
        gsm: m.gsm,
        finish: m.finish,
      },
    },
    background: state.background,
    spine: {
      color: hex(scene.spineMat.color),
      artwork: spineImage ? await toDataUrl(spineImage, "image/png") : null,
      frontEdge: hex(scene.frontWrapMat.color),
      backEdge: hex(scene.backWrapMat.color),
    },
    wire: hasWire(setup.binding) ? { hex: setup.wire, metal: wireIsMetal(setup.wire) } : null,
    headband: setup.binding === "hardcover" ? setup.headband : null,
    glue: { folios: glued ? [2, 3, n - 2, n - 1] : [], mm: glued },
    score: { folios: glued ? [1, n] : [], mm: glued },
    labels: book.pages.map((_, i) => label(book, i + 1)),
    pages,
    // Pages not in view are drawn from images this tall, as the app's are.
    baseHeight: Math.min(heightPx, baseHeight(n, m.width / m.height)),
  };
}

/** An image (bitmap or canvas) as a data URL. */
async function toDataUrl(image, type, quality = undefined) {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  const blob = await canvas.convertToBlob({ type, quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

const CLIENT_CSS = `
html, body { margin: 0; height: 100%; background: #56575b; color: #fff; font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
#root { position: fixed; inset: 0; }
#root .view { position: absolute; inset: 0; }
#root .view canvas { display: block; }
/* The title and the credit along the top, the controls along the bottom: both rows inside the
   screen's safe area, the bottom one wrapping onto a second row where the screen is narrow. */
#root .top, #root .bar { position: absolute; left: calc(12px + env(safe-area-inset-left)); right: calc(12px + env(safe-area-inset-right)); display: flex; gap: 8px; align-items: center; pointer-events: none; }
#root .top > *, #root .bar > * { pointer-events: auto; }
#root .top { top: calc(12px + env(safe-area-inset-top)); flex-wrap: wrap; }
#root .bar { bottom: calc(12px + env(safe-area-inset-bottom)); flex-wrap: wrap; justify-content: center; }
#root .title { display: block; flex-shrink: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; line-height: 30px; }
#root .made { margin-left: auto; flex: none; opacity: 0.6; }
#root .pill { height: 30px; padding: 0 14px; border-radius: 15px; border: 0; background: #000; color: #fff; font: inherit; display: inline-flex; align-items: center; white-space: nowrap; cursor: pointer; }
@media (hover: hover) { #root .pill:hover { background: #fff; color: #000; } }
#root .pill:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
#root .pill:disabled { opacity: 0.4; cursor: default; }
@media (hover: hover) { #root .pill:disabled:hover, #root .pill.label:hover { background: #000; color: #fff; } }
#root .pill.label { cursor: default; }
#root select.pill { appearance: none; -webkit-appearance: none; padding-right: 14px; box-sizing: border-box; }
/* Touch: buttons a finger's size, the menu's text at 16 px (smaller, iOS zooms the page in on it). */
@media (pointer: coarse) {
  #root .pill { height: 40px; border-radius: 20px; padding: 0 16px; font-size: 15px; }
  #root .title { line-height: 40px; }
  #root select.pill { font-size: 16px; }
  #root .made { height: 28px; padding: 0 10px; font-size: 11px; }
}
#root .report { position: absolute; inset: calc(12px + env(safe-area-inset-top)) 12px calc(12px + env(safe-area-inset-bottom)); background: #000; color: #fff; padding: 12px; border-radius: 12px; display: flex; flex-direction: column; gap: 8px; z-index: 2; }
#root .report p { margin: 0; }
#root .report textarea { flex: 1; min-height: 0; background: #111; color: #fff; border: 0; font: 11px/1.4 ui-monospace, Menlo, monospace; white-space: pre; }
#root .report .pill { align-self: flex-end; background: #fff; color: #000; }
`;
