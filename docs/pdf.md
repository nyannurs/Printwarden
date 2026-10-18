# PDFs (`app/pdf/`, `app/impose/`)

Two libraries handle PDFs:
- **pdf-lib** reads a file's structure and writes the imposed PDF.
- **pdf.js** draws pages into images.

Both run in background threads, so a large file never freezes the window.

| File | What it does |
|---|---|
| `load.js` | The interface's entry to PDF work: reading structure and writing the imposed PDF, in a background thread (`tasks-worker.js`), or on the main thread if threads are unavailable. |
| `structure.js` | Reads every page's boxes, rotation and labels, the output intent's profile, and settings an earlier Printwarden export left in the file. |
| `render.js` | The pool of render threads: what to draw, in which order, on which thread, and caching. |
| `render-worker.js` | One render thread: opens the document in pdf.js and draws pages, regions and the vector text's analysis. |
| `parser-worker.js`, `parser-profile.js` | pdf.js's parsing thread, with the chosen CMYK profile and the fast JPEG decoder plugged in. |
| `cull.js` | Which drawing operations a render of part of a page may skip. |
| `icc.js` | Reads an ICC profile's header: color space, class, description. |
| `sample.js` | The built-in sample document. |
| `app/impose/writer.js` | Writes the imposed PDF from a sheet plan. |

## Reading a file

`readStructure` (structure.js) reads, with pdf-lib, what pdf.js doesn't expose:
- **Every page's boxes**: MediaBox, TrimBox, BleedBox. pdf.js only knows the MediaBox and CropBox.
- **`/Rotate`**: the displayed size is computed after rotation.
- **Page labels** (`/PageLabels`), the PDF's own page numbering.
- **The output intent** (PDF/X): its CMYK profile and its name. The name is taken from the PDF's `/Info` entry, which is what InDesign writes ("Coated FOGRA39 (ISO 12647-2:2004)"), else the profile's own description, else the condition's identifier.
- **Printwarden's own settings**, in the info dictionary of a file it exported: binding, signature size, pages a sheet, page size, sheet count. The import dialog fills itself in from them.

## Drawing pages

### The pool of threads

`createRenderer` (render.js) starts the threads:
- **How many:** half the processor's threads, between two and six, fewer with little memory (three on an 8 GB computer). Each thread holds what it has learned from the file, about 100 MB for a 10 MB report.
- **Sharing the file:** a file under 24 MB is copied to each thread, which pdf.js reads fastest. A larger one stays in a single shared Blob, read by the piece in 256 KB parts, with no copies.
- **Spare threads:** while the computer is idle, spare threads start for the next document. Its first pages then begin rendering while the rest load.
- **Resting:** a thread idle for 20 seconds lets go of the pages and caches it built.

The scheduler (`Scheduler`, `pump`) decides what goes where:
- **Priorities:** sharp strips first, then pages in view, then the rest by distance from the open spread.
- **Which thread:** a thread keeps the last four pages it interpreted (their operations, decoded images and glyph outlines). Another render of one of those takes milliseconds there. So a page goes to the thread that knows it. Its sharp strips go to any thread that knows it, so they render in parallel once the page has been taught to them (`warm`).
- **Canceling:** work no longer needed is dropped from the queue. A render in progress stops within one slice, about 15 ms, because the thread yields between slices so a cancel can arrive.

Pages are rendered with pdf.js's "display" intent, not "print". In print mode pdf.js throws away a page's interpreted content after every render, which made each render redo about 0.3 s of work. For InDesign output the two intents draw the same.

### What gets rendered

| Image | Size | Used for |
|---|---|---|
| Base image | 700 to 1600 px tall: as large as a 480 MB budget allows for the whole book | Every page in 3D |
| Small image | 200 px tall | The timeline thumbnail, show-through on thin paper, a page small on screen |
| Sharp strips | Exactly what the screen needs, up to 8192 px a side | The part of a page on screen, at rest |
| Capture images | What a screenshot tile or a video frame needs | Exports |

Results come back as ImageBitmaps, handed over without copying.

### Skipping work outside a strip

A sharp strip covers a small part of a page, but pdf.js executes the whole page's drawing for every render. Most of it is cheap to clip. Soft masks are not: InDesign drop shadows are soft masks, each a pass over a canvas-sized buffer, and a page with 200 shadows took seconds per strip.

`cull.js` skips only whole, self-contained blocks: a save/restore pair, a form or a transparency group. pdf.js restores all graphics state when such a block ends, so skipping it can't change anything drawn after it. A block is skipped only if what it can paint is proven to lie outside the strip:
- Forms and groups: their bounding box.
- Paths: their own bounds, widened for strokes.
- Text, shadings and images could be anywhere, so a block holding them is always drawn. Its sub-blocks may still be skipped.

