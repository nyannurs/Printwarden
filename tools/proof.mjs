// The geometry proof (tests/geometry.test.js) in node, its tests spread over the CPU's
// cores: one process per test, the slowest (most pages) first. For development only.
//
//   node tools/proof.mjs            every geometry test
//   node tools/proof.mjs hardcover  those whose name contains "hardcover"

import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = new URL("../", pathToFileURL(here));
globalThis.window = globalThis; // the harness reports on window

async function load() {
  const harness = await import(new URL("tests/harness.js", root));
  await import(new URL("tests/geometry.test.js", root));
  return harness;
}

if (process.argv[2] === "--one") {
  // A child: run one test by name, report as JSON.
  const name = process.argv[3];
  const harness = await load();
  const [result] = await harness.run({ textContent: "", innerHTML: "" }, (n) => n === name);
  process.stdout.write(JSON.stringify(result ?? { name, pass: false, error: "no such test" }));
} else {
  const filter = process.argv[2] ?? "";
  const harness = await load();
  const pages = (n) => Number(/(\d+) pages/.exec(n)?.[1] ?? 0);
  const names = harness.testNames().filter((n) => n.includes(filter)).sort((a, b) => pages(b) - pages(a));
  const width = Math.max(1, os.availableParallelism?.() ?? os.cpus().length) - 1;
  const started = Date.now();
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const name = names[next++];
      const t = Date.now();
      const out = await new Promise((resolve) => {
        let text = "";
        const child = spawn(process.execPath, [here, "--one", name], { stdio: ["ignore", "pipe", "inherit"] });
        child.stdout.on("data", (d) => (text += d));
        child.on("close", () => resolve(text));
      });
      let r;
      try {
        r = JSON.parse(out);
      } catch {
        r = { name, pass: false, error: `no result: ${out.slice(0, 300)}` };
      }
      results.push(r);
      console.log(`${r.pass ? "ok  " : "FAIL"} ${((Date.now() - t) / 1000).toFixed(1).padStart(5)} s  ${name}`);
      if (!r.pass) console.log(`     ${String(r.error).slice(0, 1500).replace(/\n/g, "\n     ")}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, names.length) }, worker));
  const failed = results.filter((r) => !r.pass).length;
  console.log(`${failed ? `${failed} failed` : "all passed"} · ${results.length} tests · ${((Date.now() - started) / 1000).toFixed(0)} s`);
  process.exitCode = failed ? 1 : 0;
}
