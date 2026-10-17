// What keeps pages sharp on screen and in videos (0.17.75 to 0.17.80): when a page keeps its
// base image and when sharp strips are made, that strips cover the page to its edges, how a
// video sizes its page images frame by frame, and that strips go to the GPU like any page
// image.

import { baseSuffices, planDetail, videoImageHeight } from "../app/viewer/detail.js";
import { BookScene } from "../app/viewer/scene.js";
import { eq, near, ok, test } from "./harness.js";

const stock = { color: "#ffffff", roughness: 0.85, specular: 0.3, clearcoat: 0, show: 0.1 };
const paper = { ...stock, cover: { ...stock, color: "#d8d0c0" }, thickness: 0.1, coverThickness: 0.3, gsm: 120, finish: "uncoated" };

function makeScene() {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 480px; height: 300px;";
  document.body.append(box);
  return { scene: new BookScene(box), box };
}

/** A flat page filling the screen at `pxPerMm` everywhere: one strip at that density times the supersample. */
const flatView = (pxPerMm) => ({
  region: { u0: 0, v0: 0, u1: 1, v1: 1 },
  samples: Array.from({ length: 12 }, (_, k) => ({ u: (k % 4) / 3, v: Math.floor(k / 4) / 2, pxPerMm })),
});
const pageMm = { width: 148, height: 210 };

test("sharp strips: none while the base image has a pixel for every screen pixel, strips once it hasn't", () => {
  const base = 1345 / 210; // a 1345 px image of a 210 mm page: 6.4 px/mm
  for (const screen of [3, 4.5, 6.4]) {
    const plan = planDetail(flatView(screen), pageMm, { supersample: 1.25 });
    ok(baseSuffices(plan, base, 1.25), `at ${screen} px/mm on screen the base's ${base.toFixed(1)} px/mm is enough`);
  }
  for (const screen of [6.5, 8, 12]) {
    const plan = planDetail(flatView(screen), pageMm, { supersample: 1.25 });
    ok(!baseSuffices(plan, base, 1.25), `at ${screen} px/mm on screen the base is too coarse`);
    // The strips then carry 1.25 image pixels a screen pixel: finer than the base.
    ok(plan.every((t) => t.pxPerMm > base), "every strip is finer than the base");
    near(plan[0].pxPerMm, screen * 1.25, 1e-9);
  }
});

test("video: a page image is rendered for the frame's need, again when sharper is needed, not for every small change", () => {
  const mm = 210;
  const max = 8192;
  // Nothing yet: 1.25 pixels a video pixel, plus a tenth so the next frames keep it.
  eq(videoImageHeight(4, mm, null, max), Math.round(Math.ceil(1.25 * 4 * mm) * 1.1));
  // Kept while it is between what the frame needs and 1.3 times that.
  const have = videoImageHeight(4, mm, null, max);
  eq(videoImageHeight(4, mm, have, max), null, "the same need: kept");
  eq(videoImageHeight(4.3, mm, have, max), null, "a little more: kept (it was rendered a tenth ahead)");
  ok(videoImageHeight(5, mm, have, max) > have, "a page coming nearer: sharper");
  ok(videoImageHeight(2.5, mm, have, max) < have, "a page gone far: smaller (read from a smaller mipmap level a sharper image goes soft)");
  // Never beyond the GPU's largest texture, never under 256 px; a page not in the picture keeps what it has.
  eq(videoImageHeight(100, mm, null, 4096), 4096);
  eq(videoImageHeight(100, mm, 4096, 4096), null);
  eq(videoImageHeight(0.5, mm, null, max), Math.round(256 * 1.1));
  eq(videoImageHeight(0, mm, 900, max), null);
});

test("sharp strips: the part of the page on screen reaches the page's edges when all of it is in view", () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 16, pageSize: { width: 148, height: 210 }, binding: "perfect", paper });
    for (const preset of ["top", "reading"]) {
      scene.setPreset(preset);
      scene.settleCamera();
      scene.goTo(4, { animate: false });
      scene.debugSample(0.5, 0.5); // places the camera
      const views = scene.visiblePages();
      eq(views.map((v) => v.folio), [8, 9]);
      for (const v of views) {
        const r = v.region;
        ok(r.u0 === 0 && r.v0 === 0 && r.u1 === 1 && r.v1 === 1, `${preset}, page ${v.folio}: region ${JSON.stringify(r)} stops short of an edge`);
        ok(v.samples.length > 20, `${preset}, page ${v.folio}: ${v.samples.length} density samples`);
      }
    }
  } finally {
    box.remove();
  }
});

