// Separations, as Acrobat's Output Preview has them: which of the press's plates print,
// switched on and off live, to check overprint and what each ink carries. A button under Video
// opens a small window to its left, in the manner of a dropdown's open list: a row per plate with
// its ink's circle and name; a click prints the plate or leaves it out. Process plates switches
// the four at once. The drawing is the renderer's (setPlatesEngine): every page, raster images
// included, wholly in the plates that print. Without an engine that has plates (pdf.js has
// none: MuPDF's renderer brings them, see CONTEXT.md, Decisions) the rows are muted. Every
// plate prints again with a new file.

import { $ } from "./dom.js";

/**
 * What draws the plates: whether the document has any now, and the plates to print (by plate:
 * Cyan, Magenta, Yellow, Black, then the page's spots; false leaves one out). None yet.
 * @type {{canSeparate: () => boolean, setInks: (inkOn: boolean[]) => void} | null}
 */
let engine = null;

/** The renderer that draws the plates, or null (the window muted). */
export function setPlatesEngine(next) {
  engine = next;
  show();
}

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
const rows = [];

/** Build the window's rows and wire the button (once, at startup). */
export function initPlates() {
  const row = (name, dot, onClick) => {
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
  };
  row("Process plates", null, () => setInks(inkOn.every(Boolean) ? [false, false, false, false] : [true, true, true, true]));
  PROCESS.forEach((ink, i) => row(ink.name, ink.color, () => setInks(inkOn.map((on, j) => (j === i ? !on : on)))));
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
  setInks([true, true, true, true]);
}

function setInks(next) {
  inkOn = next;
  engine?.setInks([...inkOn, true, true, true, true]); // spots always print
  show();
}

/**
 * The rows and the button as things are: a row's circle filled while its plate prints, an outline
 * when it doesn't; muted when the document has no plates (no engine, or Overprint ignored). The
 * button inverted while any plate is left out, so it can't be forgotten.
 */
export function refreshPlates() {
  show();
}

function show() {
  const usable = !!engine?.canSeparate();
  rows.forEach((r, i) => {
    const on = i === 0 ? inkOn.every(Boolean) : inkOn[i - 1];
    r.setAttribute("aria-checked", String(on));
    r.disabled = !usable;
  });
  button.classList.toggle("on", usable && !inkOn.every(Boolean));
}
