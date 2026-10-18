// A stapled booklet's folds, frame by frame (the plan in _lab/plan-stapled-fold.md, step 1):
// every sheet is folded round the ones inside it, so each sheet's fold must stay inside the
// fold round it, never poking out past it. Read from the fold mesh itself (writeFoldGeometry
// in extras.js): per sheet, its outside and inside surfaces, 33 points each along the fold.
// The author's recording (0.17.84): opening and closing, the inner sheets' white folds
// showed outside the cover's at the spine.

import { BookScene } from "../app/viewer/scene.js";
import { ok, test } from "./harness.js";

const FRAME = 1000 / 60;
const ROW = 33; // points along a fold (writeFoldGeometry: SEGS + 1)
const SHEET = 8 * ROW; // vertices a sheet: four strips of two rows

function makeScene() {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  return { scene: new BookScene(box), box };
}

const stock = (thickness) => {
  const s = { color: "#ffffff", roughness: 0.85, specular: 0.3, clearcoat: 0, show: 0.1 };
  return { ...s, cover: { ...s }, thickness, coverThickness: thickness, gsm: 120, finish: "uncoated" };
};

/** A sheet's surface as points (x, y): 0 its outside, 1 its inside. */
function surface(pos, k, inside) {
  const base = k * SHEET + (inside ? 2 * ROW : 0);
  return Array.from({ length: ROW }, (_, j) => [pos.getX(base + 2 * j), pos.getY(base + 2 * j)]);
}

/**
 * How far any sheet's fold pokes out past the inside of the fold round it (mm, 0 if none),
 * and where: for each point of sheet k's outside, its distance to sheet k − 1's inside,
 * signed inward (toward the middle of the fold's two ends).
 */
export function foldIntrusion(scene) {
  const fold = scene.extras?.fold;
  if (!fold) return { mm: 0 };
  const pos = fold.geometry.attributes.position;
  const sheets = Math.floor(scene.leaves.length / 2);
  let worst = { mm: 0, sheet: -1, at: -1 };
  for (let k = 1; k < sheets; k++) {
    const outer = surface(pos, k - 1, true); // the inside of the fold round it
    const o0 = surface(pos, k - 1, false);
    const mid = [(outer[0][0] + o0[0][0] + outer[ROW - 1][0] + o0[ROW - 1][0]) / 4, (outer[0][1] + o0[0][1] + outer[ROW - 1][1] + o0[ROW - 1][1]) / 4];
    for (const [j, p] of surface(pos, k, false).entries()) {
      let best = Infinity;
      let signed = 0;
      for (let i = 0; i < ROW - 1; i++) {
        const a = outer[i];
        const b = outer[i + 1];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const len2 = ex * ex + ey * ey || 1e-12;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2));
        const q = [a[0] + ex * t, a[1] + ey * t];
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < best) {
          best = d;
          let nx = -ey;
          let ny = ex;
          if (nx * (mid[0] - q[0]) + ny * (mid[1] - q[1]) < 0) {
            nx = -nx;
            ny = -ny;
          }
          const nl = Math.hypot(nx, ny) || 1;
          signed = ((p[0] - q[0]) * nx + (p[1] - q[1]) * ny) / nl;
        }
      }
      if (best < 3 && -signed > worst.mm) worst = { mm: -signed, sheet: k, at: j };
    }
  }
  return worst;
}

/** Run `act` on the scene's clock for `ms`; the worst intrusion of any frame. */
function trace(scene, act, ms) {
  const t0 = 10000;
  scene.clock = t0;
  scene.debugStep();
  act();
  let worst = { mm: 0 };
  for (let t = FRAME; t <= ms; t += FRAME) {
    scene.clock = t0 + t;
    scene.debugStep();
    const w = foldIntrusion(scene);
    if (w.mm > worst.mm) worst = { ...w, t: Math.round(t) };
  }
  return worst;
}

