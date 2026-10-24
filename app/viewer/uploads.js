// The pages' images to the GPU: their base images (setPageTexture, spread over frames), an image
// shown for now instead (a video's), a capture's sharp strips, and the tiles (tiles.js) bound to
// each page's material as their tables come; with each page, its spot channels and the spot
// matrix that mixes them in (spotInk). Functions of the scene (scene.js); the textures are kept
// through rebuilds of the book (scene.pageTextures, overrides).

import * as THREE from "three";
import { MAX_DETAIL } from "./shaders.js";
import { disposeTexture, freeImage, makeInkTexture, makeWarmer } from "./textures.js";

const UPLOADS_PER_FRAME = 2;
const TILES_PER_FRAME = 3; // tiles to the GPU a frame (5.5 MB each with its mips: a frame at 130 Hz takes about three)
// Page images are filtered as stored (sRGB values) and only then turned into light: type
// keeps its weight, the way browsers and Acrobat antialias it. Filtered as light, the grey
// edge pixels of dark type on white come out too light, and text looks thin and grey.
const PAGE_COLOR_SPACE = THREE.NoColorSpace;

/** Forget every page's image and tiles (a new file). */
export function clearPages(scene) {
  for (const { image } of scene.uploads.values()) image?.close();
  scene.uploads.clear();
  for (const tex of [...scene.pageTextures.values(), ...scene.overrides.values()]) tex.dispose();
  scene.pageTextures.clear();
  scene.overrides.clear();
  scene.tiles.reset();
  scene.spotNames.clear();
  showAllPages(scene);
}

/**
 * A page's tiles (its table and its pyramid's shape) on its material; none, the empty table.
 * A page showing an image for now (a video's, showPageImage) shows that: it was rendered for
 * the frame, and tiles kept from the view may be coarser.
 */
export function bindTiles(scene, folio) {
  const leaf = scene.leaves[Math.ceil(folio / 2) - 1];
  if (!leaf) return;
  const u = (folio % 2 ? leaf.front : leaf.back).userData.uniforms;
  const t = scene.overrides.has(folio) ? null : scene.tiles.pageUniforms(folio);
  u.uTileTable.value = t?.table ?? scene.tiles.emptyTable;
  if (t) u.uTilePage.value.fromArray(t.page);
  u.uTileOn.value = t ? 1 : 0;
}

/**
 * The pages numbered anew (`map`: old folio -> new; ui/pages.js carryPages): their images on the
 * GPU, those on their way, their spot channels' names and their tiles go with them, and are shown
 * where they now are. A page not in `map` is let go.
 * @param {Map<number, number>} map
 */
export function renumberPages(scene, map) {
  const move = (m, free) => {
    const out = new Map();
    for (const [folio, v] of m) {
      if (map.has(folio)) out.set(map.get(folio), v);
      else free(v);
    }
    return out;
  };
  scene.pageTextures = move(scene.pageTextures, (tex) => tex.dispose());
  scene.overrides = move(scene.overrides, (tex) => tex.dispose());
  scene.uploads = move(scene.uploads, ({ image }) => image?.close());
  scene.spotNames = move(scene.spotNames, () => {});
  scene.tiles.renumber(map);
  showAllPages(scene);
  scene.dirty = true;
}

/** A page's tiles let go (its image changed: ui/pages.js). */
export function forgetTiles(scene, folio) {
  scene.tiles.forgetPage(folio);
  bindTiles(scene, folio);
  scene.dirty = true;
}

/**
 * Put textures on the GPU now, as they arrive, and draw from each once (into a single
 * pixel nobody sees): graphics drivers finish taking a texture in only when it is first
 * drawn from, and pages first shown mid-turn (flipping through a document just opened)
 * cost 30-70 ms frames.
 */
function warm(scene, ...textures) {
  const w = (scene.warmer ??= makeWarmer());
  const r = scene.renderer;
  const before = r.getRenderTarget();
  r.setRenderTarget(w.target);
  for (const t of textures.flatMap((t) => (t.userData.spots ? [t, t.userData.spots] : [t]))) { // an ink image's spots with it
    r.initTexture(t);
    const m = t.type === THREE.UnsignedIntType ? w.uint : w.float;
    m.uniforms.uTex.value = t;
    w.quad.material = m;
    r.render(w.scene, w.camera);
  }
  r.setRenderTarget(before);
}

/**
 * A page's image (an ImageBitmap, or null for plain paper). Uploads are spread over frames,
 * so a burst of finished renders never stutters. The scene takes the image: once it is on
 * the GPU it is freed from memory, and the texture is kept through rebuilds of the book.
 */
