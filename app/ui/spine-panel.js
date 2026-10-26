// The book's spine: its colour (a preset, a cover's edge, or any) or artwork from a PDF, and
// the panel where they are chosen, with the spine's width.

import { inkToRgb, mixInks, naiveLut } from "../viewer/inklut.js";
import { coverOf } from "../core/paper.js";
import { calculatedSpine, coverMmFor, hasSpine, paperForSpine, spineTakesArtwork } from "../core/spine.js";
import { openPdf } from "../pdf/load.js";
import { mipChain } from "../pdf/mips.js";
import { openOne, renderOnce } from "../pdf/render.js";
import { SPINE_FOLIO } from "../viewer/tiles.js";
import { pickPdf } from "../platform.js";
import { scene, state, updateSetup } from "./app.js";
import { profileBytes, spotsChanged } from "./colour.js";
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
 * The colour along a cover's spine edge (its inks there, through the ink table with the plates
 * that print, on the paper colour), or null until the page is rendered. The front cover's spine
 * edge is its left; the back cover's (the back of the last leaf) its right. An odd page count
 * has a blank back cover.
 */
function coverEdge(which) {
  const n = state.analysis?.book.pages.length ?? 0;
  const folio = which === "front" ? 1 : n % 2 === 0 ? n : null;
  const paper = coverOf(state.setup.paper).color; // the covers' stock
  if (!folio) return paper;
  const t = state.textures.get(folio);
  if (!t) return null;
  if (!t.edge) return paper; // a blank cover
  const [c, m, y, k] = mixInks(t.edge.inks, t.edge.spots, t.edge.spotNames, state.colour.inks ?? [], state.spotInks);
  const rgb = inkToRgb(state.inkLut ?? naiveLut(), c, m, y, k);
  const p = [1, 3, 5].map((i) => parseInt(paper.slice(i, i + 2), 16) / 255);
  return "#" + rgb.map((v, i) => Math.round(v * p[i]).toString(16).padStart(2, "0")).join("");
}

/**
 * The average inks of a page along its left or right edge (an ink image, see
 * pdf/mupdf-render.js): Cyan, Magenta, Yellow, Black and its spot channels' tints, 0..1, and
 * which spot each channel is (mixed with the plates as they are by mixInks).
 * @returns {{inks: number[], spots: number[], spotNames: string[]}}
 */
export function averageEdge(image, left) {
  const { width: w, height: h, data, spots } = image;
  const cols = Math.max(1, Math.round(w * 0.03));
  const x0 = left ? 0 : w - cols;
  const y0 = Math.round(h * 0.08);
  const y1 = Math.round(h * 0.92);
  const sum = [0, 0, 0, 0, 0, 0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x0 + cols; x++) {
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) sum[k] += data[o + k];
      if (spots) for (let k = 0; k < 4; k++) sum[4 + k] += spots[o + k];
      n++;
    }
  }
  const mean = sum.map((v) => v / Math.max(1, n) / 255);
  return { inks: mean.slice(0, 4), spots: mean.slice(4), spotNames: image.spotNames ?? [] };
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
    turn: state.setup.spine.rotation,
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
 * as on a book standing on a shelf.) The artwork is its inks (as the pages are, so the plates
 * and the profile change it with them), turned texel by texel, with its smaller copies.
 */
let face = null; // {image, quarters, out}: the last face made (the same one shows until either changes)

function spineFace(image, quarters) {
  if (face?.image === image && face.quarters === quarters) return face.out;
  const { width: w, height: h } = image;
  const turned = quarters % 2 === 1;
  const W = turned ? h : w;
  const H = turned ? w : h;
  // Where texel (x, y) goes: as a canvas mirrored and then turned would draw it.
  const to = [
    (x, y) => [w - 1 - x, y],
    (x, y) => [y, x],
    (x, y) => [x, h - 1 - y],
    (x, y) => [h - 1 - y, w - 1 - x],
  ][((quarters % 4) + 4) % 4];
  const turn = (src) => {
    if (!src) return null;
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [X, Y] = to(x, y);
        const a = (y * w + x) * 4, b = (Y * W + X) * 4;
        out[b] = src[a]; out[b + 1] = src[a + 1]; out[b + 2] = src[a + 2]; out[b + 3] = src[a + 3];
      }
    }
    return out;
  };
  const data = turn(image.data);
  const spots = turn(image.spots);
  const levels = Math.floor(Math.log2(Math.max(W, H)));
  const out = { width: W, height: H, data, spots, spotNames: image.spotNames ?? [],
    mips: mipChain(data, W, H, levels), spotMips: spots ? mipChain(spots, W, H, levels) : undefined };
  face = { image, quarters, out };
  return out;
}

/**
 * The spine's artwork as a picture, turned as it shows (the client viewer's: sRGB, as printed),
 * or null without any.
 * @returns {Promise<HTMLCanvasElement | null>}
 */
