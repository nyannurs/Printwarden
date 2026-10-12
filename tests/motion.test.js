// Drawing resolution in motion on slower graphics cards (app/viewer/motion.js).

import { MOTION_SCALES, motionReset, motionState, motionStep } from "../app/viewer/motion.js";
import { eq, ok, test } from "./harness.js";

const HZ120 = 1000 / 120;

/** Rounds of 30 frames whose cost follows the drawn area: `full` ms at full size, plus `fixed`. */
function run(state, rounds, full, { fixed = 0, refresh = HZ120, timed = true } = {}) {
  const scales = [];
  let scale = MOTION_SCALES[state.k];
  for (let i = 0; i < rounds; i++) {
    scale = motionStep(state, fixed + full * scale * scale, refresh, timed);
    scales.push(scale);
  }
  return scales;
}

test("motion: a graphics card too slow for the screen draws motion smaller until it keeps up", () => {
  const s = motionState();
  const scales = run(s, 8, 16); // 16 ms a frame at full size, a 120 Hz screen
  const last = scales[scales.length - 1];
  ok(last < 1 && 16 * last * last <= HZ120 * 0.85, `settled at ${last}`);
  eq(new Set(scales.slice(-3)).size, 1, "and stays there");
});

test("motion: a step down that doesn't help (not the drawing) is taken back, and no further tried", () => {
  const s = motionState();
  const scales = run(s, 6, 0, { fixed: 20 }); // 20 ms whatever the size
  eq(scales.slice(0, 2), [0.85, 1]);
  eq(scales.slice(2), [1, 1, 1, 1]);
  motionReset(s);
  eq(run(s, 1, 0, { fixed: 20 }), [0.85], "a new window size: tried again");
});

test("motion: keeping up easily, back to full size, a step at a time", () => {
  const s = motionState();
  s.k = MOTION_SCALES.length - 1;
  const scales = run(s, 20, 2);
  eq(scales[scales.length - 1], 1);
  ok(scales.indexOf(MOTION_SCALES[MOTION_SCALES.length - 2]) >= 3, "not at once");
});

test("motion: screens faster than 120 Hz aren't chased with a smaller picture", () => {
  eq(run(motionState(), 4, 7, { refresh: 1000 / 165 }), [1, 1, 1, 1]);
  eq(run(motionState(), 1, 9, { refresh: 1000 / 165 }), [0.85]);
});

test("motion: without the graphics card's timing, frames that come late count", () => {
  eq(run(motionState(), 1, 0, { fixed: 12, timed: false }), [0.85]);
  eq(run(motionState(), 1, 0, { fixed: 9, timed: false }), [1]);
});