export function setPageTexture(scene, folio, image) {
  const waiting = scene.uploads.get(folio);
  if (waiting?.image && waiting.image !== image) waiting.image.close(); // replaced before it went up
  scene.uploads.set(folio, { image });
  scene.dirty = true;
}

/**
 * Show `image` on a page for now instead of its own (a video's sharper pages), or its own
 * again (null). Not taken: the caller frees it, after.
 */
export function showPageImage(scene, folio, image) {
  disposeTexture(scene.overrides.get(folio), scene.blank);
  if (image) scene.overrides.set(folio, pageTexture(scene, image));
  else scene.overrides.delete(folio);
  showPage(scene, folio);
  bindTiles(scene, folio);
  scene.dirty = true;
}

/** A page image's texture: a page's inks (see textures.js makeInkTexture), or an sRGB image. */
function pageTexture(scene, image) {
  if (image.data) return makeInkTexture(image, scene.renderer.capabilities.getMaxAnisotropy()); // a page's inks
  const tex = new THREE.Texture(image);
  tex.flipY = false;
  tex.colorSpace = PAGE_COLOR_SPACE;
  tex.anisotropy = scene.renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return tex;
}

/**
 * A page's image on its leaf (one shown for now, else its own, else white), with its spot
 * channels and spot matrix, and through it (the other side's show-through).
 */
export function showPage(scene, folio) {
  const leaf = scene.leaves[Math.ceil(folio / 2) - 1];
  if (!leaf) return;
  const [mat, other] = folio % 2 ? [leaf.front, leaf.back] : [leaf.back, leaf.front];
  const shown = scene.overrides.get(folio);
  mat.map = shown ?? scene.pageTextures.get(folio) ?? scene.blank;
  const u = mat.userData.uniforms;
  u.uSpots.value = mat.map.userData.spots ?? scene.noSpots;
  // The page's own channels: its tiles' too, which may come before its image (an image shown
  // for now is of the same page, but has channels only if it was drawn with them).
  spotInk(scene, (shown ? shown.userData.spotNames : scene.spotNames.get(folio)) ?? [], u.uSpotInk.value);
  const back = other.userData.uniforms;
  back.uBack.value = mat.map; // show-through from this side
  back.uBackSpots.value = u.uSpots.value;
  back.uBackSpotInk.value.copy(u.uSpotInk.value);
}

/**
 * A page's spot matrix (see INK_GLSL): column i, the look in CMYK (0..1) of the spot in its
 * channel i (`names`), from scene.spotInks; nothing for a spot left out (not there), or a
 * channel it hasn't.
 * @param {import("./scene.js").BookScene} scene
 * @param {string[]} names
 * @param {THREE.Matrix4} out
 * @returns {THREE.Matrix4} out
 */
export function spotInk(scene, names, out) {
  const e = out.elements;
  e.fill(0);
  names.forEach((name, i) => {
    const look = i < 4 ? scene.spotInks.get(name) : null;
    if (look) for (let c = 0; c < 4; c++) e[4 * i + c] = look[c];
  });
  return out;
}

/** A spot matrix of nothing (no spot channels, or none printing). */
export const noSpotInk = () => new THREE.Matrix4().fromArray(new Array(16).fill(0));

/**
 * Every page's spot matrix again (the spots that print, or their looks, changed: setSpotInks),
 * the flaps' too: from the next frame, no image is touched.
 * @param {import("./scene.js").BookScene} scene
 */
export function refreshSpots(scene) {
  for (let folio = 1; folio <= 2 * scene.leaves.length; folio++) showPage(scene, folio);
  for (const flap of scene.flaps.values()) {
    const m = /** @type {any} */ (flap.material);
    spotInk(scene, m.map?.userData.spotNames ?? [], m.userData.uniforms.uSpotInk.value);
  }
  scene.dirty = true;
}

/**
 * A tile drawn (see tiles.js TileCache queueTile), its page's spot channels noted: the page's
 * spot matrix is theirs, which the tiles come with as its image does (whichever comes first).
 * @param {import("./scene.js").BookScene} scene
 */
export function queueTile(scene, folio, level, ix, iy, page, tile, stamp) {
  noteSpotNames(scene, folio, tile.spotNames);
  scene.tiles.queueTile(folio, level, ix, iy, page, tile, stamp);
}

function noteSpotNames(scene, folio, names = []) {
  const had = scene.spotNames.get(folio);
  if (had && had.join("\n") === names.join("\n")) return;
  scene.spotNames.set(folio, names);
  showPage(scene, folio);
}

/**
 * A capture's sharp strips of a page (each: an image and its region in texture uv), drawn
 * over its base image and its tiles. Replaces the page's previous strips; pass [] to clear.
 * The images are owned: closed when replaced. `immediate`: on the GPU now (a capture draws
 * no frames between), else one a frame.
 */
