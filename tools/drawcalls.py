# One frame's draw calls, by what they draw: sheet faces, backs, edges, fillers, the occluder,
# the folds, everything else, and the shadow map's when it is drawn again; for a binding and a
# document, at three views. What batching the sheets (draw.js makeBatches) saves, counted
# exactly. For development only.
#
#   python tools/drawcalls.py                      saddle binding, the sample
#   python tools/drawcalls.py perfect --pdf my.pdf
import json, sys

from smoke import BINDINGS, SmokeError, pdf_arg, run

SCRIPT = r"""
  await openDocument();
  app.updateSetup({ binding: %s }); await sleep(6000);
  const sc = app.scene, N = sc.model.leafCount, r = sc.renderer;
  for (const o of [Math.floor(N / 2), 0, N]) { sc.goTo(o, { animate: false }); await sleep(1500); }
  for (let i = 0; i < 200 && (sc.uploads.size || sc.detailQueue.size); i++) await sleep(50);
  const leafOf = new Map(sc.leaves.map((l) => [l.mesh, l]));
  const batches = new Set(Object.values(sc.batches ?? {}).map((b) => b?.mesh ?? b).filter(Boolean));
  // One render of the frame, its draws tallied by kind; `shadow`: the shadow map drawn again too.
  const count = (shadow) => {
    settle(sc); // lays out and draws (twice): everything in place
    const tally = {};
    const orig = r.renderBufferDirect.bind(r);
    r.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      const inShadow = camera !== sc.camera;
      const leaf = leafOf.get(object);
      let key;
      if (leaf) {
        const idx = group ? group.materialIndex : -1;
        key = "sheet " + (material === leaf.front ? "front" : material === leaf.back ? "back" : leaf.fillers?.includes(material) ? "filler" : idx === 2 ? "edges" : idx >= 3 ? "coil strip" : "part " + idx);
      } else if (object === sc.occluder?.mesh) key = "occluder";
      else if (batches.has(object)) key = "batch " + (object.name || "?");
      else key = (object.name || object.type) + " / " + material.type;
      key = (inShadow ? "shadow: " : "") + key;
      tally[key] = (tally[key] ?? 0) + 1;
      return orig(camera, scene, geometry, material, object, group);
    };
    if (shadow) r.shadowMap.needsUpdate = true;
    sc.lastRequest = -1e9;
    sc.composer.render();
    r.renderBufferDirect = orig;
    return tally;
  };
  const view = (az, el, zoom) => { const g = sc.rig; g.free = true; g.pan = { x: 0, y: 0, z: 0 }; g.azimuth = g.home.azimuth + az; g.elevation = el; g.zoom = zoom; g.springing = false; g.dragging = false; sc.zoomBias = 1; };
  const out = {};
  sc.goTo(Math.floor(N / 2), { animate: false }); sc.setClosed(false, { animate: false }); sc.rig.free = false; sc.settleCamera();
  out["open at the middle"] = count(false);
  out["open, shadow map drawn again"] = count(true);
  view(Math.PI / 2, 0.12, 0.6);
  out["low at the fore-edge"] = count(false);
  sc.rig.free = false;
  sc.goTo(0, { animate: false }); sc.setClosed(true, { animate: false }); sc.settleCamera();
  out.closed = count(false);
  window.__bench = { out, sheets: N, multiDraw: !!r.getContext().getExtension("WEBGL_multi_draw") };
"""

if __name__ == "__main__":
    pdf, args = pdf_arg(sys.argv[1:])
    binding = args[0] if args else "saddle"
    if binding not in BINDINGS:
        raise SystemExit(f"unknown binding {binding}: one of {', '.join(BINDINGS)}")
    try:
        res = run(f"drawcalls-{binding}", SCRIPT % json.dumps(binding), pdf=pdf, timeout=600)
    except SmokeError as e:
        raise SystemExit(f"drawcalls: {e}")
    print(f"{binding}: {res['sheets']} sheets; multi-draw {'yes' if res['multiDraw'] else 'no'}")
    for label, tally in res["out"].items():
        print(f"\n{label}: {sum(tally.values())} draw calls")
        for key, n in sorted(tally.items(), key=lambda kv: -kv[1]):
            print(f"  {n:5d}  {key}")
