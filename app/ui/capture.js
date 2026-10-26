// Pictures of the book: a screenshot at many times the screen's resolution, and a video of
// it turning page by page. Both rendered offline (see viewer/capture.js); the pages in them
// rendered from the PDF at the output's resolution.

import { spineTakesArtwork } from "../core/spine.js";
import { chooseSaveLocation, proResAvailable } from "../platform.js";
import { planDetail, videoImageHeight } from "../viewer/detail.js";
import { visibleSpine } from "../viewer/framing.js";
import { mixImage } from "../viewer/inklut.js";
import { MAX_DETAIL } from "../viewer/shaders.js";
import { FLAP_HEIGHT, onOpeningChanged, refreshFlaps, scene, state } from "./app.js";
import { mp4Bitrate, screenshotDialog, videoDialog, videoLength } from "./dialogs.js";
import { showBusy, toast } from "./dom.js";
import { applyFinish, FINISH_HEIGHT, finishAt } from "./finish.js";
import { CAPTURE_PRIORITY, DETAIL_MAX_SIDE, pageImage, pageRegionImage } from "./pages.js";
import { spineAt } from "./spine-panel.js";
import { cancelTiles, updateTiles } from "./tiles.js";

const SUPERSAMPLE = 1.25; // a capture's image pixels per output pixel (see SUPERSAMPLE in pages.js; plus the render's own 8× multisampling)

/**
 * What a capture draws again at its own resolution besides the pages' faces, everything the
 * picture shows printed (the author, 2026-10-26: "as high fidelity as the program can render,
 * no sidesteps"), put back afterwards (restoreCapture): the pages in it whole (their faces' base,
 * and what reads them besides: their sheets' cut edges, a fold's print, show-through, the
 * faces between a flying stack's sheets) with the pages printed with them (scene.pagesWith),
 * the finish's masks, the cover's flaps, the spine's artwork. Heights in px (the image's). The
 * finish and the flaps only where the capture needs them sharper than the screen has them.
 */
const capture = {
  /** @type {Map<number, {image: {close?: () => void}, height: number}>} */
  pages: new Map(),
  /** @type {Map<number, number>} folio -> its finish mask's height */
  finish: new Map(),
  /** @type {{close?: () => void}[]} the finish masks drawn, to close */
  finishImages: [],
  flaps: 0,
  spine: { height: 0, /** @type {(() => void) | null} */ restore: null },
};

/** A height in px a capture asks of an image of a page (or a part) `mm` tall at `pxPerMm` (output px), within what the GPU and memory take. */
function captureHeight(pxPerMm, mm, aspect = 1) {
  const most = Math.min(DETAIL_MAX_SIDE, scene.maxTextureSize, Math.sqrt(40e6 / Math.max(0.05, aspect)));
  return Math.round(Math.min(most, Math.max(16, pxPerMm * SUPERSAMPLE * mm)));
}

/**
 * A whole page's sharp image at most this long on its long side (px): they share one texture
 * array of their largest's size, a layer each (up to a dozen with the pages printed with them
 * and their spot channels): at 6144 px about 140 MB a layer. The faces in the picture are drawn
 * from the capture's strips at any resolution; what reads the whole image besides (cut edges,
 * read half a level softer; show-through, two and a half; a fold's print) at up to 29 px a mm
 * on an A4 page. (Uncapped, a 4K close-up asked for gigabytes and lost the GPU.)
 */
const WHOLE_PAGE_MAX = 6144;

/**
 * A page whole at `height` px for the capture (and the pages printed with it, as tall): into
 * the scene's sharp images (showPageImage), which every reader of the page prefers. Drawn
 * again only when it was drawn more than a tenth smaller.
 */
async function sharpPages(folios, height) {
  const g = state.analysis.geometry[folios[0] - 1];
  const aspect = g ? (g.trim.x1 - g.trim.x0) / (g.trim.y1 - g.trim.y0) : 1;
  height = Math.round(Math.min(height, WHOLE_PAGE_MAX, WHOLE_PAGE_MAX / Math.max(1e-3, aspect)));
  await Promise.all(folios.map(async (folio) => {
    const have = capture.pages.get(folio);
    if (have && have.height >= height / 1.1) return;
    const image = await pageImage(folio, height, CAPTURE_PRIORITY, { mode: "ink", cache: false, mips: -1 });
    if (!image) return;
    scene.showPageImage(folio, image);
    have?.image.close?.();
    capture.pages.set(folio, { image, height });
  }));
}