Images are never skipped at all. In Chromium, how an image draws depends on which images were drawn before it on the same canvas: skipping four images outside a strip changed a few hundred pixels of the images inside it. Everything else was verified pixel for pixel against unskipped renders on every page of a 44-page InDesign document.

## Color management

### CMYK

pdf.js converts plain CMYK (DeviceCMYK) with a built-in US profile. Printwarden replaces that with the profile you choose. The default is ISO Coated v2 (ECI), shipped with the app. The alternatives are the PDF's output intent or any profile installed on the computer (ui/colour.js).

pdf.js loads its CMYK profile by a fixed file name the first time it meets plain CMYK. `parser-profile.js` answers that request with the chosen profile. The profile arrives as a message that this code sees before pdf.js does. So the document can be opened before the profile is known: the profile depends on the output intent, which is read in parallel.

Profiles embedded in the PDF (ICCBased colors) are always honored, through qcms. Changing the profile restarts the renderer and redraws every page; the old images stay on screen until the new ones arrive.

### Overprint

pdf.js ignores the overprint keys (`OP` for strokes, `op` for fills). A patch makes them set the blend mode while overprint is shown: multiply, as Acrobat's Overprint Preview shows ink laid over ink. White set to overprint vanishes. With **Overprint** off, overprinting objects cover what is under them, as most viewers draw them.

### JPEG

CMYK photos are decoded by jpeg-decoder (image-rs), compiled to WebAssembly (`vendor/jpeg-decoder.wasm`, from `tools/jpegwasm`). pdf.js's own decoder is JavaScript and far slower on large photos. When a file carries Adobe's APP14 marker, that marker decides the color transform, as in pdf.js. Anything this decoder can't take goes back to pdf.js's own.

## Vector text

Plain text is drawn on the 3D page from its glyph outlines (see [The 3D book](3d-view.md#vector-text)), so it stays exact at any zoom. The render threads decide which glyphs:
- `analyse` renders the page small, 512 px tall. Glyph boxes are exact at any size, and soft masks cost by the pixel. It records every glyph pdf.js paints: where it can paint, its outline, its placement and its color.
- Only plain text qualifies:
  - filled, not stroked or used as a clip;
  - a solid color, not a pattern;
  - fully opaque, with the normal blend;
  - not clipped through, and not inside a transparency group or a soft mask;
  - in a font with real outlines (not a Type 3 font).
- `decide` walks from the last thing drawn back to the first. A glyph becomes vector text only if nothing drawn after it, which stays in the image, overlaps it.
- Every render of that page for the 3D view then leaves exactly those glyphs out. The set is keyed, so every thread leaves out the same glyphs. A test checks that.
- Everything else stays in the page's image, drawn by pdf.js as usual.

## The pdf.js patches

`tools/patch-pdfjs.py` changes five lines of pdf.js, each documented in the script, which refuses to run if pdf.js changed under it:
1. **The JPEG decoder** (`pdf.worker.mjs`): pdf.js asks ours first.
2. **Overprint** (`pdf.worker.mjs`): the keys set the blend mode, as above.
3. **Image smoothing** (`pdf.mjs`): an image is smoothed only where it is drawn smaller than its own pixels, or where the PDF asks for it with `/Interpolate`. It is never smoothed where it is enlarged, as a print RIP draws it. pdf.js smoothed anything enlarged up to 1.33 times, so one image drew soft in a page rendered small and crisp in the same page rendered large.
4. **A scale computed as NaN** (`pdf.mjs` and `pdf.worker.mjs`, two lines): a transform's two scale factors came from the square root of a difference that rounding made a hair negative, giving NaN, then a scale of 1. An image enlarged 11 times then counted as unscaled and was smoothed: one page of a pixel-art book came out blurry at some render sizes. The difference is now clamped at zero.

## Writing the imposed PDF

`writeImposedPdf` (impose/writer.js) executes the sheet plan from core/sheets.js with pdf-lib:
- **Pages stay vectors.** Each source page is embedded once as a form XObject and placed, clipped to its visible region, wherever it goes. Fonts, vectors and color are untouched. Spread halves share their resources.
- **Upside-down cells** (a folding scheme's upper row) are drawn turned 180° about their trim.
- **Creep** shifts each placement toward the spine by the plan's amount.
- **Marks** are 0.25 pt hairlines in registration color (100 % of all four inks):
  - crop marks at the trim's corners;
  - dashed fold marks outside the area at every fold;
  - solid marks at the cuts inside a scheme's sheet;
  - the page information line in 6 pt type.
- **The output intents are copied**, so a PDF/X workflow survives imposition.
- **The file is labeled**: its title names the source and "(imposed)", and Printwarden's settings go into the info dictionary for the next import.

The writer runs in a background thread. The interface hands over the source bytes and receives the new file.
