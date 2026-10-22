// Colour management: which CMYK profile the pages are shown with (the ink table the 3D view and
// the timeline read their inks through, see viewer/inklut.js; the renderer's, for sRGB images),
// and which plates print. The profile last chosen, for every file until another is; until one
// is, the PDF's output intent if it has one, else the one included.

import { listCmykProfiles, readProfile } from "../platform.js";
import { naiveLut } from "../viewer/inklut.js";
import { filmstrip, inkView, inspector, scene, state } from "./app.js";
import { applySpine, renderSpineArt } from "./spine-panel.js";

const PROFILE_PREF = "cmykProfile"; // remembered choice (localStorage)

// Shipped with the app by the European Color Initiative's permission (see vendor/icc/README.txt):
// the default everywhere, so colours look the same on every computer, whatever is installed.
const INCLUDED_PROFILE = { id: "included", name: "ISO Coated v2 (ECI)", url: "vendor/icc/ISOcoated_v2_eci.icc" };

/**
 * The CMYK profiles to choose from, and the one to start with: the profile last chosen,
 * whatever the file (it sticks until another is chosen: the author, 2026-10-12); "From PDF"
 * chosen, or nothing yet, the PDF's output intent (what Acrobat uses) where it has one; else
 * ISO Coated v2 (ECI), which ships with the app. Every CMYK profile installed on the computer
 * is offered too.
 */
export async function colourOptions(outputIntent) {
  const options = [];
  if (outputIntent) options.push({ id: "intent", name: `From PDF: ${outputIntent.name}`, bytes: outputIntent.profile });
  options.push({ id: INCLUDED_PROFILE.id, name: `Included: ${INCLUDED_PROFILE.name}`, url: INCLUDED_PROFILE.url });
  for (const p of await listCmykProfiles().catch(() => [])) {
    if (p.name === INCLUDED_PROFILE.name) continue; // the same profile, installed: listed once
    options.push({ id: `system:${p.path}`, name: p.name, path: p.path });
  }
  options.push({ id: "builtin", name: "Built-in: MuPDF's own CMYK" }); // no profile handed over: MuPDF's default
  let pref = null;
  try {
    pref = localStorage.getItem(PROFILE_PREF);
  } catch {
    // no storage: fine
  }
  const has = (id) => options.some((o) => o.id === id);
  const choice = pref !== "intent" && has(pref) ? pref : outputIntent ? "intent" : INCLUDED_PROFILE.id;
  return { options, choice, inks: [true, true, true, true] };
}

export async function profileBytes(colour, id) {
  const o = colour.options.find((x) => x.id === id);
  if (!o) return null;
  if (o.bytes) return o.bytes;
  if (o.url) {
    const response = await fetch(o.url);
    if (!response.ok) throw new Error(`${o.name} is missing from the app (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
  if (o.path) return readProfile(o.path);
  return null;
}

/**
 * Switch profile. Nothing is drawn again: the pages are their inks, and the profile is the ink
 * table they are shown through (applyProfile).
 */
export async function setColourProfile(id) {
  if (!state.bytes || id === state.colour.choice) return;
  state.colour = { ...state.colour, choice: id };
  try {
    localStorage.setItem(PROFILE_PREF, id); // "intent" too: then every file's own, where it has one
  } catch {
    // no storage: fine
  }
  await applyProfile();
}

/**
 * The chosen profile applied: as the ink table (viewer/inklut.js, made by MuPDF), to the 3D
 * view, the timeline and the cover's edge colour, which show every page's inks through it from
 * the next frame; to the renderer, for the sRGB images it draws (the client viewer's pages, the
 * spine artwork). Called once the renderer is ready, and on every change of profile.
 */
export async function applyProfile() {
  const renderer = state.renderer;
  if (!renderer) return;
  const bytes = await profileBytes(state.colour, state.colour.choice);
  renderer.setProfile(bytes);
  const lut = (await renderer.inkLut(bytes)) ?? naiveLut();
  if (state.renderer !== renderer) return; // another document since
  state.inkLut = lut;
  scene.setInkLut(lut);
  inkView.setLut(lut);
  filmstrip.refreshInk();
  inspector.render(state.analysis, state.name, state.colour);
  applySpine(); // the covers' edge colours come through the table
  // Spine artwork is an sRGB image, drawn through the profile.
  const art = state.spineArt;
  if (art) {
    renderSpineArt(art).then((image) => {
      if (state.spineArt !== art) return image.close();
      art.image.close();
      art.image = image;
      applySpine();
    }, (err) => console.error(err));
  }
}

/**
 * Which plates print (the Separations window, ui/plates.js): by plate, Cyan, Magenta, Yellow,
 * Black, then a page's spots; false leaves one out. A process plate is switched where the inks
 * are shown (the 3D view's shaders, the timeline's converter, the cover's edge colour), from
 * the next frame, on every page at once: nothing is drawn again. (A spot left out would be: the
 * window has the process plates only, spots always print.)
 * @param {boolean[]} inkOn
 */
export function setPlates(inkOn) {
  if (!state.bytes) return;
  const process = inkOn.slice(0, 4);
  state.colour = { ...state.colour, inks: process };
  scene.setInksOn(process);
  inkView.setInksOn(process);
  filmstrip.refreshInk();
  applySpine();
  if (inkOn.slice(4).includes(false)) state.renderer?.setInks(inkOn); // a spot left out: drawn again without it
}
