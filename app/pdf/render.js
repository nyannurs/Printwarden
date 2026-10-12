// Page images for the 3D book and the timeline, rendered from the PDF's vectors.
//
// A pool of background workers does the drawing (render-worker.js), several pages at
// once, so the interface never stalls. Results are ImageBitmaps. If workers can't start,
// a main-thread renderer takes over (slower, same results).
//
// Requests: one image per page (sized to a memory budget), a small one per page (the
// timeline's thumbnail, and the page where it is small on screen), and on-demand sharp
// strips for the pages in view, at the resolution they're shown at.

import { mmToPt } from "../core/units.js";
import { SYSTEM_MEMORY } from "../platform.js";

export const THUMB_HEIGHT = 200;
const BASE_BUDGET_BYTES = 480 * 1024 * 1024;
const BASE_MIN = 700;
const BASE_MAX = 1600;

/** Base texture height for a document of `pageCount` pages. */
export function baseHeight(pageCount, aspect) {
  const perPage = BASE_BUDGET_BYTES / Math.max(1, pageCount);
  const h = Math.sqrt(perPage / 4 / Math.max(0.2, aspect));
  return Math.round(Math.min(BASE_MAX, Math.max(BASE_MIN, h)));
}

/**
 * How many threads render pages: half the processor's, two to six; fewer on a computer with
 * little memory (three with 8 GB), and for a large file (each thread holds all of it and what
 * it learns from it: about 100 MB for a 10 MB report).
 */
const poolSize = (fileBytes = 0) => Math.max(1, Math.min(
  Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2))),
  Math.floor(SYSTEM_MEMORY / (2.5 * 2 ** 30)),
  Math.floor(FILE_COPIES_BYTES / Math.max(1, fileBytes)),
));
const FILE_COPIES_BYTES = 600 * 2 ** 20;
// Threads idle this long let go of the pages and caches they built (see render-worker.js).
const REST_MS = 20000;

/**
 * Start a renderer for `bytes`: worker pool if possible, main thread otherwise.
 * `cmykProfile` (ICC bytes, or a promise of them, optional) converts plain CMYK; without
 * it, pdf.js's built-in profile is used. Embedded ICC profiles are always honoured. The
 * workers start loading right away and wait for the profile only before opening.
 */
export async function createRenderer(bytes, fallbackPdf, cmykProfile = null) {
  try {
    const slots = takeSpareWorkers(poolSize(bytes.byteLength));
    return await WorkerPool.start(bytes, slots, cmykProfile);
  } catch (err) {
    console.warn("Background rendering unavailable, using the main thread:", err);
    return new MainThreadRenderer(await fallbackPdf());
  }
}

/**
 * Render several areas of a small, separate PDF (e.g. a spot varnish layer) in one thread
 * of its own, in order. jobs: [{index, rectMm, height}]. The thread ends when done.
 * @returns {Promise<ImageBitmap[]>}
 */
export async function renderMany(bytes, jobs, cmykProfile = null) {
  const pool = await WorkerPool.start(bytes, [spawnWorker()], cmykProfile);
  try {
    const out = [];
    for (const job of jobs) out.push(await pool.render(job.index, job.rectMm, job.height, 0, { cache: false }));
    return out;
  } finally {
    pool.destroy();
  }
}

let jobIds = 0;

/**
 * Render one area of a small, separate PDF (e.g. spine artwork) in a thread of its own, with
 * the same colour management as the book. The thread ends when done.
 * @returns {Promise<ImageBitmap>}
 */
export async function renderOnce(bytes, pageIndex, rectMm, height, cmykProfile = null) {
  const pool = await WorkerPool.start(bytes, [spawnWorker()], cmykProfile);
  try {
    return await pool.render(pageIndex, rectMm, height, 0, { cache: false });
  } finally {
    pool.destroy();
  }
}

/** Shared queue logic: priorities, caching, cancellation. */
class Scheduler {
  constructor() {
    this.cache = new Map(); // key -> Promise<ImageBitmap>
    this.queue = [];
    this.closed = false;
  }

