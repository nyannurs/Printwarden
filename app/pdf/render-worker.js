// Renders PDF pages in a background thread, so the interface never stutters. Each
// worker owns its own copy of the document; pages are drawn from the PDF's vectors at
// whatever resolution is asked for and returned as ImageBitmaps (zero-copy transfer).

import * as pdfjs from "../../vendor/pdf.mjs";
import { blockTree, skippable } from "./cull.js";

const vendor = (p) => new URL(`../../vendor/${p}`, import.meta.url).href;

class CanvasFactory {
  create(width, height) {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, context: canvas.getContext("2d", { willReadFrequently: true }) };
  }
  reset(cc, width, height) {
    cc.canvas.width = width;
    cc.canvas.height = height;
  }
  destroy(cc) {
    cc.canvas.width = 0;
    cc.canvas.height = 0;
  }
}

/** No DOM here, so no SVG filters: transfer-function effects render unfiltered. */
class FilterFactory {
  addFilter() { return "none"; }
  addHCMFilter() { return "none"; }
  addAlphaFilter() { return "none"; }
  addLuminosityFilter() { return "none"; }
  addHighlightHCMFilter() { return "none"; }
  destroy() {}
}

let doc = null;
// The pages interpreted last are kept (their operations, decoded images and glyph outlines:
// tens of MB a page with photos), so another render of one takes milliseconds: the pages in
// view, rendered again sharper or in other regions, and their neighbours. Older ones are let
// go (see forget): kept all, six threads held about 800 MB for a 44-page document.
const KEEP_PAGES = 4;
const pages = new Map(); // page index -> Promise<PDFPageProxy>, the longest unused first
const page = (i) => {
  const p = pages.get(i) ?? doc.getPage(i + 1);
  pages.delete(i);
  pages.set(i, p);
  return p;
};
const blocks = new Map(); // page index -> {list, tree}: see cull.js
let busy = 0; // renders and analyses under way
let resting = null; // the document's caches being let go (see "rest"): new work waits for it

const inUse = new Map(); // page index -> renders and analyses of it under way

