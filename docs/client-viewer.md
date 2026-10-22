# The client viewer (`app/client/`, `app/ui/client.js`)

**Export > Export as HTML file** makes one HTML file with the book in it, for a designer to send a client. It opens in any browser, from a folder or hosted on a website. Nothing else goes with it: no PDF, no other files, nothing fetched from the internet. The client can turn the pages, open and close the book, change the camera and look round in 3D.

## What's in the file

| Part | What it is |
|---|---|
| The viewer's code | `app/client/viewer.js` and everything it imports: the app's whole 3D code (`app/viewer/`), three.js and its addons, and the performance check. Each module goes in as text. |
| The book | A description of the book as the app shows it, as JSON (`ClientBook`): the scene's own book spec, the background, the spine (color, artwork as a PNG, the covers' edge colors), the wire, the headband, side glue and the score, the page labels. |
| The pages | Every page as a JPEG (quality 0.86) at the height chosen in the dialog: 1024, 1536 or 2048 px. Blank pages carry nothing. |
| A small loader | It turns each module's text into a blob URL and writes an import map. Every import between the modules was rewritten to a key (`viewer/scene.js`, `three`, `three/addons/...`), and the map points each key at its blob. Then it starts the viewer. |

The file's size is mostly the JPEGs. If the viewer can't start, it shows why instead of a blank page.

## How the code is packed

`bundleModules` (client/bundle.js) starts at the viewer's entry module and follows every import:
- It reads each module's file, rewrites its imports to keys, and collects the text by key.
- three.js and its addons come from `vendor/`, everything else from `app/`.
- The bundler imports nothing from the app itself, so it can be tested on its own.

A test checks that the bundle holds the viewer, the 3D code and three.js, and that no import is left pointing at a file. A viewer exported after a change to the 3D code's imports would otherwise fail in the client's browser, where there are no files.

## What runs in the client's browser

`start(data, root)` (client/viewer.js) builds the book from the description, with the same calls the app makes:
- `setBook`, `setSpine`, `setWire`, `setHeadband`;
- side glue and the score;
- the background.

Then it adds its own controls:
- **Top row**: the title (cut short with an ellipsis if long), **Performance check**, and "Made with Printwarden" and the version.
- **Bottom bar**: **Previous**, the page numbers, **Next**, **Open book / Close book**, and the camera menu. It wraps onto a second row on a narrow screen.
- **Keys**: the arrow keys and Page Up / Page Down turn pages; Home and End go to the covers.
- **Mouse and touch**: drag, pan, zoom and click exactly as in the app, because the input code is the app's own.

The layout stays inside the screen's safe area (phones with a notch). On touch screens the buttons are 40 px tall, and the camera menu's text is 16 px, below which iOS zooms the page in on it. Hover styles apply only where there is hover.

The viewer draws at most 3.5 million device pixels. That is about what the app's 3D view has on a Retina laptop; the viewer fills the window.

### Loading pages

`pageLoader` handles the images as the app handles its own:
1. Every page is first decoded small, at the app's base height for the book, nearest the open spread first. The book shows at once and fills in.
2. When the book comes to rest, the spread before, the open one and the next are shown at the full exported size, one image a frame. All at once, turning stuttered.
3. Pages that leave that range go back to their small image and free their memory.

All pages at full size would be as much texture memory as the app's at its most.

## What it shares with the app

The viewer runs the app's own code, so a change to the 3D book reaches the next exported viewer by itself:
- **The 3D book** (`app/viewer/`): the model, the shaders, the bindings' parts, the camera, the input. The bundle carries the very files the app runs.
- **The camera presets**, from the app's list.
- **The performance check** (`app/ui/probe.js`), the same file as Ctrl/Cmd+Shift+P.
- **Everything about the look**, read off the app's live scene when exporting, not worked out again: paper colors and stocks, the endpaper color, the sheet thickness, the spine color and artwork, the covers' spine-edge colors.
- **The page images**, rendered by the app's own page renderer with your color profile, overprint as printed.
- **The base image size**, by the app's own rule.
- **The side-glue rule and the wire's finish**, from `app/core/binding.js`, the same as the app and Preflight.

Separate by design:
- **The controls.** The app's side panel and timeline don't belong in a client's file.
- **The page loader.** It decodes JPEGs rather than rendering from a PDF; its policy is the app's. It is the one place where a change in the app needs a matching change here, and its comment says so.
- **The look of the buttons.** Black pills (`CLIENT_CSS` in ui/client.js), independent of the app's panel.

## What it doesn't carry

- **Text from outlines.** The viewer has only images, so its sharpness is the height chosen in the dialog.
- **Cover flaps and spot finishes.** The app shows them in 3D; the viewer doesn't yet.
- **The PDF itself.** By design: a client's file can't leak the print data.