  /**
   * Render `rectMm` (PDF user space) of page `index` at `height` pixels.
   * Lower priority numbers go first; re-requesting a queued key re-prioritises it.
   * `cache: false` for one-off sharp renders, which are large; "pending" to share a render
   * only while it runs (an image handed on and freed, see loadAllTextures in ui/pages.js). `vector`:
   * for the 3D page, leaving out the text it draws from outlines (see vectorText).
   */
  /**
   * @param {number} index
   * @param {{x0: number, y0: number, x1: number, y1: number}} rectMm
   * @param {number} height
   * @param {number} [priority]
   * @param {{cache?: boolean | "pending", flex?: boolean, slot?: any, vector?: boolean}} [options]
   * @returns {Promise<ImageBitmap>}
   */
  render(index, rectMm, height, priority = 10, { cache = true, flex = false, slot = null, vector = false } = {}) {
    const key = `${index}|${height}|${[rectMm.x0, rectMm.y0, rectMm.x1, rectMm.y1].map((v) => v.toFixed(2))}|${vector ? "v" : ""}`;
    const hit = this.cache.get(key);
    if (hit) {
      const queued = this.queue.find((q) => q.key === key);
      if (queued) queued.priority = Math.min(queued.priority, priority);
      return hit;
    }
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ id: ++jobIds, key, index, rect: { ...rectMm }, height, priority, resolve, reject, flex, slot, vector });
    });
    if (cache) this.cache.set(key, promise);
    const drop = () => this.cache.get(key) === promise && this.cache.delete(key);
    promise.then(() => cache === "pending" && drop(), drop);
    this.pump();
    return promise;
  }

  /** Drop work that is no longer wanted (e.g. an outdated sharp render). */
  cancel(predicate) {
    this.queue = this.queue.filter((job) => {
      if (!predicate(job)) return true;
      this.cache.delete(job.key);
      job.reject(new Error("cancelled"));
      return false;
    });
  }

  /** Let more threads learn a page, so its sharp strips can render in parallel. */
  warm() {}

  /** A page's vector text, or null where there is none (see render-worker.js). */
  vectorText() {
    return Promise.resolve(null);
  }

  /** Start what can start (each kind of renderer its own way). */
  pump() {}

  next() {
    if (!this.queue.length) return null;
    let best = 0;
    for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority < this.queue[best].priority) best = i;
    return this.queue.splice(best, 1)[0];
  }

  close() {
    this.closed = true;
    for (const job of this.queue) job.reject(new Error("closed"));
    this.queue = [];
    this.cache.clear();
  }
}

// --- workers started ahead of time -----------------------------------------------------
//
// Starting a render worker means loading pdf.js (~2 MB of code) twice (renderer and
// parser); six at once, while a file is being read, took seconds. So a set of workers is
// started while the app is idle and handed to the first document; then a couple are
// prepared for the next. Each set serves one document: pdf.js keeps the CMYK profile it
// first used for the lifetime of its parser.

let spare = null;

function spawnWorker() {
  const worker = new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" });
  // Listeners, not handler properties: the pool sets its own handlers while this waits.
  /** @type {Promise<void>} */
  const loaded = new Promise((resolve, reject) => {
    worker.addEventListener("message", ({ data }) => data.type === "loaded" && resolve());
    worker.addEventListener("error", (e) => reject(new Error(e.message || "worker failed to start")));
  });
  return { worker, loaded, job: null };
}

/**
 * Start workers for the next document, when the machine is otherwise quiet: a full set
 * before the first, a couple while one is open (14 MB each, idle; the next document's
 * first pages start on them while the rest load).
 */
export function prepareSpareWorkers(delayMs = 0, count = poolSize()) {
  if (spare) return;
  const start = () => {
    if (!spare) spare = Array.from({ length: Math.min(count, poolSize()) }, spawnWorker);
  };
  if (delayMs) setTimeout(start, delayMs);
  else start();
}

function takeSpareWorkers(count) {
  const ready = spare ?? [];
  spare = null;
  for (const slot of ready.splice(count)) slot.worker.terminate(); // more than this file takes
  prepareSpareWorkers(4000, 2); // after this document's first renders
  return [...ready, ...Array.from({ length: count - ready.length }, spawnWorker)];
}

