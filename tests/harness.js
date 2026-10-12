// Minimal test harness that runs in the browser. Results render on the page and are
// exposed as window.testResults for automation.

const tests = [];
export const test = (name, fn) => tests.push({ name, fn });
export const testNames = () => tests.map((t) => t.name);

export function eq(actual, expected, msg = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}\n  expected ${e}\n  actual   ${a}`);
}

export function ok(value, msg = "expected truthy") {
  if (!value) throw new Error(msg);
}

export function near(actual, expected, tol = 1e-6, msg = "") {
  if (Math.abs(actual - expected) > tol) throw new Error(`${msg} expected ${expected} ± ${tol}, got ${actual}`);
}

export function throws(fn, msg = "expected an exception") {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

/** Run the tests (those whose name `only` accepts, if given); results on `out`. */
export async function run(out, only = null) {
  const results = [];
  for (const t of tests) {
    if (only && !only(t.name)) continue;
    out.textContent = `Running: ${t.name}`; // shows which one, should a test hang
    try {
      await t.fn();
      results.push({ name: t.name, pass: true });
    } catch (err) {
      results.push({ name: t.name, pass: false, error: String(err.message ?? err) });
    }
  }
  const failed = results.filter((r) => !r.pass);
  out.innerHTML = `<h1>${failed.length ? `${failed.length} failed` : "All passed"} · ${results.length} tests</h1>` +
    results.map((r) => `<div class="${r.pass ? "pass" : "fail"}">${r.pass ? "✓" : "✗"} ${escape(r.name)}` +
      (r.error ? `<pre>${escape(r.error)}</pre>` : "") + "</div>").join("");
  window.testResults = { total: results.length, failed };
  return results;
}

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
