// Desktop shell (Electron). Serves the web app from disk over a private app:// scheme,
// so ES modules and the PDF worker load exactly as in a browser, and exposes native
// open/save dialogs through preload.cjs. The app itself knows nothing about Electron.

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, screen, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Packaged: build.mjs copies the web app into ./web. Development: the repository root.
const WEB_ROOT = app.isPackaged ? path.join(__dirname, "web") : path.resolve(__dirname, "..");
const SERVED = ["index.html", "product.json", "LICENSE", "NOTICE", "app", "vendor"]; // nothing else leaves the disk
// Development only: BOOKVIEW_LAB=<page> opens an experiment from _lab/ (never in a build).
const LAB = !app.isPackaged && process.env.BOOKVIEW_LAB;
if (LAB) SERVED.push("_lab", "_testfiles");
const product = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, "product.json"), "utf8"));
app.setName(product.name);

// --- storage: everything the app writes stays in its own folder ------------------------
//
// The built app is portable and keeps to itself: preferences, window size, Chromium's
// caches, logs and temporary files all go into one folder, and nothing is written anywhere
// else except the files you export. (Reading, too: only files you choose to import.)
//   Windows: "<name> Data" next to <name>.exe
//   macOS:   inside the app itself, <name>.app/Contents/<name> Data
//   From source (Start scripts): _build/dev-data (smoke tests: _build/dev-data-smoke, or
//   dev-data-smoke-<BOOKVIEW_SMOKE_DATA> so several can run at once)
// The folder's name follows the app name in product.json.
const SMOKE_DATA = /^[a-z0-9-]{1,32}$/.test(process.env.BOOKVIEW_SMOKE_DATA ?? "") ? `-${process.env.BOOKVIEW_SMOKE_DATA}` : "";
const DATA_DIR = !app.isPackaged
  ? path.join(__dirname, process.env.BOOKVIEW_SMOKE ? `dev-data-smoke${SMOKE_DATA}` : "dev-data")
  : process.platform === "darwin"
    ? path.resolve(path.dirname(process.execPath), "..", `${product.name} Data`) // Contents/
    : path.join(path.dirname(process.execPath), `${product.name} Data`);
const TEMP_DIR = path.join(DATA_DIR, "Temp");

/** Create the data folder and check it can be written. */
function prepareStorage() {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true }); // last session's leftovers
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const probe = path.join(DATA_DIR, ".write-test");
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

