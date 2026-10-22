// Pictures of the book: a screenshot at many times the screen's resolution, and a video of
// it turning page by page. Both rendered offline (see viewer/capture.js); the pages in them
// rendered from the PDF at the output's resolution.

import { chooseSaveLocation, proResAvailable } from "../platform.js";
import { planDetail, videoImageHeight } from "../viewer/detail.js";
import { MAX_DETAIL } from "../viewer/shaders.js";
import { onOpeningChanged, scene, state } from "./app.js";
import { mp4Bitrate, screenshotDialog, videoDialog, videoLength } from "./dialogs.js";
import { showBusy, toast } from "./dom.js";
import { CAPTURE_PRIORITY, DETAIL_MAX_SIDE, isSharp, pageImage, pageRegionImage, sharpen } from "./pages.js";

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
  state.renderer.cancel(isSharp);
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
    sharpen();
  }
}

/** Redraw the pages in one capture tile at the tile's resolution. */
export async function prepareCaptureTile(visible) {
  const a = state.analysis;
  await Promise.all(visible.map(async (view) => {
    const { folio } = view;
    const g = a.geometry[folio - 1];
    if (!g) return;
    const pageMm = { width: g.trim.x1 - g.trim.x0, height: g.trim.y1 - g.trim.y0 };
    const plan = planDetail(view, pageMm, {
      supersample: 1.25, // image pixels per output pixel (see SUPERSAMPLE in pages.js; plus the render's own 8× multisampling)
      maxTiles: MAX_DETAIL,
      maxSide: Math.min(DETAIL_MAX_SIDE, scene.maxTextureSize),
      maxPixels: 40e6,
    });
    const tr = g.trim;
    const images = await Promise.all(plan.map(({ region, heightPx }) => pageRegionImage(folio, {
      x0: tr.x0 + region.u0 * pageMm.width, x1: tr.x0 + region.u1 * pageMm.width,
      y0: tr.y1 - region.v1 * pageMm.height, y1: tr.y1 - region.v0 * pageMm.height,
    }, heightPx, CAPTURE_PRIORITY, { mode: "ink", cache: false, flex: true })));
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
  /** @type {Map<number, {image: ImageBitmap, height: number}>} its image at the video's resolution, while it may be in view */
  const sharp = new Map();
  let writer = null;
  state.capturing = true;
  state.renderer.cancel(isSharp);
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
    scene.turnMs = before.turnMs;
    scene.closeMs = before.closeMs;
    scene.goTo(before.opening, { animate: false });
    if (before.closed && !scene.isClosed) scene.setClosed(true, { animate: false });
    onOpeningChanged();
    sharpen();
  }
}

/**
 * Every page in the frame at the resolution the frame needs (`need`: px per mm by folio, see
 * recordVideo; 0: may be in the picture, kept as it is), rendering what's missing or no longer
 * right (videoImageHeight in detail.js); images of pages that can't be in the picture are let
 * go. Exported for the tests.
 * @param {Map<number, {image: ImageBitmap, height: number}>} sharp
 * @param {Map<number, number>} need
 */
export async function sharpenForVideo(sharp, need) {
  const a = state.analysis;
  const maxHeight = Math.min(DETAIL_MAX_SIDE, scene.maxTextureSize);
  for (const [folio, { image }] of sharp) {
    if (need.has(folio)) continue;
    scene.showPageImage(folio, null);
    image.close();
    sharp.delete(folio);
  }
  await Promise.all([...need].map(async ([folio, px]) => {
    const g = a.geometry[folio - 1];
    if (!g) return;
    const have = sharp.get(folio);
    const height = videoImageHeight(px, g.trim.y1 - g.trim.y0, have?.height ?? null, maxHeight);
    if (height == null) return;
    const image = await pageImage(folio, height, CAPTURE_PRIORITY, { mode: "ink", cache: false });
    if (!image) return;
    scene.showPageImage(folio, image);
    have?.image.close();
    sharp.set(folio, { image, height });
  }));
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
