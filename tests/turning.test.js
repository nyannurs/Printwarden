// Pages turning, the book opening and closing, in every binding: frame by frame, nothing
// jumps. The scene's own clock drives the animations (debugStep), and every frame the
// largest move of any point of any leaf is measured: a page that is held back by another
// and dropped the rest of the way, or a stack that lands short of its pile and falls, shows
// as one frame moving far more than the frames round it (a double-click's second page fell
// 115 mm in one frame before 0.17.82, a stack swung over to close the book 16 mm).

import { restingAngle } from "../app/viewer/model.js";
import { BookScene } from "../app/viewer/scene.js";
import { eq, ok, test } from "./harness.js";

const stock = { color: "#ffffff", roughness: 0.85, specular: 0.3, clearcoat: 0, show: 0.1 };
const paper = { ...stock, cover: { ...stock, color: "#d8d0c0" }, thickness: 0.1, coverThickness: 0.3, gsm: 120, finish: "uncoated" };
const FRAME = 1000 / 60;

/** A scene in a box off the page (a WebGL context, as the app's). */
function makeScene() {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  return { scene: new BookScene(box), box };
}

/**
 * Run `act()` on the scene's clock and step it `ms` on (`acts`: more at their times, ms from
 * the start): per frame, the largest move of any point of any leaf (mm) and which leaf.
 */
function trace(scene, act, ms, acts = []) {
  const t0 = 10000;
  scene.clock = t0;
  scene.debugStep();
  const snap = () => scene.leaves.map((l) => [Float64Array.from(l.profile.x), Float64Array.from(l.profile.y)]);
  let prev = snap();
  act();
  const pending = [...acts].sort((a, b) => a.at - b.at);
  const frames = [];
  for (let t = FRAME; t <= ms; t += FRAME) {
    while (pending.length && pending[0].at <= t) pending.shift().run();
    scene.clock = t0 + t;
    scene.debugStep();
    const now = snap();
    let move = 0;
    let leaf = -1;
    now.forEach(([x, y], i) => {
      const [px, py] = prev[i];
      for (let k = 0; k < x.length; k++) {
        const d = Math.hypot(x[k] - px[k], y[k] - py[k]);
        if (d > move) {
          move = d;
          leaf = i;
        }
      }
    });
    frames.push({ t: Math.round(t), move, leaf });
    prev = now;
  }
  return frames;
}

/** Frames moving more than `factor` times both their neighbours (and over `floor` mm): a jump. */
function jumps(frames, factor = 2.5, floor = 1) {
  return frames.filter((f, i) => {
    const before = frames[i - 1]?.move ?? 0;
    const after = frames[i + 1]?.move ?? 0;
    return f.move > floor && f.move > factor * Math.max(before, after, 0.05);
  });
}

/** Set the book at opening `j` at once, at rest, the next request not a quick one. */
function settleAt(scene, j) {
  scene.goTo(j, { animate: false });
  if (scene.model.style.spine === "coil") scene.setClosed(false, { animate: false });
  scene.debugStep();
  scene.lastRequest = -Infinity;
}

/** Every leaf at rest at its resting angle for the opening, nothing still turning. */
function atRest(scene, label) {
  const m = scene.model;
  ok(scene.leaves.every((l) => l.start == null), `${label}: a leaf still turning at the end`);
  for (const [i, l] of scene.leaves.entries()) {
    const want = restingAngle(m, i, scene.opening);
    ok(Math.abs(l.theta - want) < 1e-6, `${label}: leaf ${i} at ${l.theta.toFixed(2)}°, not ${want.toFixed(2)}°`);
  }
}

const BINDINGS = ["saddle", "perfect", "sewn", "hardcover", "spiral", "wire-o"];