/** The capture's own drawings for a set of pages in the picture (`want`: folio -> px a mm on the output). */
async function sharpenFor(want) {
  const a = state.analysis;
  const n = a.book.pages.length;
  const jobs = [];
  const finishHeights = new Map();
  let flaps = 0;
  for (const [folio, pxPerMm] of want) {
    const g = a.geometry[folio - 1];
    if (!g || !(pxPerMm > 0)) continue;
    const w = g.trim.x1 - g.trim.x0;
    const h = g.trim.y1 - g.trim.y0;
    const height = captureHeight(pxPerMm, h, w / h);
    jobs.push(sharpPages([folio, ...scene.pagesWith(folio)], height));
    const finished = state.finish?.jobs?.some((j) => j.folio === folio);
    if (finished && (capture.finish.get(folio) ?? FINISH_HEIGHT) < height / 1.1) finishHeights.set(folio, height);
    if (folio === 2 || folio === n - 1) flaps = Math.max(flaps, height);
  }
  if (finishHeights.size) {
    jobs.push(finishAt(finishHeights).then((images) => {
      for (const [folio, image] of images) {
        capture.finish.set(folio, finishHeights.get(folio));
        capture.finishImages.push(image);
      }
    }));
  }
  if (flaps > Math.max(capture.flaps, FLAP_HEIGHT) * 1.1 && scene.flaps.size) {
    capture.flaps = flaps;
    jobs.push(refreshFlaps(flaps));
  }
  await Promise.all(jobs);
}

/** The spine's artwork at `height` px, for the capture (drawn again when more than a tenth taller is wanted). */
async function sharpSpine(height) {
  if (!(height > capture.spine.height * 1.1)) return;
  capture.spine.restore?.();
  capture.spine.restore = await spineAt(height);
  capture.spine.height = capture.spine.restore ? height : 0;
}

/** Everything a capture drew again let go: the screen's pages, finish, flaps and spine back. (Exported for the tools, which drive captures without the dialogs.) */
export function restoreCapture() {
  for (const [folio, { image }] of capture.pages) {
    scene.showPageImage(folio, null);
    image.close?.();
  }
  capture.pages.clear();
  scene.releaseSharp();
  if (capture.finish.size) applyFinish();
  for (const image of capture.finishImages) image.close?.();
  capture.finish.clear();
  capture.finishImages = [];
  if (capture.flaps) refreshFlaps();
  capture.flaps = 0;
  capture.spine.restore?.();
  capture.spine = { height: 0, restore: null };
}

/**
 * When a picture or video was made, for its file name, so each render has a name of its
 * own: "2026-10-16 at 17.25.03", as macOS names screenshots (no colons: Windows doesn't
 * allow them in file names, and the Finder shows them as slashes).
 */
function stamp(date = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} at ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
}

/**
 * A still of the current view at many times screen resolution: rendered in tiles, and
 * for every tile the pages in it are redrawn from the PDF's vectors at exactly that
 * tile's resolution. As sharp as the output size allows.
 */
export async function renderScreenshot() {
  if (!state.analysis || !state.renderer) return;
  const choice = await screenshotDialog();
  if (!choice) return;
  const base = state.name.replace(/\.pdf$/i, "");
  const target = await chooseSaveLocation(`${base} render ${choice.width}x${choice.height} ${stamp()}.png`,
    { name: "PNG image", extensions: ["png"], mime: "image/png" });
  if (!target) return;
  const busy = showBusy("Rendering screenshot…");
  state.capturing = true;
  cancelTiles();
  try {
    const blob = await scene.captureImage({
      ...choice,
      prepare: prepareCaptureTile,
      onProgress: (done, total) => busy.progress(done / total),
    });
    busy.title("Saving…");
    const saved = await target.write(new Uint8Array(await blob.arrayBuffer()));
    toast(`Saved ${saved} (${choice.width} × ${choice.height} px).`, "ok");
  } catch (err) {
    console.error(err);
    toast(`Screenshot failed: ${err.message}`, "error");
  } finally {
    state.capturing = false;
    busy.remove();
    // The capture's page images were sized for the capture: back to the screen's.
    for (const folio of [...state.details.keys()]) scene.setPageDetails(folio, []);
    state.details.clear();
    restoreCapture();
    updateTiles(performance.now(), { settled: true });
  }
}