/** Run `fn` with page `i` held: not let go meanwhile (see forget). */
async function held(i, fn) {
  inUse.set(i, (inUse.get(i) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    if (inUse.get(i) > 1) inUse.set(i, inUse.get(i) - 1);
    else inUse.delete(i);
  }
}

/**
 * Let go of the pages unused longest, beyond KEEP_PAGES. Not one in use: pdf.js would clear
 * what it interpreted the moment its render ended, before an analysis had read it (see
 * analyse), and the glyphs it chose came out different.
 */
function forget() {
  for (const [i, p] of pages) {
    if (pages.size <= KEEP_PAGES) return;
    if (inUse.has(i)) continue;
    pages.delete(i);
    blocks.delete(i);
    skips.delete(i);
    p.then((pg) => pg.cleanup(), () => {});
    self.postMessage({ type: "forgot", index: i });
  }
}
const running = new Map(); // render id -> pdf.js RenderTask, while drawing
const PT_PER_MM = 72 / 25.4;
// "display", not "print": in print mode pdf.js discards a page's interpreted content after
// every render (to save memory while printing), so each render redid ~0.3 s of work.
// Kept, a repeat render of a page costs milliseconds at any resolution. (For InDesign
// output the two modes draw the same; they differ only for screen-only annotations.)
const RENDER_INTENT = "display";

// pdf.js parses in its own worker. We create it ourselves (no same-origin checks, which
// assume a window) through a wrapper that can supply our CMYK profile. Created at once, so
// a worker started ahead of time (see prepareSpareWorkers in render.js) has everything
// loaded before a document arrives.
const parser = new Worker(new URL("./parser-worker.js", import.meta.url), { type: "module" });
pdfjs.GlobalWorkerOptions.workerPort = parser;
self.postMessage({ type: "loaded" });

self.onmessage = async ({ data }) => {
  if (data.type === "profile") {
    // The CMYK profile, once known (see parser-profile.js). Sent before any page request.
    const url = data.bytes ? URL.createObjectURL(new Blob([data.bytes], { type: "application/vnd.iccprofile" })) : null;
    parser.postMessage({ bookviewProfile: url });
    return;
  }
  if (data.type === "open") {
    try {
      doc = await pdfjs.getDocument({
        data: data.bytes,
        isOffscreenCanvasSupported: true,
        disableFontFace: true, // glyphs drawn as paths: no DOM fonts needed, exact outlines
        fontExtraProperties: true, // and the outlines kept, for vector text (see analyse)
        useSystemFonts: false,
        standardFontDataUrl: vendor("pdf-standard-fonts/"),
        cMapUrl: vendor("pdf-cmaps/"),
        cMapPacked: true,
        useWorkerFetch: true, // the parser fetches fonts/cmaps itself (avoids a DOM check)
        // Colour management: embedded ICC profiles are honoured (qcms, WebAssembly), and
        // plain CMYK goes through a CMYK printing profile rather than a formula.
        wasmUrl: vendor("pdf-wasm/"),
        iccUrl: vendor("pdf-iccs/"),
        CanvasFactory,
        FilterFactory,
      }).promise;
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err?.stack ?? err) });
    }
    return;
  }
  if (data.type === "rest") {
    // Nothing asked of this thread for a while: every page let go, and the document's caches
    // (fonts, colour spaces, images used on several pages), on both of its threads. The next
    // render learns what it needs again.
    if (busy || !doc || resting) return;
    for (const i of pages.keys()) self.postMessage({ type: "forgot", index: i });
    pages.clear();
    blocks.clear();
    skips.clear();
    resting = doc.cleanup().catch(() => {}).finally(() => { resting = null; });
    return;
  }
  if (data.type === "cancel") {
    running.get(data.id)?.cancel();
    return;
  }
  if (data.type === "vector") {
    busy++;
    try {
      await resting;
      const a = await analyse(data.index);
      self.postMessage({ type: "vector", id: data.id, glyphs: [...a.glyphs], instances: a.instances });
    } catch {
      // Never left unanswered: the page's image waits for its text.
      self.postMessage({ type: "vector", id: data.id, glyphs: [], instances: [] });
    } finally {
      busy--;
    }
    forget();
    return;
  }
  if (data.type === "render") {
    busy++;
    try {
      await resting;
      const { bitmap, skipped } = await draw(data.id, data.index, data.rect, data.height, data.vector);
      self.postMessage({ type: "done", id: data.id, bitmap, skipped }, [bitmap]);
    } catch (err) {
      self.postMessage({ type: "fail", id: data.id, message: String(err?.message ?? err) });
    } finally {
      busy--;
    }
    forget();
  }
};

// pdf.js draws in slices of ~15 ms, but in a worker it chains them as microtasks, so no
// message gets in until a render ends. Yielding a real task between slices lets a
// "cancel" arrive: a render the view no longer needs stops within a slice.
const tick = new MessageChannel();
const ticks = [];
tick.port1.onmessage = () => ticks.shift()?.();
const yieldThen = (fn) => {
  ticks.push(fn);
  tick.port2.postMessage(0);
};

/** The page's finished operator list (pdf.js internals: see cull.js), once interpreted. */
function operatorList(p) {
  for (const state of p._intentStates?.values() ?? []) {
    const list = state.operatorList;
    if (list?.lastChunk && list.fnArray.length) return list;
  }
  return null;
}

/** What a render of `r` (mm, PDF user space) may skip, or null. */
function skipFor(index, p, r) {
  const list = operatorList(p);
  if (!list) return null;
  let known = blocks.get(index);
  if (known?.list !== list) {
    known = { list, tree: blockTree(list, pdfjs.OPS) };
    blocks.set(index, known);
  }
  const area = [r.x0 * PT_PER_MM - 1, r.y0 * PT_PER_MM - 1, r.x1 * PT_PER_MM + 1, r.y1 * PT_PER_MM + 1];
  return skippable(known.tree, list.fnArray.length, area, pdfjs.OPS);
}

const draw = (id, index, ...rest) => held(index, () => drawPage(id, index, ...rest));