for (const binding of BINDINGS) {
  test(`turning: ${binding}: clicks fast and slow, closing and opening, never a jump`, () => {
    const { scene, box } = makeScene();
    try {
      scene.setBook({ pageCount: 32, pageSize: { width: 148, height: 210 }, binding, paper });
      const n = scene.model.leafCount;
      const mid = n >> 1;
      const bad = [];
      const check = (label, from, act, ms, acts = []) => {
        settleAt(scene, from);
        const frames = trace(scene, act, ms, acts);
        for (const j of jumps(frames)) bad.push(`${label}: at ${j.t} ms leaf ${j.leaf} moved ${j.move.toFixed(1)} mm in one frame`);
        atRest(scene, label);
      };
      check("one click", mid, () => scene.goTo(mid + 1), 1400);
      check("a double-click", mid, () => scene.goTo(mid + 1), 1600, [{ at: 100, run: () => scene.goTo(mid + 2) }]);
      check("three quick clicks", mid, () => scene.goTo(mid + 1), 1800, [{ at: 100, run: () => scene.goTo(mid + 2) }, { at: 200, run: () => scene.goTo(mid + 3) }]);
      check("five quick clicks", mid - 3, () => scene.goTo(mid - 2), 2200, [1, 2, 3, 4].map((k) => ({ at: 90 * k, run: () => scene.goTo(mid - 2 + k) })));
      check("back and forth", mid, () => scene.goTo(mid + 1), 1800, [{ at: 120, run: () => scene.goTo(mid) }, { at: 240, run: () => scene.goTo(mid + 1) }]);
      check("close from the middle", mid, () => scene.close(), 3000);
      check("close from the second spread", 2, () => scene.close(), 3000);
      check("close from the last spread", n - 1, () => scene.close(), 3000);
      check("open at the middle from the front cover", 0, () => scene.goTo(mid), 3000);
      check("open at the last spread from the front cover", 0, () => scene.goTo(n - 1), 3000);
      check("from the end to the start", n - 1, () => scene.goTo(1), 3000);
      eq(bad, []);
    } finally {
      scene.clock = null;
      box.remove();
    }
  });
}

// The cases that jumped before 0.17.82 grew with the page count (a hair of ordering per leaf,
// 35 leaves swung over at once): the thick book too.
for (const binding of ["perfect", "hardcover", "spiral"]) {
  test(`turning: ${binding}, 80 pages: closing from deep in the book and opening there, never a jump`, () => {
    const { scene, box } = makeScene();
    try {
      scene.setBook({ pageCount: 80, pageSize: { width: 148, height: 210 }, binding, paper });
      const n = scene.model.leafCount;
      const bad = [];
      const check = (label, from, act, ms) => {
        settleAt(scene, from);
        const frames = trace(scene, act, ms);
        for (const j of jumps(frames)) bad.push(`${label}: at ${j.t} ms leaf ${j.leaf} moved ${j.move.toFixed(1)} mm in one frame`);
        atRest(scene, label);
      };
      check("close from spread 35", 35, () => scene.close(), 3000);
      check("open at spread 35", 0, () => scene.goTo(35), 3000);
      check("close from the last spread", n - 1, () => scene.close(), 3000);
      eq(bad, []);
    } finally {
      scene.clock = null;
      box.remove();
    }
  });
}

test("turning: a stack swung over together is drawn at its full thickness (no gaps to see through), single pages thinned", () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 32, pageSize: { width: 148, height: 210 }, binding: "perfect", paper });
    settleAt(scene, 0);
    scene.clock = 30000;
    scene.goTo(10); // ten leaves swing over as one stack
    scene.clock = 30300;
    scene.debugStep();
    const moving = scene.leaves.filter((l) => l.start != null);
    eq(moving.length, 10);
    ok(moving.every((l) => l.fill === 1), "every sheet of the stack at its full thickness");
    ok(scene.leaves.filter((l) => l.start == null).every((l) => l.fill < 1), "the rest thinned");
    scene.clock = 32000;
    scene.debugStep();
    ok(scene.leaves.every((l) => l.start == null && l.fill < 1), "landed: thinned again");
    // One page turning alone: thinned (it has neighbours' faces under and over it).
    settleAt(scene, 10);
    scene.clock = 40000;
    scene.goTo(11);
    scene.clock = 40300;
    scene.debugStep();
    ok(scene.leaves[10].start != null && scene.leaves[10].fill < 1, "a page on its own stays thinned");
  } finally {
    scene.clock = null;
    box.remove();
  }
});

test("turning: a quick second click's page lands with the first, never before it", () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 32, pageSize: { width: 148, height: 210 }, binding: "perfect", paper });
    settleAt(scene, 10);
    scene.clock = 20000;
    scene.goTo(11); // leaf 10 turns, at the normal pace
    scene.clock = 20100;
    scene.goTo(12); // leaf 11 after it, asked for quickly: it would go at twice the pace
    const first = scene.leaves[10];
    const second = scene.leaves[11];
    ok(second.start >= first.start, "it starts no earlier");
    ok(second.start + second.duration >= first.start + first.duration - 1e-9, "and lands no earlier");
    // Never further over than the first at any moment.
    const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
    const angle = (l, t) => l.from + (l.to - l.from) * ease(Math.max(0, Math.min(1, (t - l.start) / l.duration)));
    for (let t = 20100; t <= 20100 + 1500; t += 10) ok(angle(second, t) >= angle(first, t) - 1e-9, `at ${t - 20000} ms the second page is ahead`);
  } finally {
    scene.clock = null;
    box.remove();
  }
});