export async function spineArtPicture() {
  const art = spineTakesArtwork(state.setup.binding) ? state.spineArt : null;
  if (!art) return null;
  const { width, height } = art.sizeMm;
  const px = Math.round(height >= width ? 2400 : (2400 * height) / width);
  const image = await renderOnce(art.bytes, 0, art.box, px, await profileBytes(state.colour, state.colour.choice));
  const quarters = state.setup.spine.rotation;
  const turned = quarters % 2 === 1;
  const canvas = document.createElement("canvas");
  canvas.width = turned ? image.height : image.width;
  canvas.height = turned ? image.width : image.height;
  const g = canvas.getContext("2d");
  g.translate(canvas.width / 2, canvas.height / 2);
  g.scale(-1, 1);
  g.rotate((quarters * Math.PI) / 2); // mirrored: turns clockwise as seen on the spine
  g.drawImage(image, -image.width / 2, -image.height / 2);
  image.close();
  return canvas;
}

/** Spine artwork from a PDF (its first page's trim box), rendered like the book's pages. */
export async function importSpineArt(file = null) {
  file ??= await pickPdf();
  if (!file) return;
  let art = null;
  try {
    const { pages } = await openPdf(file.bytes);
    if (!pages.length) throw new Error("This PDF has no pages.");
    const box = pages[0].trimBox ?? pages[0].mediaBox;
    art = { name: file.name, bytes: file.bytes, box, sizeMm: { width: box.x1 - box.x0, height: box.y1 - box.y0 } };
    Object.assign(art, await renderSpineArt(art));
    // Only now, with the new one ready, does it replace any artwork shown so far.
    setSpineArt(art);
    // Laid out lying down (wider than tall): start turned upright. Rotate spine turns it.
    state.setup.spine.rotation = art.sizeMm.width > art.sizeMm.height ? 1 : 0;
    applySpine();
  } catch (err) {
    console.error(err);
    if (art && state.spineArt !== art) art.pool?.destroy();
    toast(`Couldn't use ${file.name} as the spine: ${err.message}`, "error");
  }
  spine?.refresh();
}

/**
 * Render spine artwork: at most 2400 px along its long side (its base image: its sharp tiles
 * come as the view needs them, as the pages' do, see ui/tiles.js), its inks in the current CMYK
 * profile (drawn through the ink table as the pages are: the plates switch it too), and its
 * spot colours with their looks. Its PDF stays open in a thread of its own for the tiles
 * (`art.pool`, ended by setSpineArt when the artwork goes).
 * @returns {Promise<{image: any, spots: {name: string, cmyk: number[]}[]}>}
 */
export async function renderSpineArt(art) {
  const { width, height } = art.sizeMm;
  const px = Math.round(height >= width ? 2400 : (2400 * height) / width);
  const profile = await profileBytes(state.colour, state.colour.choice);
  if (!art.pool) art.pool = await openOne(art.bytes, profile);
  else art.pool.setProfile(profile);
  art.profile = state.colour.choice; // what its tiles are drawn with from now (their stamp, ui/tiles.js)
  const image = await art.pool.render(0, art.box, px, 0, { cache: false, mode: "ink" });
  return { image, spots: await art.pool.spots() };
}

/**
 * The spine artwork drawn again `heightPx` tall (its height on the artwork's page) for a
 * capture (ui/capture.js), shown in place of its base image, its tiles off. Resolves to what
 * puts the screen's back (null: no artwork on the spine).
 * @returns {Promise<(() => void) | null>}
 */
export async function spineAt(heightPx) {
  const art = spineTakesArtwork(state.setup.binding) ? state.spineArt : null;
  if (!art?.pool || !art.image) return null;
  const image = await art.pool.render(0, art.box, Math.round(heightPx), 0, { cache: false, mode: "ink" });
  if (!image) return null;
  const base = art.image;
  art.image = image;
  applySpine();
  scene.setSpineTiles(false);
  return () => {
    art.image = base;
    applySpine();
    scene.setSpineTiles(true);
    image.close?.();
  };
}

/**
 * The spine artwork shown from now (or none): the one before let go, its thread and its
 * tiles; the spot colours listed again (it may have its own).
 */
export function setSpineArt(art) {
  const old = state.spineArt;
  if (old && old !== art) {
    old.pool?.destroy();
    scene.forgetTiles(SPINE_FOLIO);
  }
  state.spineArt = art;
  spotsChanged();
}

let spine = null; // the open spine panel, if any

export function openSpinePanel() {
  if (spine) return spine.focus();
  spine = spinePanel({
    info: () => {
      const a = state.analysis;
      const s = state.setup;
      const calc = calculatedSpine(a.book.pages.length, s.paper, s.binding, s.boardMm);
      const coverMm = coverMmFor(s.binding, s.paper, s.boardMm);
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
      setSpineArt(null); // its own spots go with it
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
