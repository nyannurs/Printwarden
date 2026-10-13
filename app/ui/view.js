// Around the 3D view: zoom steps, camera presets, the backdrop colour, dropping a PDF on the
// window, the frame counter and the performance check (Ctrl/Cmd+Shift+P). Set going by
// initView, once the scene is there.

import { rememberDroppedFile } from "../platform.js";
import { CAMERA_PRESETS } from "../viewer/camera.js";
import { inspector, scene, startImport, state } from "./app.js";
import { reportDialog } from "./dialogs.js";
import { $, fitPill, toast } from "./dom.js";
import { runProbe } from "./probe.js";

const VIEW_PREF = "cameraPreset";
const BACKGROUND_PREF = "background";

// Zoom in fixed steps, as a percentage of the preset's framing: a preset and a step always
// frame the book alike, for comparable mockup renders. The wheel zooms freely in between.
const ZOOM_STEPS = [50, 75, 100, 125, 150, 200, 300, 400, 600, 800];
const zoomSlider = /** @type {HTMLInputElement} */ ($("zoom-slider"));
const showSliderFill = () => {
  zoomSlider.style.setProperty("--fill", `${(100 * Number(zoomSlider.value)) / (ZOOM_STEPS.length - 1)}%`);
};
const nearestStep = (percent) => ZOOM_STEPS.reduce((best, s, i) =>
  (Math.abs(Math.log(s / percent)) < Math.abs(Math.log(ZOOM_STEPS[best] / percent)) ? i : best), 0);
export function showZoom(percent) {
  $("zoom-value").textContent = `${Math.round(percent)} %`;
  // Not while gliding to a chosen step: the thumb would flick through the steps between.
  if (!scene.zoomGlide?.keepPivot) zoomSlider.value = String(nearestStep(percent));
  showSliderFill();
}

// Camera presets: one button, a menu. Double-tapping space returns to the chosen one.
const viewBtn = $("view-btn");
const viewMenu = $("view-menu");
function choosePreset(id, { remember = true } = {}) {
  if (!CAMERA_PRESETS[id]) id = "reading";
  scene.setPreset(id);
  for (const b of viewMenu.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.id === id));
  if (remember) {
    try {
      localStorage.setItem(VIEW_PREF, id);
    } catch {
      // no storage: fine
    }
  }
}
function toggleViewMenu(open = viewMenu.hidden) {
  viewMenu.hidden = !open;
  viewBtn.setAttribute("aria-expanded", String(open));
  if (open) /** @type {HTMLElement} */ (viewMenu.querySelector('[aria-checked="true"]'))?.focus();
}

/**
 * Plain type over the 3D view (frame counter, zoom value): black or white, whichever reads
 * better on the backdrop (the larger contrast ratio). It fades between them (styles.css).
 */
function typeOver(hex) {
  const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16) / 255));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (lum + 0.05) / 0.05 > 1.05 / (lum + 0.05) ? "#000" : "#fff";
}

/** Backdrop colour: live while picking, remembered once chosen. */
export function setBackground(color, commit) {
  state.background = color;
  scene.setBackground(color);
  $("viewport").style.background = color;
  $("viewport").style.setProperty("--over", typeOver(color));
  if (!commit) return;
  try {
    localStorage.setItem(BACKGROUND_PREF, color);
  } catch {
    // no storage: fine
  }
  if (state.analysis) inspector.render(state.analysis, state.name, state.colour);
}

// Frame counter, top left of the view: frames a second while anything moves (nothing while
// nothing does), the main
// thread's and (where it can be timed) the graphics card's time a frame, and the resolution
// motion is drawn at when the card can't keep up (see motion.js). Updated four times a second.
const fpsHud = $("fps-hud");
function showFrameStats() {
  const s = scene.frameStats;
  const parts = s.fps == null ? [] : [`${Math.round(s.fps)} fps`, `cpu ${s.cpu.toFixed(1)} ms`];
  if (s.fps != null && s.gpu != null) parts.push(`gpu ${s.gpu.toFixed(1)} ms`);
  if (s.fps != null && s.scale < 1) parts.push(`res ${Math.round(s.scale * 100)} %`);
  const text = parts.join("  •  ");
  if (fpsHud.textContent !== text) fpsHud.textContent = text;
}

/** Wire the controls round the view and restore what was remembered (preset, backdrop). */
export function initView() {
  $("viewport").style.setProperty("--over", typeOver(state.background));
  window.addEventListener("resize", () => fitPill($("doc-name"), 2, 6)); // squares change size
  zoomSlider.max = String(ZOOM_STEPS.length - 1);
  // A notch per step: the thumb snaps to them (the slider moves in whole steps).
  for (let i = 0; i < ZOOM_STEPS.length; i++) {
    const tick = document.createElement("span");
    tick.className = "zoom-tick";
    // The thumb's middle at this step, the 1 px notch on the whole pixel there.
    tick.style.left = `round(down, calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${i / (ZOOM_STEPS.length - 1)}), 1px)`;
    $("zoom-track").prepend(tick);
  }
  zoomSlider.addEventListener("input", () => {
    showSliderFill();
    scene.setZoomPercent(ZOOM_STEPS[Number(zoomSlider.value)]);
  });
  showZoom(100);

  for (const [id, preset] of Object.entries(CAMERA_PRESETS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pill";
    b.style.setProperty("--w", "3");
    b.role = "menuitemradio";
    b.dataset.id = id;
    b.textContent = preset.label;
    b.addEventListener("click", () => {
      choosePreset(id);
      toggleViewMenu(false);
    });
    viewMenu.append(b);
  }
  viewBtn.addEventListener("click", () => toggleViewMenu());
  document.addEventListener("pointerdown", (e) => {
    if (!viewMenu.hidden && !/** @type {Element} */ (e.target).closest(".menu")) toggleViewMenu(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !viewMenu.hidden) toggleViewMenu(false);
  });
  try {
    choosePreset(localStorage.getItem(VIEW_PREF) ?? "reading", { remember: false });
  } catch {
    choosePreset("reading", { remember: false });
  }

  // Ctrl + scroll (and a trackpad pinch) would zoom the whole interface in a browser:
  // only the 3D camera zooms here.
  window.addEventListener("wheel", (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });

  // Drag and drop anywhere in the window opens the import dialog with the file filled in.
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    dragDepth++;
    $("app").classList.add("dragging");
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) $("app").classList.remove("dragging");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("app").classList.remove("dragging");
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      toast(`${file.name} is not a PDF.`);
      return;
    }
    rememberDroppedFile(file);
    startImport({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  });

  try {
    const saved = localStorage.getItem(BACKGROUND_PREF);
    if (saved && /^#[0-9a-f]{6}$/i.test(saved)) setBackground(saved, false);
  } catch {
    // no storage: fine
  }

  // The performance check (probe.js): Cmd/Ctrl+Shift+P with a document open.
  let probing = false;
  document.addEventListener("keydown", async (e) => {
    if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.code !== "KeyP" || !state.analysis || probing) return;
    e.preventDefault();
    probing = true;
    try {
      const report = await runProbe(scene, (step) => toast(`Performance check: ${step.trim()}`, "info"));
      toast("Performance check: done", "info");
      reportDialog("Performance check", report);
    } catch (err) {
      toast(`Performance check failed: ${err.message}`);
    } finally {
      probing = false;
    }
  });

  setInterval(showFrameStats, 250);
}
