BUILDING THE DESKTOP APP
========================

Everything needed to turn the app into a program you double-click lives in this
folder. You don't need to build after every change: build when you want a new
version to pass on.

Both builds are portable: no installer, and the app keeps to its own folder
(see "WHAT THE APP TOUCHES" below).


ONE-TIME SETUP
--------------

Install Node.js (the "LTS" version) from https://nodejs.org
  Windows: already installed on this computer.
  macOS:   download the macOS installer from nodejs.org and run it.

That's all. The first start or build downloads the rest by itself (a few hundred
MB, once). FFmpeg, for transparent videos, is already in this folder (see "FFMPEG"
below): nothing to fetch for it.


RUN IT WITHOUT BUILDING (quickest way to try changes)
------------------------------------------------------

Windows:  double-click  "Start (Windows).bat"
macOS:    double-click  "Start (macOS).command"

A console window opens alongside the app; closing it quits the app. Settings of
this development copy are kept in "_build/dev-data".


BUILD THE WINDOWS APP
---------------------

Double-click  "Build for Windows.bat"  and wait (a few minutes the first time).

When it's done, the "dist" folder opens:
  "<name> <version> Windows.zip"   send this one
  "win-unpacked"                   the same app, unzipped (to try it yourself)

It is a folder with <name>.exe in it, not a single .exe: a one-file .exe unpacks
itself into Windows' temporary folder every time it starts, outside its own
folder, which this app must not do.


BUILD THE MAC APP (on your Mac)
-------------------------------

1. Copy the whole project folder to the Mac (USB stick, cloud drive, anything).
   You can leave out _build/node_modules, _build/dist, _build/web and
   _build/dev-data; the build recreates what it needs, and replaces a
   node_modules that came from Windows by itself.

2. Once: make the two .command files runnable (a copy from Windows loses that).
   Open Terminal, type  chmod +x  followed by a space, drag the two .command
   files from this folder into the Terminal window, press Return.

3. Double-click  "Build for macOS.command"  and wait.
   If macOS refuses to open it: right-click it > Open > Open.

When it's done, the "dist" folder opens:
  "<name> <version> macOS.zip"   send this one
  "mac-universal/<name>.app"     the same app, unzipped

The app runs on Apple Silicon and Intel Macs.

(Without a Mac: put the project on GitHub, open the repository's "Actions" tab,
choose "Build desktop app", "Run workflow". The run's page then offers both zips.)


PASSING IT ON
-------------

Always send the freshly built zip, never a copy you have been using: that one
contains your own settings (and, on a Mac, is no longer in its original state,
which macOS may then refuse to open).

Neither build is signed by Microsoft or Apple, so each computer asks once:

Windows
  1. Unzip (right-click > Extract All). Keep the folder anywhere you can write to,
     e.g. Documents or the desktop, not inside the zip itself.
  2. Open <name>.exe. If Windows says "Windows protected your PC":
     "More info" > "Run anyway". Only the first time.

Mac
  1. Double-click the zip. Move <name>.app to Applications (or any folder).
  2. Open it. macOS says it can't check it for malicious software:
     System Settings > Privacy & Security > scroll down > "Open Anyway".
     Only the first time.
  Shortcut for step 2, instead: in Terminal,
     xattr -dr com.apple.quarantine /Applications/<name>.app
  (removes the "downloaded from the internet" mark; then it opens normally).

  Open the app from where you moved it, not straight out of the Downloads folder:
  macOS runs freshly downloaded apps from a hidden read-only copy, where the app
  can't keep its settings. It then says so and quits instead of writing anywhere
  else.


WHAT THE APP TOUCHES
--------------------

Writes, only in its own folder:
  Windows: "<name> Data" next to <name>.exe
  Mac:     inside the app, <name>.app/Contents/<name> Data
In it: settings (window size, camera view, backdrop, color profile), Chromium's
caches, logs, temporary files. Deleting it resets the app; nothing else is lost.
If the app can't write there (a read-only drive, run from inside a zip) it says so
and quits instead of writing anywhere else.

Outside that folder the app only:
  - reads a PDF you choose (Import, or dropped on the window), and the cover, spine
    and spot finish PDFs you choose
  - writes the files you choose to save (imposed PDF, HTML viewer, screenshot,
    video); it refuses to overwrite the PDF you imported
  - reads CMYK printing profiles in the system's color folders, to offer them under
    Color > CMYK profile (read only, never written)
Its only request to the internet: once a start, it asks GitHub for the latest
release's version number, to say when a newer one is out (nothing is sent but the
request itself, nothing is downloaded). Every other request is blocked, and it asks
for no permissions (camera, microphone, location, notifications: all refused).

