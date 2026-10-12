// A performance check of this computer, for reports from machines the developer can't run
// (Cmd/Ctrl+Shift+P with a document open). Drags the camera round the book for two seconds
// at a time, with one part of the image switched off each time, then turns pages quickly;
// times every frame as the screen shows it. The parts that change the result most are what
// limits this computer. About 25 seconds; everything is put back as it was.

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
    `Multisampled render to texture: ${r.extensions.has("WEBGL_multisampled_render_to_texture") ? "yes" : "no"}, GPU timer: ${scene.motion.timer ? "yes" : "no"}`,
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

  const stats = (ivals, cpu) => {
    const s = ivals.slice().sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const c = cpu.slice().sort((a, b) => a - b);
    return `${(1000 / q(0.5)).toFixed(0).padStart(4)} fps   p95 ${q(0.95).toFixed(1).padStart(5)} ms   worst ${s[s.length - 1].toFixed(1).padStart(5)} ms   main thread ${c[c.length >> 1].toFixed(1)} ms`;
  };
  // One run: `step` moves something every frame; frames and main-thread time measured.
  const run = async (label, step) => {
    onProgress?.(label);
    const log = scene.frameLog;
    const ivals = [];
    const cpu = [];
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
      } else {
        n0 = log.n;
      }
    }
    for (let k = n0; k < log.n; k++) cpu.push(log.cpu[k % log.time.length]);
    lines.push(`${label.padEnd(28)} ${ivals.length ? stats(ivals, cpu.length ? cpu : [0]) : "no frames"}`);
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
  // Measured at full resolution: the adaptive one held (it had motion at this scale).
  lines.push(`Motion was drawn at ${Math.round(scene.motion.scale * 100)} %`, "");
  const scale = scene.motion.scale;
  scene.motion.frozen = true;
  scene.motion.scale = 1;
  try {
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
    const vec = pages().map((m) => m.userData.uniforms.uVecOn.value);
    await dragging("  no vector text", () => {
      for (const m of pages()) m.userData.uniforms.uVecOn.value = 0;
    }, () => pages().forEach((m, i) => { m.userData.uniforms.uVecOn.value = vec[i]; }));
    const top = new Set([scene.opening - 1, scene.opening]);
    await dragging("  only the two open pages", () => {
      for (const l of scene.leaves) l.mesh.visible = top.has(l.i);
    }, () => {
      for (const l of scene.leaves) l.mesh.visible = true;
    });
    const first = scene.depthFirst;
    await dragging(first ? "  sheets' depth not first" : "  sheets' depth first", () => { scene.depthFirst = !first; }, () => { scene.depthFirst = first; });
    lines.push("");
    // Pages turned quickly: one every 150 ms, forward then back.
    const turning = async (label) => {
      scene.goTo(Math.max(1, Math.floor(scene.model.leafCount / 2) - 6), { animate: false });
      let turned = 0;
      await run(label, (k) => {
        const want = Math.floor(k / 0.15);
        while (turned < want) {
          turned++;
          scene.goTo(scene.opening + (turned <= 7 ? 1 : -1));
        }
      });
    };
    await turning("Turning pages quickly");
    scene.depthFirst = !first;
    try {
      await turning(first ? "  sheets' depth not first" : "  sheets' depth first");
    } finally {
      scene.depthFirst = first;
    }
  } finally {
    scene.motion.scale = scale;
    scene.motion.frozen = false;
    scene.goTo(opening, { animate: false });
    if (closed) scene.setClosed(true, { animate: false });
  }
  return lines.join("\n");
}