class WorkerPool extends Scheduler {
  constructor() {
    super();
    /** @type {any[]} the threads (slots), once started */
    this.workers = [];
    this.owner = new Map(); // page index -> first slot to interpret it
    this.vectorJobs = new Map(); // id -> {resolve, slot}
  }

  static async start(bytes, slots, cmykProfile) {
    const pool = new WorkerPool();
    pool.workers = await Promise.all(slots.map((slot) => new Promise((resolve, reject) => {
      const { worker } = slot;
      worker.onerror = (e) => reject(new Error(e.message || "worker failed to start"));
      // The document opens right away; the CMYK profile follows when known (it depends on
      // the file's output intent). A worker takes pages only once it has both.
      let opened = false;
      let profiled = false;
      const maybeReady = () => opened && profiled && resolve(slot);
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") {
          worker.onmessage = ({ data: msg }) => pool.#finished(slot, msg);
          worker.onerror = (e) => pool.#finished(slot, { type: "fail", message: e.message });
          opened = true;
          maybeReady();
        } else if (data.type === "error") {
          reject(new Error(data.message));
        }
      };
      slot.loaded.then(() => {
        const copy = bytes.slice(); // each thread its own copy, handed over (not copied again)
        worker.postMessage({ type: "open", bytes: copy }, [copy.buffer]);
      }, reject);
      Promise.resolve(cmykProfile).then((profile) => {
        worker.postMessage({ type: "profile", bytes: profile ?? null });
        profiled = true;
        maybeReady();
      }, reject);
    }))).catch((err) => {
      // None of them is used then: all stopped (they each hold a copy of the file).
      for (const slot of slots) slot.worker.terminate();
      throw err;
    });
    return pool;
  }

  /**
   * A worker keeps the pages it interpreted last, so later renders of one (sharper, other
   * regions) take milliseconds there. Pages therefore go to a worker that knows
   * them: normally the one that first interpreted it; sharp strips ("flex" jobs) to any
   * worker that knows the page, so a page's strips render in parallel once warm() has
   * taught it to the others. A page nobody knows yet goes to whichever worker is free.
   */
  pump() {
    if (this.closed) return;
    clearTimeout(this.resting);
    for (const slot of this.workers) {
      if (slot.job) continue;
      slot.knows ??= new Set();
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const job = this.queue[i];
        const owner = this.owner.get(job.index);
        // (Its first thread always fits: it may have let the page go, as may every other.)
        const fits = job.slot ? job.slot === slot
          : job.flex ? !owner || owner === slot || slot.knows.has(job.index)
          : !owner || owner === slot;
        if (!fits) continue;
        if (best < 0 || job.priority < this.queue[best].priority) best = i;
      }
      if (best < 0) continue;
      const job = this.queue.splice(best, 1)[0];
      if (!this.owner.has(job.index)) this.owner.set(job.index, slot);
      slot.job = job;
      slot.worker.postMessage({ type: "render", id: job.id, index: job.index, rect: job.rect, height: job.height, vector: job.vector });
    }
    if (!this.queue.length && !this.vectorJobs?.size && this.workers.every((s) => !s.job)) {
      this.resting = setTimeout(() => {
        for (const slot of this.workers) slot.worker.postMessage({ type: "rest" });
      }, REST_MS);
    }
  }

  /** Queued work is dropped; work being drawn stops within a slice (see render-worker.js). */
  cancel(predicate) {
    super.cancel(predicate);
    for (const slot of this.workers) {
      if (slot.job && !slot.job.cancelled && predicate(slot.job)) {
        slot.job.cancelled = true;
        slot.worker.postMessage({ type: "cancel", id: slot.job.id });
      }
    }
  }

  warm(index) {
    for (const slot of this.workers) {
      slot.knows ??= new Set();
      slot.warming ??= new Set();
      if (slot.knows.has(index) || slot.warming.has(index)) continue;
      slot.warming.add(index);
      // A tiny render is enough: interpreting the page is the work that gets kept.
      // Done, the thread knows the page (#finished): until it lets it go, when warm() teaches
      // it again (kept as warming, it never was, and a page's strips rendered on one thread).
      this.render(index, { x0: 0, y0: 0, x1: 1, y1: 1 }, 4, 150, { cache: false, slot })
        .then((img) => img?.close?.(), () => {})
        .finally(() => slot.warming.delete(index));
    }
  }

  /**
   * A page's vector text: the glyphs its 3D page draws from their outlines, and where (any
   * thread gives the same answer; the page's own thread knows it best).
   * Null if the threads stop first (a page's image never waits on its text for ever).
   * @returns {Promise<{glyphs: Map<string, Float32Array>, instances: {glyph: string, m: number[], color: number[]}[]} | null>}
   */
  vectorText(index) {
    if (this.closed) return Promise.resolve(null);
    const slot = this.owner?.get(index) ?? this.workers[index % this.workers.length];
    const id = `v${++jobIds}`;
    clearTimeout(this.resting);
    return new Promise((resolve) => {
      this.vectorJobs.set(id, { resolve, slot });
      slot.worker.postMessage({ type: "vector", id, index });
    });
  }

  /** Answer waiting vector text requests (of one thread, or all) with none. */
  #dropVectorJobs(slot = null) {
    for (const [id, job] of this.vectorJobs ?? []) {
      if (slot && job.slot !== slot) continue;
      this.vectorJobs.delete(id);
      job.resolve(null);
    }
  }

  #finished(slot, msg) {
    if (msg.type === "forgot") { // let go of (see render-worker.js): learnt again if needed
      slot.knows?.delete(msg.index);
      return;
    }
    if (msg.type === "vector") {
      const job = this.vectorJobs?.get(msg.id);
      this.vectorJobs?.delete(msg.id);
      job?.resolve({ glyphs: new Map(msg.glyphs), instances: msg.instances });
      this.pump();
      return;
    }
    if (msg.type === "fail") this.#dropVectorJobs(slot);
    const job = slot.job;
    slot.job = null;
    if (job) {
      if (msg.type === "done") {
        (slot.knows ??= new Set()).add(job.index);
        msg.bitmap.skippedOps = msg.skipped; // for tests: operators left out (see cull.js)
        job.resolve(msg.bitmap);
      } else {
        job.reject(new Error(msg.message));
      }
    }
    this.pump();
  }

  destroy() {
    this.close();
    clearTimeout(this.resting);
    this.#dropVectorJobs();
    for (const slot of this.workers) slot.worker.terminate();
  }
}

