# Mouse and keyboard in the app, on the scene's own clock (the same result every time):
# wheel zoom, a drag that orbits, a space-drag that pans, a double space that resets, clicks
# that turn pages forward and back. Records where the camera and the book end up after each,
# so two versions can be compared: a change to the input code that shouldn't alter how it
# behaves must leave every figure the same. For development only.
#
#   python tools/input.py save before          perfect binding and spiral, the sample
#   python tools/input.py save before --pdf my.pdf
#   python tools/input.py compare before after
#
# Results go to _build/test-out/input/<label>.json.
import json, os, sys, time

from smoke import OUT, SmokeError, finish, pdf_arg, start

STEPS = r"""
  await openDocument();
  app.updateSetup({ binding: %s }); await sleep(5000);
  const sc = app.scene, el = sc.renderer.domElement, N = sc.model.leafCount;
  el.setPointerCapture = () => {}; // a made-up pointer can't be captured
  const box = el.getBoundingClientRect();
  const at = (fx, fy) => ({ clientX: box.left + fx * box.width, clientY: box.top + fy * box.height });
  let t = 1e6;
  // Time passes only here: 60 frames a second on the set clock, then draw (places the camera).
  const advance = (ms) => { const end = t + ms; for (; t < end; t += 1000 / 60) { sc.clock = t; sc.debugStep(); } sc.clock = t; settle(sc); };
  const pointer = (type, fx, fy, more = {}) => el.dispatchEvent(new PointerEvent(type,
    { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...at(fx, fy), ...more }));
  const wheel = (deltaY, n) => { for (let i = 0; i < n; i++) el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, deltaMode: 0, ...at(0.5, 0.5) })); };
  const key = (type) => window.dispatchEvent(new KeyboardEvent(type, { code: "Space", key: " ", bubbles: true, cancelable: true }));
  const drag = (dx, dy, moves) => {
    let x = 0.5, y = 0.5;
    pointer("pointerdown", x, y);
    for (let i = 0; i < moves; i++) { x += dx / box.width; y += dy / box.height; pointer("pointermove", x, y, { movementX: dx, movementY: dy }); }
    pointer("pointerup", x, y);
  };
  const click = (fx) => { pointer("pointerdown", fx, 0.5); pointer("pointerup", fx, 0.5); };
  const r6 = (v) => Math.round(v * 1e6) / 1e6;
  const now = () => {
    const g = sc.rig, c = sc.camera.position;
    return { azimuth: r6(g.azimuth), elevation: r6(g.elevation), zoom: r6(g.zoom), pan: [g.pan.x, g.pan.y, g.pan.z].map(r6),
      free: !!g.free, opening: sc.opening, closed: sc.isClosed, camera: [c.x, c.y, c.z].map(r6) };
  };
  const out = {};
  sc.clock = t; sc.goTo(Math.floor(N / 2), { animate: false }); sc.setClosed(false, { animate: false }); sc.settleCamera(); advance(100);
  out.start = now();
  wheel(-120, 4); advance(800); out.zoomIn = now();
  drag(6, 2, 12); out.orbiting = now();
  advance(1500); out.orbited = now();
  await sleep(400); // a space more than a double tap's time after the last
  key("keydown"); drag(-5, 4, 10); key("keyup"); advance(300); out.panned = now();
  await sleep(400);
  key("keydown"); key("keyup"); key("keydown"); key("keyup"); advance(2000); out.reset = now();
  click(0.65); advance(2000); out.clickRight = now();
  click(0.35); advance(2000); out.clickLeft = now();
  wheel(120, 6); advance(1000); out.zoomOut = now();
  sc.clock = null;
  window.__bench = out;
"""
BINDINGS = ["perfect", "spiral"]


def save(label, pdf):
    folder = os.path.join(OUT, "input")
    os.makedirs(folder, exist_ok=True)
    started = time.time()
    runs = {b: start(f"input-{b}", STEPS % json.dumps(b), pdf=pdf) for b in BINDINGS}
    result, failed = {}, 0
    for b, p in runs.items():
        try:
            result[b] = finish(p)
        except SmokeError as e:
            print(f"{b}: {e}")
            failed += 1
    with open(os.path.join(folder, f"{label}.json"), "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=1)
    for b, steps in result.items():
        print(b)
        for name, s in steps.items():
            print(f"  {name:11s} opening {s['opening']:3d}{' closed' if s['closed'] else '       '}  zoom {s['zoom']:.3f}"
                  f"  azimuth {s['azimuth']:+.3f}  elevation {s['elevation']:+.3f}{'  free' if s['free'] else ''}")
    print(f"saved as {label} - {time.time() - started:.0f} s")
    return failed


def compare(a, b):
    def load(label):
        with open(os.path.join(OUT, "input", f"{label}.json"), encoding="utf-8") as fh:
            return json.load(fh)
    x, y = load(a), load(b)
    off = 0
    for binding in BINDINGS:
        for name in x.get(binding, {}):
            s, t = x[binding][name], y.get(binding, {}).get(name)
            if t is None:
                print(f"{binding} {name}: missing in {b}")
                off += 1
                continue
            diffs = []
            for k, v in s.items():
                w = t.get(k)
                vs, ws = (v if isinstance(v, list) else [v]), (w if isinstance(w, list) else [w])
                if any(isinstance(p, bool) or isinstance(q, bool) or not isinstance(p, (int, float)) or abs(p - q) > 1e-5
                       for p, q in zip(vs, ws)) and v != w:
                    diffs.append(f"{k} {v} -> {w}")
            print(f"{binding} {name:11s} {'same' if not diffs else '; '.join(diffs)}")
            off += bool(diffs)
    print("all the same" if not off else f"{off} differ")
    return off


if __name__ == "__main__":
    pdf, args = pdf_arg(sys.argv[1:])
    if len(args) == 2 and args[0] == "save":
        sys.exit(1 if save(args[1], pdf) else 0)
    if len(args) == 3 and args[0] == "compare":
        sys.exit(1 if compare(args[1], args[2]) else 0)
    raise SystemExit("python tools/input.py save <label> [--pdf FILE] | compare <a> <b>")
