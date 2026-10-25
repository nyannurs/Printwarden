// Page images for the 3D book and the timeline, drawn by MuPDF from the PDF's vectors as the
// press prints them (mupdf-render.js: overprint, spot colours, the chosen CMYK profile).
//
// A pool of background workers does the drawing (mupdf-worker.js), several pages at once, so
// the interface never stalls. Results are a page's inks (`mode: "ink"`: what the 3D view and
// the timeline show, see mupdf-render.js) or ImageBitmaps in sRGB (what leaves the app). If
// workers can't start, a main-thread renderer takes over (same drawing, the interface waits).
//
// Requests: a base image per page (sized to a memory budget), a thumbnail per page, the view's
// tiles (ui/tiles.js), a capture's strips, and one-offs (flaps, spine artwork, finish masks).

import { COVER_BASE } from "../core/document.js";
import { SYSTEM_MEMORY } from "../platform.js";
import { naiveLut } from "../viewer/inklut.js";

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
 * little memory (three with 8 GB), and fewer for a large file: every thread holds its own copy
 * of the file in MuPDF's memory (MuPDF reads a file whole), plus what it caches from it (fonts,
 * decoded images: up to 100 MB).
 */
const poolSize = (bytes = 0) => Math.max(1, Math.min(
  Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2))),
  Math.floor(SYSTEM_MEMORY / (2.5 * 2 ** 30)),
  Math.floor(THREADS_FILE_BYTES / Math.max(1, bytes)),
));
const THREADS_FILE_BYTES = 1.5 * 2 ** 30; // the threads' copies of a file together, at most
// A file this large goes to the threads as one Blob (each reads it into its own memory when it
// opens); smaller files are handed over whole.
const SHARED_FILE_BYTES = 24 * 2 ** 20;
// Threads idle this long let go of the pages and caches they built (see mupdf-worker.js).
const REST_MS = 20000;
// Threads started in place of failed ones, at most, in a document (see WorkerPool #restart).
const RESTARTS_MAX = 6;

/**
 * One renderer for a book from two files: the pages' and the cover file's (its pages at
 * COVER_BASE and up). Cancelled, warmed and destroyed together.
 */
export function routedRenderer(main, cover) {
  if (!cover) return main;
  const of = (index) => (index >= COVER_BASE ? [cover, index - COVER_BASE] : [main, index]);
  return {
    render(index, ...rest) { const [r, i] = of(index); return r.render(i, ...rest); },
    setSpotsOff(names) { main.setSpotsOff(names); cover.setSpotsOff(names); },
    setProfile(bytes) { main.setProfile(bytes); cover.setProfile(bytes); },
    inkLut(bytes) { return main.inkLut(bytes); },
    /** Both files' spots, by name (a spot in both: one, on the pages of both). */
    async spots() {
      const [a, b] = await Promise.all([main.spots(), cover.spots()]);
      const byName = new Map(a.map((s) => [s.name, { ...s, pages: [...s.pages], composited: [...s.composited] }]));
      for (const s of b) {
        const pages = s.pages.map((i) => i + COVER_BASE);
        const composited = s.composited.map((i) => i + COVER_BASE);
        const had = byName.get(s.name);
        if (had) {
          had.pages.push(...pages);
          had.composited.push(...composited);
        } else byName.set(s.name, { ...s, pages, composited });
      }
      return [...byName.values()];
    },
    cancel(predicate) { main.cancel(predicate); cover.cancel(predicate); },
    destroy() { main.destroy(); cover.destroy(); },
  };
}

/**
 * Start a renderer for `bytes`: worker pool if possible, main thread otherwise.
 * `cmykProfile` (ICC bytes, or a promise of them, optional): plain CMYK is read in it and RGB
 * content converted through it; without it, MuPDF's own. Embedded ICC profiles are always
 * honoured. The workers start loading right away and wait for the profile only before opening.
 * @param {Uint8Array} bytes
 * @param {Uint8Array | null | Promise<Uint8Array | null>} [cmykProfile]
 */
