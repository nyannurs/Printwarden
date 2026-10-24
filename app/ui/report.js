// A view report: Cmd/Ctrl+Shift+G with a document open saves what is on screen as a file the
// developer can rebuild exactly, to look at the same frame and check its geometry (see
// tests/drawn.js restoreView): the scene's snapshot (the book as built, the paper, the camera,
// every sheet's motion at that moment), the setup and the file it came from (its name and
// size: not its contents), and a picture of the view. A few hundred kilobytes.

import { APP_VERSION, chooseSaveLocation } from "../platform.js";
import { scene, state } from "./app.js";
import { toast } from "./dom.js";

/** Listen for the shortcut (once, at startup). */
export function initViewReport() {
  let saving = false;
  document.addEventListener("keydown", async (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.code !== "KeyG" || !state.analysis || saving) return;
    e.preventDefault();
    saving = true;
    try {
      // The moment the keys went down: taken before anything else moves.
      const snapshot = scene.snapshot();
      const { width, height } = snapshot.canvas;
      const picture = await scene.captureImage({ width, height });
      const report = {
        kind: "printwarden view report",
        version: 1,
        app: APP_VERSION,
        taken: new Date().toISOString(),
        file: { name: state.name, bytes: state.bytes?.byteLength ?? 0, pages: state.pages?.length ?? 0 },
        setup: state.setup,
        scene: snapshot,
        picture: await dataUrl(picture),
      };
      const base = (state.name ?? "view").replace(/\.pdf$/i, "");
      const target = await chooseSaveLocation(`${base} view report.json`, { name: "View report", extensions: ["json"], mime: "application/json" });
      if (!target) return;
      await target.write(new TextEncoder().encode(JSON.stringify(report)));
      toast(`Saved ${target.name}.`, "ok");
    } catch (err) {
      console.error(err);
      toast(`View report failed: ${err.message}`, "error");
    } finally {
      saving = false;
    }
  });
}

/** A Blob as a data: URL. */
function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(/** @type {string} */ (reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