async function drawPage(id, index, r, height, vector = false) {
  // For the 3D page: without the glyphs it draws as vector text.
  const skipText = vector ? skips.get(index) ?? (await analyse(index)).skip : null;
  const p = await page(index);
  const base = p.getViewport({ scale: 1 });
  // PDF user space (pt) to viewport pixels at scale 1, via the viewport's matrix.
  const [ax, ay] = toViewport(base, r.x0 * PT_PER_MM, r.y0 * PT_PER_MM);
  const [bx, by] = toViewport(base, r.x1 * PT_PER_MM, r.y1 * PT_PER_MM);
  const x0 = Math.min(ax, bx);
  const y0 = Math.min(ay, by);
  const w = Math.abs(bx - ax);
  const h = Math.abs(by - ay);
  const scale = height / h;
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  // White, not the paper colour: the 3D material multiplies paper colour with the page,
  // like ink on stock, so the paper can change without re-rendering.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const viewport = p.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
  // Known pages skip what lies outside the rectangle (see cull.js). A page's first render
  // (still interpreting) draws everything and can't be cancelled: stopping it would throw
  // away the interpretation.
  const skip = skipFor(index, p, r);
  if (skipText?.size) textModes.set(ctx, { skip: skipText });
  const task = p.render({
    canvasContext: ctx, viewport, intent: RENDER_INTENT,
    operationsFilter: skip ? (i) => !skip[i] : null,
  });
  task.onContinue = (cont) => yieldThen(cont);
  if (operatorList(p)) running.set(id, task);
  try {
    await task.promise;
  } finally {
    running.delete(id);
    textModes.delete(ctx);
  }
  return { bitmap: canvas.transferToImageBitmap(), skipped: skip ? skip.reduce((n, v) => n + v, 0) : 0 };
}

// --- vector text (see app/viewer/vectortext.js) -----------------------------------------
//
// Plain text is drawn on the 3D page from its glyph outlines, exact at any zoom; the page
// images leave it out. Which glyphs: once per page, an analysis render records every glyph
// pdf.js paints (where, and its outline and colour) and, from pdf.js's own bookkeeping, the
// box of every other drawing operation. A glyph goes vector if it is plain filled text (not
// clipped, no transparency, soft mask, blend mode, pattern or Type 3 font) and nothing drawn
// after it overlaps it; everything else stays in the image, so what covers what is kept.
// Renders for the 3D page then skip exactly those glyphs. Every thread decides the same, from
// the same file.

// px. Small: the glyphs' boxes are exact at any size, pdf.js keeps the other operations' at
// 1/256 of the page whatever the size, and soft masks cost by the pixel.
const TEXT_ANALYSIS_HEIGHT = 512;
const CLIP_SLACK_PT = 0.1; // a glyph this far over its clip still counts as inside
const textModes = new Map(); // canvas context -> {ops} or {skip}, during a render
// A page's analysis is kept only while it is being made (its outlines go to the main thread
// once); what renders of the page leave out, while the page is kept (see forget).
const analyses = new Map(); // page index -> Promise<{skip, glyphs, instances}>, while made
const skips = new Map(); // page index -> Set of the glyphs its renders leave out
let hooked = null;

/** Hook pdf.js's glyph painting (once): a tiny render hands us its drawing class. */
function hookText() {
  hooked ??= (async () => {
    const p = await page(0);
    const ctx = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
    const task = p.render({ canvasContext: ctx, viewport: p.getViewport({ scale: 0.01 }), intent: RENDER_INTENT });
    await task.promise;
    const proto = Object.getPrototypeOf(task._internalRenderTask?.gfx ?? {});
    if (typeof proto?.paintChar !== "function") return false; // a pdf.js without it: no vector text
    const paint = proto.paintChar;
    proto.paintChar = function (opIdx, ch, x, y, patternFill, patternStroke) {
      const mode = textModes.get(this.ctx);
      if (mode?.skip?.has(`${opIdx}|${ch}|${x}|${y}`)) return;
      if (mode?.ops) collectGlyph(this, mode, opIdx, ch, x, y);
      return paint.call(this, opIdx, ch, x, y, patternFill, patternStroke);
    };
    return true;
  })();
  return hooked;
}

