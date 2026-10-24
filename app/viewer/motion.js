// Drawing resolution while the book or the camera moves (see #adaptResolution in scene.js):
// a graphics card too slow for the screen draws motion a step smaller; still frames are
// always drawn at full resolution. Pure, so it can be tested.

export const MOTION_SCALES = [1, 0.85, 0.7, 0.6, 0.5];

/** A fresh state: full size, any step allowed. */
export function motionState() {
  return { k: 0, floor: MOTION_SCALES.length - 1, stepped: null, fast: 0 };
}

/**
 * The next step, from what the frames drawn in motion cost on average (`mean`, ms) against
 * the screen's refresh (`refreshMs`), and the share of them that reached the screen a
 * refresh or more late (`late`, 0 to 1). `timed`: `mean` is the graphics card's own time to
 * draw a frame (else the time between frames drawn, which can't be shorter than a refresh).
 * Too slow or too often late, a step smaller; keeping up easily for a while (4 rounds), a
 * step larger. A step down that made frames neither a tenth faster nor late half as often
 * (they waited on something else than drawing) is taken back, and no smaller one tried until
 * `reset`. Screens faster than 120 Hz aren't chased with a smaller picture.
 *
 * Why late frames count: the card's timer measures the 3D drawing only. On the author's M4
 * Pro (a 3354 × 2186 canvas, 130 Hz) the drawing took 7 ms of 7.7 and looked in time, but
 * with the browser compositing the canvas every other frame came a refresh late: 47 to 50
 * fps while panning, and its performance check showed any one saving enough (0.17.93).
 * Judged by the slowest frames instead (0.17.93), every step down looked as if it didn't
 * help (the slowest frames are noisy) and it stayed at full size: worse.
 *
 * Why the card's time alone never steps down (2026-10-24): on the same M4 Pro the timer read
 * 8.7 ms a frame at full size against a 7.4 ms refresh, and every frame still reached the
 * screen on time, 120 fps, at full size and at half alike; motion was drawn at 50 % for
 * nothing, every turn and drag soft, sharp again at rest ("it just feels bad", the author).
 * With the timer, a step down needs frames actually late too; a step up, the card's time
 * scaled to the next size within the refresh (from 50 % the old rule, under 0.4 of the
 * refresh, was never met: it stayed small).
 * @param {number} late
 * @returns {number} the scale to draw motion at
 */
export function motionStep(state, mean, refreshMs, timed, late = 0) {
  const refresh = Math.max(1000 / 120, refreshMs);
  const slow = timed ? refresh * 0.7 : refresh * 1.35;
  const easy = timed ? refresh * 0.4 : refresh * 1.1;
  const stepped = state.stepped;
  state.stepped = null;
  const helped = stepped && (mean <= stepped.mean * 0.9 || (stepped.late > 0.05 && late <= stepped.late * 0.5));
  if (stepped && !helped) {
    state.floor = stepped.k;
    state.k = stepped.k;
    state.fast = 0;
  } else if (((timed ? mean > slow && late > 0.05 : mean > slow) || late > 0.1) && state.k < state.floor) {
    state.stepped = { k: state.k, mean, late };
    state.k++;
    state.fast = 0;
  } else if ((timed ? mean * (MOTION_SCALES[state.k - 1] / MOTION_SCALES[state.k]) ** 2 < refresh * 0.9 : mean < easy) && late < 0.02 && state.k > 0) {
    if (++state.fast >= 4) {
      state.k--;
      state.fast = 0;
    }
  } else {
    state.fast = 0;
  }
  return MOTION_SCALES[state.k];
}

/** A new window size: smaller may help again. */
export function motionReset(state) {
  state.floor = MOTION_SCALES.length - 1;
  state.stepped = null;
}
