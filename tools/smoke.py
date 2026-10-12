# Shared by the tools here: run the app from source with a script, the way _build/main.cjs
# runs a smoke test (BOOKVIEW_SMOKE: off-screen, out of the taskbar, never focused, so
# several can run while you work), and read back what the script left in window.__bench.
# For development only.
#
# The app opens its sample by itself; a tool given --pdf FILE opens that file instead.
import json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "_build")
OUT = os.path.join(BUILD, "test-out")  # what the tools write (gitignored)
NPX = "npx.cmd" if os.name == "nt" else "npx"
BINDINGS = ["perfect", "saddle", "sewn", "hardcover", "spiral", "wire-o"]
sys.stdout.reconfigure(errors="replace")  # a console that can't show a character shows "?"

# Ahead of every tool's script: sleep(ms); openDocument() opens --pdf (the sample is open
# already) and waits for its analysis; settle(scene) lays out and draws on the set clock
# and places the camera, without the screen's own frames.
PRELUDE = r"""
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PDF = %s;
async function openDocument() {
  if (PDF) await app.openDocument({ file: await window.desktop.openPdf(), source: "pages" });
  for (let i = 0; i < 100 && !app.state.analysis; i++) await sleep(100);
}
const settle = (sc) => sc.debugSample(0.5, 0.5);
"""


class SmokeError(Exception):
    pass


def pdf_arg(args):
    """Take "--pdf FILE" out of a tool's arguments: (the file or None, the rest)."""
    if "--pdf" not in args:
        return None, args
    i = args.index("--pdf")
    if i + 1 >= len(args):
        raise SystemExit("--pdf needs a file")
    pdf = os.path.abspath(args[i + 1])
    if not os.path.isfile(pdf):
        raise SystemExit(f"no such file: {pdf}")
    return pdf, args[:i] + args[i + 2:]


def start(name, body, pdf=None, save_as=None, env=None, merged=False):
    """Launch the app running `body` (the inside of an async function). `name`: lowercase,
    digits and dashes, at most 32 (it names the app's data folder). `merged`: its errors
    output in with the rest (read it with result())."""
    data = os.path.join(BUILD, f"dev-data-smoke-{name}")
    os.makedirs(data, exist_ok=True)
    e = dict(os.environ)
    e.update(env or {})
    e["BOOKVIEW_SMOKE"] = os.path.join(data, "window.png")
    e["BOOKVIEW_SMOKE_DATA"] = name
    e["BOOKVIEW_SMOKE_JS"] = ("(async () => {\n  try {\n" + PRELUDE % json.dumps(bool(pdf)) + body
                              + "\n  } catch (e) { window.__bench = { error: String((e && e.stack) || e) }; }\n})()")
    if pdf:
        e["BOOKVIEW_SMOKE_OPEN"] = pdf
    if save_as:
        e["BOOKVIEW_SMOKE_SAVE_AS"] = save_as
    return subprocess.Popen([NPX, "electron", "."], cwd=BUILD, env=e, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT if merged else subprocess.PIPE)


def finish(proc, timeout=900):
    """Wait for a launched app: what its script left in window.__bench. Raises SmokeError if
    it left nothing or an error, or if the page logged errors."""
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise SmokeError("timed out")
    return result(out.decode("utf-8", "replace"), (err or b"").decode("utf-8", "replace"))


def result(text, errors=""):
    """What a run's script left in window.__bench, from the app's output (see finish)."""
    line = next((l for l in text.splitlines() if '"bench"' in l), None)
    bench = json.loads(line[line.index("{"):]).get("bench") if line else None
    if bench is None:
        raise SmokeError(f"no result\n{text[-2000:]}\n{errors[-2000:]}")
    if isinstance(bench, dict) and "error" in bench:
        raise SmokeError(bench["error"])
    if "SMOKE ERRORS:" in text:
        raise SmokeError(text[text.index("SMOKE ERRORS:"):][:2000])
    return bench


def run(name, body, **kw):
    timeout = kw.pop("timeout", 900)
    return finish(start(name, body, **kw), timeout)
