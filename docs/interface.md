# The interface (`app/ui/`)

The interface ties the parts together. It has no print logic of its own:
- the arithmetic comes from `app/core/`;
- the pictures come from `app/pdf/`;
- the book comes from `app/viewer/`.

What it adds is the window, the controls, and the bookkeeping of which page has which image.

| File | What it does |
|---|---|
| `app.js` | The coordinator: the app's state, importing, re-analyzing after every change, exporting. Creates the scene, the timeline and the side panel. |
| `inspector.js` | The side panel. |
| `filmstrip.js` | The timeline. |
| `view.js` | Around the 3D view: zoom steps, camera presets, backdrop, drag and drop, the frame counter, the performance check shortcut. |
| `pages.js` | Page images for the 3D view: loading, sharpening, vector text, thumbnails. |
| `dialogs.js` | Every dialog: import, export choice, imposed export, HTML export, screenshot, video, spot finish, book spine, About and Licenses, reports. |
| `capture.js` | Screenshots and videos: the pages at the output's resolution, the MP4 encoder, ProRes through FFmpeg. |
| `client.js` | The client viewer export (see [The client viewer](client-viewer.md)). |
| `colour.js` | The CMYK profile and overprint choices. |
| `spine-panel.js` | The spine's color or artwork and the Book spine panel. |
| `finish.js` | Spot finishes. |
| `compass.js` | The view's compass. |
| `probe.js` | The performance check. |
| `dom.js` | Shared pieces: toasts, the loading bar, the progress window, pills, the app's own scrollbars and dropdown lists, whole-pixel placement. |

Beside them, `app/platform.js` is the only place that knows whether the app runs in the desktop shell or a browser. It covers:
- opening and saving files;
- the computer's memory;
- the installed CMYK profiles;
- ProRes availability;
- the update check;
- Quit.

## The state and the flow

`state` (app.js) holds everything about the open document:
- the source bytes, kept for export;
- the source pages, and any cover file, spine artwork and spot finish;
- the setup, which is your settings, and the analysis made from it;
- which image each page has on the graphics card (`textures`) and which sharp strips (`details`);
- the color choices, the backdrop, the export options;
- `generation`, which bumps on every re-analysis so renders made for an old one are dropped.

The flow:
1. `startImport` asks (importDialog), then `openDocument` reads the structure and starts the renderers in parallel.
2. `reanalyse` runs `analyse` with the setup.
   - It renders the side panel and the timeline.
   - It rebuilds the 3D book if its shape changed (`bookKey`), or only updates its look if not.
   - It applies the cover's extras (`applyCoverExtras`: side glue, the score, flaps), the wire, the headband and the spine.
   - It loads page images.
3. Every change in the side panel calls `updateSetup`, which merges the change and runs `reanalyse` again. Analysis is fast, so there is no partial update to get wrong.
4. **Export** asks which (exportChoiceDialog), then `exportImposed` or `exportClientViewer`.

## The side panel (`inspector.js`)

`Inspector.render` builds the panel from the analysis every time, in sections:
- Document, Document setup, Binding, Paper, Background, Color, Preflight.
- Each field reports changes through callbacks to app.js. While you pick a color, previews run live: paper, wire and headband colors.
- After a rebuild, the focus returns to the control you were using, if you stepped it with the arrow keys, committed it with Enter, or chose from it.
- Numbers show with their unit ("80 gsm", "3 mm"), are typed with or without it, and step with the arrow keys (in dialogs, the mouse wheel steps them too).
- Color rows are four swatches and a custom color.

## The timeline (`filmstrip.js`)

`Filmstrip.render` lays out cells from the analysis:
- **Reading order** shows facing pairs.
- **Press sheets** shows sheet sides, from the layout.

Thumbnails are the small images, 200 px tall. A click asks app.js to turn the book there. `setActive` highlights the open spread.

## Page images (`pages.js`)

The bookkeeping between the PDF and the 3D pages:
- **`loadAllTextures`** renders every page's base image, nearest the open spread first. A page's key names the color profile, the overprint setting, the source page and its trim. A page whose key hasn't changed keeps its image, so a settings change redraws only what it affects.
- **`sharpen`**, at rest:
  - It plans strips for every page in view (viewer/detail.js) at 1.25 image pixels per screen pixel.
  - It keeps strips already on screen that are within reach of the new plan (`sufficient`).
  - It renders the rest from the PDF's vectors. Strips outdated by a turn or a move are dropped.
- **`vectorText`** asks the render threads once per page and profile for its vector text. It packs it for the 3D page, and every image of that page leaves exactly those glyphs out.
- **`warmVisiblePages`** teaches every render thread the pages in view, so their strips render in parallel.
- **`thumbnail`** makes the small image, with all text.

## Dialogs (`dialogs.js`)

Each dialog is a function that returns a promise of the choices, or null if canceled. That keeps the callers simple: `const opts = await exportDialog(...)`.
- Dialogs remember their last settings for the session.
- Their labels can't be selected as text.
- Escape cancels.
- The Book spine panel is the exception: it floats, doesn't block the window, and can be dragged by its title.
- `mp4Bitrate` and the quality choices also live here: a ceiling of width × height × frame rate × bits per pixel, between 16 and 240 Mbit/s.