test("video: every frame's need lists the pages that can be in the picture, a turning page denser than at rest", async () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 16, pageSize: { width: 148, height: 210 }, binding: "perfect", paper });
    scene.setPreset("reading");
    const log = [];
    const turnAt = 300;
    await scene.recordVideo({
      width: 160, height: 90, fps: 20, durationMs: 1800,
      cues: [{ at: turnAt, run: () => scene.goTo(3) }],
      reset: () => { scene.goTo(2, { animate: false }); scene.settleCamera(); },
      prepare: async (ms, need) => { log.push({ ms, need: new Map(need) }); },
      onFrame: () => {}, onProgress: () => {},
    });
    ok(log.length >= 30, `${log.length} frames planned`);
    // Before the turn: pages 4 and 5 (opening 2) have a density; the spread turned to (6, 7) is listed.
    const first = log[0].need;
    ok(first.get(4) > 0 && first.get(5) > 0, "the open spread is dense");
    ok(first.has(1) && first.has(16), "the covers are listed");
    // Mid-turn: leaf 2 (pages 5 and 6) is in the picture and listed with a density; it comes
    // nearer the camera than it lies, so its densest frame beats its rest.
    const mid = log.filter((f) => f.ms > turnAt + 100 && f.ms < turnAt + 600);
    ok(mid.length >= 5, "frames mid-turn");
    ok(mid.every((f) => f.need.has(5) && f.need.has(6)), "the turning leaf's pages are listed through the turn");
    const peak5 = Math.max(...mid.map((f) => f.need.get(5) ?? 0));
    const last = log[log.length - 1].need;
    ok(peak5 > 0, "the turning page has a density");
    ok(last.get(6) > 0 && last.get(7) > 0, "at the end the new spread is dense");
    ok(peak5 >= first.get(5) * 1.02, `the turning page's peak density ${peak5.toFixed(2)} px/mm, at rest ${first.get(5).toFixed(2)}`);
    // Pages that can't be in the picture aren't asked for.
    ok(!first.has(12), "a page deep in the block isn't listed");
  } finally {
    box.remove();
  }
});

/**
 * The first and last rows of a frame lighter than the backdrop: the paper. (A page swinging
 * up throws a soft shadow on the backdrop, darker than it: that is room, not book.)
 */
function bookRows(rgba, W, H, bg) {
  let top = -1;
  let bottom = -1;
  const floor = bg[0] + bg[1] + bg[2] + 24;
  for (let y = 0; y < H; y++) {
    let has = false;
    for (let x = 0; x < W && !has; x += 2) {
      const k = 4 * (y * W + x);
      if (rgba[k] + rgba[k + 1] + rgba[k + 2] > floor) has = true;
    }
    if (has) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return [top, H - 1 - bottom];
}

test("video: the picture is balanced, the room above all the book does equals the room below, in every camera preset", async () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 16, pageSize: { width: 148, height: 210 }, binding: "perfect", paper });
    scene.setBackground("#56575b");
    const W = 180;
    const H = 320;
    const bad = [];
    for (const preset of ["top", "reading", "isometric"]) {
      scene.setPreset(preset);
      const turns = 2;
      const cues = Array.from({ length: turns }, (_, k) => ({ at: 600 + k * 900, run: () => scene.goTo(k + 1) }));
      let minTop = Infinity;
      let minBottom = Infinity;
      await scene.recordVideo({ width: W, height: H, fps: 20, durationMs: 600 + turns * 900 + 500, cues,
        reset: () => { scene.goTo(0, { animate: false }); scene.settleCamera(); }, prepare: async () => {},
        onFrame: (rgba) => {
          const [top, bottom] = bookRows(rgba, W, H, [0x56, 0x57, 0x5b]);
          minTop = Math.min(minTop, top);
          minBottom = Math.min(minBottom, bottom);
        }, onProgress: () => {} });
      // Within a few pixels of each other (the frame's 8 % margin, bows and paper thickness aside).
      if (Math.abs(minTop - minBottom) > 6 || minTop < 4) bad.push(`${preset}: ${minTop} px above the book at its most, ${minBottom} below`);
    }
    eq(bad, []);
  } finally {
    box.remove();
  }
});

test("sharp strips go to the GPU as page images do: mipmapped, the image freed, the page's uniforms set", async () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 8, pageSize: { width: 148, height: 210 }, binding: "saddle", paper });
    const canvas = new OffscreenCanvas(64, 64);
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    const image = await createImageBitmap(canvas);
    scene.setPageDetails(5, [{ image, region: { u0: 0.1, v0: 0, u1: 0.9, v1: 1 } }], { immediate: true });
    const u = scene.leaves[2].front.userData.uniforms; // page 5: leaf 2's front
    eq(u.uDetailCount.value, 1);
    // New over the base image: they fade in over a few frames (DETAIL_FADE_MS), then stay.
    eq(u.uDetailFade.value, 0, "the fade starts at the base image");
    scene.debugSample(0.5, 0.5);
    ok(u.uDetailFade.value > 0 && u.uDetailFade.value < 1, `a frame later: part way (${u.uDetailFade.value.toFixed(2)})`);
    // A frame counts at most 100 ms of it (a stalled frame doesn't skip the fade): frames.
    for (let k = 0; k < 4; k++) {
      await new Promise((r) => setTimeout(r, 80));
      scene.debugSample(0.5, 0.5);
    }
    eq(u.uDetailFade.value, 1, "faded in");
    const tex = u.uDetail0.value;
    ok(tex.generateMipmaps, "mipmapped (for when the view moves on)");
    eq(tex.anisotropy, scene.renderer.capabilities.getMaxAnisotropy());
    ok(!tex.image?.close, "the image was freed once on the GPU");
    eq(tex.image.width, 64);
    eq(u.uDetailRect0.value.toArray(), [0.1, 0, 0.9, 1]);
    scene.setPageDetails(5, [], { immediate: true });
    eq(u.uDetailCount.value, 0);
    eq(u.uDetail0.value, scene.white, "cleared: the placeholder again");
  } finally {
    box.remove();
  }
});
