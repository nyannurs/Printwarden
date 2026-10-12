// Colour management: which CMYK profile the pages are rendered with (see pdf/icc.js). The one
// last chosen, for every file until another is; until one is, the PDF's output intent if it has
// one, else the computer's best match.

import { openForRendering } from "../pdf/load.js";
import { createRenderer } from "../pdf/render.js";
import { listCmykProfiles, readProfile } from "../platform.js";
import { filmstrip, inspector, scene, state } from "./app.js";
import { forgetThumbnails, loadAllTextures } from "./pages.js";
import { applySpine, renderSpineArt } from "./spine-panel.js";

const PROFILE_PREF = "cmykProfile"; // remembered choice (localStorage)

// The app ships no profile of its own (none it may pass on): the default is the computer's
// closest to offset printing on coated paper as Europe's presets have it (FOGRA39, what
// InDesign's Europe settings use), then its successor, then any coated one, then any.
const PREFERRED = [/ISO ?Coated v2/i, /FOGRA ?39/i, /PSO Coated v3|FOGRA ?51/i, /(?<!un)coated/i];

/** The installed profile to start with: the first of PREFERRED found, else the first listed. */
function bestInstalled(installed) {
  for (const re of PREFERRED) {
    const hit = installed.find((p) => re.test(p.name));
    if (hit) return hit;
  }
  return installed[0] ?? null;
}

/**
 * The CMYK profiles to choose from, and the one to start with: the profile last chosen,
 * whatever the file (it sticks until another is chosen: the author, 2026-10-12); "From PDF"
 * chosen, or nothing yet, the PDF's output intent (what Acrobat uses) where it has one; else
 * the best installed one (bestInstalled), else pdf.js's own. Every CMYK profile installed on
 * the computer is offered.
 */
export async function colourOptions(outputIntent) {
  const options = [];
  if (outputIntent) options.push({ id: "intent", name: `From PDF: ${outputIntent.name}`, bytes: outputIntent.profile });
  const installed = await listCmykProfiles().catch(() => []);
  for (const p of installed) options.push({ id: `system:${p.path}`, name: p.name, path: p.path });
  options.push({ id: "builtin", name: "Built-in: US coated (GRACoL)" });
  let pref = null;
  try {
    pref = localStorage.getItem(PROFILE_PREF);
  } catch {
    // no storage: fine
  }
  const has = (id) => options.some((o) => o.id === id);
  const best = bestInstalled(installed);
  const fallback = best ? `system:${best.path}` : "builtin";
  const choice = pref !== "intent" && has(pref) ? pref : outputIntent ? "intent" : fallback;
  return { options, choice };
}

export async function profileBytes(colour, id) {
  const o = colour.options.find((x) => x.id === id);
  if (!o) return null;
  if (o.bytes) return o.bytes;
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
  const bytes = state.bytes;
  const rendererReady = createRenderer(bytes, () => openForRendering(bytes), profileBytes(state.colour, id));
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
