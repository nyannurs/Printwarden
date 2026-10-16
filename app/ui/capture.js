// Pictures of the book: a screenshot at many times the screen's resolution, and a video of
// it turning page by page. Both rendered offline (see viewer/capture.js); the pages in them
// rendered from the PDF at the output's resolution.

import { chooseSaveLocation, proResAvailable } from "../platform.js";
import { planDetail } from "../viewer/detail.js";
import { MAX_DETAIL } from "../viewer/shaders.js";
import { onOpeningChanged, scene, state } from "./app.js";
import { screenshotDialog, videoDialog, videoLength } from "./dialogs.js";
import { showBusy, toast } from "./dom.js";
import { CAPTURE_PRIORITY, DETAIL_MAX_SIDE, isSharp, pageImage, sharpen, VECTOR_TEXT } from "./pages.js";

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
      supersample: 1.5, // plus the render's own 8× multisampling
      maxTiles: MAX_DETAIL,
      maxSide: Math.min(DETAIL_MAX_SIDE, scene.maxTextureSize),
      maxPixels: 40e6,
    });
    const index = a.book.pages[folio - 1].source.index;
    const tr = g.trim;
    const images = await Promise.all(plan.map(({ region, heightPx }) => state.renderer.render(index, {
      x0: tr.x0 + region.u0 * pageMm.width, x1: tr.x0 + region.u1 * pageMm.width,
      y0: tr.y1 - region.v1 * pageMm.height, y1: tr.y1 - region.v0 * pageMm.height,
    }, heightPx, CAPTURE_PRIORITY, { cache: false, flex: true, vector: VECTOR_TEXT })));
    scene.setPageDetails(folio, images.map((image, i) => ({ image, region: plan[i].region })), { immediate: true });
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
  const sharp = new Map(); // folio -> page image at the video's resolution, while in view
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
    // Each page's image at the size that draws it sharpest where it lies at rest in the video:
    // 1.5 image pixels to a video pixel where the page is nearest the camera. (The page shader
    // samples four times a pixel; more pixels than that, and the GPU blends in the next smaller
    // mipmap level, which blurs: images at 1.4 times the video's size were soft at rest, sharp
    // only once a turn swapped them for the screen's.) Measured by planning the video first.
    const maxHeight = Math.min(DETAIL_MAX_SIDE, scene.maxTextureSize);
    const fallback = Math.min(maxHeight, Math.round(Math.max(choice.width, choice.height) * 1.4));
    const heightFor = (folio, density) => {
      const g = a.geometry[folio - 1];
      // A page never at rest in the picture (a tall video shows one page of a spread): as
      // large as the largest that is.
      const px = density.get(folio) ?? (density.size ? Math.max(...density.values()) : 0);
      if (!g || !px) return fallback;
      return Math.max(256, Math.min(maxHeight, Math.round(1.5 * px * (g.trim.y1 - g.trim.y0))));
    };
    const openingAt = (ms) => cues.filter((c) => c.at <= ms).length;
    await scene.recordVideo({
      ...choice,
      durationMs,
      cues,
      reset,
      prepare: async (ms, density) => {
        if (cancelled) throw new Error("cancelled");
        // Sharp for the video: the spread before (a turning leaf shows it until it lands), the
        // spread now and the next one. (Leaving out the one before swapped the lifting page and
        // the page under it to the screen's images the moment a turn began.)
        const o = openingAt(ms);
        const folios = Array.from({ length: 8 }, (_, k) => 2 * o - 2 + k);
        await sharpenForVideo(sharp, folios, (f) => heightFor(f, density));
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
    for (const [folio, image] of sharp) {
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

/** Have exactly these folios at the video's resolution (rendering what's missing). `height(folio)`: its image's. */
async function sharpenForVideo(sharp, folios, height) {
  const a = state.analysis;
  const want = new Set(folios.filter((f) => f >= 1 && f <= a.book.pages.length && a.geometry[f - 1]));
  for (const [folio, image] of sharp) {
    if (want.has(folio)) continue;
    scene.showPageImage(folio, null);
    image.close();
    sharp.delete(folio);
  }
  await Promise.all([...want].filter((f) => !sharp.has(f)).map(async (folio) => {
    const image = await pageImage(folio, height(folio), CAPTURE_PRIORITY, { cache: false, vector: VECTOR_TEXT });
    sharp.set(folio, image);
    scene.showPageImage(folio, image);
  }));
}

/** An MP4 (H.264) encoder: the computer's own, through WebCodecs. Frames: RGBA. */
async function mp4Writer({ width, height, fps }) {
  const { Muxer, ArrayBufferTarget } = await import("../../vendor/mp4-muxer/mp4-muxer.mjs");
  // A master, not a delivery copy: 0.4 bits a pixel a frame (1080p at 30 fps about 25 Mbit/s,
  // 4K about 100), 16 to 120 Mbit/s. Dithered and halftoned images, fine type and pixel art
  // are the hardest content there is for H.264; at 0.12 (8 Mbit/s for 1080p) still frames
  // came out soft, the first after a keyframe most. Editors and platforms re-encode anyway.
  const bitrate = Math.round(Math.min(120e6, Math.max(16e6, width * height * fps * 0.4)));
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
