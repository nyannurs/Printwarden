// A performance check of this computer, for reports from machines the developer can't run
// (Cmd/Ctrl+Shift+P with a document open). Pans the view where it is, as the space bar and
// a drag do, then drags the camera round the book, two seconds at a time, with one part of
// the image switched off each time, then turns pages quickly; times every frame as the
// screen shows it. The parts that change the result most are what limits this computer.
// Last, it asks for a few seconds of panning by hand and measures the mouse's own rate and
// what was drawn: a frame can only be drawn when the mouse reports a move. Then dragging round
// three more views: the closed book, the open book as framed, its piles from low at the
// fore-edge. Turning pages, the main thread's time is broken down by part (FRAME_PARTS in
// scene.js). About 45 seconds and the hand panning; everything is put back as it was.

import { FRAME_PARTS } from "../viewer/scene.js";

const SECONDS = 2.2; // each run; the first 0.4 s isn't counted (shaders compiling)

/** @param {import("../viewer/scene.js").BookScene} scene */
export async function runProbe(scene, onProgress) {
  const r = scene.renderer;
  const gl = r.getContext();
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const ratio = r.getPixelRatio();
  const targets = [scene.composer.renderTarget1, scene.composer.renderTarget2];
  const samples = targets[0].samples;
  const lines = [
    `GPU: ${gpu}`,
    `Screen: pixel ratio ${ratio}, view ${gl.drawingBufferWidth} × ${gl.drawingBufferHeight} px, multisampling ${samples}×, ${navigator.hardwareConcurrency} CPU threads`,
    `Book: ${scene.leaves.length} sheets, ${scene.model?.binding ?? "?"}`,
    `Multisampled render to texture: ${r.extensions.has("WEBGL_multisampled_render_to_texture") ? "yes" : "no"}, GPU timer: ${scene.gpuTime.timer ? "yes" : "no"}`,
  ];
  const frame = () => new Promise((done) => requestAnimationFrame(done));
  // The screen's own pace: frames with nothing drawn.
  const idle = [];
  let last = await frame();
  for (let i = 0; i < 40; i++) {
    const t = await frame();
    idle.push(t - last);
    last = t;
  }
  const refresh = Math.min(...idle.slice(5));
  lines.push(`Refresh: ${(1000 / refresh).toFixed(0)} Hz (${refresh.toFixed(1)} ms)`, "");

  const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const stats = (ivals, cpu, gpu) => {
    const s = ivals.slice().sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const g = gpu.length ? `   gpu ${median(gpu).toFixed(1)} ms` : "";
    return `${(1000 / q(0.5)).toFixed(0).padStart(4)} fps   p95 ${q(0.95).toFixed(1).padStart(5)} ms   worst ${s[s.length - 1].toFixed(1).padStart(5)} ms   main thread ${median(cpu).toFixed(1)} ms${g}`;
  };
  // The graphics card's time for the frames of a run, where it can be timed (see #adaptResolution).
  const gpuNow = (since) => (scene.gpuTime.timer && scene.gpuTime.at > since ? scene.gpuTime.ms : null);
  // One run: `step` moves something every frame; frames and main-thread time measured;
  // `parts`: that time by part too, on a line of its own.
  const run = async (label, step, { parts = false } = {}) => {
    onProgress?.(label);
    const log = scene.frameLog;
    const ivals = [];
    const cpu = [];
    const gpu = [];
    const t0 = performance.now();
    let prev = null;
    let n0 = log.n;
    for (;;) {
      const t = await frame();
      const k = (t - t0) / 1000;
      if (k > SECONDS) break;
      step(k);
      if (k > 0.4) {
        if (prev != null) ivals.push(t - prev);
        prev = t;
        const g = gpuNow(t - 100);
        if (g != null) gpu.push(g);
      } else {
        n0 = log.n;
      }
    }
    for (let k = n0; k < log.n; k++) cpu.push(log.cpu[k % log.time.length]);
    lines.push(`${label.padEnd(28)} ${ivals.length ? stats(ivals, cpu.length ? cpu : [0], gpu) : "no frames"}`);
    if (parts && log.n > n0) {
      const mean = (a) => {
        let sum = 0;
        for (let k = n0; k < log.n; k++) sum += a[k % log.time.length];
        return sum / (log.n - n0);
      };
      lines.push(`  main thread by part:  ${FRAME_PARTS.map((name, i) => `${name} ${mean(log.parts[i]).toFixed(1)}`).join("   ")}  (ms a frame)`);
    }
  };
  const orbit = (k) => scene.rig.drag(Math.cos(k * 2.1) * 7, Math.sin(k * 1.4) * 5);
  const dragging = async (label, apply, undo) => {
    apply?.();
    scene.rig.beginDrag();
    scene.dirty = true; // the camera moved directly: wakes the scene's frames (they stop at rest)
    try {
      await run(label, orbit);
    } finally {
      scene.rig.endDrag();
      undo?.();
    }
  };
  const pages = () => scene.leaves.flatMap((l) => [l.front, l.back]);
  const setSamples = (n) => {
    for (const t of targets) {
      t.samples = n;
      t.dispose();
    }
  };

  const opening = scene.opening;
  const closed = scene.isClosed;
  const rig = scene.rig;
  const here = { pan: { ...rig.pan }, zoom: rig.zoom, azimuth: rig.azimuth, elevation: rig.elevation, free: rig.free, bias: scene.zoomBias };
  const putBack = () => {
    rig.pan = { ...here.pan };
    rig.zoom = here.zoom;
    rig.azimuth = here.azimuth;
    rig.elevation = here.elevation;
    rig.free = here.free;
    scene.zoomBias = here.bias;
    scene.dirty = true;
  };
  try {
    // Panning where the view is now (the page, the zoom), as the space bar and a drag pan:
    // through the same steps, re-pivoting onto the paper included.
    lines.push(`Panning here, at ${Math.round(scene.zoomPercent)} %`);
    const sway = (k) => scene.debugPan(Math.cos(k * 2.1) * 8, Math.sin(k * 1.4) * 5);
    const panning = async (label, apply, undo) => {
      apply?.();
      scene.dirty = true;
      try {
        await run(label, sway);
      } finally {
        undo?.();
        putBack();
      }
    };
    await panning("Panning, as is");
    await panning("  half the pixels", () => {
      r.setPixelRatio(ratio / 2);
      scene.composer.setPixelRatio(ratio / 2);
    }, () => {
      r.setPixelRatio(ratio);
      scene.composer.setPixelRatio(ratio);
    });
    await panning("  no re-pivot onto the paper", () => { scene.debugNoPivot = true; }, () => { scene.debugNoPivot = false; });
    lines.push("");
    scene.goTo(Math.max(1, Math.floor(scene.model.leafCount / 2)), { animate: false });
    await dragging("Dragging round, as is");
    await dragging("  half the pixels", () => {
      r.setPixelRatio(ratio / 2);
      scene.composer.setPixelRatio(ratio / 2);
    }, () => {
      r.setPixelRatio(ratio);
      scene.composer.setPixelRatio(ratio);
    });
    await dragging("  no shadows", () => {
      scene.key.castShadow = false;
      for (const m of pages()) m.needsUpdate = true;
    }, () => {
      scene.key.castShadow = true;
      r.shadowMap.needsUpdate = true;
      for (const m of pages()) m.needsUpdate = true;
    });
    await dragging("  no multisampling", () => setSamples(0), () => setSamples(samples));
    const top = new Set([scene.opening - 1, scene.opening]);
    await dragging("  only the two open pages", () => {
      for (const l of scene.leaves) l.mesh.visible = top.has(l.i);
    }, () => {
      for (const l of scene.leaves) l.mesh.visible = true;
    });
    lines.push("");
    // Pages turned quickly: one every 150 ms, forward then back.
    const turning = async (label, apply, undo) => {
      scene.goTo(Math.max(1, Math.floor(scene.model.leafCount / 2) - 6), { animate: false });
      let turned = 0;
      apply?.();
      try {
        await run(label, (k) => {
          const want = Math.floor(k / 0.15);
          while (turned < want) {
            turned++;
            scene.goTo(scene.opening + (turned <= 7 ? 1 : -1));
          }
        }, { parts: true });
      } finally {
        undo?.();
      }
    };
    await turning("Turning pages quickly");
    await turning("  no shadows", () => {
      scene.key.castShadow = false;
      for (const m of pages()) m.needsUpdate = true;
    }, () => {
      scene.key.castShadow = true;
      r.shadowMap.needsUpdate = true;
      for (const m of pages()) m.needsUpdate = true;
    });
    // Dragging round more views, each from its own place.
    const views = [
      { label: "Closed book", open: () => {
        scene.goTo(0, { animate: false });
        scene.setClosed(true, { animate: false });
      }, at: { zoom: 1, azimuth: rig.home.azimuth, elevation: rig.home.elevation } },
      { label: "Open book, framed", open: () => {
        scene.goTo(Math.max(1, Math.floor(scene.model.leafCount / 2)), { animate: false });
      }, at: { zoom: 1, azimuth: rig.home.azimuth, elevation: rig.home.elevation } },
      { label: "Low at the fore-edge", open: () => {
        scene.goTo(Math.max(1, Math.floor(scene.model.leafCount / 2)), { animate: false });
      }, at: { zoom: 0.6, azimuth: rig.home.azimuth + Math.PI / 2, elevation: 0.12 } },
    ];
    lines.push("");
    for (const { label, open, at } of views) {
      open();
      const place = () => {
        rig.free = true;
        rig.pan = { x: 0, y: 0, z: 0 };
        Object.assign(rig, at);
        scene.zoomBias = 1;
      };
      place();
      await dragging(label);
    }
  } finally {
    scene.debugNoPivot = false;
    scene.goTo(opening, { animate: false });
    if (closed) scene.setClosed(true, { animate: false });
    putBack();
  }
  lines.push("", await byHand(scene, onProgress, frame, median, gpuNow));
  return lines.join("\n");
}