What the operating system itself records about any program you run is outside
the app's control: e.g. recent files and folders in the open/save dialogs, and
graphics-driver shader caches (Windows); the open/save panels' last folder and
window-restore data in your Library (Mac). These contain no document content.


RENAMING THE APP
----------------

The name, version and id live in one file: product.json in the project folder.
Change "name" there and rebuild (the app icon is separate: app/icon.svg for the Mac
and the About window, app/icon-windows.svg for Windows); the window title, menus, file names and the data
folder ("<name> Data") all follow. A renamed app starts with fresh settings (its
data folder has the new name; the old one can be deleted). Change "appId" too if
Macs should treat it as a different program.


FFMPEG (TRANSPARENT VIDEOS)
---------------------------

"Render video" with a transparent background writes ProRes 4444 (.mov) with FFmpeg,
which ships inside the app. It is in this folder, ready: _build/ffmpeg-lgpl/ holds FFmpeg
for Windows, Apple Silicon Macs and Intel Macs (3 to 4 MB each), built from the official
FFmpeg 9.0.2 source with only what Printwarden uses (raw frames in, ProRes 4444 out, MOV),
nothing else: no download during a build. Each comes with its license (LGPL 2.1 or later)
and a NOTICE.txt saying exactly how it was built and where its source is.
Normal videos (MP4) don't use FFmpeg.

To build them again (a new FFmpeg version, say): tools/build-ffmpeg.sh, from Git Bash on
Windows; it lists the four downloads it needs and checks each one.

When publishing the app, also offer FFmpeg's source next to it: attach
ffmpeg-9.0.2.tar.xz (ffmpeg.org/releases) to the release (the LGPL asks for it).


COLOR PROFILES
--------------

vendor/icc/ISOcoated_v2_eci.icc: ISO Coated v2 (ECI), the default CMYK profile,
so colors look the same on every computer. It ships by permission of the European
Color Initiative and is not under the GNU Affero General Public License: see
vendor/icc/README.txt.
A PDF with its own output intent (PDF/X) still uses that, and the CMYK profiles
installed on the computer are offered too.


WHAT'S IN THIS FOLDER
---------------------

main.cjs        the desktop shell: window, menus, open/save dialogs, where the
                app keeps its data, what it may touch
preload.cjs     the bridge between the shell and the app (the only way the app
                reaches files: through the dialogs above)
build.mjs       copies the app into "web" and packages it
package.json    lists the two build tools (Electron, electron-builder)

ffmpeg-lgpl     FFmpeg for each system, with license and notice (see FFMPEG above)
icons.cjs       draws the app icons (app/icon.svg, app/icon-windows.svg) as PNGs
                for a build

Created by builds and runs, safe to delete: node_modules, web, dist, dev-data,
dev-data-smoke, ffmpeg, ffmpeg-cache, icons (ffmpeg and ffmpeg-cache are from older
builds; ffmpeg-cache also holds the tools for tools/build-ffmpeg.sh, if it ran)


IF SOMETHING GOES WRONG
-----------------------

"npm is not recognized" / "command not found: npm"
    Node.js isn't installed, or the computer needs a restart after installing.

The build stops with a network error
    Run it again; the tools download parts of themselves on first use.

"<name> can't start from here"
    The app can't write to its own folder. Windows: unzip it to a normal folder
    first. Mac: move the app out of Downloads (or see the Terminal shortcut in
    "PASSING IT ON").

The app opens but shows nothing
    Start it with "Start (Windows).bat" / "Start (macOS).command" and press F12:
    the developer tools show the error. Note it down.
