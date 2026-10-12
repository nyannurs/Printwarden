// Renders the app icons (SVG, in ../app) to the PNGs electron-builder turns into the Mac
// .icns and the Windows .ico. Run by build.mjs with Electron itself (its Chromium draws the
// SVG): electron icons.cjs '[{"svg": ..., "png": ..., "size": ...}, ...]'
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// Electron's own files for this run stay in the build folder, deleted afterwards.
const scratch = path.join(__dirname, "icons", ".electron");
app.setPath("userData", scratch);
app.setPath("sessionData", scratch);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let failed = false;
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL("about:blank");
    for (const { svg, png, size } of JSON.parse(process.argv.at(-1))) {
      const url = `data:image/svg+xml;base64,${fs.readFileSync(svg).toString("base64")}`;
      const data = await win.webContents.executeJavaScript(`(async () => {
        const image = new Image();
        image.src = ${JSON.stringify(url)};
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = ${size};
        canvas.getContext("2d").drawImage(image, 0, 0, ${size}, ${size});
        return canvas.toDataURL("image/png");
      })()`);
      fs.writeFileSync(png, Buffer.from(data.split(",")[1], "base64"));
    }
  } catch (err) {
    console.error(err);
    failed = true;
  }
  app.exit(failed ? 1 : 0);
});
