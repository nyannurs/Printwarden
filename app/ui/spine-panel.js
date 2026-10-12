// The book's spine: its colour (a preset, a cover's edge, or any) or artwork from a PDF, and
// the panel where they are chosen, with the spine's width.

import { coverOf } from "../core/paper.js";
import { calculatedSpine, coverMmFor, hasSpine, paperForSpine, spineTakesArtwork } from "../core/spine.js";
import { openPdf } from "../pdf/load.js";
import { renderOnce } from "../pdf/render.js";
import { pickPdf } from "../platform.js";
import { scene, state, updateSetup } from "./app.js";
import { profileBytes } from "./colour.js";
import { spinePanel } from "./dialogs.js";
import { toast } from "./dom.js";

/** Spine colour presets: sampled from each cover's spine edge, white, black. */
function spinePresets() {
  return [
    { id: "front", label: "From the front cover", hex: coverEdge("front") },
    { id: "back", label: "From the back cover", hex: coverEdge("back") },
    { id: "#ffffff", label: "White", hex: "#ffffff" },
    { id: "#1f2023", label: "Black", hex: "#1f2023" },
  ];
}

/**
 * The colour along a cover's spine edge (its image, as printed on the paper colour), or
 * null until the page is rendered. The front cover's spine edge is its left; the back
 * cover's (the back of the last leaf) its right. An odd page count has a blank back cover.
 */
function coverEdge(which) {
  const n = state.analysis?.book.pages.length ?? 0;
  const folio = which === "front" ? 1 : n % 2 === 0 ? n : null;
  const paper = coverOf(state.setup.paper).color; // the covers' stock
  if (!folio) return paper;
  const t = state.textures.get(folio);
  if (!t) return null;
  if (!t.edge) return paper; // a blank cover
  const p = [1, 3, 5].map((i) => parseInt(paper.slice(i, i + 2), 16) / 255);
  return "#" + t.edge.map((v, k) => Math.round(v * p[k]).toString(16).padStart(2, "0")).join("");
}

/** The average colour (0-255) of a page image along its left or right edge. */
export function averageEdge(image, left) {
  const h = 64;
  const w = Math.max(8, Math.round((image.width * h) / image.height));
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(image, 0, 0, w, h);
  const cols = Math.max(1, Math.round(w * 0.03));
  const d = g.getImageData(left ? 0 : w - cols, Math.round(h * 0.08), cols, Math.round(h * 0.84)).data;
  const sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
  return sum.map((v) => v / (d.length / 4));
}

/** The colour the spine shows (without artwork). */
function spineColour() {
  const c = state.setup.spine.color;
  return c === "front" || c === "back" ? coverEdge(c) ?? coverOf(state.setup.paper).color : c;
}

/** Show the spine as set: artwork on glued and sewn spines if imported, else the colour. */
export function applySpine(previewColour = null) {
  if (!state.analysis) return;
  const art = spineTakesArtwork(state.setup.binding) ? state.spineArt : null;
  const paper = coverOf(state.setup.paper).color;
  scene.setSpine({
    color: previewColour ?? spineColour(),
    artwork: art ? spineFace(art.image, state.setup.spine.rotation) : null,
    // Where the covers wrap onto the spine, each shows its own colour there.
    frontEdge: coverEdge("front") ?? paper,
    backEdge: coverEdge("back") ?? paper,
  });
}

/**
 * The artwork as the spine face shows it: turned by quarter turns (each clockwise as you
 * look at the spine), and mirrored left to right, because the face's texture runs from the
 * front cover's side to the back's, the opposite of the artwork. (Checked with four
 * coloured corners: the artwork's top at the head, its right edge against the front cover,
 * as on a book standing on a shelf.)
 */
let face = null; // {image, quarters, canvas}: the last face drawn (the same one shows until either changes)

