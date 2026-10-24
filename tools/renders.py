# Render fixed views of a document in the app, on the scene's own clock (the same pictures
# every time), and compare two sets: a change that shouldn't alter the picture (a
# refactor, a cleanup) must leave every pixel within 1 or 2 of 255. For development only;
# compare needs numpy and Pillow.
#
#   python tools/renders.py save before                every binding, the sample
#   python tools/renders.py save before --pdf my.pdf   a document of your own
#   python tools/renders.py save after perfect spiral  just these bindings
#   python tools/renders.py compare before after       per view: largest difference, share off
#   python tools/renders.py compare before after --images   and difference pictures (x8)
#   python tools/renders.py sheet before after         a contact sheet: per view before, after,
#                                                      and where they differ (red), one PNG
#
# Pictures go to _build/test-out/renders/<label>/.
import base64, glob, json, os, sys, time

from smoke import BINDINGS, OUT, SmokeError, finish, pdf_arg, start

VIEWS = r"""
  await openDocument();
  app.updateSetup({ binding: %s }); await sleep(6000);
  const sc = app.scene, N = sc.model.leafCount, shots = {};
  const snap = (name) => { settle(sc); shots[name] = sc.renderer.domElement.toDataURL("image/png"); };
  const at = (opening, closed) => { sc.clock = 1e6; sc.goTo(opening, { animate: false }); sc.setClosed(closed, { animate: false }); sc.debugStep(); sc.settleCamera(); sc.lastRequest = -1e9; };
  // Every page these views show uploaded first (uploads go a few a frame, as pages render).
  for (const o of [Math.floor(N / 2), Math.floor(N / 2) + 1, N - 1, 0, N]) { sc.goTo(o, { animate: false }); await sleep(1500); }
  for (let i = 0; i < 200 && (sc.uploads.size || sc.detailQueue.size); i++) await sleep(50);
  const run = (ms) => { for (let t = 0; t <= ms; t += 1000 / 120) { sc.clock = 1e6 + 500 + t; sc.debugStep(); } };
  const view = (az, el, zoom) => { const g = sc.rig; g.free = true; g.azimuth = g.home.azimuth + az; g.elevation = el; g.zoom = zoom; g.springing = false; g.dragging = false; };
  const mid = Math.floor(N / 2);
  at(mid, false); sc.clock = 1e6 + 300; snap("spread");
  at(mid, false); sc.clock = 1e6 + 500; sc.goTo(sc.opening + 1); run(250); snap("turn");
  at(N - 1, false); sc.clock = 1e6 + 500; sc.close(); run(400); snap("closing");
  at(0, true); sc.clock = 1e6 + 300; snap("closed");
  at(N, true); sc.clock = 1e6 + 500; sc.open(); run(300); snap("backopen");
  at(mid, false); sc.clock = 1e6 + 300; view(0.7, -0.6, 1); snap("below");
  at(mid, false); sc.clock = 1e6 + 300; view(1.45, 0.06, 0.8); snap("grazing");
  at(mid, false); sc.clock = 1e6 + 300; view(0.3, 0.5, 0.18); snap("zoom");
  at(mid, false); sc.clock = 1e6 + 500; view(-0.5, -0.3, 1); sc.goTo(sc.opening + 1); run(250); snap("turnbelow");
  sc.rig.free = false;
  sc.clock = null;
  window.__bench = shots;
"""


def save(label, bindings, pdf):
    folder = os.path.join(OUT, "renders", label)
    os.makedirs(folder, exist_ok=True)
    for f in glob.glob(os.path.join(folder, "*.png")):
        os.remove(f)
    started = time.time()
    # One app per binding, all at once: each waits for its pages before drawing.
    runs = {b: start(f"renders-{b}", VIEWS % json.dumps(b), pdf=pdf) for b in bindings}
    failed = 0
    for b, p in runs.items():
        try:
            shots = finish(p)
        except SmokeError as e:
            print(f"{b}: {e}")
            failed += 1
            continue
        for name, url in shots.items():
            with open(os.path.join(folder, f"{b}-{name}.png"), "wb") as fh:
                fh.write(base64.b64decode(url.split(",", 1)[1]))
        print(f"{b}: {len(shots)} views")
    print(f"saved to {folder} - {time.time() - started:.0f} s")
    return failed


