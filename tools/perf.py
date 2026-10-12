# How fast the app draws on this computer, in the app: first the frame loop (at rest it asks
# for no frames at all; dragging, one frame per screen refresh, no more), then the
# performance check (Ctrl/Cmd+Shift+P), whose report it prints. For development only.
#
#   python tools/perf.py                    spiral binding, the sample
#   python tools/perf.py perfect --pdf my.pdf
import json, sys

from smoke import BINDINGS, SmokeError, pdf_arg, run

SCRIPT = r"""
  await openDocument();
  app.updateSetup({ binding: %s }); await sleep(6000);
  const sc = app.scene, loop = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    for (let i = 0; i < 100 && sc.frameRequest != null; i++) await sleep(50); // at rest: no frame asked for
    const rested = sc.frameRequest == null;
    const n0 = sc.frameLog.n;
    let refreshes = 0;
    sc.rig.beginDrag(); sc.dirty = true;
    await new Promise((done) => {
      const t0 = performance.now();
      const step = (t) => { refreshes++; sc.rig.drag(3, 1); if (t - t0 < 1000) requestAnimationFrame(step); else done(); };
      requestAnimationFrame(step);
    });
    sc.rig.endDrag();
    loop.push({ rested, drawn: sc.frameLog.n - n0, refreshes });
    await sleep(1500);
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyP", key: "P", ctrlKey: true, shiftKey: true, bubbles: true }));
  for (let i = 0; i < 900 && !document.querySelector(".report-text"); i++) await sleep(100);
  const report = document.querySelector(".report-text");
  window.__bench = { loop, report: report ? report.textContent : null };
"""

if __name__ == "__main__":
    pdf, args = pdf_arg(sys.argv[1:])
    binding = args[0] if args else "spiral"
    if binding not in BINDINGS:
        raise SystemExit(f"unknown binding {binding}: one of {', '.join(BINDINGS)}")
    try:
        res = run("perf", SCRIPT % json.dumps(binding), pdf=pdf)
    except SmokeError as e:
        raise SystemExit(str(e))
    bad = 0
    print("frame loop (1 s dragging, four times):")
    for c in res["loop"]:
        # One frame per refresh, give or take the first and last.
        ok = c["rested"] and abs(c["drawn"] - c["refreshes"]) <= 2
        bad += not ok
        print(f"  {'ok  ' if ok else 'FAIL'} at rest before: {'yes' if c['rested'] else 'NO'}   drawn {c['drawn']} in {c['refreshes']} refreshes")
    print()
    print(res["report"] or "no performance report")
    sys.exit(1 if bad or not res["report"] else 0)
