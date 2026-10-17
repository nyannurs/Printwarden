// The client viewer's code as one bundle (see ui/client.js, which puts it in the HTML file):
// the entry module and everything it imports, each as text, by key. Every import between
// them is rewritten to a key (viewer/scene.js, three, three/addons/...), which the HTML
// file maps to a blob URL of that text. No part of the app itself: testable on its own.

/** The viewer's entry module (app/client/viewer.js), as a key: relative to app/. */
export const CLIENT_ENTRY = "client/viewer.js";

const IMPORT_RE = /^((?:import|export)[^;]*?from\s*|import\s*)(['"])([^'"]+)\2/gm;

/**
 * The entry module and everything it imports, by key, their imports rewritten to keys.
 * @returns {Promise<Record<string, string>>}
 */
export async function bundleModules(entry = CLIENT_ENTRY) {
  /** @type {Record<string, string>} */
  const modules = {};
  const queue = [entry];
  while (queue.length) {
    const key = queue.shift();
    if (modules[key] !== undefined) continue;
    const response = await fetch(urlOf(key));
    if (!response.ok) throw new Error(`${key} is missing (${response.status})`);
    const text = await response.text();
    modules[key] = text.replace(IMPORT_RE, (_, pre, quote, spec) => {
      const target = resolveKey(key, spec);
      queue.push(target);
      return `${pre}${quote}${target}${quote}`;
    });
  }
  return modules;
}

/** Where a key's file is: three.js and its addons in vendor/, the rest under app/. */
export function urlOf(key) {
  if (key === "three") return new URL("../../vendor/three.module.js", import.meta.url);
  if (key.startsWith("three/addons/")) return new URL(`../../vendor/three-addons/${key.slice("three/addons/".length)}`, import.meta.url);
  return new URL(`../${key}`, import.meta.url);
}

/** A specifier as a key: relative ones resolved against the importing module's key. */
export function resolveKey(fromKey, spec) {
  if (!spec.startsWith(".")) return spec;
  const parts = fromKey.split("/").slice(0, -1);
  for (const piece of spec.split("/")) {
    if (piece === "." || piece === "") continue;
    if (piece === "..") parts.pop();
    else parts.push(piece);
  }
  return parts.join("/");
}