/**
 * Redraw the pages in one capture tile at the tile's resolution: their faces in sharp strips
 * (as the tile shows them), and whole (see sharpenFor) for what else of them the picture shows;
 * the spine's artwork as the tile shows it. `tile`: its place in the output (px).
 */
export async function prepareCaptureTile(visible, tile = null) {
  const a = state.analysis;
  const want = new Map();
  for (const view of visible) want.set(view.folio, Math.max(want.get(view.folio) ?? 0, ...view.samples.map((q) => q.pxPerMm)));
  const spine = spineTakesArtwork(state.setup.binding) ? state.spineArt : null;
  if (spine && tile) {
    // The spine as this tile shows it (visibleSpine measures on the canvas: scaled to the tile).
    const seen = visibleSpine(scene, spine.sizeMm, state.setup.spine.rotation);
    const perPx = tile.w / scene.renderer.domElement.width;
    if (seen?.samples.length) await sharpSpine(captureHeight(Math.max(...seen.samples.map((q) => q.pxPerMm)) * perPx, spine.sizeMm.height, spine.sizeMm.width / spine.sizeMm.height));
  }
  await sharpenFor(want);
  await Promise.all(visible.map(async (view) => {
    const { folio } = view;
    const g = a.geometry[folio - 1];
    if (!g) return;
    const pageMm = { width: g.trim.x1 - g.trim.x0, height: g.trim.y1 - g.trim.y0 };
    const plan = planDetail(view, pageMm, {
      supersample: SUPERSAMPLE,
      maxTiles: MAX_DETAIL,
      maxSide: Math.min(DETAIL_MAX_SIDE, scene.maxTextureSize),
      maxPixels: 40e6,
    });
    const tr = g.trim;
    const images = await Promise.all(plan.map(({ region, heightPx }) => pageRegionImage(folio, {
      x0: tr.x0 + region.u0 * pageMm.width, x1: tr.x0 + region.u1 * pageMm.width,
      y0: tr.y1 - region.v1 * pageMm.height, y1: tr.y1 - region.v0 * pageMm.height,
    }, heightPx, CAPTURE_PRIORITY, { mode: "ink", cache: false, flex: true })));
    // As they print, the plates as they are: strips have no spot channels in the page shader.
    for (const image of images) {
      image.data = mixImage(image, state.colour.inks, state.spotInks);
      image.spots = null;
      image.spotNames = [];
    }
    scene.setPageDetails(folio, images.map((image, i) => ({ image, region: plan[i].region })), { immediate: true });
    // Known, so the capture's strips go with the others once it ends (until 0.17.79 the strips
    // of a page that had none before stayed on it after a screenshot, at the capture's size).
    state.details.set(folio, plan.map(({ region, pxPerMm }) => ({ region, pxPerMm })));
  }));
}

/**
 * A video of the book: closed on its front cover, turning page by page at the chosen speed,
 * closed on its back cover. Rendered offline, frame by frame, from the current camera
 * view, framed for the chosen shape; the pages coming into view are rendered from the PDF
 * at the video's resolution. MP4 (H.264, by the computer's own encoder), or with a
 * transparent background ProRes 4444 (.mov, by the FFmpeg shipped with the app).
 */
