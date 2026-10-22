// The client viewer's bundle (app/client/bundle.js): the viewer and everything it imports,
// every import rewritten to a key the HTML file can map, nothing left pointing at a file.
// A viewer exported after a change to the 3D code's imports would otherwise fail to start in
// the client's browser, where there are no files.

import { bundleModules, CLIENT_ENTRY, resolveKey } from "../app/client/bundle.js";
import { eq, ok, test } from "./harness.js";

test("client viewer: relative imports resolve to keys under app/", () => {
  eq(resolveKey("client/viewer.js", "../viewer/scene.js"), "viewer/scene.js");
  eq(resolveKey("viewer/scene.js", "./camera.js"), "viewer/camera.js");
  eq(resolveKey("viewer/scene.js", "three"), "three");
  eq(resolveKey("viewer/scene.js", "three/addons/postprocessing/RenderPass.js"), "three/addons/postprocessing/RenderPass.js");
  eq(resolveKey("viewer/shaders.js", "./model.js"), "viewer/model.js");
});

test("client viewer: the bundle holds the viewer, the 3D code and three.js, with no import left pointing at a file", async () => {
  const modules = await bundleModules(CLIENT_ENTRY);
  const keys = Object.keys(modules);
  for (const k of [CLIENT_ENTRY, "viewer/scene.js", "viewer/model.js", "viewer/shaders.js", "viewer/capture.js", "three"]) {
    ok(keys.includes(k), `${k} is in the bundle`);
  }
  ok(keys.some((k) => k.startsWith("three/addons/")), "three's addons");
  // The app's performance check rides along (the viewer's button; it imports nothing).
  ok(keys.includes("ui/probe.js"), "the performance check");
  ok(!keys.some((k) => (k.startsWith("ui/") && k !== "ui/probe.js") || k.startsWith("pdf/") || k.startsWith("core/")), `only the viewer's own code: ${keys.join(", ")}`);
  const importRe = /^(?:import|export)[^;]*?from\s*(['"])([^'"]+)\1|^import\s*(['"])([^'"]+)\3/gm;
  for (const [key, text] of Object.entries(modules)) {
    for (const m of text.matchAll(importRe)) {
      const spec = m[2] ?? m[4];
      ok(!spec.startsWith("."), `${key} still imports "${spec}" by file`);
      ok(modules[spec] !== undefined, `${key} imports "${spec}", which the bundle lacks`);
    }
  }
  ok(modules.three.length > 500000, "three.js itself, whole");
});
