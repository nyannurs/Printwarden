// Build the desktop app: copies the web app into ./web and packages it with
// electron-builder. Usage: node build.mjs [win|mac]   (default: this computer's system)
// The app name, id and version come from ../product.json.
//
// Both builds are portable: no installer, nothing unpacked elsewhere at startup, nothing
// written outside the app's own folder (see "storage" in main.cjs).
//   Windows: a folder with <name>.exe, zipped. Its data folder appears next to the .exe.
//   macOS:   <name>.app (Intel and Apple Silicon), zipped. Its data lives inside the app.
// Not signed by Microsoft or Apple (see README.txt for opening it the first time). The
// Mac app carries an ad-hoc signature: Apple Silicon runs no code without one.

import { build, Platform } from "electron-builder";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const product = JSON.parse(await fs.readFile(path.join(root, "product.json"), "utf8"));
const target = process.argv[2] ?? (process.platform === "darwin" ? "mac" : "win");

// 0. The CMYK profile the app ships with must be there (see ../vendor/icc/README.txt).
const icc = path.join(root, "vendor", "icc", "ISOcoated_v2_eci.icc");
if ((await fs.stat(icc).catch(() => null))?.size !== 1829077) {
  console.error(`Missing or wrong ${icc}: see vendor/icc/README.txt for where it comes from.`);
  process.exit(1);
}

// FFmpeg for transparent videos, for each architecture this build ships: built from the
// official source with only what the app uses, LGPL (../tools/build-ffmpeg.sh), kept in
// ffmpeg-lgpl/<platform>-<arch>/ with its license and how it was made.
const ffmpegKeys = target === "mac" ? ["darwin-arm64", "darwin-x64"] : ["win32-x64"];
for (const key of ffmpegKeys) {
  const exe = path.join(here, "ffmpeg-lgpl", key, key.startsWith("win") ? "ffmpeg.exe" : "ffmpeg");
  if (!(await fs.stat(exe).catch(() => null))) {
    console.error(`Missing ${exe}: see ../tools/build-ffmpeg.sh.`);
    process.exit(1);
  }
  if (!key.startsWith("win")) await fs.chmod(exe, 0o755);
}

// The icons, drawn from their SVGs (../app/icon.svg for the Mac, icon-windows.svg for
// Windows) by Electron's Chromium; electron-builder makes the .icns and .ico from them.
const icons = path.join(here, "icons");
await fs.rm(icons, { recursive: true, force: true });
await fs.mkdir(icons, { recursive: true });
const icon = {
  mac: { svg: path.join(root, "app", "icon.svg"), png: path.join(icons, "mac.png"), size: 1024 },
  win: { svg: path.join(root, "app", "icon-windows.svg"), png: path.join(icons, "windows.png"), size: 256 },
};
const electron = createRequire(import.meta.url)("electron");
const electronDist = path.join(path.dirname(createRequire(import.meta.url).resolve("electron")), "dist");
const drawn = spawnSync(electron, [path.join(here, "icons.cjs"), JSON.stringify([icon[target]])], { stdio: "inherit" });
await fs.rm(path.join(icons, ".electron"), { recursive: true, force: true });
if (drawn.status !== 0) {
  console.error("Couldn't draw the app icon.");
  process.exit(1);
}

// 1. Fresh copy of the web app.
const web = path.join(here, "web");
await fs.rm(web, { recursive: true, force: true });
for (const item of ["index.html", "product.json", "LICENSE", "NOTICE", "app", "vendor"]) {
  // (Not the type checker's pointers in vendor/: development only.)
  await fs.cp(path.join(root, item), path.join(web, item), { recursive: true, filter: (src) => !/\.d\.m?ts$/.test(src) });
}

// 2. Package.
const slug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
await build({
  targets: target === "mac" ? Platform.MAC.createTarget() : Platform.WINDOWS.createTarget(),
  config: {
    appId: product.appId,
    productName: product.name,
    copyright: `© ${new Date().getFullYear()} Ramin Strauss`,
    directories: { output: "dist" },
    files: ["main.cjs", "preload.cjs", "package.json", "web/**/*"],
    // Outside the app's code archive, as a program FFmpeg must be: Resources/ffmpeg/<platform>-<arch>,
    // with its license and notice. On the Mac, Electron's and Chromium's
    // licenses too (Windows builds have them next to the .exe already): Resources/licenses.
    extraResources: [
      ...ffmpegKeys.map((key) => ({ from: `ffmpeg-lgpl/${key}`, to: `ffmpeg/${key}` })),
      ...(target === "mac" ? [
        { from: path.join(electronDist, "LICENSE"), to: "licenses/LICENSE.electron.txt" },
        { from: path.join(electronDist, "LICENSES.chromium.html"), to: "licenses/LICENSES.chromium.html" },
      ] : []),
    ],
    extraMetadata: { name: slug, version: product.version, description: product.description },
    asar: true,
    // Electron's back doors, closed in the binary itself: the app can't be repurposed to run
    // other code (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect), and only ever loads its own
    // packaged code. Cookie encryption stays off: it would keep a key in the system keychain,
    // outside the app's folder (and the app has no cookies).
    electronFuses: {
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
      enableCookieEncryption: false,
    },
    // A folder, not a single .exe: a one-file .exe unpacks itself into the system's temp
    // folder on every start, outside its own folder. dist/win-unpacked is the same app,
    // unzipped.
    win: {
      target: [{ target: "zip", arch: ["x64"] }],
      artifactName: "${productName} ${version} Windows.${ext}",
      icon: icon.win.png,
    },
    // A zipped .app, not a disk image: an app run from a disk image is read-only and
    // couldn't keep its settings inside itself.
    mac: {
      target: [{ target: "zip", arch: ["universal"] }],
      category: "public.app-category.graphics-design",
      icon: icon.mac.png,
      identity: "-", // ad-hoc: no Apple account needed
      // Both FFmpeg builds (Apple Silicon and Intel) ship in the one app and are already
      // single-architecture: they're kept as they are, not merged.
      x64ArchFiles: "Contents/Resources/ffmpeg/**",
      hardenedRuntime: false, // required with ad-hoc signing (Electron's frameworks are signed by others)
      gatekeeperAssess: false,
      artifactName: "${productName} ${version} macOS.${ext}",
    },
  },
});

console.log(`\nDone. Output is in ${path.join(here, "dist")}`);
