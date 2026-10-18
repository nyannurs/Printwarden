# How it works

Printwarden is a web app that runs inside a desktop shell. The app itself is plain JavaScript modules, with no build step. It uses three libraries:
- **three.js** for the 3D view;
- **pdf.js** to read and draw PDFs;
- **pdf-lib** to write the imposed PDF.

The shell is Electron. It gives the app a window and native open and save dialogs, and keeps it to its own files. The same app also runs in a plain browser, which is how the tests run, and its 3D part runs inside every client viewer.

## The four layers

The code lives in `app/`, in four layers. Work only passes downward: the interface uses the 3D view and the PDF code, and they use the arithmetic, which uses nothing. This one rule keeps the parts from tangling.

```
app/ui/  app/client/        the window, panels, dialogs, exports      (front desk)
      │            │
      ▼            ▼
app/viewer/     app/pdf/  app/impose/                                  (3D room, PDF room)
      │            │
      ▼            ▼
               app/core/        pure arithmetic: no screen, no PDF     (arithmetic room)
```

| Folder | Lines | Its job |
|---|---|---|
| `app/core/` | 1,700 | Page pairing, binding rules, imposition and folding schemes, sheet geometry, spine and paper figures, setup detection, Preflight. Pure numbers in millimeters. A test enforces that it imports nothing outside itself. |
| `app/pdf/` | 1,640 | Reading PDFs (pdf-lib) and drawing them (pdf.js) in background threads; color profiles; skipping drawing outside a sharp strip; the vector text's glyphs. |
| `app/impose/` | 160 | Writing the imposed PDF from a sheet plan. |
| `app/viewer/` | 7,000 | The 3D book: the physical model, layout, the GPU-built sheets and shaders, each binding's parts, the scene and its frame loop, the camera, input, screenshots and videos. |
| `app/ui/` | 3,960 | The window: state, the side panel, the timeline, dialogs, page images, exports, the performance check. |
| `app/client/` | 250 | The client viewer that runs in a client's browser, and the bundler that packs it. |
| `app/platform.js` | 130 | The one place that knows whether the app runs in the desktop shell or a browser. |

Outside `app/`:

| Path | What it holds |
|---|---|
| `index.html` | The window's markup and its strict content policy. |
| `app/styles.css`, `app/theme.css` | The look. |
| `vendor/` | The outside libraries, exactly as released, plus their licenses. pdf.js is patched in five lines by `tools/patch-pdfjs.py` (see [PDFs](pdf.md)). |
| `_build/` | The Electron shell and the build scripts. |
| `tests/` | The browser test suite. |
| `tools/` | Development tools: smoke runs, the geometry proof, render comparisons, the test documents' generators. |
| `testfiles/` | Test documents, made by `node tools/make-testfiles.mjs` (not in the repository: generate them). |
| `product.json` | The app's name, id, version and repository: one place for all of them. |

## What happens when you open a PDF

1. **The file is chosen** (ui/app.js `startImport`, ui/dialogs.js `importDialog`).
2. **Its structure is read in a background thread** (pdf/load.js `openPdf`, pdf/structure.js).
   - pdf-lib reads every page's boxes (MediaBox, TrimBox, BleedBox), its rotation, and the PDF's page labels, which are InDesign's section numbering.
   - It also reads the output intent's CMYK profile, and settings Printwarden left in a file it exported.
   - This is done in a thread so the window never freezes on a large file.
3. **The renderers start in parallel** (pdf/render.js `createRenderer`).
   - A pool of threads opens the file with pdf.js: half the processor's threads, two to six, fewer on a computer with little memory (three with 8 GB).
   - They wait only for the color profile, which depends on step 2.
4. **The document is understood** (core/analysis.js `analyse`).
   - From the pages and your settings: spread or single detection (core/detect.js), the setup (core/setup.js), the binding's rule (core/binding.js) and the book itself (core/book.js).
   - The book is every finished page with its folio number, its side and the place on its source page it comes from.
   - Then come the sheet layout (core/imposition.js) and Preflight (core/validate.js).
   - This is quick and pure, so it runs again on every settings change.
5. **The 3D book is built** (viewer/scene.js `setBook`).
   - The model (viewer/model.js `makeBook`) gives every leaf its thickness from the paper.
   - The scene makes one mesh per leaf, plus the binding's parts (viewer/extras.js).
6. **Page images arrive** (ui/pages.js `loadAllTextures`).
   - Every page is rendered once at a size that lets the whole book fit in memory, nearest the open spread first.
   - The images go to the graphics card two a frame, so a burst of finished renders never stutters.
   - Plain text is drawn on the 3D page from its outlines (viewer/vectortext.js), so the images leave it out.
7. **Every frame** (viewer/scene.js `#frame`):
   - the animations advance;
   - the layout places every sheet (viewer/layout.js, model.js `layoutBook`), and only sheets whose shape changed go to the graphics card;
   - the binding's parts follow (extras.js `layoutExtras`);
   - the frame is drawn: shadows only when they changed, sheets nearest first.
   - At rest nothing is drawn at all.
8. **When the view comes to rest** (ui/pages.js `sharpen`), the part of each page on screen is rendered again from the PDF's vectors, in strips. Each strip gets exactly the resolution its part of the screen needs, and is laid over the page.

## Rules the code keeps

- **The arithmetic is pure.** Everything a printer would check (which pages face, what goes on which sheet, how wide the spine is) is plain functions of numbers, tested on their own. The 3D model is the same: model.js has no three.js in it.
- **Heavy work runs in background threads.** Reading, rendering and writing PDFs never run on the thread that draws the window. If threads can't start, the same code runs on the main thread, slower.
- **Millimeters everywhere.** The core works in mm, and the 3D world is in mm: the book lies on a table, the spine along z, the head at −z.
- **Your file is read, never written.** Exports go to new files you choose, and the shell refuses to overwrite the PDF you imported.
- **Nothing is drawn at rest.** The frame loop draws only when something changed (an animation, input, a page image arriving), so an idle app uses no processor time.
- **Every frame of a video or a test runs on the scene's own clock.** A frame is placed by time, not by how long the last one took. Videos are evenly spaced, and tests give the same result every run.
- **Measure, then change.** Wherever a number was tuned (a resolution, a threshold, a budget), the comment beside it says what was measured. Many comments also record what went wrong before and in which version it was fixed, so the next change doesn't undo the lesson.
- **Whole pixels in the interface.** Sizes and positions are kept on whole pixels; a test measures the side panel at several window sizes.
- **Outside code is used as released.** Libraries sit in `vendor/` byte for byte, except the documented pdf.js patches. three.js's shaders are changed as text through `patchShader`, which fails loudly if an upgrade changed what it looks for.

## Names to keep apart

| Term | Meaning |
|---|---|
| Source index | A page's position in the PDF (0-based in code). |
| Folio | A page's position in the bound book, 1-based. Folio 1 is always a right-hand page (recto). |
| Label | What the reader sees as the page number: the PDF's own page label, or the folio counted from where the labels start. Labels never change folios. |
| Leaf | One sheet of paper in the book: two pages, front and back. Leaf `i`, counting from 0, carries folio `2i + 1` on its front and `2i + 2` on its back: leaf 0 is the front cover. |
| Opening | What lies open: 0 is the front cover, opening `j` shows pages `2j` and `2j + 1`. |
| Facing pair | Two pages seen together by the reader (core/pairing.js). |
| Sheet side | One side of a press sheet: which folios go where on it (core/imposition.js). In saddle stitch, a facing pair and a sheet side coincide only at the center spread. |
| Signature | Sheets folded and nested together, then gathered with the other signatures into the block. |