for (const thickness of [0.075, 0.15, 0.3]) {
  test(`stapled folds: each sheet's fold stays inside the one round it, opening and closing (${thickness} mm paper)`, () => {
    const { scene, box } = makeScene();
    try {
      const bad = [];
      for (const pageCount of [8, 16, 44, 80]) {
        scene.setBook({ pageCount, pageSize: { width: 148, height: 210 }, binding: "saddle", paper: stock(thickness) });
        const m = scene.model.leafCount / 2;
        const check = (label, from, act, ms = 2500) => {
          scene.goTo(from, { animate: false });
          scene.debugStep();
          scene.lastRequest = -Infinity;
          const w = trace(scene, act, ms);
          // A hundredth of a millimetre for rounding; anything more shows.
          if (w.mm > 0.01) bad.push(`${pageCount} pages, ${label}: sheet ${w.sheet} ${w.mm.toFixed(3)} mm outside sheet ${w.sheet - 1} at ${w.t} ms`);
        };
        check("opening from closed", 0, () => scene.goTo(1));
        check("closing from the first spread", 1, () => scene.close());
        check("opening at the centre from closed", 0, () => scene.goTo(m));
        check("closing from the centre", m, () => scene.close());
        check("turning a page", 1, () => scene.goTo(2), 1500);
        // At rest, open and closed.
        for (const opening of [0, 1, m]) {
          scene.goTo(opening, { animate: false });
          scene.debugStep();
          const w = foldIntrusion(scene);
          if (w.mm > 0.01) bad.push(`${pageCount} pages, at rest at ${opening}: sheet ${w.sheet} ${w.mm.toFixed(3)} mm outside`);
        }
      }
      ok(bad.length === 0, bad.slice(0, 8).join("; ") + (bad.length > 8 ? `; and ${bad.length - 8} more` : ""));
    } finally {
      scene.clock = null;
      box.remove();
    }
  });
}

// The fix above (a sheet peeling off its pile, model.js) is for opening and closing only: a
// page turning in an open booklet keeps its gentle bend at the gutter. Peeled there too
// (0.17.99), its first few millimetres bent 60 degrees one way, then the other, mid-turn: a
// kink the author saw flipping through booklet-16. Unpeeled, 17 to 34 degrees.
test("stapled page turns: no kink at the gutter mid-turn (the first 6 mm bend under 40 degrees)", () => {
  const { scene, box } = makeScene();
  try {
    const bad = [];
    for (const [pageCount, thickness] of [[16, 0.15], [44, 0.15], [80, 0.3]]) {
      scene.setBook({ pageCount, pageSize: { width: 148, height: 210 }, binding: "saddle", paper: stock(thickness) });
      const m = scene.model.leafCount / 2;
      for (const from of [2, m - 1]) {
        scene.goTo(from, { animate: false });
        scene.debugStep();
        scene.lastRequest = -Infinity;
        const t0 = 50000;
        scene.clock = t0;
        scene.debugStep();
        scene.goTo(from + 1);
        const leaf = scene.leaves[from];
        const near = Array.from(leaf.s).map((v, k) => (v <= 6 ? k : -1)).filter((k) => k >= 0);
        let most = 0;
        for (let t = FRAME; t <= 1400; t += FRAME) {
          scene.clock = t0 + t;
          scene.debugStep();
          const e = Math.min(1, Math.max(0, (90 - leaf.theta) / 180));
          const p = leaf.profile;
          if (e > 0.3 && e < 0.7) most = Math.max(most, Math.abs(p.phi[near[near.length - 1]] - p.phi[0]) * (180 / Math.PI));
        }
        if (most >= 40) bad.push(`${pageCount} pages, ${thickness} mm, turning ${from} to ${from + 1}: ${most.toFixed(1)} degrees`);
      }
    }
    ok(bad.length === 0, bad.join("; "));
  } finally {
    scene.clock = null;
    box.remove();
  }
});

// The staples' legs lie in the crease of the centre spread: shown only there, where it opens.
// Elsewhere the centre pages lie on each other, and the legs showed through the page on them
// as a grey line in the gutter (the author, booklet-16 at 6 | 7, 0.17.100).
test("staples: their legs show at the centre spread only, where the crease opens", () => {
  const { scene, box } = makeScene();
  try {
    for (const pageCount of [16, 44]) {
      scene.setBook({ pageCount, pageSize: { width: 148, height: 210 }, binding: "saddle", paper: stock(0.15) });
      const m = scene.model.leafCount / 2;
      for (let opening = 0; opening <= 2 * m; opening++) {
        scene.goTo(opening, { animate: false });
        scene.debugStep();
        const shown = scene.extras.staples.map((st) => st.inner.visible);
        ok(shown.every((v) => v === (opening === m)), `${pageCount} pages at opening ${opening}: legs ${shown.join(", ")}`);
      }
    }
  } finally {
    box.remove();
  }
});
