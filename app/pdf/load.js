// Entry points for PDF work from the interface. Heavy jobs run in a background worker
// (tasks-worker.js); if workers are unavailable they run here instead.

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

export function writeImposed(bytes, analysis, plan, info, coverBytes = null) {
  return run("export", { bytes, analysis, plan, info, coverBytes },
    async () => (await import("../impose/writer.js")).writeImposedPdf(bytes, analysis, plan, info, coverBytes));
}