/**
 * A glyph pdf.js paints, in drawing order within its operation: where it can paint (`box`,
 * canvas px; null if unknown; `blank` if nothing, as a space) and, if it can be vector text,
 * how (`key`, outline, placement, colour).
 */
function collectGlyph(g, mode, opIdx, ch, x, y) {
  let list = mode.ops.get(opIdx);
  if (!list) mode.ops.set(opIdx, (list = []));
  const glyph = { box: null };
  list.push(glyph);
  const ctx = g.ctx;
  const cur = g.current;
  const font = cur.font;
  if (!font || font.missingFile || font.isType3Font || !font.disableFontFace) return;
  let data;
  try {
    data = g.commonObjs.get(`${font.loadedName}_path_${ch}`);
  } catch {
    return;
  }
  const path = data?.path;
  if (!path) return;
  const size = cur.fontSize / cur.fontSizeScale;
  const m = ctx.getTransform().translate(x, y).scale(size, -size);
  // The outline's box on the canvas (control points included: conservative).
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < path.length;) {
    const op = path[i++];
    const count = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : 0;
    for (let k = 0; k < count; k += 2) {
      const px = path[i + k];
      const py = path[i + k + 1];
      const dx = m.a * px + m.c * py + m.e;
      const dy = m.b * px + m.d * py + m.f;
      x0 = Math.min(x0, dx); x1 = Math.max(x1, dx); y0 = Math.min(y0, dy); y1 = Math.max(y1, dy);
    }
    i += count;
    if (op > 4) return;
  }
  if (!(x1 >= x0)) {
    glyph.blank = true; // no outline: paints nothing
    return;
  }
  // Where it can paint: its box, wider by its outline's stroke if stroked.
  const tm = cur.textRenderingMode;
  const t = ctx.getTransform();
  const pad = 1 + ((tm & 3) === 1 || (tm & 3) === 2 ? ctx.lineWidth * (Math.hypot(t.a, t.b) + Math.hypot(t.c, t.d)) : 0);
  glyph.box = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  // Vector text only if plain: filled, unclipped (a clip that doesn't hold the whole glyph),
  // opaque, in a flat colour.
  if ((tm & 3) !== 0 || (tm & 4) !== 0 || cur.patternFill) return;
  const clip = g.dependencyTracker?.clipBox;
  const slack = CLIP_SLACK_PT * mode.scale;
  if (clip && (x0 < clip[0] - slack || y0 < clip[1] - slack || x1 > clip[2] + slack || y1 > clip[3] + slack)) return;
  if (g.groupLevel > 0 || g.inSMaskMode || cur.activeSMask) return;
  if (ctx.globalAlpha !== 1 || ctx.globalCompositeOperation !== "source-over") return;
  const color = parseColor(ctx.fillStyle);
  if (!color) return;
  Object.assign(glyph, {
    key: `${opIdx}|${ch}|${x}|${y}`, glyph: `${font.loadedName}|${ch}`, path,
    m: [m.a, m.b, m.c, m.d, m.e, m.f], color,
  });
}

/** "#rrggbb" or an opaque "rgb(...)"/"rgba(..., 1)" as sRGB 0-1, else null. */
function parseColor(style) {
  if (typeof style !== "string") return null;
  if (style[0] === "#" && style.length === 7) {
    return [1, 3, 5].map((i) => parseInt(style.slice(i, i + 2), 16) / 255);
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(style);
  if (!m) return null;
  const v = m[1].split(",").map((t) => parseFloat(t));
  if (v.length === 4 && v[3] < 1) return null;
  return v.length >= 3 ? v.slice(0, 3).map((c) => c / 255) : null;
}

/** The page's vector text: which glyphs (skip), their outlines, and where they go (PDF pt). */
function analyse(index) {
  if (!analyses.has(index)) {
    const made = held(index, async () => {
      const none = { skip: new Set(), glyphs: new Map(), instances: [] };
      if (!(await hookText())) return none;
      const p = await page(index);
      if (p.rotate % 360 !== 0) return none; // a turned page (/Rotate) keeps its text in the image
      const one = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: TEXT_ANALYSIS_HEIGHT / one.height });
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
      const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
      const mode = { ops: new Map(), scale: viewport.scale };
      textModes.set(ctx, mode);
      try {
        await p.render({ canvasContext: ctx, viewport, intent: RENDER_INTENT, recordOperations: true }).promise;
      } finally {
        textModes.delete(ctx);
      }
      const boxes = p.recordedBBoxes;
      if (!boxes || !mode.ops.size) return none;
      return decide(mode, boxes, operatorList(p)?.fnArray ?? [], canvas.width, canvas.height, viewport);
    }).catch(() => ({ skip: new Set(), glyphs: new Map(), instances: [] }));
    analyses.set(index, made);
    made.then((a) => {
      analyses.delete(index);
      if (pages.has(index)) skips.set(index, a.skip);
    });
  }
  return analyses.get(index);
}

