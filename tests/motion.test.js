// Drawing resolution in motion on slower graphics cards (app/viewer/motion.js).

import { MOTION_SCALES, motionReset, motionState, motionStep } from "../app/viewer/motion.js";
import { eq, ok, test } from "./harness.js";

const HZ120 = 1000 / 120;

/** Rounds of 30 frames whose cost follows the drawn area: `full` ms at full size, plus `fixed`. */
function run(state, rounds, full, { fixed = 0, refresh = HZ120, timed = true, late = () => 0 } = {}) {
  const scales = [];
  let scale = MOTION_SCALES[state.k];
  for (let i = 0; i < rounds; i++) {
    scale = motionStep(state, fixed + full * scale * scale, refresh, timed, late(scale));
    scales.push(scale);
  }
  return scales;
}

test("motion: a graphics card too slow for the screen draws motion smaller until it keeps up", () => {
  const s = motionState();
  // 16 ms a frame at full size, a 120 Hz screen: frames late whenever the drawing outlasts a refresh.
  const scales = run(s, 16, 16, { late: (scale) => (16 * scale * scale > HZ120 ? 0.5 : 0) }); // (one step back up is tried, once)
  const last = scales[scales.length - 1];
  ok(last < 1 && 16 * last * last <= HZ120, `settled at ${last}, where frames are on time`);
  eq(new Set(scales.slice(-3)).size, 1, "and stays there");
});

test("motion: a step down that doesn't help (not the drawing) is taken back, and no further tried", () => {
  const s = motionState();
  const scales = run(s, 6, 0, { fixed: 20, late: () => 0.5 }); // 20 ms whatever the size, as late
  eq(scales.slice(0, 2), [0.85, 1]);
  eq(scales.slice(2), [1, 1, 1, 1]);
  motionReset(s);
  eq(run(s, 1, 0, { fixed: 20, late: () => 0.5 }), [0.85], "a new window size: tried again");
});

test("motion: keeping up easily, back to full size, a step at a time", () => {
  const s = motionState();
  s.k = MOTION_SCALES.length - 1;
  const scales = run(s, 20, 2);
  eq(scales[scales.length - 1], 1);
  ok(scales.indexOf(MOTION_SCALES[MOTION_SCALES.length - 2]) >= 3, "not at once");
});

test("motion: screens faster than 120 Hz aren't chased with a smaller picture", () => {
  eq(run(motionState(), 4, 5.5, { refresh: 1000 / 165 }), [1, 1, 1, 1]);
  eq(run(motionState(), 1, 9, { refresh: 1000 / 165, late: () => 0.3 }), [0.85]);
});

test("motion: REGRESSION: frames on time stay full size, whatever the card's timer says (the author's M4 Pro: 8.7 ms timed, a 7.4 ms refresh, 120 fps at any size)", () => {
  eq(run(motionState(), 6, 8.7, { refresh: 1000 / 135 }), [1, 1, 1, 1, 1, 1]);
  // And back up from 50 % once frames are on time (they had stayed there).
  const s = motionState();
  s.k = MOTION_SCALES.length - 1;
  const scales = run(s, 40, 8.7, { refresh: 1000 / 135 });
  eq(scales[scales.length - 1], 1, `back up to full size: ${scales.join(" ")}`);
});

test("motion: a step up that makes frames late is taken back and not tried again (no bouncing)", () => {
  const s = motionState();
  s.k = MOTION_SCALES.indexOf(0.85);
  // On time at 85 %, late at full size.
  const scales = run(s, 30, 9, { late: (scale) => (scale > 0.9 ? 0.4 : 0) });
  const tail = scales.slice(-10);
  ok(tail.every((x) => x === 0.85), `settles at 85 %: ${scales.join(" ")}`);
});

test("motion: frames reaching the screen late count, though the card's drawing looks in time (the author's M4 Pro, 0.17.93)", () => {
  // 7 ms of drawing at 70 % on a 130 Hz screen; every other frame late above 50 %, none at 50 %.
  const s = motionState();
  s.k = MOTION_SCALES.indexOf(0.7);
  const full = 7 / (0.7 * 0.7);
  const scales = run(s, 10, full, { refresh: 1000 / 130, late: (scale) => (scale > 0.5 ? 0.5 : 0) });
  eq(scales.slice(-4), [0.5, 0.5, 0.5, 0.5], `settled at 50 %: ${scales.join(" ")}`);
});

test("motion: a step down that leaves frames as late as before is taken back", () => {
  const s = motionState();
  const scales = run(s, 4, 0, { fixed: 3, late: () => 0.4 }); // late, whatever the size: not the drawing
  eq(scales.slice(0, 2), [0.85, 1]);
  eq(scales.slice(2), [1, 1]);
});

test("motion: without the graphics card's timing, frames that come late count", () => {
  eq(run(motionState(), 1, 0, { fixed: 12, timed: false }), [0.85]);
  eq(run(motionState(), 1, 0, { fixed: 9, timed: false }), [1]);
});
