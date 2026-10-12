// The only place that knows whether we run in the desktop shell or a plain browser.
// The desktop shell (Electron, see _build/) exposes `window.desktop` from its preload.

import product from "../product.json" with { type: "json" };

export const APP_NAME = product.name;
export const APP_VERSION = product.version;
const desktop = window.desktop ?? null;
// The system, for the few looks that differ (styles.css, `data-os`): "darwin", "win32"; none in a browser.
if (desktop?.os) document.documentElement.dataset.os = desktop.os;
// macOS rounds a window's corners, except in fullscreen: 10 pt up to macOS 15, 16 pt from
// macOS 26 for a window with a title bar and no toolbar, as this one. The frame's lower
// corners follow (styles.css, --window-corner; a CSS pixel is a point on a Mac).
if (desktop?.os === "darwin") {
  const major = parseInt(desktop.osVersion, 10) || 0;
  document.documentElement.style.setProperty("--window-corner", `${major >= 26 ? 16 : 10}px`);
  desktop.onFullScreen?.((on) => document.documentElement.toggleAttribute("data-full-screen", on));
}
/** The computer's memory, bytes (a browser tells at most 8 GB). */
export const SYSTEM_MEMORY = desktop?.memory ?? (navigator.deviceMemory ?? 8) * 2 ** 30;

/** Ask for a PDF. Resolves to {name, bytes} or null if cancelled. */
export async function pickPdf() {
  if (desktop) return desktop.openPdf();
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    input.addEventListener("change", async () => {
      const file = input.files[0];
      resolve(file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Save a PDF. Resolves to the saved path/name, or null if cancelled. */
export async function savePdf(suggestedName, bytes) {
  if (desktop) return desktop.savePdf(suggestedName, bytes);
  return download(suggestedName, bytes, "application/pdf");
}

/**
 * Two-step save: ask where first (desktop), write later. Resolves to a handle with
 * write(bytes) -> saved name, or null if cancelled. In a plain browser the file is
 * downloaded when written.
 */
export async function chooseSaveLocation(suggestedName, filter) {
  if (!desktop) {
    return { name: suggestedName, write: async (bytes) => download(suggestedName, bytes, filter.mime) };
  }
  const file = await desktop.chooseSavePath(suggestedName, { name: filter.name, extensions: filter.extensions });
  if (!file) return null;
  return {
    name: file.split(/[\\/]/).pop(),
    write: (bytes) => desktop.writeChosenFile(file, bytes),
    /** Desktop only: a ProRes 4444 video written frame by frame (RGBA, straight alpha). */
    proRes: async ({ width, height, fps }) => {
      const id = await desktop.videoBegin(file, { width, height, fps });
      return {
        frame: (rgba) => desktop.videoFrame(id, rgba),
        end: () => desktop.videoEnd(id),
        abort: () => desktop.videoAbort(id),
      };
    },
  };
}

/** Whether the app can quit itself (the desktop app; a browser tab can't close itself). */
export const canQuit = !!desktop;

/** Quit the app (the welcome screen's Quit). */
export function quit() {
  desktop?.quit();
}

/** Can this copy of the app write transparent (ProRes) videos? Desktop with FFmpeg only. */
export async function proResAvailable() {
  return desktop ? desktop.videoAvailable() : false;
}

/** Browser only: save by downloading. */
function download(name, bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return name;
}

/** Remember a dropped file's location, so an export can never overwrite it. */
export function rememberDroppedFile(file) {
  desktop?.rememberFile(file);
}

/** CMYK printing profiles installed on this computer (desktop only): [{name, path}]. */
export async function listCmykProfiles() {
  return desktop ? desktop.listCmykProfiles() : [];
}

/** The bytes of a profile from listCmykProfiles(), or null (not one of them). */
export async function readProfile(path) {
  const bytes = desktop ? await desktop.readProfile(path) : null;
  return bytes ? new Uint8Array(bytes) : null; // (never an empty profile)
}

/**
 * The newest release on GitHub, asked once a start (desktop only; a browser asks nothing):
 * {tag, newer} with `newer` if it is a later version than this one, or null if it couldn't
 * be asked (offline, say). The shell asks GitHub for the latest release, nothing else.
 */
export async function latestRelease() {
  return desktop?.latestRelease ? desktop.latestRelease().catch(() => null) : null;
}

/** Open the releases page in the browser (desktop; in a browser, a new tab). */
export function openReleases() {
  if (desktop?.openReleases) desktop.openReleases();
  else window.open(`https://github.com/${product.repository}/releases`, "_blank", "noopener");
}

/** Menu commands from the desktop shell (File > Import…, File > Export…). */
export function onMenuCommand(handler) {
  desktop?.onMenu(handler);
}