## Screenshots and videos (`capture.js`)

- **`renderScreenshot`** asks for the shape and size, then `scene.captureImage`. For each tile, `prepareCaptureTile` renders the pages in it at the tile's resolution. The PNG is written where you chose.
- **`renderVideo`** asks for the settings, then closes the book on its front cover and runs `scene.recordVideo` with a cue per turn.
  - Before each frame, `sharpenForVideo` renders whatever the frame needs sharper.
  - Frames go to the computer's own H.264 encoder through WebCodecs (hardware first), muxed by mp4-muxer.
  - With a transparent background, frames are piped to the bundled FFmpeg for ProRes 4444.
  - Afterwards the book, the camera and the turn speed are put back.
- File names carry the time they were made ("2026-10-16 at 17.25.03"), as macOS names screenshots, without colons.

## Color (`colour.js`)

- `colourOptions` lists the profiles: the included ISO Coated v2 (ECI), "From PDF" where the file has an output intent, and every installed CMYK profile.
- The last choice is remembered, as is overprint.
- `setColourProfile` and `setOverprint` restart the renderer and redraw every page. The old images stay until the new ones arrive.

## The spine (`spine-panel.js`)

- **The color presets** are sampled from each cover's spine edge: the average color along the front cover's left edge and the back cover's right edge, as printed on the paper's color. White and black are added.
- **Spine artwork** is a PDF's first page within its trim box. It is rendered with the current profile, at most 2400 px along its long side.
- **`spineFace`** turns it in quarter turns and mirrors it, because the spine face's texture runs from the front cover's side to the back's. That was checked with four colored corners: the artwork's top at the head, its right edge against the front cover, as on a book standing on a shelf.

## Spot finishes (`finish.js`)

`importFinish` renders the finish PDF's pages as masks, at 1600 px tall:
- in the same page geometry as the document, with spreads split alike;
- or, with one or two pages, onto the covers.

`applyFinish` hands the masks and the kind to the scene. A finish belongs to its document and is dropped on the next import.

## Around the view (`view.js`)

- **Zoom** in fixed steps (50 to 800 %), so a preset plus a step always frames the book alike. The slider snaps to the steps.
- **The camera menu**, the focus button and the backdrop color picker.
- **Drag and drop** of a PDF onto the window.
- **The frame counter**, updated four times a second from `scene.frameStats`.
- **Black or white type** for the counter and the zoom value. Four times a second, the brightness of the picture under them is read back from the graphics card after a drawn frame (`scene.sampleUnder`). That is a few kilobytes, with no stall, and the better-contrasting color is chosen.
- **Ctrl/Cmd+Shift+P** starts the performance check.

## The performance check (`probe.js`)

`runProbe(scene, onProgress)` measures the computer it runs on and returns a text report:
- The GPU, the screen (pixel ratio, canvas size, multisampling), processor threads, the book.
- The refresh rate, from frames with nothing drawn.
- **Panning where the view is**: as is, at half the pixels, without vector text, without re-pivoting onto the paper.
- **Dragging round the book**: as is, then without each of half the pixels, shadows, multisampling, vector text, and every sheet but the two open pages.
- **Turning pages quickly.**
- **Panning by hand**: the mouse's moves per second, frames drawn per second, the card's time, the resolution drawn at.

Each run reports frames per second, the 95th-percentile and worst frame time, the main thread's time, and the graphics card's time where it can be timed. The check freezes the motion resolution while it runs and puts everything back afterwards. The client viewer bundles the same file.

## Shared pieces (`dom.js`)

- **`toast`**: a message at the bottom of the window.
- **`showLoad`**: the loading bar along the top.
- **`showBusy`**: the progress window, with Cancel where canceling makes sense.
- **`fitPill`**: a pill as wide as its text, in whole squares of the layout grid.
- **`addScrollbar`**: the app's own scrollbar, an outlined pill. The system's is hidden.
- **Dropdowns**: every `<select>` keeps its closed look but opens the app's own list, in the pills' manner, with keyboard support. The system's list can't be styled.
- **`snapToPixels`**: keeps chosen elements on whole pixels. An edge on a half pixel is drawn a pixel off, and two pills alike came out a pixel apart.

## Styles

- `app/theme.css` holds the colors and the type: Space Grotesk for the interface, Space Mono for labels and readouts.
- `app/styles.css` holds the layout: a grid whose square (`--u`) follows the window's width, pills, panels, dialogs.
- On a Mac, the window's lower corners follow the system's rounding (`--window-corner`).
- The interface's own words (labels, headings) can't be selected. Only what is about the document can: its details and Preflight's notes.

## Preferences

Remembered between starts, in the browser storage of the app's data folder:
- the camera preset;
- the backdrop color;
- the CMYK profile choice;
- overprint.

The window's size and place are kept by the desktop shell. Nothing about a document is remembered.
