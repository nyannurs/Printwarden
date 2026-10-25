# PDFs (`app/pdf/`, `app/impose/`)

Two libraries handle PDFs:
- **pdf-lib** reads a file's structure and writes the imposed PDF.
- **MuPDF** draws pages into images, as the press prints them.

Both run in background threads, so a large file never freezes the window.

| File | What it does |
|---|---|
| `load.js` | The interface's entry to PDF work: reading structure and writing the imposed PDF, in a background thread (`tasks-worker.js`), or on the main thread if threads are unavailable. |
| `structure.js` | Reads every page's boxes, rotation and labels, the output intent's profile, and settings an earlier Printwarden export left in the file. |
| `render.js` | The pool of render threads: what to draw, in which order, on which thread, and caching. |
| `mupdf-worker.js` | One render thread: MuPDF drawing pages for the pool. |
| `mupdf-render.js` | The drawing itself (`InkDocument`): a document open in MuPDF, its pages with their separations, a page's region drawn as an sRGB image or as its inks. The threads use it, and the main thread if threads can't start. |
| `icc.js` | Reads an ICC profile's header: color space, class, description. |
| `sample.js` | The built-in sample document. |
| `app/impose/writer.js` | Writes the imposed PDF from a sheet plan. |

## Reading a file

`readStructure` (structure.js) reads, with pdf-lib:
- **Every page's boxes**: MediaBox, TrimBox, BleedBox.
- **`/Rotate`**: the displayed size is computed after rotation.
- **Page labels** (`/PageLabels`), the PDF's own page numbering.
- **The output intent** (PDF/X): its CMYK profile and its name. The name is taken from the PDF's `/Info` entry, which is what InDesign writes ("Coated FOGRA39 (ISO 12647-2:2004)"), else the profile's own description, else the condition's identifier.
- **Printwarden's own settings**, in the info dictionary of a file it exported: binding, signature size, pages a sheet, page size, sheet count. The import dialog fills itself in from them.

## Drawing pages

Pages are drawn by [MuPDF](https://mupdf.com) (Artifex Software), the renderer behind many print tools, as Printwarden's own build of its WebAssembly (`vendor/mupdf/`, built by `tools/mupdf/`, see its README): the published package leaves out three things a print proof needs, so a few functions are added to its glue. Nothing of MuPDF itself is changed.

### The pool of threads

`createRenderer` (render.js) starts the threads:
- **How many:** half the processor's threads, between two and six, fewer with little memory (three on an 8 GB computer), and fewer for a large file: every thread holds its own copy of the file in MuPDF's memory (MuPDF reads a file whole; the copies together take at most 1.5 GB), plus what it caches from it (decoded images and fonts, up to 100 MB).
- **Spare threads:** while the computer is idle, spare threads start for the next document (each instantiates 10 MB of WebAssembly). Its first pages then begin rendering while the rest load.
- **Resting:** a thread idle for 20 seconds lets go of the pages and caches it built.

The scheduler (`Scheduler`, `pump`) decides what goes where:
- **Priorities:** a capture's images first, then the view's tiles nearest the screen's middle, then every page's base image by distance from the open spread.
- **Which thread:** a thread keeps the last eight pages it read, their decoded images above all, so another render of one is quickest there. A page goes to the thread that knows it; its tiles and a capture's strips to any free thread (MuPDF reads a page in milliseconds; a photo's JPEG is decoded once more on another thread).
- **Canceling:** work no longer needed is dropped from the queue. A render in a thread's hands runs on: tens of milliseconds at most.

### What gets rendered

| Image | Size | Used for |
|---|---|---|
| Base image | 700 to 1600 px tall: as large as a 480 MB budget allows for the whole book | Every page in 3D |
| Tiles | 1024 px square, at twice the base image's density and up (32 × at most) | The part of a page on screen, as the view moves; kept (see [The 3D view](3d-view.md)) |
| Sharp strips | Exactly what a capture needs, up to 8192 px a side | A screenshot's or a video frame's pages |
| Thumbnail | 200 px tall | The timeline |
| Capture images | What a screenshot tile or a video frame needs | Exports |

All of these come back as the page's inks (`mode: "ink"`): a byte a channel, Cyan, Magenta, Yellow, Black, in the chosen profile (plain CMYK exactly as in the file, RGB content converted into it), and the page's spot colors as channels of their own, up to four (`SPOT_CHANNELS`: a second RGBA image, with the names of the spots in it). The 3D view and the timeline turn them into the color they print through the ink table (below), every plate switched there, the spots mixed in as MuPDF composites them: CMYK plus each spot's tint times its look in CMYK, at most full ink (checked against MuPDF's own composite, overprint included: `tests/press.test.js`). So every plate, spots included, changes every page at once, as does the profile's look of plain CMYK. A page's fifth spot and on are composited into its four inks; what the inks themselves depend on (the profile, for RGB content, and those spots left out) is each image's stamp: when it changes, the pages it changes are drawn again in the background, each shown as it was until its new image is there (`redrawInks` in ui/pages.js). The other kind, an sRGB ImageBitmap (`mode: "rgb"`, handed over without copying), is for what leaves the app or is drawn as a picture: the client viewer's pages and spine artwork, finish masks. (In the app, the spine artwork is inks too, so the plates switch it.)

