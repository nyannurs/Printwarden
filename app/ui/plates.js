// Separations, as Acrobat's Output Preview has them: which of the press's plates print,
// switched on and off live, to check overprint and what each ink carries. A button under Video
// opens a small window to its left, in the manner of a dropdown's open list: a row per plate with
// its ink's circle and name; a click prints the plate or leaves it out. Process plates switches
// the four at once; the document's spot colours follow, a row each, once the renderer has listed
// them. A process plate is switched where the inks are shown (setPlates in colour.js): every page
// is its inks, and a plate left out is ink that isn't there, from the next frame, raster images
// included. A spot plate left out is left out where the pages are drawn: the pages with it are
// drawn again, in the background. The rows are muted until a document's renderer is ready.
// Every plate prints again with a new file.

import { naiveLut, inkToRgb } from "../viewer/inklut.js";
import { state } from "./app.js";
import { setPlates } from "./colour.js";
import { $ } from "./dom.js";

// The process inks on the screen as ISO Coated v2 prints them solid (C 0/159/227, M 229/0/125,
// Y 255/237/0, K 29/29/27): what the circles show.
const PROCESS = [
  { name: "Cyan", color: "#009fe3" },
  { name: "Magenta", color: "#e5007d" },
  { name: "Yellow", color: "#ffed00" },
  { name: "Black", color: "#1d1d1b" },
];

const button = $("plates-btn");
const panel = $("plates-panel");
/** Which process plates print: Cyan, Magenta, Yellow, Black. */
let inkOn = [true, true, true, true];
/** @type {Set<string>} the spot plates left out, by name */
let spotsOff = new Set();
/** @type {HTMLButtonElement[]} the process rows (Process plates first), then a row a spot */
const rows = [];
/** @type {{name: string, row: HTMLButtonElement}[]} */
let spotRows = [];
let spotsShown = null; // the spot list the rows were made for

function makeRow(name, dot, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "select-item plate-item";
  b.role = "menuitemcheckbox";
  const circle = document.createElement("span");
  circle.className = "plate-dot";
  if (dot) circle.style.setProperty("--plate", dot);
  else circle.classList.add("process");
  const label = document.createElement("span");
  label.textContent = name;
  b.append(circle, label);
  b.addEventListener("click", onClick);
  b.addEventListener("pointerenter", () => mark(b));
  b.addEventListener("pointerleave", () => b.classList.remove("active"));
  panel.append(b);
  rows.push(b);
  return b;
}

/** Build the window's rows and wire the button (once, at startup). */
export function initPlates() {
  makeRow("Process plates", null, () => setInks(inkOn.every(Boolean) ? [false, false, false, false] : [true, true, true, true]));
  PROCESS.forEach((ink, i) => makeRow(ink.name, ink.color, () => setInks(inkOn.map((on, j) => (j === i ? !on : on)))));
  button.addEventListener("click", () => toggle());
  document.addEventListener("pointerdown", (e) => {
    if (!panel.hidden && !/** @type {Element} */ (e.target).closest("#plates-btn, #plates-panel")) toggle(false);
  });
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      toggle(false);
      button.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = rows.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
      rows[(i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
    }
  });
  show();
}

/** The row under the pointer: a lighter black, as a dropdown's. */
function mark(row) {
  for (const r of rows) r.classList.toggle("active", r === row);
}

function toggle(open = panel.hidden) {
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) {
    refreshPlates();
    rows[0].focus();
  }
}

/** Every plate prints again (a new file). */
export function resetPlates() {
  spotsOff = new Set();
  setInks([true, true, true, true]);
}

function setInks(next) {
  inkOn = next;
  setPlates(inkOn, [...spotsOff]);
  show();
}

function toggleSpot(name) {
  if (!spotsOff.delete(name)) spotsOff.add(name);
  setInks(inkOn);
}

/**
 * A row a spot colour of the document (state.spots), after the process plates, made again when
 * the list changes: its circle the spot's look in CMYK, through the profile's ink table.
 */
function syncSpotRows() {
  if (spotsShown !== state.spots) {
    spotsShown = state.spots;
    for (const { row } of spotRows) row.remove();
    rows.length = 1 + PROCESS.length;
    spotRows = state.spots.map((s) => ({ name: s.name, row: makeRow(s.name, "transparent", () => toggleSpot(s.name)) }));
    // A spot left out that this file doesn't have: forgotten.
    for (const name of spotsOff) if (!state.spots.some((s) => s.name === name)) spotsOff.delete(name);
  }
  const lut = state.inkLut ?? naiveLut();
  state.spots.forEach((s, i) => {
    const [r, g, b] = inkToRgb(lut, ...s.cmyk);
    /** @type {HTMLElement} */ (spotRows[i].row.firstChild).style.setProperty("--plate", `rgb(${r} ${g} ${b})`);
  });
}

/**
 * The rows and the button as things are: a row a spot of the document's; a row's circle filled
 * while its plate prints, an outline when it doesn't; muted until the document's renderer is
 * ready. The button inverted while any plate is left out, so it can't be forgotten.
 */
export function refreshPlates() {
  show();
}

function show() {
  syncSpotRows();
  const usable = !!state.renderer;
  rows.forEach((r, i) => {
    const on = i === 0 ? inkOn.every(Boolean)
      : i <= PROCESS.length ? inkOn[i - 1]
      : !spotsOff.has(spotRows[i - 1 - PROCESS.length].name);
    r.setAttribute("aria-checked", String(on));
    r.disabled = !usable;
  });
  button.classList.toggle("on", usable && (!inkOn.every(Boolean) || spotsOff.size > 0));
}
