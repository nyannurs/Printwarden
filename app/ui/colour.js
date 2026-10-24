// Colour management: which CMYK profile the pages are shown with (the ink table the 3D view and
// the timeline read their inks through, see viewer/inklut.js; the renderer's, which RGB content
// is converted into), and which plates print. The profile last chosen, for every file until
// another is; until one is, the PDF's output intent if it has one, else the one included.

import { listCmykProfiles, readProfile } from "../platform.js";
import { naiveLut } from "../viewer/inklut.js";
import { filmstrip, inkView, inspector, scene, state } from "./app.js";
import { redrawInks } from "./pages.js";
import { refreshPlates } from "./plates.js";
import { applySpine, renderSpineArt } from "./spine-panel.js";

const PROFILE_PREF = "cmykProfile"; // remembered choice (localStorage)
let profileRun = 0; // see applyProfile

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
 * Switch profile: the pages' plain CMYK shown through it from the next frame, their RGB content
 * drawn again in the background (applyProfile).
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
 * the next frame; to the renderer, which converts RGB content into it (the inks of a page with
 * RGB images or RGB colours depend on it: every page is drawn again, in the background, each
 * shown as it was until then) and draws the sRGB images through it (the client viewer's pages,
 * the spine artwork). Called once the renderer is ready, and on every change of profile.
 */
export async function applyProfile() {
  const renderer = state.renderer;
  if (!renderer) return;
  // The newest call wins: two switches in quick succession could finish in the other order
  // (reading a profile, making its table), the older table applied last.
  const run = ++profileRun;
  const bytes = await profileBytes(state.colour, state.colour.choice);
  if (run !== profileRun || state.renderer !== renderer) return;
  const id = state.colour.choice;
  if (state.drawn.profile !== id) {
    // (The threads started with the profile chosen then: see startRenderers in app.js.)
    renderer.setProfile(bytes);
    state.drawn = { ...state.drawn, profile: id };
    redrawInks();
  }
  const lut = (await renderer.inkLut(bytes)) ?? naiveLut();
  if (run !== profileRun || state.renderer !== renderer) return; // a newer profile, or another document, since
  state.inkLut = lut;
  scene.setInkLut(lut);
  inkView.setLut(lut);
  // The spots' looks are in the profile (what MuPDF composites them as): asked for again.
  const spots = await renderer.spots();
  if (run !== profileRun || state.renderer !== renderer) return;
  state.spots = spots;
  refreshPlates(); // the rows' circles, and the looks to the views
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
 * Which plates print (the Separations window, ui/plates.js), switched where the inks are shown
 * (the 3D view's shaders, the timeline's converter, the cover's edge colour), from the next
 * frame, on every page at once: nothing is drawn again. The process plates (Cyan, Magenta,
 * Yellow, Black; false leaves one out) and the spots left out (`spotsOff`, by name), which every
 * ink image carries as channels of their own (up to SPOT_CHANNELS a page, see
 * pdf/mupdf-render.js). A page's further spots are composited where it is drawn: the pages with
 * such a spot are drawn again, in the background, each shown as it was until then (redrawInks);
 * so are the sRGB images drawn from then on (the client viewer's).
 * @param {boolean[]} process
 * @param {string[]} [spotsOff]
 */
export function setPlates(process, spotsOff = []) {
  if (!state.bytes) return;
  state.colour = { ...state.colour, inks: process };
  scene.setInksOn(process);
  inkView.setInksOn(process);
  const changed = spotsOff.join("\n") !== state.drawn.spotsOff.join("\n");
  if (changed) state.drawn = { ...state.drawn, spotsOff };
  applySpotInks(); // (and the timeline, the cover's edge)
  if (changed && state.renderer) {
    state.renderer.setSpotsOff(spotsOff);
    if (state.spots.some((s) => s.composited.length)) redrawInks(); // only pages whose stamp changed are drawn
  }
}

/**
 * The spots that print, each with its look (state.spots: in the profile), to everything that
 * shows inks: the 3D view, the timeline, the cover's edge colour.
 */
function applySpotInks() {
  const off = new Set(state.drawn.spotsOff);
  state.spotInks = new Map(state.spots.filter((s) => !off.has(s.name)).map((s) => [s.name, s.cmyk]));
  scene.setSpotInks(state.spotInks);
  inkView.setSpotInks(state.spotInks);
  filmstrip.refreshInk();
  applySpine();
}
