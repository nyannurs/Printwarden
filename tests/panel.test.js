// The side panel on whole pixels (the author's rule: no fractional sizes or positions; an
// edge on a half pixel is drawn a pixel off, and two pills alike came out a pixel apart).
// The panel is built as the app builds it, with the app's own stylesheets, for several
// sizes of the grid's square (the window's width sets it), and every control and label is
// measured.

import { analyse } from "../app/core/analysis.js";
import { Binding } from "../app/core/binding.js";
import { rect } from "../app/core/units.js";
import { Inspector } from "../app/ui/inspector.js";
import { eq, ok, test } from "./harness.js";

const A5 = rect(0, 0, 148, 210);
const singles = (n) => Array.from({ length: n }, (_, index) => ({ index, mediaBox: A5, trimBox: rect(3, 3, 151, 213), bleedBox: A5, rotation: 0 }));

/** The app's stylesheets, loaded once into the test page. */
let styled = null;
function withStyles() {
  styled ??= Promise.all(["theme.css", "styles.css"].map((name) => new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL(`../app/${name}`, import.meta.url).href;
    link.onload = resolve;
    link.onerror = () => reject(new Error(`${name} didn't load`));
    document.head.append(link);
  }))).then(() => document.fonts.ready);
  return styled;
}

const noop = () => {};
const deps = {
  onSetup: noop, onGoToFolio: noop, onPaperPreview: noop, onWirePreview: noop, onHeadbandPreview: noop, onSpine: noop, onFinish: noop,
  onColourProfile: noop, onOverprint: noop, onBackground: noop, background: () => "#56575b", onAbout: noop,
};
const colour = { options: [{ id: "included", name: "Included: ISO Coated v2 (ECI)" }, { id: "builtin", name: "Built-in: US coated (GRACoL)" }], choice: "included", overprint: true };

const frac = (v) => Math.abs(v - Math.round(v));

test("side panel: every control and label on whole pixels, at several sizes of the grid's square", async () => {
  await withStyles();
  // The app's frame, as index.html has it, off the page: the panel in its column.
  const app = document.createElement("div");
  app.className = "app";
  app.dataset.state = "ready";
  app.style.cssText = "position: fixed; left: -4000px; top: 0; width: 1600px; height: 900px;";
  const view = document.createElement("main");
  view.className = "viewport";
  const panel = document.createElement("aside");
  panel.className = "inspector";
  const strip = document.createElement("footer");
  strip.className = "filmstrip";
  app.append(view, panel, strip);
  document.body.append(app);
  const bad = [];
  try {
    const inspector = new Inspector(panel, deps);
    for (const binding of [Binding.HARDCOVER, Binding.SPIRAL, Binding.PERFECT]) {
      const a = analyse({ pages: singles(36) }, { binding, signaturePages: binding === Binding.PERFECT ? 4 : null });
      // The square (--u) as the window's width would set it: 1280 px wide gives 32 px, 1600 gives 42, 2432 gives 64.
      for (const u of [32, 42, 50, 58, 64]) {
        app.style.setProperty("--u", `${u}px`);
        inspector.render(a, "test.pdf", colour);
        // In the app the swatches are put on whole pixels once they are on the page (a
        // ResizeObserver, dom.js); a hidden test page gets no observer callbacks, so the
        // window's resize, which snaps the same, stands in for it.
        window.dispatchEvent(new Event("resize"));
        await new Promise((r) => setTimeout(r, 0));
        const panelBox = panel.getBoundingClientRect();
        if (frac(panelBox.width) > 0.01 || frac(panelBox.height) > 0.01) bad.push(`${binding} at ${u} px: the panel is ${panelBox.width} × ${panelBox.height}`);
        for (const el of panel.querySelectorAll(".btn, select, input, .swatch, .custom-swatch, .field > label, .section h2, .facts dt, .facts dd, .finding, .swatches, .field, .section")) {
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          const off = [["x", r.x], ["y", r.y], ["width", r.width], ["height", r.height]].filter(([, v]) => frac(v) > 0.01);
          if (off.length) {
            const what = el.className || el.tagName.toLowerCase();
            const text = (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 24);
            bad.push(`${binding} at ${u} px: ${what} "${text}" ${off.map(([k, v]) => `${k} ${v.toFixed(3)}`).join(", ")}`);
          }
        }
      }
    }
    eq(bad.slice(0, 20), []);
    ok(panel.querySelectorAll(".section").length >= 7, "the panel's sections");
  } finally {
    app.remove();
  }
});
