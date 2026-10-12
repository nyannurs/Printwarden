# Click replays: clicks through sequences in the real app (a development smoke run), on the
# scene's own clock, and checks every frame for sheets passing through each other: every
# sheet's cross-section at its drawn thickness, with its bow, at rows 0, 2, 4, 6 and 8 of 9
# (head to foot; corner-led turns lay rows out on their own); and for folds: neighbouring
# rows of a sheet more than FOLD_DEG apart (a page sent while still under pages in the air
# once had its middle row flat and the others lifted). One app per binding, all at once.
# For development only.
#
#   python tools/replay.py                    every binding
#   python tools/replay.py perfect hardcover  just these
import json, os, sys, time

from smoke import BINDINGS, ROOT, SmokeError, finish, start

bindings = sys.argv[1:] or BINDINGS
for b in bindings:
    if b not in BINDINGS:
        raise SystemExit(f"unknown binding {b}: one of {', '.join(BINDINGS)}")

# The crossing test the geometry proof uses (exact, binned), inlined: the app serves only app/.
with open(os.path.join(ROOT, "tests", "crossings.js"), encoding="utf-8") as f:
    CROSSINGS = f.read().replace("export function", "function")

JS = r"""
  const BINDING = %s;
  await openDocument();
  %s
  const FILL = 0.9;
  // A leaf's cross-section at row r (zz: -1 head .. 1 foot), lifted by its bow along its normal.
  const outline = (sc, leaf, r, zz, p) => {
    const t = sc.model.thickness[leaf.i], half = t * FILL / 2, n = p.x.length;
    const W = leaf.width ?? sc.model.width, bow = leaf.bows ? leaf.bows[r] : leaf.bow || 0;
    const out = new Float64Array(4 * n);
    for (let k = 0; k < n; k++) {
      const nx = -Math.cos(p.phi[k]), ny = Math.sin(p.phi[k]);
      const a = Math.min(1, Math.hypot(p.x[k] - p.x[0], p.y[k] - p.y[0]) / W);
      const lift = bow * a * a * (0.4 + 0.6 * zz * zz);
      const cx = p.x[k] + nx * lift, cy = p.y[k] + ny * lift;
      out[2 * k] = cx + nx * half; out[2 * k + 1] = cy + ny * half; // front, spine to fore-edge
      const b = 2 * (2 * n - 1 - k); out[b] = cx - nx * half; out[b + 1] = cy - ny * half; // back, returning
    }
    return out;
  };
  const FOLD_DEG = 8; // a corner-led turn's rows differ by a few degrees each
  const chord = (p) => { const k = p.x.length - 1; return Math.atan2(p.x[k] - p.x[0], p.y[k] - p.y[0]) * 180 / Math.PI; };
  const check = (sc) => {
    const L = sc.leaves, found = new Set();
    for (const l of L) {
      if (!l.rowsActive) continue;
      for (let r = 0; r + 1 < l.rows.length; r++) if (Math.abs(chord(l.rows[r]) - chord(l.rows[r + 1])) > FOLD_DEG) { found.add('fold ' + l.i); break; }
    }
    const R = L[0].rows?.length || 9;
    for (const r of [0, 2, 4, 6, 8]) {
      const zz = (2 * r) / (R - 1) - 1;
      const outs = L.map((l) => outline(sc, l, r, zz, l.rowsActive ? l.rows[r] : l.profile));
      for (const [i, j] of crossingPairs(outs)) found.add(i + '/' + j);
    }
    return [...found];
  };
  const sc = app.scene;
  const step = () => (sc.debugStep ? sc.debugStep() : sc.debugSample(0.5, 0.5)); // lay out, no drawing
  const n = () => sc.model.leafCount;
  // Sequences: [name, start {opening, closed}, clicks [[ms, action]]]; action: +1/-1 turn,
  // 'open', 'button' (the Open/Close book button: closing from a spread swings the pile over).
  const click = (a) => {
    if (a === 'button') { if (sc.isClosed || sc.atCover) sc.open(); else sc.close(); }
    else if (a === 'open' || sc.isClosed) sc.open();
    else sc.goTo(sc.opening + a);
  };
  const seqs = (N) => {
    const mid = Math.floor(N / 2), out = [];
    for (const gap of [80, 150, 260]) {
      out.push(['closed: open, in, out, out @' + gap, { opening: 0, closed: true }, [[0, 'open'], [gap * 3, 1], [gap * 4, -1], [gap * 5, -1]]]);
      out.push(['cover: in, out, out @' + gap, { opening: 1, closed: false }, [[0, 1], [gap, -1], [gap * 2, -1]]]);
      out.push(['cover: out then in @' + gap, { opening: 1, closed: false }, [[0, -1], [gap, 1], [gap * 2, 1]]]);
      out.push(['mid: left right x6 @' + gap, { opening: mid, closed: false }, [0, 1, 2, 3, 4, 5].map((k) => [k * gap, k %% 2 ? -1 : 1])]);
      out.push(['mid: 4 forward then 4 back @' + gap, { opening: mid, closed: false }, [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k * gap, k < 4 ? 1 : -1])]);
      out.push(['end: out, in, in @' + gap, { opening: N - 1, closed: false }, [[0, 1], [gap, -1], [gap * 2, 1]]]);
      out.push(['closed: open, out (close), open @' + gap, { opening: 0, closed: true }, [[0, 'open'], [gap * 4, -1], [gap * 5, 'open']]]);
      out.push(['closed: in x4 @' + gap, { opening: 0, closed: true }, [[0, 1], [gap, 1], [gap * 2, 1], [gap * 3, 1]]]);
      out.push(['closed at the back: out x4 @' + gap, { opening: N, closed: true }, [[0, -1], [gap, -1], [gap * 2, -1], [gap * 3, -1]]]);
      out.push(['closed at the back: button x2 @' + gap, { opening: N, closed: true }, [[0, 'button'], [gap * 3, 'button']]]);
      out.push(['mid: button, then in @' + gap, { opening: mid, closed: false }, [[0, 'button'], [gap, 1]]]);
    }
    // Random mashing: seeded, so a failure can be replayed.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) %% 2147483647) / 2147483647;
    for (let r = 0; r < 10; r++) {
      const startOpen = Math.floor(rnd() * (N + 1));
      let t = 0; const clicks = [];
      for (let c = 0; c < 14; c++) { clicks.push([t, rnd() < 0.5 ? 1 : -1]); t += 40 + Math.floor(rnd() * 260); }
      out.push(['random ' + r + ' from ' + startOpen, { opening: startOpen, closed: startOpen === 0 && rnd() < 0.5 }, clicks]);
    }
    return out;
  };
  app.updateSetup({ binding: BINDING }); await sleep(3000);
  const bad = []; let frames = 0;
  const started = performance.now();
  for (const [name, start, clicks] of seqs(n())) {
    sc.clock = performance.now();
    sc.goTo(start.opening, { animate: false });
    sc.setClosed(start.closed, { animate: false });
    step();
    const t0 = sc.clock + 1000; sc.lastRequest = -1e9;
    const pending = clicks.slice(); let firstBad = null;
    for (let t = 0; t < 9000; t += 20) {
      while (pending.length && pending[0][0] <= t) { sc.clock = t0 + pending[0][0]; click(pending.shift()[1]); }
      sc.clock = t0 + t; step(); frames++;
      const f = check(sc);
      if (f.length && !firstBad) firstBad = { t, leaves: f.slice(0, 6), closed: +sc.closed.toFixed(2), thetas: f.filter((p) => p.includes('/')).slice(0, 2).map((p) => p.split('/').map((i) => +sc.leaves[+i].theta.toFixed(1))) };
      const busy = sc.leaves.some((l) => l.start != null) || sc.closeAnim;
      if (!pending.length && !busy && t > 400) break;
    }
    if (firstBad) bad.push(name + ' -> ' + JSON.stringify(firstBad));
  }
  sc.clock = null;
  window.__bench = { [BINDING]: bad, frames, seconds: +((performance.now() - started) / 1000).toFixed(1) };
"""

started = time.time()
runs = {b: start(f"replay-{b}", JS % (json.dumps(b), CROSSINGS)) for b in bindings}
failed = 0
for b, p in runs.items():
    try:
        rep = finish(p, timeout=1800)
    except SmokeError as e:
        print(f"{b}: {e}")
        failed += 1
        continue
    bad = rep[b]
    failed += len(bad) > 0
    print(f"{b}: {len(bad)} failing sequences ({rep['frames']} frames, {rep['seconds']} s)")
    for x in bad:
        print("   ", x[:300])
print(f"{'all passed' if not failed else f'{failed} bindings failed'} - {time.time() - started:.0f} s")
sys.exit(1 if failed else 0)
