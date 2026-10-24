// A render thread: MuPDF drawing pages (mupdf-render.js) for the pool in render.js, which
// hands it the document, the CMYK profile, the spot plates left out, and one render at a time.
// Messages in: open {bytes | blob}, profile {bytes}, spots-off {names}, render {id, index, rect,
// height, mode, mips}, lut {id, bytes}, spots {id}, rest. Out: loaded, ready, error, done {id,
// bitmap | ink}, fail {id, message, fatal}, answer {id, data}.
//
// `fatal`: MuPDF itself failed (a WebAssembly trap or abort: out of memory, say), and nothing
// more can be drawn here; the pool starts another thread in this one's place.

import { InkDocument, toBitmap } from "./mupdf-render.js";

/** @type {InkDocument | null} */
let doc = null;
let profile = null; // the profile's bytes, if they arrived before the document
let spotsOff = [];

self.postMessage({ type: "loaded" }); // MuPDF is instantiated (the import)

self.onmessage = async ({ data }) => {
  try {
    switch (data.type) {
      case "open": {
        const bytes = data.bytes ?? new Uint8Array(await data.blob.arrayBuffer());
        doc = new InkDocument(bytes);
        if (profile !== null) doc.setProfile(profile);
        doc.setSpotsOff(spotsOff);
        self.postMessage({ type: "ready" });
        return;
      }
      case "profile":
        profile = data.bytes ?? null;
        doc?.setProfile(profile);
        return;
      case "spots-off":
        spotsOff = data.names;
        doc?.setSpotsOff(spotsOff);
        return;
      case "render": {
        if (!doc) throw new Error("no document");
        const drawn = doc.draw(data.index, data.rect, data.height, data.mode ?? "rgb", { mips: data.mips ?? 0 });
        if (data.mode === "ink") {
          const buffers = [drawn.data, drawn.spots, ...(drawn.mips ?? []), ...(drawn.spotMips ?? [])].filter(Boolean).map((b) => b.buffer);
          self.postMessage({ type: "done", id: data.id, ink: drawn }, buffers);
        } else {
          const bitmap = await toBitmap(drawn);
          self.postMessage({ type: "done", id: data.id, bitmap }, [bitmap]);
        }
        return;
      }
      case "lut": {
        const table = doc.lut(data.bytes ?? null);
        self.postMessage({ type: "answer", id: data.id, data: table }, [table.buffer]);
        return;
      }
      case "spots":
        self.postMessage({ type: "answer", id: data.id, data: doc.spots() });
        return;
      case "rest":
        doc?.forget();
        return;
      default:
        return;
    }
  } catch (err) {
    const fatal = err instanceof WebAssembly.RuntimeError;
    if (data.type === "open") self.postMessage({ type: "error", message: String(err?.stack ?? err) });
    else if (data.type === "render") self.postMessage({ type: "fail", id: data.id, message: String(err?.message ?? err), fatal });
    else if (data.type === "lut" || data.type === "spots") self.postMessage({ type: "answer", id: data.id, data: null, fatal });
    else {
      console.warn("[mupdf-worker]", data.type, err);
      if (fatal) self.postMessage({ type: "fail", id: null, message: String(err?.message ?? err), fatal });
    }
  }
};
