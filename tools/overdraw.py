# How many sheet layers the graphics card shades per pixel, in fixed views: what a GPU that
# can't skip hidden points before shading them pays (Apple's under Chromium and Safari, see
# draw.js makeOccluder), counted exactly on any computer. Every sheet's surfaces drawn with a
# shader that only adds one per point, over the depth the occluder leaves (none with it off):
# mean, the worst pixel, the share of the view over 8 layers, and a heat map a view. For
# development only; needs numpy and Pillow.
#
#   python tools/overdraw.py                        saddle binding, the sample, occluder off and every 8th sheet
#   python tools/overdraw.py perfect --pdf my.pdf
#   python tools/overdraw.py saddle --every 0 4 8 16   these choices of occluder sheets (0: none;
#                                                      -1: the sheets' own depth first, the tool's check)
#
# Heat maps go to _build/test-out/overdraw/<binding>-<view>-every<n>.png.
import base64, json, os, sys

from smoke import BINDINGS, OUT, SmokeError, pdf_arg, run

SCRIPT = r"""
  const THREE = await import("three");
  await openDocument();
  app.updateSetup({ binding: %s }); await sleep(6000);
  const sc = app.scene, N = sc.model.leafCount, r = sc.renderer, gl = r.getContext();
  for (const o of [Math.floor(N / 2), 0, N]) { sc.goTo(o, { animate: false }); await sleep(1500); }
  for (let i = 0; i < 200 && (sc.uploads.size || sc.detailQueue.size); i++) await sleep(50);
  const at = (opening, closed) => { sc.clock = 1e6; sc.goTo(opening, { animate: false }); sc.setClosed(closed, { animate: false }); sc.debugStep(); sc.settleCamera(); sc.lastRequest = -1e9; };
  const step = (ms) => { for (let t = 0; t <= ms; t += 1000 / 120) { sc.clock = 1e6 + 500 + t; sc.debugStep(); } };
  const view = (az, el, zoom) => { const g = sc.rig; g.free = true; g.pan = { x: 0, y: 0, z: 0 }; g.azimuth = g.home.azimuth + az; g.elevation = el; g.zoom = zoom; g.springing = false; g.dragging = false; sc.zoomBias = 1; };
  const mid = Math.floor(N / 2);
  // One per point of any sheet surface, over the depth already there (the occluder's).
  const count = new THREE.ShaderMaterial({
    vertexShader: "void main() {\n#include <beginnormal_vertex>\n#include <begin_vertex>\ngl_Position = projectionMatrix * modelViewMatrix * vec4( transformed, 1.0 );\n}",
    fragmentShader: "void main() { gl_FragColor = vec4( 1.0 ); }",
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  });
  count.onBeforeCompile = (shader) => sc.sheetDepth.onBeforeCompile(shader); // the sheets built on the GPU, as every sheet program has it
  // The occluder's own pass: its depth, and one in the colour to count what it covers (cleared before the sheets).
  const mark = new THREE.ShaderMaterial({ vertexShader: count.vertexShader, fragmentShader: count.fragmentShader, depthWrite: true, depthTest: true, side: THREE.DoubleSide });
  mark.onBeforeCompile = (shader) => { sc.sheetDepth.onBeforeCompile(shader); shader.uniforms.uSheetSide = sc.occluder.side; };
  const markSheets = new THREE.ShaderMaterial({ vertexShader: count.vertexShader, fragmentShader: count.fragmentShader, depthWrite: true, depthTest: true, side: THREE.DoubleSide });
  markSheets.onBeforeCompile = (shader) => sc.sheetDepth.onBeforeCompile(shader);
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true });
  const leafMeshes = new Set(sc.leaves.map((l) => l.mesh));
  // `every` -1: the sheets' own depth first instead of the occluder's (what a GPU that skips
  // hidden points sees: about one layer a pixel; the tool's own check).
  const layers = (every) => {
    sc.occluderEvery = Math.max(0, every);
    settle(sc); // lays out, chooses the occluder's sheets, draws
    const shown = [];
    sc.scene.traverse((o) => { if (o.isMesh) { shown.push([o, o.visible]); o.visible = every < 0 ? leafMeshes.has(o) : o === sc.occluder?.mesh; } });
    const was = { target: r.getRenderTarget(), clear: r.autoClear, override: sc.scene.overrideMaterial, background: sc.scene.background };
    let covered = 0;
    try {
      sc.scene.background = null; // (a background colour has three clear colour and depth on every render, autoClear or not)
      r.setRenderTarget(target);
      r.setClearColor(0x000000, 1);
      r.clear();
      r.autoClear = false;
      sc.scene.overrideMaterial = every < 0 ? markSheets : mark;
      r.render(sc.scene, sc.camera); // the occluder alone: its depth
      const cov = new Float32Array(W * H * 4);
      r.readRenderTargetPixels(target, 0, 0, W, H, cov);
      for (let i = 0; i < W * H; i++) if (cov[4 * i] > 0.5) covered++;
      r.clear(true, false, false);
      for (const [o, v] of shown) o.visible = leafMeshes.has(o);
      sc.scene.overrideMaterial = count;
      r.render(sc.scene, sc.camera);
    } finally {
      sc.scene.background = was.background;
      sc.scene.overrideMaterial = was.override;
      r.autoClear = was.clear;
      r.setRenderTarget(was.target);
      for (const [o, v] of shown) o.visible = v;
    }
    const px = new Float32Array(W * H * 4);
    r.readRenderTargetPixels(target, 0, 0, W, H, px);
    let sum = 0, max = 0, over = 0, paper = 0;
    const hist = new Uint32Array(256);
    for (let i = 0; i < W * H; i++) {
      const c = Math.round(px[4 * i]);
      if (c > 0) { paper++; sum += c; if (c > 8) over++; if (c > max) max = c; }
      hist[Math.min(255, c)]++;
    }
    // The heat map at a quarter size: the most layers in each 4 × 4 block, rows top down.
    const w = Math.floor(W / 4), h = Math.floor(H / 4);
    const map = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) m = Math.max(m, px[4 * ((H - 1 - (4 * y + dy)) * W + 4 * x + dx)]);
      map[y * w + x] = Math.min(255, Math.round(m));
    }
    let bin = ""; for (let i = 0; i < map.length; i++) bin += String.fromCharCode(map[i]);
    return { pixels: W * H, paper, covered, mean: paper ? sum / paper : 0, max, over8: paper ? over / paper : 0, w, h, map: btoa(bin) };
  };
  const EVERY = %s;
  const views = {
    spread: () => { at(mid, false); sc.clock = 1e6 + 300; },
    turn: () => { at(mid, false); sc.clock = 1e6 + 500; sc.goTo(sc.opening + 1); step(250); },
    closed: () => { at(0, true); sc.clock = 1e6 + 300; },
    foreedge: () => { at(mid, false); sc.clock = 1e6 + 300; view(Math.PI / 2, 0.12, 0.6); },
    below: () => { at(mid, false); sc.clock = 1e6 + 300; view(0.7, -0.6, 1); },
    grazing: () => { at(mid, false); sc.clock = 1e6 + 300; view(1.45, 0.06, 0.8); },
  };
  const out = {};
  for (const [name, go] of Object.entries(views)) {
    out[name] = {};
    for (const every of EVERY) { go(); out[name][every] = layers(every); }
  }
  sc.occluderEvery = EVERY[0];
  sc.rig.free = false;
  sc.clock = null;
  window.__bench = out;
"""