function spineFace(image, quarters) {
  if (face?.image === image && face.quarters === quarters) return face.canvas;
  const turned = quarters % 2 === 1;
  const canvas = document.createElement("canvas");
  canvas.width = turned ? image.height : image.width;
  canvas.height = turned ? image.width : image.height;
  const g = canvas.getContext("2d");
  g.translate(canvas.width / 2, canvas.height / 2);
  g.scale(-1, 1);
  g.rotate((quarters * Math.PI) / 2); // mirrored: turns clockwise as seen on the spine
  g.drawImage(image, -image.width / 2, -image.height / 2);
  face = { image, quarters, canvas };
  return canvas;
}

/** Spine artwork from a PDF (its first page's trim box), rendered like the book's pages. */
export async function importSpineArt(file = null) {
  file ??= await pickPdf();
  if (!file) return;
  try {
    const { pages } = await openPdf(file.bytes);
    if (!pages.length) throw new Error("This PDF has no pages.");
    const box = pages[0].trimBox ?? pages[0].mediaBox;
    const art = { name: file.name, bytes: file.bytes, box, sizeMm: { width: box.x1 - box.x0, height: box.y1 - box.y0 } };
    art.image = await renderSpineArt(art);
    // Only now, with the new one ready, does it replace any artwork shown so far.
    state.spineArt?.image?.close();
    state.spineArt = art;
    // Laid out lying down (wider than tall): start turned upright. Rotate spine turns it.
    state.setup.spine.rotation = art.sizeMm.width > art.sizeMm.height ? 1 : 0;
    applySpine();
  } catch (err) {
    console.error(err);
    toast(`Couldn't use ${file.name} as the spine: ${err.message}`, "error");
  }
  spine?.refresh();
}

/** Render spine artwork: at most 2400 px along its long side, with the current CMYK profile. */
export async function renderSpineArt(art) {
  const { width, height } = art.sizeMm;
  const px = Math.round(height >= width ? 2400 : (2400 * height) / width);
  const profile = await profileBytes(state.colour, state.colour.choice);
  return renderOnce(art.bytes, 0, art.box, px, profile);
}

let spine = null; // the open spine panel, if any

export function openSpinePanel() {
  if (spine) return spine.focus();
  spine = spinePanel({
    info: () => {
      const a = state.analysis;
      const s = state.setup;
      const calc = calculatedSpine(a.book.pages.length, s.paper, s.binding);
      const coverMm = coverMmFor(s.binding, s.paper);
      return {
        binding: s.binding,
        takesArtwork: spineTakesArtwork(s.binding),
        pages: a.book.pages.length,
        calc,
        widthMm: s.spine.widthMm,
        widthValid: !s.spine.widthMm || !!paperForSpine(s.spine.widthMm, a.book.pages.length, coverMm),
        heightMm: a.setup.page.height,
        bleedMm: a.setup.page.bleed,
        paper: s.paper,
        artwork: state.spineArt && { name: state.spineArt.name, sizeMm: state.spineArt.sizeMm },
        color: s.spine.color,
        presets: spinePresets(),
      };
    },
    setWidth: (mm) => updateSetup({ spine: { ...state.setup.spine, widthMm: mm } }),
    importArtwork: () => importSpineArt(),
    removeArtwork: () => {
      state.spineArt?.image?.close();
      state.spineArt = null;
      applySpine();
      spine?.refresh();
    },
    rotate: () => {
      state.setup.spine.rotation = /** @type {0 | 1 | 2 | 3} */ ((state.setup.spine.rotation + 1) % 4);
      applySpine();
    },
    previewColour: (hex) => applySpine(hex),
    setColour: (value) => {
      state.setup.spine.color = value;
      applySpine();
      spine?.refresh();
    },
    onClose: () => {
      spine = null;
    },
  });
}

/** The spine panel, if open, after the setup changed: shown again, or closed if the binding has no spine. */
export function updateSpinePanel(binding) {
  if (hasSpine(binding)) spine?.refresh();
  else spine?.close();
}
