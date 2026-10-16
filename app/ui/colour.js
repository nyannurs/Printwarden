// Colour management: which CMYK profile the pages are rendered with (see pdf/icc.js). The one
// last chosen, for every file until another is; until one is, the PDF's output intent if it has
// one, else the one included.

import { listCmykProfiles, readProfile } from "../platform.js";
import { filmstrip, inspector, scene, startRenderers, state } from "./app.js";
import { forgetThumbnails, loadAllTextures } from "./pages.js";
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
  options.push({ id: "builtin", name: "Built-in: US coated (GRACoL)" });
  let pref = null;
  try {
    pref = localStorage.getItem(PROFILE_PREF);
  } catch {
    // no storage: fine
  }
  const has = (id) => options.some((o) => o.id === id);
  const choice = pref !== "intent" && has(pref) ? pref : outputIntent ? "intent" : INCLUDED_PROFILE.id;
  return { options, choice };
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

/** Switch profile: restart the renderer and re-render every page (old images stay until then). */
export async function setColourProfile(id) {
  if (!state.bytes || id === state.colour.choice) return;
  state.colour = { ...state.colour, choice: id };
  try {
    localStorage.setItem(PROFILE_PREF, id); // "intent" too: then every file's own, where it has one
  } catch {
    // no storage: fine
  }
  const old = state.renderer;
  const rendererReady = startRenderers({ bytes: state.bytes, cover: state.cover }, profileBytes(state.colour, id));
  state.rendererReady = rendererReady;
  state.renderer = null;
  rendererReady.then((r) => {
    if (state.rendererReady === rendererReady) state.renderer = r;
    else r.destroy();
    old?.destroy();
  });
  for (const folio of [...state.details.keys()]) scene.setPageDetails(folio, []);
  state.details.clear();
  inspector.render(state.analysis, state.name, state.colour);
  state.generation++;
  state.stripKey = ""; // timeline thumbnails re-render in the new colours
  forgetThumbnails();
  // Spine artwork is rendered with the profile too.
  const art = state.spineArt;
  if (art) {
    renderSpineArt(art).then((image) => {
      if (state.spineArt !== art) return image.close();
      art.image.close();
      art.image = image;
      applySpine();
    }, (err) => console.error(err));
  }
  filmstrip.render(state.analysis, state.analysis.geometry.find(Boolean)?.size ?? { width: 148, height: 210 });
  filmstrip.setActive(scene.opening);
  loadAllTextures();
}