export async function renderVideo(preset = null) {
  const a = state.analysis;
  if (!a || !state.renderer) return;
  const turns = scene.model.leafCount;
  // `preset`: settings given directly (tests); otherwise asked for.
  const choice = preset ?? await videoDialog(turns, await proResAvailable());
  if (!choice) return;
  const base = state.name.replace(/\.pdf$/i, "");
  const kind = choice.transparent ? { ext: "mov", name: "ProRes video", mime: "video/quicktime" } : { ext: "mp4", name: "MP4 video", mime: "video/mp4" };
  const target = await chooseSaveLocation(`${base} video ${choice.width}x${choice.height} ${stamp()}.${kind.ext}`,
    { name: kind.name, extensions: [kind.ext], mime: kind.mime });
  if (!target) return;

  let cancelled = false;
  const busy = showBusy("Rendering video…", () => { cancelled = true; });
  const before = { opening: scene.opening, closed: scene.isClosed, turnMs: scene.turnMs, closeMs: scene.closeMs };
  /** @type {Map<number, {image: {close: () => void}, height: number}>} its inks at the video's resolution, while it may be in view */
  const sharp = new Map();
  let writer = null;
  state.capturing = true;
  cancelTiles();
  for (const folio of [...state.details.keys()]) scene.setPageDetails(folio, []);
  state.details.clear();
  try {
    writer = choice.transparent ? await target.proRes(choice) : await mp4Writer(choice);
    // The book starts closed on its front cover, camera at rest.
    scene.turnMs = choice.turnSeconds * 1000;
    scene.closeMs = choice.turnSeconds * 1250;
    const reset = () => {
      scene.goTo(0, { animate: false });
      scene.settleCamera();
    };
    reset();
    // The spine's artwork as tall as it can be in the picture: the whole book is (the video's
    // camera keeps every page in it), so at most the frame's height, as tall as a page.
    const spine = spineTakesArtwork(state.setup.binding) ? state.spineArt : null;
    const pageMm = a.geometry.find(Boolean)?.trim;
    if (spine && pageMm) await sharpSpine(captureHeight(choice.height / (pageMm.y1 - pageMm.y0), spine.sizeMm.height, spine.sizeMm.width / spine.sizeMm.height));
    const step = (choice.turnSeconds + choice.pauseSeconds) * 1000;
    const cues = Array.from({ length: turns }, (_, k) => ({ at: 1000 + k * step, run: () => scene.goTo(k + 1) }));
    const durationMs = videoLength(turns, choice.turnSeconds, choice.pauseSeconds);
    await scene.recordVideo({
      ...choice,
      durationMs,
      cues,
      reset,
      prepare: async (ms, need) => {
        if (cancelled) throw new Error("cancelled");
        await sharpenForVideo(sharp, need);
      },
      onFrame: (rgba, i) => writer.frame(rgba, i),
      onProgress: (done, total) => busy.progress(done / total),
    });
    busy.title("Saving…");
    const saved = choice.transparent ? await writer.end() : await target.write(await writer.end());
    toast(`Saved ${saved} (${choice.width} × ${choice.height} px, ${(durationMs / 1000).toFixed(1)} s).`, "ok");
  } catch (err) {
    await writer?.abort?.();
    if (!cancelled) {
      console.error(err);
      toast(`Video failed: ${err.message}`, "error");
    }
  } finally {
    busy.remove();
    state.capturing = false;
    // Back to the screen's page images and to where the book was.
    for (const [folio, { image }] of sharp) {
      scene.showPageImage(folio, null);
      image.close();
    }
    restoreCapture();
    scene.turnMs = before.turnMs;
    scene.closeMs = before.closeMs;
    scene.goTo(before.opening, { animate: false });
    if (before.closed && !scene.isClosed) scene.setClosed(true, { animate: false });
    onOpeningChanged();
    updateTiles(performance.now(), { settled: true });
  }
}

/**
 * Every page in the frame at the resolution the frame needs (`need`: px per mm by folio, see
 * recordVideo; 0: may be in the picture, kept as it is), rendering what's missing or no longer
 * right (videoImageHeight in detail.js); images of pages that can't be in the picture are let
 * go.
 * @param {Map<number, {image: {close: () => void}, height: number}>} sharp
 * @param {Map<number, number>} need
 */
async function sharpenForVideo(sharp, need) {
  const a = state.analysis;
  const maxHeight = Math.min(DETAIL_MAX_SIDE, scene.maxTextureSize);
  for (const [folio, { image }] of sharp) {
    if (need.has(folio)) continue;
    scene.showPageImage(folio, null);
    image.close();
    sharp.delete(folio);
  }
  // The pages printed with each (the other side, a fold's other half: see scene.pagesWith),
  // as sharp as it: what the frame shows of them is its show-through and its fold.
  const wanted = new Map(need);
  for (const [folio, px] of need) {
    for (const other of scene.pagesWith(folio)) wanted.set(other, Math.max(wanted.get(other) ?? 0, px));
  }
  for (const [folio, { image }] of sharp) {
    if (wanted.has(folio)) continue;
    scene.showPageImage(folio, null);
    image.close();
    sharp.delete(folio);
  }
  await Promise.all([...wanted].map(async ([folio, px]) => {
    const g = a.geometry[folio - 1];
    if (!g) return;
    const have = sharp.get(folio);
    const height = videoImageHeight(px, g.trim.y1 - g.trim.y0, have?.height ?? null, maxHeight);
    if (height == null) return;
    // With its smaller copies: into the scene's sharp images, which every reader of the page takes.
    const image = await pageImage(folio, height, CAPTURE_PRIORITY, { mode: "ink", cache: false, mips: -1 });
    if (!image) return;
    scene.showPageImage(folio, image);
    have?.image.close();
    sharp.set(folio, { image, height });
  }));
  // The finish's masks and the flaps of the pages in the frame, as sharp as their pages.
  const extra = new Map([...need].filter(([, px]) => px > 0));
  for (const folio of extra.keys()) {
    const height = sharp.get(folio)?.height ?? 0;
    const g = a.geometry[folio - 1];
    if (g && height) extra.set(folio, height / SUPERSAMPLE / (g.trim.y1 - g.trim.y0));
  }
  await sharpenForExtras(extra);
}

