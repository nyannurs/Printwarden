// A recording of whatever the author does, for a report: Cmd/Ctrl+Shift+L starts it, the same
// again stops it and shows the report (to copy and paste to the developer). Every frame the
// screen shows: its time since the one before, the main thread's time by part (FRAME_PARTS in
// viewer/scene.js), the graphics card's where it can be timed; the main thread blocked (long
// tasks, and gaps with no frame at all); and what happened meanwhile: pages turned, the book
// opened or closed, page images and tiles arriving, page renders asked for and how long each
// took, the JavaScript heap shrinking (garbage collected). For hiccups the performance check
// (probe.js) doesn't reproduce: a jump along the timeline, opening a closed book deep in.

import { APP_VERSION } from "../platform.js";
import { FRAME_PARTS } from "../viewer/scene.js";

const GAP_MS = 50; // a gap between frames this long counts as a stall
const SLOWEST = 12; // frames listed in the report
const SLOT_MS = 100; // the timeline's other events summed up this long at a time

/**
 * Start recording. Returns stop(), which ends the recording, puts everything back as it was
 * and returns the report's text.
 * @param {import("../viewer/scene.js").BookScene} scene
 * @param {any} state the app's (ui/app.js)
 */
export function startTrace(scene, state) {
  const t0 = performance.now();
  const at = (t = performance.now()) => t - t0;
  /** @type {{t: number, what: string}[]} */
  const events = [];
  const note = (what) => events.push({ t: at(), what });
  /** @type {{t: number, gap: number, cpu: number | null, parts: number[] | null, gpu: number | null, heap: number | null}[]} */
  const ticks = [];
  /** @type {{t: number, ms: number}[]} */
  const longs = [];
  const renders = { asked: 0, landed: 0, ms: [] };
  let tiles = 0;

  // What happened: the scene's entry points, wrapped, and put back on stop.
  const undo = [];
  const wrap = (obj, name, describe) => {
    const own = Object.prototype.hasOwnProperty.call(obj, name);
    const was = obj[name];
    if (typeof was !== "function") return;
    obj[name] = function (...args) {
      try {
        const what = describe(...args);
        if (what) note(what);
      } catch {
        // a description that fails is left out
      }
      return was.apply(this, args);
    };
    undo.push(() => {
      if (own) obj[name] = was;
      else delete obj[name];
    });
  };
  wrap(scene, "goTo", (j) => `turn to opening ${j} (from ${scene.opening})`);
  wrap(scene, "setClosed", (closed) => (closed ? "close" : "open"));
  wrap(scene, "setPageTexture", (folio, image) => `page image ${folio}${image ? ` (${image.height} px)` : " (blank)"}`);
  wrap(scene, "showPageImage", (folio, image) => (image ? `sharp image ${folio} (${image.height} px)` : `sharp image ${folio} let go`));
  wrap(scene.tiles, "queueTile", () => {
    tiles++;
    return null;
  });
  // Page renders asked of the render threads, and when each arrives.
  const renderer = state.renderer;
  if (renderer?.render) {
    const was = renderer.render;
    renderer.render = function (...args) {
      const asked = performance.now();
      renders.asked++;
      const p = was.apply(this, args);
      Promise.resolve(p).then(() => {
        const took = performance.now() - asked;
        renders.landed++;
        renders.ms.push(took);
        note(`page render landed after ${took.toFixed(0)} ms`);
      }, () => {});
      return p;
    };
    undo.push(() => { renderer.render = was; });
  }

  // The main thread blocked 50 ms or more (Chromium's long tasks).
  let observer = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longs.push({ t: e.startTime - t0, ms: e.duration });
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    observer = null;
  }

  // Every refresh: the gap since the last, and the frames the scene drew since (its log).
  const log = scene.frameLog;
  let seen = log.n;
  let last = performance.now();
  let lastGpu = scene.gpuTime.at;
  let running = true;
  const memory = /** @type {any} */ (performance).memory;
  const tick = (now) => {
    if (!running) return;
    const gap = now - last;
    last = now;
    let cpu = null;
    let parts = null;
    for (; seen < log.n; seen++) {
      const k = seen % log.time.length;
      if (cpu === null || log.cpu[k] > cpu) {
        cpu = log.cpu[k];
        parts = log.parts.map((p) => p[k]);
      }
    }
    let gpu = null;
    if (scene.gpuTime.at > lastGpu) {
      gpu = scene.gpuTime.ms;
      lastGpu = scene.gpuTime.at;
    }
    ticks.push({ t: at(now), gap, cpu, parts, gpu, heap: memory ? memory.usedJSHeapSize : null });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return function stop() {
    running = false;
    observer?.disconnect();
    for (const u of undo.reverse()) u();
    return report({ scene, state, events, ticks, longs, renders, tiles, duration: at() });
  };
}