/**
 * Panning by hand, as the app is used: how often the
 * mouse reports a move while its button is held, how many frames were drawn, the graphics
 * card's time. A frame is only drawn when a move arrives, so a mouse reporting 60 times a
 * second gives 60 frames however fast the card. Waits up to 15 s for the drag to start.
 */
async function byHand(scene, onProgress, frame, median, gpuNow) {
  const SECONDS_BY_HAND = 4;
  onProgress?.("now move the book by hand (drag it about) for 4 seconds");
  let moves = 0;
  let pressed = false;
  const onMove = (e) => {
    pressed = (e.buttons & 1) === 1;
    if (pressed) moves += e.getCoalescedEvents?.().length || 1;
  };
  window.addEventListener("pointermove", onMove, { capture: true, passive: true });
  try {
    const wait = performance.now();
    while (!pressed) {
      if (performance.now() - wait > 15000) return "By hand: no drag within 15 seconds (skipped)";
      await frame();
    }
    moves = 0;
    const n0 = scene.frameLog.n;
    const t0 = performance.now();
    const gpu = [];
    let ticks = 0;
    let held = 0;
    for (;;) {
      const t = await frame();
      if (t - t0 > SECONDS_BY_HAND * 1000) break;
      if (pressed) held++;
      const g = gpuNow(t - 100);
      if (g != null) gpu.push(g);
      ticks++;
    }
    const seconds = (performance.now() - t0) / 1000;
    const drawn = scene.frameLog.n - n0;
    const parts = [
      `By hand: pointer ${Math.round(moves / seconds)} moves/s`,
      `frames drawn ${Math.round(drawn / seconds)}/s`,
      gpu.length ? `gpu ${median(gpu).toFixed(1)} ms` : null,
      held < 0.8 * ticks ? "(the button wasn't held the whole time)" : null,
    ];
    return parts.filter(Boolean).join("   ");
  } finally {
    window.removeEventListener("pointermove", onMove, { capture: true });
  }
}
