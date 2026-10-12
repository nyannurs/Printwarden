# Memory and idle activity of the app with a document open and every page visited: what
# the scene holds on the GPU (estimated from its textures), then each of the app's
# processes, sampled from outside while the app sits idle (35 s): memory and CPU. At rest
# the app should use no CPU. For development only; run it on its own (it counts every
# Electron started from _build).
#
#   python tools/memory.py                  spiral binding, the sample
#   python tools/memory.py perfect --pdf my.pdf
import json, os, subprocess, sys, threading, time

from smoke import BINDINGS, SmokeError, pdf_arg, result, start

SCRIPT = r"""
  const THREE = await import("three");
  await openDocument();
  app.updateSetup({ binding: %s }); await sleep(6000);
  const sc = app.scene, N = sc.model.leafCount;
  for (let o = 0; o <= N; o++) { sc.goTo(o); await sleep(350); }
  sc.goTo(Math.floor(N / 2)); await sleep(9000);
  const seen = new Set(), sizes = {}, counts = {};
  const bytes = (t) => {
    const img = t.image;
    const w = img?.width, h = img?.height;
    if (!w || !h) return 0;
    const perPixel = img.data ? img.data.byteLength / (w * h * (img.depth || 1)) : 4;
    const mips = t.generateMipmaps && t.minFilter !== THREE.NearestFilter && t.minFilter !== THREE.LinearFilter ? 4 / 3 : 1;
    return w * h * perPixel * mips;
  };
  const add = (what, t) => {
    if (!t?.isTexture || seen.has(t)) return;
    seen.add(t);
    sizes[what] = (sizes[what] || 0) + bytes(t);
    counts[what] = (counts[what] || 0) + 1;
  };
  for (const l of sc.leaves) for (const m of [l.front, l.back]) {
    const u = m.userData.uniforms;
    add("page images", m.map);
    add("page images", u.uBack.value);
    for (let i = 0; i < 6; i++) add("sharp strips", u["uDetail" + i].value);
    add("small pages", u.uSmall.value);
    add("vector text", u.uVecF.value);
    add("vector text", u.uVecU.value);
    add("finish", u.uFinish.value);
  }
  for (const [, t] of sc.small) add("small pages", t);
  sc.scene.traverse((o) => { for (const m of [].concat(o.material || [])) for (const k of ["map", "bumpMap", "alphaMap", "envMap", "roughnessMap"]) add("other", m[k]); });
  add("other", sc.scene.environment);
  add("sheets", sc.shared.uSheets.value);
  const mb = (v) => +(v / 1048576).toFixed(1);
  const gpu = Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, { mb: mb(v), textures: counts[k] }]));
  console.log("PHASE idle");
  await sleep(45000);
  window.__bench = { gpu, heap: mb(performance.memory.usedJSHeapSize) };
"""

# Every Electron process started from _build: id, kind, private memory, working set, CPU ms.
WINDOWS = r"""$ps = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -like '*node_modules\electron\dist*' }
$out = foreach ($c in $ps) { $g = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue; if ($g) {
  $t = 'main'; if ($c.CommandLine -match '--type=([a-z-]+)') { $t = $Matches[1] }
  if ($c.CommandLine -match '--utility-sub-type=([A-Za-z.]+)') { $t += ':' + $Matches[1] }
  [pscustomobject]@{ id = $c.ProcessId; type = $t; priv = $g.PrivateMemorySize64; ws = $g.WorkingSet64; cpu = $g.TotalProcessorTime.TotalMilliseconds } } }
@($out) | ConvertTo-Json -Compress"""


def sample():
    if os.name == "nt":
        r = subprocess.run(["powershell", "-NoProfile", "-Command", WINDOWS], capture_output=True, text=True)
        v = json.loads(r.stdout or "[]")
        return v if isinstance(v, list) else [v]
    # macOS, Linux: resident memory only (no private figure), CPU time as [[hh:]mm:]ss.cc
    r = subprocess.run(["ps", "-A", "-o", "pid=,rss=,time=,command="], capture_output=True, text=True)
    out = []
    for line in r.stdout.splitlines():
        pid, rss, cpu, cmd = line.split(None, 3)
        if "node_modules/electron/dist" not in cmd:
            continue
        kind = cmd.split("--type=")[1].split()[0] if "--type=" in cmd else "main"
        secs = sum(float(x) * 60 ** i for i, x in enumerate(reversed(cpu.replace("-", ":").split(":"))))
        out.append({"id": int(pid), "type": kind, "priv": int(rss) * 1024, "ws": int(rss) * 1024, "cpu": secs * 1000})
    return out


if __name__ == "__main__":
    pdf, args = pdf_arg(sys.argv[1:])
    binding = args[0] if args else "spiral"
    if binding not in BINDINGS:
        raise SystemExit(f"unknown binding {binding}: one of {', '.join(BINDINGS)}")
    p = start("memory", SCRIPT % json.dumps(binding), pdf=pdf, env={"ELECTRON_ENABLE_LOGGING": "1"}, merged=True)
    # The page says when it's idle (its console, with ELECTRON_ENABLE_LOGGING); the output is
    # read as it comes, so the pipe never fills.
    idle, lines = threading.Event(), []

    def watch():
        for raw in p.stdout:
            line = raw.decode("utf-8", "replace")
            lines.append(line)
            if "PHASE idle" in line:
                idle.set()
    reader = threading.Thread(target=watch, daemon=True)
    reader.start()
    if not idle.wait(300):
        p.kill()
        raise SystemExit("never went idle\n" + "".join(lines[-40:]))
    time.sleep(3)
    a, t0 = sample(), time.time()
    time.sleep(35)
    b, dt = sample(), time.time() - t0
    p.wait(timeout=300)
    reader.join(10)
    try:
        res = result("".join(lines))
    except SmokeError as e:
        raise SystemExit(str(e))
    print("GPU, estimated:", ", ".join(f"{k} {v['mb']} MB ({v['textures']})" for k, v in res["gpu"].items()),
          f"- total {sum(v['mb'] for v in res['gpu'].values()):.0f} MB; page script heap {res['heap']} MB")
    before = {x["id"]: x["cpu"] for x in a}
    print(f"{'process':34s} {'private MB':>10s} {'working MB':>10s} {'idle CPU %':>10s}")
    total = [0, 0, 0]
    for x in b:
        cpu = (x["cpu"] - before.get(x["id"], x["cpu"])) / (dt * 1000) * 100
        for i, v in enumerate((x["priv"] / 1048576, x["ws"] / 1048576, cpu)):
            total[i] += v
        print(f"{x['type']:34s} {x['priv'] / 1048576:10.0f} {x['ws'] / 1048576:10.0f} {cpu:10.2f}")
    print(f"{'total':34s} {total[0]:10.0f} {total[1]:10.0f} {total[2]:10.2f}   (CPU: % of one core)")