def compare(a, b, images):
    import numpy as np
    from PIL import Image
    fa_dir, fb_dir = (os.path.join(OUT, "renders", x) for x in (a, b))
    names = sorted(os.path.basename(f) for f in glob.glob(os.path.join(fa_dir, "*.png")))
    if not names:
        raise SystemExit(f"nothing saved as {a}")
    worst = 0
    for name in names:
        fb = os.path.join(fb_dir, name)
        if not os.path.exists(fb):
            print(f"{name:28s} missing in {b}")
            worst = 255
            continue
        x = np.asarray(Image.open(os.path.join(fa_dir, name)).convert("RGB")).astype(int)
        y = np.asarray(Image.open(fb).convert("RGB")).astype(int)
        if x.shape != y.shape:
            print(f"{name:28s} sizes differ: {x.shape[1]} x {x.shape[0]} and {y.shape[1]} x {y.shape[0]}")
            worst = 255
            continue
        d = np.abs(x - y).max(axis=2)
        worst = max(worst, int(d.max()))
        print(f"{name:28s} max {d.max():3d}   off by more than 2: {(d > 2).mean() * 100:6.3f} %   mean {d.mean():.3f}")
        if images:
            out = os.path.join(OUT, "renders", f"diff-{a}-{b}")
            os.makedirs(out, exist_ok=True)
            Image.fromarray(np.clip(d * 8, 0, 255).astype(np.uint8)).save(os.path.join(out, name))
    print(f"{len(names)} views, largest difference {worst} of 255")
    return worst > 2


def sheet(a, b, scale=0.35):
    """One picture of every view: before | after | where they differ (red over a faint after),
    a row a view, labelled; for reviewing a change before it is handed over."""
    import numpy as np
    from PIL import Image, ImageDraw
    fa_dir, fb_dir = (os.path.join(OUT, "renders", x) for x in (a, b))
    names = sorted(os.path.basename(f) for f in glob.glob(os.path.join(fa_dir, "*.png")))
    names = [n for n in names if os.path.exists(os.path.join(fb_dir, n))]
    if not names:
        raise SystemExit(f"no views in both {a} and {b}")
    rows = []
    for name in names:
        x = Image.open(os.path.join(fa_dir, name)).convert("RGB")
        y = Image.open(os.path.join(fb_dir, name)).convert("RGB")
        w, h = int(x.width * scale), int(x.height * scale)
        xa, ya = np.asarray(x).astype(int), np.asarray(y).astype(int)
        changed = np.abs(xa - ya).max(axis=2) > 2
        faint = (ya * 0.35 + 255 * 0.65).astype(np.uint8)
        faint[changed] = [220, 30, 30]
        # Changes a pixel wide still show once scaled down: grown before shrinking.
        diff = Image.fromarray(faint).resize((w, h), Image.Resampling.BOX)
        if changed.any():
            mask = Image.fromarray((changed * 255).astype(np.uint8)).resize((w, h), Image.Resampling.BOX)
            red = Image.new("RGB", (w, h), (220, 30, 30))
            diff.paste(red, (0, 0), mask.point(lambda v: 255 if v > 0 else 0))
        row = Image.new("RGB", (3 * w + 40, h + 28), "white")
        for k, im in enumerate([x.resize((w, h), Image.Resampling.LANCZOS), y.resize((w, h), Image.Resampling.LANCZOS), diff]):
            row.paste(im, (10 + k * (w + 10), 24))
        share = changed.mean() * 100
        ImageDraw.Draw(row).text((10, 6), f"{name[:-4]}   before | after | changed: {share:.3f} % of the view", fill="black")
        rows.append(row)
    out = Image.new("RGB", (rows[0].width, sum(r.height for r in rows)), "white")
    y = 0
    for r in rows:
        out.paste(r, (0, y))
        y += r.height
    path = os.path.join(OUT, "renders", f"sheet-{a}-{b}.png")
    out.save(path)
    print(f"{len(rows)} views: {path}")
    return path


if __name__ == "__main__":
    pdf, args = pdf_arg(sys.argv[1:])
    if len(args) >= 2 and args[0] == "save":
        bad = [b for b in args[2:] if b not in BINDINGS]
        if bad:
            raise SystemExit(f"unknown binding {bad[0]}: one of {', '.join(BINDINGS)}")
        sys.exit(1 if save(args[1], args[2:] or BINDINGS, pdf) else 0)
    if len(args) >= 3 and args[0] == "compare":
        sys.exit(1 if compare(args[1], args[2], "--images" in args) else 0)
    if len(args) >= 3 and args[0] == "sheet":
        sheet(args[1], args[2])
        sys.exit(0)
    raise SystemExit("python tools/renders.py save <label> [--pdf FILE] [binding ...] | compare <a> <b> [--images] | sheet <a> <b>")