/** The recording as text, to paste to the developer. */
function report({ scene, state, events, ticks, longs, renders, tiles, duration }) {
  const gl = scene.renderer.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const gpuName = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const ms = (v) => (v == null ? "-" : `${v.toFixed(1)}`);
  const sorted = (a) => a.slice().sort((x, y) => x - y);
  const q = (a, p) => (a.length ? sorted(a)[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
  const drawn = ticks.filter((k) => k.cpu !== null);
  const gaps = ticks.map((k) => k.gap);
  const lines = [
    `Recording: Printwarden ${APP_VERSION}, ${(duration / 1000).toFixed(1)} s`,
    `GPU: ${gpuName}`,
    `View ${gl.drawingBufferWidth} × ${gl.drawingBufferHeight} px, pixel ratio ${scene.renderer.getPixelRatio()}, ${navigator.hardwareConcurrency} CPU threads`,
    `Book: ${scene.leaves.length} sheets, ${scene.model?.binding ?? "?"}, ${state.analysis?.book.pages.length ?? "?"} pages`,
    "",
    `Refreshes ${ticks.length}, frames drawn ${drawn.length}; time between refreshes: median ${ms(q(gaps, 0.5))} ms, p95 ${ms(q(gaps, 0.95))}, worst ${ms(Math.max(0, ...gaps))}`,
    `Main thread a drawn frame: median ${ms(q(drawn.map((k) => k.cpu), 0.5))} ms, worst ${ms(Math.max(0, ...drawn.map((k) => k.cpu)))}`,
    `Page renders asked ${renders.asked}, landed ${renders.landed}, took median ${ms(q(renders.ms, 0.5))} ms, worst ${ms(Math.max(0, ...renders.ms))}; tiles queued ${tiles}`,
    `Long tasks (main thread blocked 50 ms or more): ${longs.length}${longs.length ? `, longest ${ms(Math.max(...longs.map((l) => l.ms)))} ms` : ""}`,
    "",
  ];
  // What happened around a moment: events, long tasks, a heap drop.
  const around = (t0, t1) => {
    const out = [];
    const ev = events.filter((e) => e.t >= t0 - 1 && e.t <= t1 + 1);
    const counted = new Map();
    for (const e of ev) {
      const key = e.what.replace(/\d+( px)?/g, "#");
      counted.set(key, [...(counted.get(key) ?? []), e.what]);
    }
    for (const [, list] of counted) out.push(list.length > 3 ? `${list[0]} … (${list.length}×)` : list.join("; "));
    for (const l of longs) if (l.t < t1 && l.t + l.ms > t0) out.push(`long task ${ms(l.ms)} ms`);
    return out;
  };
  const heapDrop = (i) => {
    const a = ticks[i - 1]?.heap;
    const b = ticks[i].heap;
    return a != null && b != null && a - b > 8e6 ? `heap −${((a - b) / 1e6).toFixed(0)} MB (garbage collected)` : null;
  };
  const partsText = (parts) => (parts ? FRAME_PARTS.map((name, i) => [name, parts[i]]).filter(([, v]) => v >= 0.5).map(([n, v]) => `${n} ${v.toFixed(1)}`).join(", ") : "");

  lines.push(`Longest waits between refreshes (over ${GAP_MS} ms, or the ${SLOWEST} longest), ms after the start:`);
  const slow = ticks.map((k, i) => ({ k, i })).sort((a, b) => b.k.gap - a.k.gap).slice(0, SLOWEST).filter(({ k }) => k.gap > 1.5 * q(gaps, 0.5)).sort((a, b) => a.k.t - b.k.t);
  if (!slow.length) lines.push("  none: every refresh on time");
  for (const { k, i } of slow) {
    const what = [...around(k.t - k.gap, k.t), heapDrop(i)].filter(Boolean);
    lines.push(`  at ${k.t.toFixed(0)}: waited ${ms(k.gap)} ms; frame main thread ${ms(k.cpu)}${k.parts ? ` (${partsText(k.parts)})` : ""}${k.gpu != null ? `, gpu ${ms(k.gpu)}` : ""}`);
    for (const w of what) lines.push(`      ${w}`);
  }
  // What happened: turns, opening and closing each on a line; the rest (page images, renders)
  // summed up SLOT_MS at a time, so a stream of renders never pushes a turn off the list.
  lines.push("", "What happened (ms after the start):");
  const major = (what) => /^turn|^open|^close/.test(what);
  const slots = new Map();
  for (const e of events) {
    if (major(e.what)) continue;
    const slot = Math.floor(e.t / SLOT_MS);
    const kinds = slots.get(slot) ?? new Map();
    const key = e.what.replace(/ \d.*$/, "");
    const k = kinds.get(key) ?? { n: 0, vals: [] };
    k.n++;
    const v = e.what.match(/after (\d+) ms/);
    if (v) k.vals.push(Number(v[1]));
    kinds.set(key, k);
    slots.set(slot, kinds);
  }
  const rows = [
    ...events.filter((e) => major(e.what)).map((e) => ({ t: e.t, text: e.what, slot: false })),
    ...[...slots].map(([slot, kinds]) => ({
      t: slot * SLOT_MS,
      text: [...kinds].map(([key, k]) => `${key} ×${k.n}${k.vals.length ? ` (${Math.min(...k.vals)}–${Math.max(...k.vals)} ms)` : ""}`).join("; "),
      slot: true,
    })),
  ].sort((a, b) => a.t - b.t);
  if (!rows.length) lines.push("  nothing");
  for (const r of rows.slice(0, 150)) lines.push(`  ${r.t.toFixed(0).padStart(6)}${r.slot ? `–${(r.t + SLOT_MS).toFixed(0)}` : ""}  ${r.text}`);
  if (rows.length > 150) lines.push(`  (and ${rows.length - 150} more)`);
  return lines.join("\n");
}