export function setPageDetails(scene, folio, strips, { immediate = false } = {}) {
  // Replaces any set still being prepared for this page.
  const pending = scene.detailQueue.get(folio);
  if (pending) {
    for (const tex of pending.textures) disposeTexture(tex, scene.blank);
    for (const s of pending.strips.slice(pending.textures.length)) s.image.close?.();
  }
  scene.detailQueue.set(folio, { strips: strips.slice(0, MAX_DETAIL), textures: [] });
  if (immediate) while (scene.detailQueue.has(folio)) prepareDetails(scene, folio);
  scene.dirty = true;
}

/**
 * Prepare queued detail strips one per frame (upload plus mipmaps is the costly part),
 * then swap a page's whole set in at once: no frame carries the full load.
 */
export function prepareDetails(scene, only = null) {
  for (const [folio, job] of scene.detailQueue) {
    if (only !== null && folio !== only) continue;
    const leaf = scene.leaves[Math.ceil(folio / 2) - 1];
    if (!leaf) {
      for (const s of job.strips) s.image.close?.();
      scene.detailQueue.delete(folio);
      continue;
    }
    if (job.textures.length < job.strips.length) {
      // Exactly as a page's base image goes up (see flushUploads): the same texture, drawn
      // from once before its pixels are let go. (Until 0.17.79 strips had a way of their
      // own, without that first draw.)
      const tex = pageTexture(scene, job.strips[job.textures.length].image);
      tex.userData.owned = true;
      warm(scene, tex);
      freeImage(tex);
      job.textures.push(tex);
      scene.dirty = true;
      return; // one per frame
    }
    const u = (folio % 2 ? leaf.front : leaf.back).userData.uniforms;
    for (let i = 0; i < MAX_DETAIL; i++) {
      disposeTexture(u[`uDetail${i}`].value, scene.blank);
      u[`uDetail${i}`].value = job.textures[i] ?? scene.blank;
      const r = job.strips[i]?.region;
      if (r) u[`uDetailRect${i}`].value.set(r.u0, r.v0, r.u1, r.v1);
    }
    // In at once: strips are a capture's, drawn the moment they are laid. (They faded in over
    // the base image for the view's own strips, until 2026-10-24; a capture draws no frames
    // between, so a screenshot of one tile showed every page's base image.)
    u.uDetailCount.value = job.textures.length;
    scene.detailQueue.delete(folio);
    scene.dirty = true;
    return;
  }
}

// --- textures ------------------------------------------------------------------------

/**
 * The page images waiting (setPageTexture) to the GPU, UPLOADS_PER_FRAME of them: each made a
 * texture, drawn from once (warm), its pixels let go; shown on its page.
 */
export function flushUploads(scene) {
  let n = 0;
  for (const [folio, { image }] of scene.uploads) {
    if (n >= UPLOADS_PER_FRAME) break;
    scene.uploads.delete(folio);
    scene.pageTextures.get(folio)?.dispose();
    scene.pageTextures.delete(folio);
    if (image) {
      const tex = pageTexture(scene, image);
      warm(scene, tex);
      freeImage(tex); // on the GPU now: the image in memory goes
      scene.pageTextures.set(folio, tex);
      scene.spotNames.set(folio, tex.userData.spotNames ?? []);
      n++;
    }
    showPage(scene, folio);
    scene.dirty = true;
  }
}

/**
 * Every page's image and tiles on its leaf (a book just built, or the pages cleared).
 * @param {import("./scene.js").BookScene} scene
 */
export function showAllPages(scene) {
  for (let folio = 1; folio <= 2 * scene.leaves.length; folio++) {
    showPage(scene, folio);
    bindTiles(scene, folio);
  }
}

/**
 * Tiles to the GPU a few a frame (they are small, and the view moving is when they are wanted),
 * each page with new ones given its table; those just up fade in over a few frames.
 * @param {import("./scene.js").BookScene} scene
 * @returns {boolean} whether to draw (tiles went up, or are fading in)
 */
export function flushTiles(scene, time) {
  let changed = false;
  if (scene.tiles.pending) {
    for (const folio of scene.tiles.flush(TILES_PER_FRAME, time)) bindTiles(scene, folio);
    changed = true;
  }
  return scene.tiles.tick(time) || changed;
}

/**
 * Sharp strips still on their way to the GPU let go (they were for the old book's leaves).
 * @param {import("./scene.js").BookScene} scene
 */
export function dropDetails(scene) {
  for (const job of scene.detailQueue.values()) {
    for (const tex of job.textures) disposeTexture(tex, scene.blank);
    for (const s of job.strips.slice(job.textures.length)) s.image.close?.();
  }
  scene.detailQueue.clear();
}