export async function createRenderer(bytes, cmykProfile = null) {
  try {
    const slots = takeSpareWorkers(poolSize(bytes.byteLength));
    return await WorkerPool.start(bytes, slots, cmykProfile);
  } catch (err) {
    console.warn("Background rendering unavailable, using the main thread:", err);
    const { InkDocument } = await import("./mupdf-render.js");
    const doc = new InkDocument(bytes);
    doc.setProfile((await cmykProfile) ?? null);
    return new MainThreadRenderer(doc);
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
 * A small, separate PDF (spine artwork) open in a thread of its own, for as long as it is kept:
 * rendered as often as wanted (its sharp tiles), with the same colour management as the book.
 * `destroy` ends it.
 * @param {Uint8Array} bytes
 * @param {Uint8Array | null} [cmykProfile]
 */
export function openOne(bytes, cmykProfile = null) {
  return WorkerPool.start(bytes, [spawnWorker()], cmykProfile);
}

/**
 * Render one area of a small, separate PDF (e.g. spine artwork) in a thread of its own, with
 * the same colour management as the book. The thread ends when done. `mode` "ink": the inks
 * (see mupdf-render.js), and with them the file's spot colours and their looks (`spots`).
 * @param {Uint8Array | null} [cmykProfile]
 * @param {{mode?: "rgb" | "ink"}} [options]
 * @returns {Promise<any>} an ImageBitmap; inks: {image, spots}
 */
export async function renderOnce(bytes, pageIndex, rectMm, height, cmykProfile = null, options = {}) {
  const mode = options.mode ?? "rgb";
  const pool = await WorkerPool.start(bytes, [spawnWorker()], cmykProfile);
  try {
    if (mode !== "ink") return await pool.render(pageIndex, rectMm, height, 0, { cache: false });
    const image = await pool.render(pageIndex, rectMm, height, 0, { cache: false, mode: "ink" });
    return { image, spots: await pool.spots() };
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
   * only while it runs (an image handed on and freed, see loadAllTextures in ui/pages.js).
   * `mode` "rgb" (an ImageBitmap) or "ink" (the page's inks, see mupdf-render.js).
   * @param {number} index
   * @param {{x0: number, y0: number, x1: number, y1: number}} rectMm
   * @param {number} height
   * @param {number} [priority]
   * @param {{cache?: boolean | "pending", flex?: boolean, slot?: any, mode?: "rgb" | "ink", tag?: string | null, mips?: number}} [options]
   *   `tag`: a name to cancel the render by (cancel's predicate sees it as job.tag); `mips`: smaller
   *   copies with an ink drawing (see mupdf-render.js)
   * @returns {Promise<any>}
   */
  render(index, rectMm, height, priority = 10, { cache = true, flex = false, slot = null, mode = "rgb", tag = null, mips = 0 } = {}) {
    const key = `${index}|${height}|${[rectMm.x0, rectMm.y0, rectMm.x1, rectMm.y1].map((v) => v.toFixed(2))}|${mode}|${mips}`;
    const hit = this.cache.get(key);
    if (hit) {
      const queued = this.queue.find((q) => q.key === key);
      if (queued) queued.priority = Math.min(queued.priority, priority);
      return hit;
    }
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ id: ++jobIds, key, index, rect: { ...rectMm }, height, priority, resolve, reject, flex, slot, mode, tag, mips });
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

  /**
   * The spot plates left out (their names): every image drawn from now on is without them.
   * What was drawn before is let go of (the caller asks again for what it shows).
   * @param {string[]} _names
   */
  setSpotsOff(_names) {
    this.cache.clear();
  }

  /** The CMYK profile (ICC bytes, or null for MuPDF's own) for every image drawn from now on. */
  setProfile(_bytes) {
    this.cache.clear();
  }

  /**
   * The document's spot colours, their look in the profile set now (see mupdf-render.js spots).
   * @returns {Promise<{name: string, cmyk: number[], pages: number[], composited: number[]}[]>}
   */
  spots() {
    return Promise.resolve([]);
  }

  /**
   * The ink table for a profile (ICC bytes, or null): see mupdf-render.js lut.
   * @param {Uint8Array | null} _bytes
   * @returns {Promise<Uint8Array | null>} null if it couldn't be made
   */
  inkLut(_bytes) {
    return Promise.resolve(naiveLut());
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
// Starting a render worker means instantiating MuPDF (10 MB of WebAssembly); six at once,
// while a file is being read, takes seconds. So a set of workers is started while the app is
// idle and handed to the first document; then a couple are prepared for the next. Each set
// serves one document.

let spare = null;

function spawnWorker() {
  const worker = new Worker(new URL("./mupdf-worker.js", import.meta.url), { type: "module" });
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
  constructor(bytes) {
    super();
    /** @type {any[]} the threads (slots), once started */
    this.workers = [];
    this.owner = new Map(); // page index -> first slot to read it (its images are cached there)
    /** @type {Map<string, {resolve: (data: any) => void, slot: any}>} questions asked of a thread (an ink table, the spots) */
    this.asks = new Map();
    // The file, for a thread started in place of one that failed: a large one as one Blob (each
    // reads it into its own memory when it opens), smaller ones handed over whole.
    this.bytes = bytes;
    this.shared = bytes.byteLength >= SHARED_FILE_BYTES ? new Blob([bytes]) : null;
    this.profile = null; // the profile's bytes, once known
    this.spotsOff = [];
    this.restarts = 0;
  }

  static async start(bytes, slots, cmykProfile) {
    const pool = new WorkerPool(bytes);
    const profile = Promise.resolve(cmykProfile).then((p) => (pool.profile = p ?? null));
    pool.workers = await Promise.all(slots.map((slot) => pool.#open(slot, profile))).catch((err) => {
      // None of them is used then: all stopped (they each hold the file, or part of it).
      for (const slot of slots) slot.worker.terminate();
      throw err;
    });
    return pool;
  }

  /**
   * A thread given the document, then the CMYK profile when known (`profile` resolves when
   * this.profile is: it depends on the file's output intent) and the spot plates left out. It
   * takes pages once it has them all.
   * @returns {Promise<any>} the slot, ready
   */
  #open(slot, profile) {
    const { worker } = slot;
    return new Promise((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || "worker failed to start"));
      let opened = false;
      let profiled = false;
      const maybeReady = () => opened && profiled && resolve(slot);
      worker.onmessage = ({ data }) => {
        if (data.type === "ready") {
          worker.onmessage = ({ data: msg }) => this.#finished(slot, msg);
          worker.onerror = (e) => {
            e.preventDefault?.();
            this.#finished(slot, { type: "fail", message: e.message, fatal: true });
          };
          opened = true;
          maybeReady();
        } else if (data.type === "error") {
          reject(new Error(data.message));
        }
      };
      slot.loaded.then(() => {
        if (this.shared) {
          worker.postMessage({ type: "open", blob: this.shared }); // the one Blob, not a copy
        } else {
          const copy = this.bytes.slice(); // each thread its own copy, handed over (not copied again)
          worker.postMessage({ type: "open", bytes: copy }, [copy.buffer]);
        }
      }, reject);
      // Once MuPDF is loaded in it too: a module thread drops what comes before (its handler
      // is set only when its imports are done). The newest profile and spots then, should they
      // have changed while it started.
      Promise.all([slot.loaded, profile]).then(() => {
        worker.postMessage({ type: "profile", bytes: this.profile });
        if (this.spotsOff.length) worker.postMessage({ type: "spots-off", names: this.spotsOff });
        profiled = true;
        maybeReady();
      }, reject);
    });
  }

  /**
   * A page's renders go to the thread that first read it: a thread keeps the pages it read
   * last (their decoded images above all), so later renders of one are quickest there. Tiles
   * and strips ("flex" jobs) go to any free one (MuPDF reads a page in milliseconds; a photo
   * page's JPEG once more on another thread). A page nobody has read goes to whichever is free.
   */
  pump() {
    if (this.closed) return;
    clearTimeout(this.resting);
    for (const slot of this.workers) {
      if (slot.job || slot.starting) continue;
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const job = this.queue[i];
        const owner = this.owner.get(job.index);
        // (Its first thread always fits: it may have let the page go, as may every other.)
        const fits = job.slot ? job.slot === slot
          : job.flex ? true
          : !owner || owner === slot;
        if (!fits) continue;
        if (best < 0 || job.priority < this.queue[best].priority) best = i;
      }
      if (best < 0) continue;
      const job = this.queue.splice(best, 1)[0];
      if (!this.owner.has(job.index)) this.owner.set(job.index, slot);
      slot.job = job;
      slot.worker.postMessage({ type: "render", id: job.id, index: job.index, rect: job.rect, height: job.height, mode: job.mode, mips: job.mips });
    }
    if (!this.queue.length && !this.asks.size && this.workers.every((s) => !s.job)) {
      this.resting = setTimeout(() => {
        for (const slot of this.workers) slot.worker.postMessage({ type: "rest" });
      }, REST_MS);
    }
  }

  setSpotsOff(names) {
    super.setSpotsOff(names);
    this.spotsOff = names;
    for (const slot of this.workers) slot.worker.postMessage({ type: "spots-off", names });
  }

  setProfile(bytes) {
    super.setProfile(bytes);
    this.profile = bytes ?? null;
    for (const slot of this.workers) slot.worker.postMessage({ type: "profile", bytes: this.profile });
  }

  /** @returns {Promise<Uint8Array | null>} the table, or null if the thread failed */
  inkLut(bytes) {
    return this.#ask({ type: "lut", bytes: bytes ?? null });
  }

  /** @returns {Promise<{name: string, cmyk: number[], pages: number[], composited: number[]}[]>} see mupdf-render.js spots (none if the thread failed) */
  async spots() {
    return (await this.#ask({ type: "spots" })) ?? [];
  }

  /** A question for a thread (the first that is running), answered with its data, or null. */
  #ask(message) {
    const slot = this.workers.find((s) => !s.starting);
    if (this.closed || !slot) return Promise.resolve(null);
    const id = `a${++jobIds}`;
    clearTimeout(this.resting);
    return new Promise((resolve) => {
      this.asks.set(id, { resolve, slot });
      slot.worker.postMessage({ ...message, id });
    });
  }

  #finished(slot, msg) {
    if (msg.type === "answer") {
      const ask = this.asks.get(msg.id);
      this.asks.delete(msg.id);
      ask?.resolve(msg.data ?? null);
      if (msg.fatal) this.#restart(slot);
      this.pump();
      return;
    }
    const job = slot.job;
    slot.job = null;
    if (msg.fatal) {
      // The thread can draw no more: another in its place, and its render tried once more
      // there or on another (a page that brings MuPDF down twice is reported as failed).
      if (job && !job.retried) {
        job.retried = true;
        this.queue.push(job);
      } else job?.reject(new Error(msg.message));
      this.#restart(slot);
    } else if (job) {
      if (msg.type === "done") {
        if (msg.ink) msg.ink.close = () => { msg.ink.data = msg.ink.spots = null; }; // as an ImageBitmap's: its bytes let go
        job.resolve(msg.bitmap ?? msg.ink);
      } else {
        job.reject(new Error(msg.message));
      }
    }
    this.pump();
  }

  /**
   * A thread that failed (MuPDF trapped, or the thread itself ended) stopped, and a new one
   * started in its place with the same document, profile and plates. The pages it had read
   * go to whichever thread is free. After RESTARTS_MAX in one document no more are started:
   * the threads left carry on; with none left, what is queued fails.
   */
  #restart(slot) {
    slot.worker.terminate();
    for (const [index, owner] of this.owner) if (owner === slot) this.owner.delete(index);
    for (const [id, ask] of this.asks) {
      if (ask.slot !== slot) continue;
      this.asks.delete(id);
      ask.resolve(null);
    }
    if (this.closed) return;
    if (++this.restarts > RESTARTS_MAX) {
      console.warn("[render] a render thread failed; not started again");
      this.workers = this.workers.filter((s) => s !== slot);
      if (!this.workers.length) {
        for (const job of this.queue) job.reject(new Error("no render thread"));
        this.queue = [];
      }
      return;
    }
    console.warn("[render] a render thread failed; starting another");
    const fresh = spawnWorker();
    slot.worker = fresh.worker;
    slot.loaded = fresh.loaded;
    slot.starting = true;
    this.#open(slot, Promise.resolve(this.profile)).then(() => {
      slot.starting = false;
      this.pump();
    }, (err) => {
      console.warn("[render] the new render thread failed:", err);
      slot.starting = false;
      this.#restart(slot);
    });
  }

  destroy() {
    this.close();
    clearTimeout(this.resting);
    for (const ask of this.asks.values()) ask.resolve(null);
    this.asks.clear();
    for (const slot of this.workers) slot.worker.terminate();
  }
}