// Operations that put ink on the page (others, like restore, carry the box of what they
// close without drawing anything).
let inking = null;
const inks = () => inking ??= new Set(Object.entries(pdfjs.OPS)
  .filter(([name]) => /^(constructPath|rawFillPath|fill|eoFill|stroke|closeStroke|closeFill|closeEOFill|paint(?!FormXObject)|shadingFill|showText|showSpacedText|nextLineShowText|nextLineSetSpacingShowText|endGroup|endAnnotation)/.test(name))
  .map(([, code]) => code));

/**
 * From the last thing drawn back to the first: a glyph goes vector if nothing drawn after it
 * (that stays in the image) overlaps it.
 */
function decide(mode, boxes, fnArray, w, h, viewport) {
  const ink = inks();
  // What stays in the image, binned on a grid for the overlap tests.
  const G = 64;
  const bins = Array.from({ length: G * G }, () => []);
  const cells = (b, fn) => {
    const cx0 = Math.max(0, Math.floor((b[0] / w) * G)), cx1 = Math.min(G - 1, Math.floor((b[2] / w) * G));
    const cy0 = Math.max(0, Math.floor((b[1] / h) * G)), cy1 = Math.min(G - 1, Math.floor((b[3] / h) * G));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (fn(cy * G + cx)) return true;
    return false;
  };
  const meet = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const covered = (b) => cells(b, (c) => bins[c].some((o) => meet(o, b)));
  const add = (b) => cells(b, (c) => { bins[c].push(b); return false; });
  const vector = [];
  for (let j = boxes.length - 1; j >= 0; j--) {
    const glyphs = mode.ops.get(j);
    if (glyphs?.every((gl) => gl.box || gl.blank)) {
      // Text, glyph by glyph (an operation's own box can be the whole page): plain ones go
      // vector unless covered, the others stay in the image where they paint.
      for (let k = glyphs.length - 1; k >= 0; k--) {
        if (glyphs[k].blank) continue;
        if (glyphs[k].key && !covered(glyphs[k].box)) vector.push(glyphs[k]);
        else add(glyphs[k].box);
      }
    } else if (!boxes.isEmpty(j) && ink.has(fnArray[j])) {
      add([boxes.minX(j) * w - 1, boxes.minY(j) * h - 1, boxes.maxX(j) * w + 1, boxes.maxY(j) * h + 1]);
    }
  }
  // Canvas pixels back to PDF user space (pt): the viewport's matrix, inverted.
  const [a, b, c, d, e, f] = viewport.transform;
  const det = a * d - b * c;
  const inv = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  const mul = (p, q) => [p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1], p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5]];
  const glyphs = new Map();
  const instances = [];
  for (const gl of vector.reverse()) { // in drawing order
    if (!glyphs.has(gl.glyph)) glyphs.set(gl.glyph, Float32Array.from(gl.path));
    instances.push({ glyph: gl.glyph, m: mul(inv, gl.m), color: gl.color });
  }
  return { skip: new Set(vector.map((gl) => gl.key)), glyphs, instances };
}

function toViewport(viewport, x, y) {
  const [a, b, c, d, e, f] = viewport.transform;
  return [a * x + c * y + e, b * x + d * y + f];
}