const storageReady = prepareStorage();
if (storageReady) {
  app.setPath("appData", DATA_DIR);
  app.setPath("userData", path.join(DATA_DIR, "Profile"));
  app.setPath("sessionData", path.join(DATA_DIR, "Profile"));
  app.setPath("logs", path.join(DATA_DIR, "Logs"));
  app.setPath("crashDumps", path.join(DATA_DIR, "Crash reports"));
  app.setPath("temp", TEMP_DIR);
  // Chromium's own processes (renderer, GPU) take their temporary folder from these.
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = TEMP_DIR;
} else {
  // Rather than write anywhere else: explain, and quit.
  const translocated = process.platform === "darwin" && process.execPath.includes("/AppTranslocation/");
  dialog.showErrorBox(`${product.name} can't start from here`, translocated
    ? `macOS is running ${product.name} from a protected, read-only copy, so it can't keep its settings inside itself.\n\n`
      + `Move ${product.name} to another folder (for example Applications) and open it again, or see the README.`
    : `${product.name} keeps its settings in a folder next to itself and can't write there:\n${DATA_DIR}\n\n`
      + `Extract ${product.name} to a normal folder (not inside a zip file, not a read-only drive) and open it again.`);
  app.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".icc": "application/vnd.iccprofile",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

async function serve(request) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "") || "index.html";
  } catch {
    return new Response("Not found", { status: 404 }); // a malformed address
  }
  const file = path.normalize(path.join(WEB_ROOT, rel));
  // Which top-level item it is, after ".." and encoded slashes are resolved: not the raw path.
  const inside = path.relative(WEB_ROOT, file);
  const top = inside.split(path.sep)[0];
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !SERVED.includes(top)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const data = await fs.promises.readFile(file);
    return new Response(data, { headers: { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// --- files ---------------------------------------------------------------------------

const sources = new Set(); // paths of opened PDFs: never overwritten by an export
let lastDir = app.getPath("documents");
const samePath = (a, b) => (process.platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase());

ipcMain.handle("open-pdf", async (event) => {
  // Development smoke tests only: open BOOKVIEW_SMOKE_OPEN without the dialog. Never in a build.
  if (!app.isPackaged && process.env.BOOKVIEW_SMOKE && process.env.BOOKVIEW_SMOKE_OPEN) {
    const file = process.env.BOOKVIEW_SMOKE_OPEN;
    return { name: path.basename(file), bytes: await fs.promises.readFile(file) };
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    defaultPath: lastDir,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  rememberSource(file);
  return { name: path.basename(file), bytes: await fs.promises.readFile(file) };
});

ipcMain.handle("quit", () => app.quit());

// --- updates -------------------------------------------------------------------------
//
// The app's only request to the internet: once a start, GitHub's answer to "the latest
// release of this repository" (its tag, e.g. v0.17.37), compared with this version number by
// number. Made here, not by the page (whose every request outside the app is refused, see
// lockDown), in a session of its own kept in memory (nothing written to disk), with nothing
// sent but the request itself. Offline or anything unexpected: no answer, no notice.
const RELEASES = `https://github.com/${product.repository}/releases`;
let latest = null;

/** [major, minor, patch] of "v1.2.3" or "1.2.3", or null. */
const versionOf = (tag) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag ?? "").trim());
  return m ? m.slice(1).map(Number) : null;
};
const isNewer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

ipcMain.handle("latest-release", () => {
  latest ??= (async () => {
    // Development: BOOKVIEW_LATEST=<tag> stands in for GitHub's answer; the smoke tests ask
    // nothing, unless BOOKVIEW_SMOKE_NETWORK is set (to try the request itself).
    let tag = !app.isPackaged ? process.env.BOOKVIEW_LATEST : undefined;
    if (tag === undefined && !app.isPackaged && process.env.BOOKVIEW_SMOKE && !process.env.BOOKVIEW_SMOKE_NETWORK) return null;
    if (tag === undefined) {
      const ses = session.fromPartition("updates", { cache: false });
      const response = await ses.fetch(`https://api.github.com/repos/${product.repository}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": product.name },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      tag = (await response.json())?.tag_name;
    }
    const found = versionOf(tag);
    const own = versionOf(product.version);
    return found && own ? { tag: String(tag), newer: isNewer(found, own) } : null;
  })().catch(() => null);
  return latest;
});

// Only ever this one page, in the system's browser.
ipcMain.handle("open-releases", () => shell.openExternal(RELEASES));

ipcMain.handle("remember-source", (_event, file) => {
  if (file) rememberSource(file);
});

ipcMain.handle("save-pdf", async (event, suggestedName, bytes) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  for (;;) {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(lastDir, suggestedName),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (result.canceled || !result.filePath) return null;
    if ([...sources].some((s) => samePath(s, result.filePath))) {
      await dialog.showMessageBox(win, {
        type: "warning",
        message: "That is the file you imported.",
        detail: "The export never overwrites its source. Choose another name.",
      });
      continue;
    }
    await fs.promises.writeFile(result.filePath, Buffer.from(bytes));
    lastDir = path.dirname(result.filePath); // the next dialog opens there, as for renders
    return path.basename(result.filePath);
  }
});

// --- colour profiles ---------------------------------------------------------------
//
// The CMYK printing profiles installed on this computer are offered (the app ships none of
// its own). Looking for them only ever reads: known colour folders, ICC files only, no
// shortcuts or links followed (so it can't wander off or loop), a few levels deep, a bounded
// number of files, oversized files skipped.

const PROFILE_DIRS = process.platform === "darwin"
  ? [
    "/Library/Application Support/Adobe/Color/Profiles/Recommended",
    "/Library/Application Support/Adobe/Color/Profiles",
    "/Library/ColorSync/Profiles",
    path.join(app.getPath("home"), "Library/ColorSync/Profiles"),
    "/System/Library/ColorSync/Profiles",
  ]
  : [
    path.join(process.env.SystemRoot || String.raw`C:\Windows`, "System32", "spool", "drivers", "color"),
    path.join(process.env.CommonProgramFiles || String.raw`C:\Program Files\Common Files`, "Adobe", "Color", "Profiles"),
  ];
const PROFILE_SCAN = { depth: 2, files: 2000, bytes: 20 * 1024 * 1024 };
let cmykProfiles = null;

/** CMYK output profiles installed on this computer: [{name, path}]. */
ipcMain.handle("list-cmyk-profiles", async () => {
  if (cmykProfiles) return cmykProfiles;
  const found = new Map();
  let budget = PROFILE_SCAN.files;
  const walk = async (dir, depth) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing or not readable: nothing to offer from here
    }
    for (const e of entries) {
      if (budget <= 0) return;
      const file = path.join(dir, e.name);
      // Dirent types come from the folder listing: a shortcut or link is neither a
      // directory nor a file here, so it is never followed.
      if (e.isDirectory() && depth < PROFILE_SCAN.depth) await walk(file, depth + 1);
      else if (e.isFile() && /\.(icc|icm)$/i.test(e.name)) {
        budget--;
        const info = await readIccInfo(file);
        if (info?.colorSpace === "CMYK" && info.deviceClass === "prtr" && !found.has(info.name)) {
          found.set(info.name, { name: info.name, path: file });
        }
      }
    }
  };
  for (const dir of PROFILE_DIRS) await walk(dir, 0);
  cmykProfiles = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  return cmykProfiles;
});

ipcMain.handle("read-profile", async (_event, file) => {
  // Only profiles found above can be read: the page can't name any other file.
  if (!cmykProfiles?.some((p) => p.path === file)) return null;
  return fs.promises.readFile(file);
});

/**
 * Colour space, class and description of an ICC profile file (header and 'desc' tag only), by
 * the web app's own reader (app/pdf/icc.js); the file's name where the profile has no
 * description. Null for what isn't a profile, is damaged, or is too large to be one.
 */
async function readIccInfo(file) {
  let b;
  try {
    if ((await fs.promises.stat(file)).size > PROFILE_SCAN.bytes) return null;
    b = await fs.promises.readFile(file);
  } catch {
    return null;
  }
  iccReader ??= import(pathToFileURL(path.join(WEB_ROOT, "app", "pdf", "icc.js")).href);
  const info = (await iccReader).iccInfo(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  return info && { ...info, name: info.name || path.basename(file).replace(/\.(icc|icm)$/i, "") };
}
let iccReader = null; // the module, imported on the first profile

// Two-step save for renders: choose the place first, write when the image is ready.
// Only paths chosen in this dialog can be written.
const chosenPaths = new Set();

ipcMain.handle("choose-save-path", async (event, suggestedName, filter) => {
  // Development smoke tests only: answer the dialog with BOOKVIEW_SMOKE_SAVE_AS. Never in a build.
  if (!app.isPackaged && process.env.BOOKVIEW_SMOKE && process.env.BOOKVIEW_SMOKE_SAVE_AS) {
    const file = `${process.env.BOOKVIEW_SMOKE_SAVE_AS}.${filter.extensions[0]}`;
    chosenPaths.add(file);
    return file;
  }
  const win = BrowserWindow.fromWebContents(event.sender);
  for (;;) {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: path.join(lastDir, suggestedName),
      filters: [filter],
    });
    if (result.canceled || !result.filePath) return null;
    if ([...sources].some((s) => samePath(s, result.filePath))) {
      await dialog.showMessageBox(win, { type: "warning", message: "That is the file you imported.", detail: "Choose another name." });
      continue;
    }
    chosenPaths.add(result.filePath);
    lastDir = path.dirname(result.filePath);
    return result.filePath;
  }
});

ipcMain.handle("write-chosen-file", async (_event, file, bytes) => {
  if (!chosenPaths.has(file)) throw new Error("Not a chosen location");
  chosenPaths.delete(file);
  await fs.promises.writeFile(file, Buffer.from(bytes));
  return path.basename(file);
});

// --- video with transparency (ProRes 4444) ------------------------------------------------
//
// The app renders the frames; FFmpeg, shipped inside the app (see build.mjs), encodes them
// as they arrive on its input: no temporary files. Only that FFmpeg, only fixed arguments,
// and only to a file chosen in the save dialog (choose-save-path).

function ffmpegPath() {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const key = `${process.platform}-${process.arch}`;
  // Built: Resources/ffmpeg/<key>; from source: ffmpeg-lgpl/<key> here (see build.mjs).
  return app.isPackaged ? path.join(process.resourcesPath, "ffmpeg", key, exe) : path.join(__dirname, "ffmpeg-lgpl", key, exe);
}

const videos = new Map(); // id -> {child, file, done, error}
let videoIds = 0;

ipcMain.handle("video-available", () => fs.existsSync(ffmpegPath()));

ipcMain.handle("video-begin", (_event, file, { width, height, fps }) => {
  if (!chosenPaths.has(file)) throw new Error("Not a chosen location");
  chosenPaths.delete(file);
  const ok = (v, max) => Number.isInteger(v) && v > 0 && v <= max;
  if (!ok(width, 16384) || !ok(height, 16384) || !ok(fps, 120)) throw new Error("Bad video size");
  const bin = ffmpegPath();
  if (!fs.existsSync(bin)) throw new Error("FFmpeg is missing from this copy of the app.");
  const child = spawn(bin, [
    "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
    // prores_aw, not prores_ks: the same ProRes 4444 with alpha, about four times faster.
    "-c:v", "prores_aw", "-profile:v", "4", "-pix_fmt", "yuva444p10le",
    "-vendor", "apl0", "-y", file,
  ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
  const video = { child, file, error: "" };
  child.stderr.on("data", (d) => { video.error = (video.error + d).slice(-2000); });
  child.stdin.on("error", () => {}); // a crash shows in `done`
  video.done = new Promise((resolve) => {
    child.on("error", (err) => { video.error ||= err.message; resolve(-1); });
    child.on("close", (code) => resolve(code));
  });
  const id = ++videoIds;
  videos.set(id, video);
  return id;
});

ipcMain.handle("video-frame", async (_event, id, bytes) => {
  const video = videos.get(id);
  if (!video) throw new Error("No such video");
  if (video.child.exitCode !== null) throw new Error(`FFmpeg stopped: ${video.error}`);
  if (!video.child.stdin.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) { // no copy
    // Or until FFmpeg stops: then no drain ever comes, and the next frame reports it.
    await Promise.race([new Promise((resolve) => video.child.stdin.once("drain", resolve)), video.done]);
  }
});

ipcMain.handle("video-end", async (_event, id) => {
  const video = videos.get(id);
  if (!video) throw new Error("No such video");
  videos.delete(id);
  video.child.stdin.end();
  const code = await video.done;
  if (code !== 0) throw new Error(`FFmpeg failed: ${video.error || code}`);
  return path.basename(video.file);
});

ipcMain.handle("video-abort", async (_event, id) => {
  const video = videos.get(id);
  if (!video) return;
  videos.delete(id);
  video.child.kill();
  await video.done;
  await fs.promises.rm(video.file, { force: true }); // our own, unfinished output
});

function rememberSource(file) {
  sources.add(file);
  lastDir = path.dirname(file);
}

// --- window size and position, remembered between launches -------------------------

const windowStateFile = () => path.join(app.getPath("userData"), "window-state.json");

/** The saved window, if it still lands on a connected screen. */
function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"));
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
      s.x < a.x + a.width - 50 && s.x + s.width > a.x + 50 && s.y < a.y + a.height - 50 && s.y + s.height > a.y);
    return onScreen ? s : null;
  } catch {
    return null;
  }
}

function saveWindowState(win) {
  if (win.isDestroyed() || win.isMinimized()) return;
  const state = { ...win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
  try {
    fs.writeFileSync(windowStateFile(), JSON.stringify(state));
  } catch {
    // not being able to remember the window is harmless
  }
}

function createWindow() {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 920,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1280, // the smallest the grid's squares get (theme.css); users have 1920 x 1080 or more
    minHeight: 720,
    backgroundColor: "#1e1f22",
    title: product.name,
    show: false,
    autoHideMenuBar: true, // no menu bar on Windows (see buildMenu)
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // No spell checking: nothing typed here is checked against or added to a dictionary.
      // (On Windows, opening any Chromium window still makes the system's spelling service
      // open its user dictionaries: their timestamps change, their contents don't. Measured;
      // unavoidable from inside the app.)
      spellcheck: false,
      backgroundThrottling: false, // keep rendering pages while the window is in the background
    },
  });
  win.once("ready-to-show", () => {
    // Development smoke tests (several at a time, while the author works): screen-sized but
    // off every screen, out of the taskbar, never taking focus. Shown all the same: a window
    // never shown gets one animation frame a second.
    if (!app.isPackaged && process.env.BOOKVIEW_SMOKE) {
      const area = screen.getPrimaryDisplay().workArea;
      const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
      win.setBounds({ x: left - area.width - 400, y: area.y, width: area.width, height: area.height });
      win.setSkipTaskbar(true);
      win.setFocusable(false);
      win.showInactive();
      return;
    }
    // First launch: maximised. After that: as it was left.
    if (!saved || saved.maximized) win.maximize();
    if (saved?.fullScreen) win.setFullScreen(true);
    win.show();
  });
  let saveTimer = null;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 400);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    win.on(event, saveSoon);
  }
  win.on("close", () => saveWindowState(win));
  // The page's frame follows the window's corners: macOS rounds them, except in fullscreen.
  const tellFullScreen = () => {
    if (!win.isDestroyed()) win.webContents.send("full-screen", win.isFullScreen());
  };
  win.on("enter-full-screen", tellFullScreen);
  win.on("leave-full-screen", tellFullScreen);
  win.webContents.on("did-finish-load", tellFullScreen);
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  // The window's contents never zoom (Ctrl/Cmd + scroll, +, -, 0): only the 3D camera does.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if ((input.control || input.meta) && ["+", "-", "=", "0"].includes(input.key)) event.preventDefault();
    // Running from source only: F12 opens the developer tools. Never in a built app.
    if (!app.isPackaged && input.key === "F12") win.webContents.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadURL(LAB && LAB !== "app" ? `app://local/_lab/${LAB}` : "app://local/index.html");
  // Development only: a built app never runs the smoke test (it writes a screenshot to a
  // path given by an environment variable).
  if (!app.isPackaged && process.env.BOOKVIEW_SMOKE) smokeTest(win);
  return win;
}

/**
 * Windows: no menu at all (no menu bar, nothing behind Alt); the app's own buttons do
 * everything. macOS: the system menu every Mac app has, kept to the essentials (no View
 * menu: no reload, developer tools or zoom).
 */
function buildMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const send = (command) => (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0])?.webContents.send("menu", command);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      // The app's own About window, not macOS's standard panel (which knows none of it).
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: () => send("about") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Import…", accelerator: "Cmd+O", click: () => send("import") },
        { label: "Export imposed PDF…", accelerator: "Cmd+E", click: () => send("export") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" }, // copy and paste in the number fields
    { role: "windowMenu" },
  ]));
}

/**
 * The app needs nothing from outside its own files: no network, no permissions, no
 * downloads. Everything else is refused here, whatever the page asks for.
 */
function lockDown() {
  const ses = session.defaultSession;
  // Only the app's own files (app://), and data it makes in memory (blob:, data:).
  ses.webRequest.onBeforeRequest((details, callback) => {
    const scheme = details.url.slice(0, details.url.indexOf(":"));
    callback({ cancel: !["app", "blob", "data", "devtools"].includes(scheme) });
  });
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  ses.setSpellCheckerEnabled(false); // see "spellcheck" in createWindow
}

/** BOOKVIEW_SMOKE=out.png: load, report console errors, save a screenshot, quit. */
function smokeTest(win) {
  // Measure at full speed even if the window is covered (Windows throttles covered windows).
  win.webContents.setBackgroundThrottling(false);
  const errors = [];
  win.webContents.on("console-message", (e) => {
    if (e.level === "error") errors.push(e.message);
  });
  win.webContents.once("did-finish-load", async () => {
    // Open the sample, let the render workers draw it, report what rendered it.
    if (!LAB || LAB === "app") await win.webContents.executeJavaScript('document.getElementById("sample-btn").click()');
    setTimeout(async () => {
      // BOOKVIEW_SMOKE_JS: optional script to set up the view before the screenshot.
      if (process.env.BOOKVIEW_SMOKE_JS) {
        await win.webContents.executeJavaScript(process.env.BOOKVIEW_SMOKE_JS);
        await new Promise((r) => setTimeout(r, 2500));
      }
      const info = await win.webContents.executeJavaScript(LAB && LAB !== "app" ? "JSON.stringify(window.lab ?? null, (k, v) => (k === 'pdf' || k === 'THREE' || k === 'renderer' || k === 'scene' || k === 'camera' ? undefined : v))"
        : "({ renderer: window.app.state.renderer?.constructor.name, pages: window.app.state.textures.size, choice: window.app.state.colour.choice, strips: [...window.app.state.details].map(([f, s]) => [f, s.map((x) => Math.round(x.pxPerMm))]), bench: window.__bench })");
      console.log(JSON.stringify(info));
      const image = await win.webContents.capturePage();
      fs.writeFileSync(process.env.BOOKVIEW_SMOKE, image.toPNG());
      console.log(errors.length ? `SMOKE ERRORS:\n${errors.join("\n")}` : "SMOKE OK");
      app.exit(errors.length ? 1 : 0);
    }, 6000);
  });
}

if (!storageReady) {
  // Explained above; quitting.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    lockDown();
    protocol.handle("app", serve);
    buildMenu();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
