// A render thread: MuPDF drawing pages (mupdf-render.js) for the pool in render.js, which
// hands it the document, the CMYK profile, the plates that print, and one render at a time.
// Messages in: open {bytes | blob}, profile {bytes}, inks {inkOn}, render {id, index, rect,
// height, mode}, info {id, index}, rest, cancel (a render in hand runs on: tens of milliseconds).
// Out: loaded, ready, error, done {id, bitmap | ink}, fail {id, message}, info {id, ...}.

import { InkDocument, toBitmap } from "./mupdf-render.js";

/** @type {InkDocument | null} */
let doc = null;
let profile = null; // the profile's bytes, if they arrived before the document

self.postMessage({ type: "loaded" }); // MuPDF is instantiated (the import)

self.onmessage = async ({ data }) => {
  try {
    switch (data.type) {
      case "open": {
        const bytes = data.bytes ?? new Uint8Array(await data.blob.arrayBuffer());
        doc = new InkDocument(bytes);
        if (profile !== null) doc.setProfile(profile);
        self.postMessage({ type: "ready" });
        return;
      }
      case "profile":
        profile = data.bytes ?? null;
        doc?.setProfile(profile);
        return;
      case "inks":
        doc?.setInks(data.inkOn);
        return;
      case "render": {
        if (!doc) throw new Error("no document");
        const drawn = doc.draw(data.index, data.rect, data.height, data.mode ?? "rgb");
        if (data.mode === "ink") {
          self.postMessage({ type: "done", id: data.id, ink: drawn }, [drawn.data.buffer]);
        } else {
          const bitmap = await toBitmap(drawn);
          self.postMessage({ type: "done", id: data.id, bitmap, overprint: drawn.overprint }, [bitmap]);
        }
        return;
      }
      case "info":
        self.postMessage({ type: "info", id: data.id, ...doc.info(data.index) });
        return;
      case "rest":
        doc?.forget();
        return;
      default:
        return;
    }
  } catch (err) {
    if (data.type === "open") self.postMessage({ type: "error", message: String(err?.stack ?? err) });
    else if (data.type === "render") self.postMessage({ type: "fail", id: data.id, message: String(err?.message ?? err) });
    else if (data.type === "info") self.postMessage({ type: "info", id: data.id, spots: [], overprint: false });
    else console.warn("[mupdf-worker]", data.type, err);
  }
};
