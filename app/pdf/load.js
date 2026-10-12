// Entry points for PDF work from the interface. Heavy jobs run in a background worker
// (tasks-worker.js); if workers are unavailable they run here instead.

import * as pdfjs from "../../vendor/pdf.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../../vendor/pdf.worker.mjs", import.meta.url).href;

let worker = null;
let seq = 0;
const pending = new Map();

function tasksWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL("./tasks-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "worker failed"));
      pending.clear();
      worker = false;
    };
  } catch {
    worker = false;
  }
  return worker;
}

/** Run a task in the background (`transfer`: buffers handed over); falls back to running it here. */
async function run(type, payload, local, transfer = []) {
  const w = tasksWorker();
  if (!w) return local();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ type, id, ...payload }, transfer);
  });
}

/** A copy of the file to hand to the background thread. */
/** @returns {[{bytes: Uint8Array}, ArrayBuffer[]]} */
const handed = (bytes) => {
  const copy = bytes.slice();
  return [{ bytes: copy }, [copy.buffer]];
};

/**
 * Read a PDF's structure (page boxes, embedded imposition settings).
 * @returns {Promise<{pages: import("../core/document.js").SourcePage[], imposition: object | null,
 *                    outputIntent: {name: string, profile: Uint8Array} | null}>}
 */
export function openPdf(bytes) {
  const [payload, transfer] = handed(bytes);
  return run("structure", payload, async () => (await import("./structure.js")).readStructure(bytes.slice()), transfer);
}

export function readImposition(bytes) {
  const [payload, transfer] = handed(bytes);
  return run("imposition", payload, async () => (await import("./structure.js")).readImposition(bytes.slice()), transfer);
}

export function writeImposed(bytes, analysis, plan, info) {
  return run("export", { bytes, analysis, plan, info },
    async () => (await import("../impose/writer.js")).writeImposedPdf(bytes, analysis, plan, info));
}

const vendor = (p) => new URL(`../../vendor/${p}`, import.meta.url).href;

/** A pdf.js document on the main thread: only needed if background rendering fails. */
export function openForRendering(bytes) {
  return pdfjs.getDocument({
    data: bytes.slice(),
    wasmUrl: vendor("pdf-wasm/"),
    iccUrl: vendor("pdf-iccs/"),
    standardFontDataUrl: vendor("pdf-standard-fonts/"),
    cMapUrl: vendor("pdf-cmaps/"),
  }).promise;
}
