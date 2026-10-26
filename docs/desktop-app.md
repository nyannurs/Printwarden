# The desktop app (`_build/`)

The desktop app is the web app inside Electron. The shell (`_build/main.cjs`) gives it a window, native open and save dialogs, and its own data folder, and keeps it to its own files. The app itself knows nothing about Electron. `app/platform.js` is the one place that uses what the shell offers, through `window.desktop`.

| File | What it does |
|---|---|
| `main.cjs` | The shell: the window, the menus, serving the app, the dialogs, file access, the data folder, the update check, FFmpeg, the lockdown. |
| `preload.cjs` | The only bridge between the app and the shell: the functions exposed as `window.desktop`. |
| `build.mjs` | Copies the app into `web/` and packages it with electron-builder. |
| `icons.cjs` | Draws the app icons from their SVGs, with Electron's own Chromium, for the build. |
| `ffmpeg-lgpl/` | FFmpeg for Windows, Apple Silicon and Intel Macs, with its license and how it was built. |
| `Start (Windows).bat`, `Start (macOS).command` | Run the app from source. |
| `Build for Windows.bat`, `Build for macOS.command` | Build the portable app. |
| `README.txt` | Building step by step, in plain words. |

## Serving the app

The shell serves the app from disk over a private `app://` scheme. ES modules and the PDF workers then load exactly as in a browser. `index.html` sets a strict content policy: scripts, styles, workers and connections only from the app itself, plus `data:` and `blob:` URLs.

## What the app may touch

The shell locks the app down (`lockDown`):
- **No network.** Every request outside the app's own files is refused, with one exception: the update check below.
- **No permissions.** Camera, microphone, location and notifications are all refused.
- **No downloads.**
- **The page is sandboxed.** No Node.js in the page, and the context is isolated. The preload's functions are the only way out.

Files:
- **Reads** only the PDFs you choose (import, cover, spine, spot finish, or dropped on the window), and the CMYK profiles in the system's color folders:
  - on a Mac, ColorSync's folders and Adobe's;
  - on Windows, `System32\spool\drivers\color` and Adobe's.
- **Writes** only the files you choose to save. Saving is two-step: you choose the place first, and only a path chosen in that dialog can be written. An export never overwrites the PDF you imported; the dialog says so and asks for another name.

## The data folder

The built app is portable: no installer, nothing unpacked elsewhere at start. Everything it writes goes into one folder:
- **Windows**: `Printwarden Data`, next to `Printwarden.exe`.
- **macOS**: inside the app, `Printwarden.app/Contents/Printwarden Data`.

In it are:
- the preferences;
- the window's size and place (restored only if it still lands on a connected screen);
- Chromium's caches, logs and temporary files.

Deleting it resets the app. If the folder can't be written (a read-only drive, a zip, a Mac app run from Downloads), the app says so and quits rather than writing anywhere else. Development runs use `_build/dev-data`.

## The update check

The app's only request to the internet: once a start, the shell asks GitHub for the latest release of this repository.
- **What it sends**: nothing but the request itself.
- **Where it runs**: in a session of its own, kept in memory, never in the page.
- **What happens**: the release's tag (for example v1.0.0) is compared with the app's version, number by number. If it is newer, the welcome screen shows **Update available**, which opens the Releases page in your browser.
- **When it fails** (offline, or anything unexpected): no notice. Nothing is downloaded or installed.

## Menus

- **Windows**: no menu at all; the app's own buttons do everything.
- **macOS**: the system menu every Mac app has, kept to the essentials. There is no View menu, so no reload, developer tools or zoom.

## FFmpeg

Transparent videos are ProRes 4444 in a .mov, written by FFmpeg 9.0.2, which ships inside the app.
- **How it was built**: by `tools/build-ffmpeg.sh` from the official source, with only what the app needs: raw frames in on a pipe, the scaler, the ProRes encoder, the MOV container. No other libraries, no network, nothing under the GPL. FFmpeg's own LGPL 2.1 or later applies.
- **How it runs**: the shell starts it as a separate program with fixed arguments and passes it frames. It is not linked into the app, and you may replace it with your own build.
- **What ships with it**: its license and a notice of exactly how it was built. FFmpeg's source is attached to every release.

MP4 videos don't use FFmpeg. They use the computer's own encoder.

## Building

`build.mjs` copies the app into `_build/web` and packages it. The name, id and version come from `product.json`.
- **Windows**: a folder with `Printwarden.exe`, zipped. It is a folder, not a single .exe: a one-file .exe unpacks itself into Windows' temporary folder every time it starts, outside its own folder.
- **macOS**: `Printwarden.app`, universal (Apple Silicon and Intel), zipped, with an ad-hoc signature. Apple Silicon runs no code without one.
- **Signing**: neither build is signed by Microsoft or Apple, so each computer asks once (see the [README](../README.md)).
- **The color profile**: the build checks that the default CMYK profile is there.

On GitHub, the **Build desktop app** workflow (`.github/workflows/build-desktop.yml`) builds both on GitHub's machines, so a Mac build doesn't need a Mac. Given a release's tag, it attaches both zips to that release.

The **Check** workflow runs the linter and the type checker on every push and pull request.

## Releasing

A release is made in five steps:
1. Raise the version in `product.json`.
2. Create the release on GitHub as a draft, with its notes, a short changelog of one line per change you would notice, and FFmpeg's source attached (the LGPL asks for it).
3. Run the **Build desktop app** workflow with the release's tag; it attaches the Windows and macOS zips.
4. Check that the release lists the three files.
5. Publish it. The app's update check finds it from then on.

## Development switches

These work only when running from source, never in a build:
- **`BOOKVIEW_SMOKE=out.png`**: a smoke run. The app opens off-screen, out of the taskbar, never focused. It reports console errors, saves a screenshot and quits, so several can run while you work.
- **`BOOKVIEW_SMOKE_OPEN`, `BOOKVIEW_SMOKE_SAVE_AS`**: answer the open and save dialogs.
- **`BOOKVIEW_LATEST=<tag>`**: stands in for GitHub's answer to the update check.
- **`BOOKVIEW_LAB=<page>`**: opens an experiment page.
- **`BOOKVIEW_ANGLE=<backend>`**: draws through another of ANGLE's backends (`gl`, `metal`, `d3d11`), to compare them. The performance check's GPU line shows which one ran.

The tools in `tools/` use these (see [Testing](testing.md)).
