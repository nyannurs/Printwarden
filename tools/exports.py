# The exports, in the app: a 3840 x 2160 screenshot (in tiles) and a short MP4 through the
# app's own save, timed. For development only.
#
#   python tools/exports.py                 perfect binding, the sample
#   python tools/exports.py spiral --pdf my.pdf
#
# The video goes to _build/test-out/exports/video.mp4.
import json, os, sys

from smoke import BINDINGS, OUT, SmokeError, pdf_arg, run

SCRIPT = r"""
  await openDocument();
  app.updateSetup({ binding: %s }); await sleep(6000);
  const sc = app.scene;
  sc.goTo(Math.floor(sc.model.leafCount / 2), { animate: false }); await sleep(3000);
  const t0 = performance.now();
  const blob = await sc.captureImage({ width: 3840, height: 2160, prepare: app.prepareCaptureTile });
  const head = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
  const size = new DataView(head.buffer);
  const shot = { bytes: blob.size, ms: Math.round(performance.now() - t0), png: head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47,
    width: size.getUint32(16), height: size.getUint32(20) };
  const t1 = performance.now();
  await app.renderVideo({ width: 540, height: 960, fps: 30, turnSeconds: 0.3, pauseSeconds: 0, transparent: false });
  window.__bench = { shot, video: { ms: Math.round(performance.now() - t1) } };
"""

if __name__ == "__main__":
    pdf, args = pdf_arg(sys.argv[1:])
    binding = args[0] if args else "perfect"
    if binding not in BINDINGS:
        raise SystemExit(f"unknown binding {binding}: one of {', '.join(BINDINGS)}")
    folder = os.path.join(OUT, "exports")
    os.makedirs(folder, exist_ok=True)
    video = os.path.join(folder, "video.mp4")
    if os.path.exists(video):
        os.remove(video)
    try:
        res = run("exports", SCRIPT % json.dumps(binding), pdf=pdf, save_as=os.path.join(folder, "video"))
    except SmokeError as e:
        raise SystemExit(str(e))
    s = res["shot"]
    shot_ok = s["png"] and s["width"] == 3840 and s["height"] == 2160
    print(f"{'ok  ' if shot_ok else 'FAIL'} screenshot {s['width']} x {s['height']}, {s['bytes'] / 1e6:.1f} MB, {s['ms'] / 1000:.1f} s")
    size = os.path.getsize(video) if os.path.exists(video) else 0
    video_ok = size > 10000
    print(f"{'ok  ' if video_ok else 'FAIL'} video {size / 1e6:.1f} MB, {res['video']['ms'] / 1000:.1f} s  ({video})")
    sys.exit(0 if shot_ok and video_ok else 1)