/**
 * Fallback: MuPDF on the main thread (the same drawing; the interface waits while a page draws).
 * (Exported for its tests, tests/pdf.test.js: the app makes one only in createRenderer.)
 */
export class MainThreadRenderer extends Scheduler {
  /** @param {import("./mupdf-render.js").InkDocument} doc */
  constructor(doc) {
    super();
    this.doc = doc;
    this.active = 0;
  }

  pump() {
    while (!this.closed && this.active < 1) {
      const job = this.next();
      if (!job) return;
      this.active++;
      this.#draw(job).then(job.resolve, job.reject).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  async #draw({ index, rect, height, mode, mips }) {
    await new Promise((r) => setTimeout(r, 0)); // a frame between pages
    const drawn = this.doc.draw(index, rect, height, mode, { mips });
    if (mode === "ink") {
      drawn.close = () => { drawn.data = drawn.spots = null; };
      return drawn;
    }
    const { toBitmap } = await import("./mupdf-render.js");
    return toBitmap(drawn);
  }

  setSpotsOff(names) {
    super.setSpotsOff(names);
    this.doc.setSpotsOff(names);
  }

  setProfile(bytes) {
    super.setProfile(bytes);
    this.doc.setProfile(bytes ?? null);
  }

  inkLut(bytes) {
    return Promise.resolve(this.doc.lut(bytes ?? null));
  }

  spots() {
    return Promise.resolve(this.doc.spots());
  }

  destroy() {
    this.close();
    this.doc.destroy();
  }
}