/** Fallback: renders on the main thread with pdf.js's display pacing (stays responsive). */
export class MainThreadRenderer extends Scheduler {
  constructor(pdf, { intent = "display" } = {}) {
    super();
    this.pdf = pdf;
    this.intent = intent;
    this.pages = new Map();
    this.active = 0;
  }

  pump() {
    while (!this.closed && this.active < 2) {
      const job = this.next();
      if (!job) return;
      this.active++;
      this.#draw(job).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  async #draw({ index, rect: r, height }) {
    if (!this.pages.has(index)) this.pages.set(index, this.pdf.getPage(index + 1));
    const page = await this.pages.get(index);
    const base = page.getViewport({ scale: 1 });
    // PDF user space (pt) to viewport pixels at scale 1, via the viewport's matrix.
    const [ax, ay] = toViewport(base, mmToPt(r.x0), mmToPt(r.y0));
    const [bx, by] = toViewport(base, mmToPt(r.x1), mmToPt(r.y1));
    const x0 = Math.min(ax, bx);
    const y0 = Math.min(ay, by);
    const scale = height / Math.abs(by - ay);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(Math.abs(bx - ax) * scale));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const viewport = page.getViewport({ scale, offsetX: -x0 * scale, offsetY: -y0 * scale });
    await page.render({ canvasContext: ctx, viewport, intent: this.intent }).promise;
    return createImageBitmap(canvas);
  }

  destroy() {
    this.close();
    this.pdf.loadingTask?.destroy?.() ?? this.pdf.destroy?.();
  }
}

function toViewport(viewport, x, y) {
  const [a, b, c, d, e, f] = viewport.transform;
  return [a * x + c * y + e, b * x + d * y + f];
}