PALETTE = [(0, 0, 0), (40, 40, 120), (30, 120, 200), (40, 200, 120), (230, 220, 40), (240, 120, 30), (220, 30, 30), (255, 255, 255)]  # 0, 1, 2, 4, 8, 16, 32, 64+ layers


def heat(map_b64, w, h, path):
    import numpy as np
    from PIL import Image
    counts = np.frombuffer(base64.b64decode(map_b64), dtype=np.uint8).reshape(h, w).astype(float)
    # Colour by the layers' doubling: 1, 2, 4, 8, 16, 32, 64 and more.
    pos = np.where(counts > 0, np.log2(np.maximum(counts, 1)) + 1, 0)
    pos = np.clip(pos, 0, len(PALETTE) - 1)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, len(PALETTE) - 1)
    t = (pos - lo)[..., None]
    pal = np.array(PALETTE, dtype=float)
    rgb = pal[lo] * (1 - t) + pal[hi] * t
    Image.fromarray(rgb.astype(np.uint8)).save(path)


if __name__ == "__main__":
    pdf, args = pdf_arg(sys.argv[1:])
    every = [0, 8]
    if "--every" in args:
        i = args.index("--every")
        every = [int(v) for v in args[i + 1:]]
        args = args[:i]
    binding = args[0] if args else "saddle"
    if binding not in BINDINGS:
        raise SystemExit(f"unknown binding {binding}: one of {', '.join(BINDINGS)}")
    folder = os.path.join(OUT, "overdraw")
    os.makedirs(folder, exist_ok=True)
    try:
        out = run(f"overdraw-{binding}", SCRIPT % (json.dumps(binding), json.dumps(every)), pdf=pdf, timeout=600)
    except SmokeError as e:
        raise SystemExit(f"overdraw: {e}")
    print(f"{binding}: layers shaded per paper pixel (mean / worst / share over 8), by occluder sheets (0: none)")
    print(f"{'view':10s}" + "".join(f"{('every ' + str(e)) if e > 0 else 'none' if e == 0 else 'sheets first':>34s}" for e in every))
    for name, by in out.items():
        cells = []
        for e in every:
            s = by[str(e)]
            cells.append(f"{s['mean']:6.2f} / {s['max']:4d} / {s['over8'] * 100:6.2f} % ({s['covered'] / max(1, s['paper']) * 100:3.0f} %)")
            heat(s["map"], s["w"], s["h"], os.path.join(folder, f"{binding}-{name}-every{e}.png"))
        print(f"{name:10s}" + "".join(f"{c:>34s}" for c in cells))
    print(f"heat maps in {folder}")
