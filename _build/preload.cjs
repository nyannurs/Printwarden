// The only bridge between the web app and the desktop. Exposed as `window.desktop`;
// app/platform.js is the single place that uses it.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  openPdf: () => ipcRenderer.invoke("open-pdf"),
  savePdf: (suggestedName, bytes) => ipcRenderer.invoke("save-pdf", suggestedName, bytes),
  /** A dropped File: remember its path so an export can never overwrite it. */
  rememberFile: (file) => ipcRenderer.invoke("remember-source", webUtils.getPathForFile(file)),
  onMenu: (handler) => ipcRenderer.on("menu", (_event, command) => handler(command)),
  listCmykProfiles: () => ipcRenderer.invoke("list-cmyk-profiles"),
  chooseSavePath: (suggestedName, filter) => ipcRenderer.invoke("choose-save-path", suggestedName, filter),
  writeChosenFile: (file, bytes) => ipcRenderer.invoke("write-chosen-file", file, bytes),
  readProfile: (file) => ipcRenderer.invoke("read-profile", file),
  videoAvailable: () => ipcRenderer.invoke("video-available"),
  videoBegin: (file, options) => ipcRenderer.invoke("video-begin", file, options),
  videoFrame: (id, bytes) => ipcRenderer.invoke("video-frame", id, bytes),
  videoEnd: (id) => ipcRenderer.invoke("video-end", id),
  videoAbort: (id) => ipcRenderer.invoke("video-abort", id),
  os: process.platform, // "darwin", "win32": macOS's title bar covers the page's top line (styles.css)
  osVersion: process.getSystemVersion(), // macOS 26 rounds windows more (platform.js)
  onFullScreen: (handler) => ipcRenderer.on("full-screen", (_event, on) => handler(on)),
  memory: process.getSystemMemoryInfo().total * 1024, // bytes of RAM: how many render threads fit
  quit: () => ipcRenderer.invoke("quit"),
  latestRelease: () => ipcRenderer.invoke("latest-release"), // see "updates" in main.cjs
  openReleases: () => ipcRenderer.invoke("open-releases"), // the welcome screen's Quit (on macOS closing the window wouldn't)
});
