// Drawing resolution while the book or the camera moves (see #adaptResolution in scene.js):
// a graphics card too slow for the screen draws motion a step smaller; still frames are
// always drawn at full resolution. Pure, so it can be tested.

export const MOTION_SCALES = [1, 0.85, 0.7, 0.6, 0.5];

/** A fresh state: full size, any step allowed. */
export function motionState() {
  return { k: 0, floor: MOTION_SCALES.length - 1, stepped: null, fast: 0 };
}

/**
 * The next step, from what the frames drawn in motion cost (`mean`, ms: the slow ones, the
 * 90th percentile of a round, see #adaptResolution) against the screen's refresh
 * (`refreshMs`). `timed`: the graphics card's own time to draw a frame (else the time
 * between frames drawn, which can't be shorter than a refresh). Too slow, a step smaller;
 * keeping up easily for a while (4 rounds), a step larger. Timed, the drawing may take 70 %
 * of a refresh: the rest is the browser's own work on the GPU (compositing the canvas, a
 * Retina screen's 3354 × 2186 pixels) and the main thread's. (At 85 %, the author's M4 Pro
 * drew in 7.0 ms of 8.3 and stayed at 70 % resolution while every other frame came a
 * refresh late: 47 to 50 fps panning; its performance check showed any one saving enough.) A step
 * down that didn't make frames at least a tenth faster (they waited on something else than
 * drawing) is taken back, and no smaller one tried until `reset`. Screens faster than 120 Hz
 * aren't chased with a smaller picture.
 * @returns {number} the scale to draw motion at
 */
export function motionStep(state, mean, refreshMs, timed) {
  const refresh = Math.max(1000 / 120, refreshMs);
  const slow = timed ? refresh * 0.7 : refresh * 1.35;
  const easy = timed ? refresh * 0.4 : refresh * 1.1;
  const stepped = state.stepped;
  state.stepped = null;
  if (stepped && mean > stepped.mean * 0.9) {
    state.floor = stepped.k;
    state.k = stepped.k;
    state.fast = 0;
  } else if (mean > slow && state.k < state.floor) {
    state.stepped = { k: state.k, mean };
    state.k++;
    state.fast = 0;
  } else if (mean < easy && state.k > 0) {
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