/** The finish's masks and the cover's flaps for the pages in a video's frame (`want`: folio -> px a mm), not the pages themselves (sharpenForVideo has them). */
async function sharpenForExtras(want) {
  const a = state.analysis;
  const n = a.book.pages.length;
  const finishHeights = new Map();
  let flaps = 0;
  for (const [folio, pxPerMm] of want) {
    const g = a.geometry[folio - 1];
    if (!g) continue;
    const height = captureHeight(pxPerMm, g.trim.y1 - g.trim.y0);
    if (state.finish?.jobs?.some((j) => j.folio === folio) && (capture.finish.get(folio) ?? FINISH_HEIGHT) < height / 1.1) finishHeights.set(folio, height);
    if (folio === 2 || folio === n - 1) flaps = Math.max(flaps, height);
  }
  if (finishHeights.size) {
    for (const [folio, image] of await finishAt(finishHeights)) {
      capture.finish.set(folio, finishHeights.get(folio));
      capture.finishImages.push(image);
    }
  }
  if (flaps > Math.max(capture.flaps, FLAP_HEIGHT) * 1.1 && scene.flaps.size) {
    capture.flaps = flaps;
    await refreshFlaps(flaps);
  }
}

/** An MP4 (H.264) encoder: the computer's own, through WebCodecs. Frames: RGBA. */
async function mp4Writer({ width, height, fps, bitsPerPixel = 1 }) {
  const { Muxer, ArrayBufferTarget } = await import("../../vendor/mp4-muxer/mp4-muxer.mjs");
  // The bitrate ceiling: the quality chosen in the dialog (VIDEO_QUALITIES), 1 bit a pixel a
  // frame for a master (1080p at 30 fps 62 Mbit/s, 4K the most High 5.2 takes, 240), at least
  // 16 Mbit/s; the encoder stays under it where it can. Dithered and halftoned images, fine
  // type and pixel art are the hardest content there is for H.264. Measured on a page turn of
  // the author's pixel-art book, 1080p, encoded and decoded again, the pages' edge energy
  // against the frames as drawn: at 0.4 bits (until 0.17.80) the encoder used 14 Mbit/s and
  // kept 0.88-0.93 of it, soft; at 1 bit it used 38 and kept 0.985-1.0, and allowing 120
  // changed nothing more. At 0.12 (8 Mbit/s, until 0.17.75) still frames came out soft.
  const bitrate = mp4Bitrate(width, height, fps, bitsPerPixel);
  let config = null;
  // The graphics card's own encoder if it has one, else the processor.
  search: for (const hardwareAcceleration of /** @type {HardwareAcceleration[]} */ (["prefer-hardware", "no-preference"])) {
    for (const codec of ["avc1.640034", "avc1.640033", "avc1.64002A", "avc1.4D0034"]) {
      /** @type {VideoEncoderConfig} */
      const c = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration, avc: { format: "avc" } };
      if ((await VideoEncoder.isConfigSupported(c)).supported) {
        config = c;
        break search;
      }
    }
  }
  if (!config) throw new Error(`this computer can't encode ${width} × ${height} H.264 video; try HD`);
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width, height, frameRate: fps }, fastStart: "in-memory" });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => { failure = err; },
  });
  encoder.configure(config);
  return {
    async frame(rgba, i) {
      if (failure) throw failure;
      const frame = new VideoFrame(rgba, {
        format: "RGBA", codedWidth: width, codedHeight: height,
        timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps),
      });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 4) await new Promise((r) => encoder.addEventListener("dequeue", r, { once: true }));
    },
    async end() {
      await encoder.flush();
      if (failure) throw failure;
      muxer.finalize();
      encoder.close();
      return new Uint8Array(muxer.target.buffer);
    },
    abort() {
      if (encoder.state !== "closed") encoder.close();
    },
  };
}