### How a page is drawn (`mupdf-render.js`)

- **Coordinates.** A request names a rectangle of the page in PDF user space (millimeters, y up, as the structure gives trim boxes). MuPDF draws in page space (points, y down, the page's rotation applied), which the page's transform maps user space to. The rectangle's top left becomes the origin, and the height asked for sets the scale.
- **Separations.** A page's spot colors are read once (its separations). A pixmap made with them is drawn with overprint honored: an overprinting object leaves the inks it doesn't set as they are, as the press does. The spots are composited into the process colors, for inks and sRGB images alike.
- **Color.** Every page is drawn for a press (`wasm_pw_new_pixmap_from_page`, tools/mupdf/printwarden.c): plain CMYK means the chosen profile. MuPDF sets a page's color spaces from the document as it runs it (for every page, and again for every embedded object with color spaces of its own, the output intent among them), over anything set before; a device of ours between them makes DeviceCMYK read as the chosen profile each time. Inks are drawn into a pixmap in that profile itself: plain CMYK is taken as it is (the same color space at both ends, no conversion: K stays K), RGB content is converted into it. An sRGB image goes through the same profile to the screen, as Acrobat's Output Preview shows a file. A page's own DefaultCMYK (an ICC profile in its resources) is honored: its content is converted from that profile.
- **Plates.** Every plate is switched where the inks are shown, so every ink image carries all of its inks: the four, and its spots in channels of their own (MuPDF's "spot" separations). A spot plate left out (`setSpotsOff`, by name) is not drawn where it is composited: in sRGB images, and a page's fifth spot and on in ink images; in fills and in images alike (MuPDF's "disabled" separation; for images with a patch of ours, `tools/mupdf/separation-disabled-images.patch`, which leaves the ink out where MuPDF drew it through its alternate color). A page with spot channels and a composited spot needs another patch, `separation-spot-channels.patch`: MuPDF read the composited spot from the wrong channel. And a fill overprinting in a spot left out knocked out the inks under it; `overprint-disabled-separations.patch` keeps them.
- **The ink table** (`lut`): the chosen profile as a grid, every entry converted to sRGB by MuPDF (about 60 ms); see below.
- **The document's spots** (`spots`): every page's separations, by name, in the order they first appear, each with its look at full tint in the profile's CMYK (what MuPDF composites it as: asked for again when the profile changes), the pages it is on, and those where it is composited (past the page's four spot channels).

### Render threads

Each thread holds the document in MuPDF's memory. One that fails (MuPDF out of memory, say: a WebAssembly trap) is stopped and a new one started in its place with the same document, profile and plates; the page it was drawing is drawn again once, there or on another thread, and the others carry on (`WorkerPool` in render.js). Six such restarts in one document at most; past that the threads left carry on alone. A new thread is told the profile only once MuPDF has loaded in it: a module thread drops what comes before.

## Color management

### CMYK

Plain CMYK (DeviceCMYK) is converted with the profile you choose. The default is ISO Coated v2 (ECI), shipped with the app. The alternatives are the PDF's output intent or any profile installed on the computer (ui/colour.js). Profiles embedded in the PDF (ICCBased colors) are always honored, through LittleCMS inside MuPDF. RGB content is converted to CMYK through the chosen profile too, so it shows as it prints on that press. Changing the profile changes the ink table: every page and thumbnail shows its plain CMYK through the new one from the next frame; the pages are drawn again in the background for their RGB content, each shown as it was until then.

### The ink table

The chosen profile, for the pages' inks, is a grid (`viewer/inklut.js`): 17 steps per ink, Cyan, Magenta, Yellow and Black, 83,521 entries, each converted to sRGB by MuPDF through the profile (`lut` in mupdf-render.js, in a render thread), paper (no ink) brought to white. The 3D view reads it as a 3D texture, 17 by 17 by 289 (`INK_GLSL` in viewer/shaders.js): Cyan and Magenta across its width and height, Yellow within a Black slice along its depth, Black by the two slices either side mixed in the shader; the plates that print are a switch there, a plate left out being ink that isn't there. The timeline's thumbnails go through the same program on a small canvas (`ui/inkview.js`), and the cover's edge color through the table on the CPU (`inkToRgb`). A switch of profile or process plates changes the table or the switch: every page, thumbnail and edge follows from the next frame.

### Overprint

Overprint (the graphics state's `OP` for strokes, `op` for fills) is always drawn as the press prints it: ink laid over ink, white set to overprint vanishing, as Acrobat's Overprint Preview shows it. There is no switch: the Separations window shows what overprints, a plate at a time.

### Spot colors

A spot color is drawn as its ink. An image in a spot ink (Photoshop's monotones and spot channels) comes out as that ink's equivalent at each tint, the same as a flat fill of it. The tint transform such files carry, which pdf.js and the published MuPDF package draw through, halves the ink's chroma: a PANTONE image over the same PANTONE came out dull. Each spot of the document has a row in the Separations window, switched as the process plates are: at once, everywhere.

### JPEG

MuPDF decodes JPEGs itself (libjpeg), CMYK ones included: a 300 ppi A4 photo in about half a second, once, kept decoded while its page is.

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
