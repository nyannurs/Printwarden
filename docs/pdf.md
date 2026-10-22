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
- **Priorities:** sharp strips first, then pages in view, then the rest by distance from the open spread.
- **Which thread:** a thread keeps the last eight pages it read, their decoded images above all, so another render of one is quickest there. A page goes to the thread that knows it; its sharp strips to any free thread (MuPDF reads a page in milliseconds; a photo's JPEG is decoded once more on another thread).
- **Canceling:** work no longer needed is dropped from the queue. A render in a thread's hands runs on: tens of milliseconds at most.

### What gets rendered

| Image | Size | Used for |
|---|---|---|
| Base image | 700 to 1600 px tall: as large as a 480 MB budget allows for the whole book | Every page in 3D; scaled down, its timeline thumbnail |
| Sharp strips | Exactly what the screen needs, up to 8192 px a side | The part of a page on screen, at rest |
| Capture images | What a screenshot tile or a video frame needs | Exports |

Results come back as ImageBitmaps, handed over without copying. A second kind, a page's inks (`mode: "ink"`: a byte a channel, Cyan, Magenta, Yellow, Black, then the page's spot colors), is for drawing pages with the plates switched in the shader, which is to come.

### How a page is drawn (`mupdf-render.js`)

- **Coordinates.** A request names a rectangle of the page in PDF user space (millimeters, y up, as the structure gives trim boxes). MuPDF draws in page space (points, y down, the page's rotation applied), which the page's transform maps user space to. The rectangle's top left becomes the origin, and the height asked for sets the scale.
- **Separations.** A page's spot colors are read once (its separations). A pixmap made with them is drawn with overprint honored: an overprinting object leaves the inks it doesn't set as they are, as the press does. For an sRGB image the spots are composited into the process colors; for inks each spot is a channel of its own.
- **Color.** An sRGB image is drawn with the chosen CMYK profile as the default for plain CMYK and as the output intent, so plain CMYK is converted through it and RGB content too, as Acrobat's Output Preview shows a file. Inks are drawn in device CMYK, exact (sent through the profile at both ends, MuPDF went by way of Lab and made a four-color black of K); the profile applies where they are shown.
- **Plates.** Which plates print (`setInks`): a process plate left out has its channel cleared, a spot left out is not drawn at all (MuPDF's "disabled" separation).
- **A page's facts** (`info`): its spot colors, each with its CMYK equivalent at full tint, and whether it uses overprint.

## Color management

### CMYK

Plain CMYK (DeviceCMYK) is converted with the profile you choose. The default is ISO Coated v2 (ECI), shipped with the app. The alternatives are the PDF's output intent or any profile installed on the computer (ui/colour.js). Profiles embedded in the PDF (ICCBased colors) are always honored, through LittleCMS inside MuPDF. RGB content is converted through the chosen profile too, so it shows as it prints. Changing the profile restarts the renderer and redraws every page; the old images stay on screen until the new ones arrive.

### Overprint

Overprint (the graphics state's `OP` for strokes, `op` for fills) is always drawn as the press prints it: ink laid over ink, white set to overprint vanishing, as Acrobat's Overprint Preview shows it. There is no switch: the Separations window shows what overprints, a plate at a time.

### Spot colors

A spot color is drawn as its ink. An image in a spot ink (Photoshop's monotones and spot channels) comes out as that ink's equivalent at each tint, the same as a flat fill of it. The tint transform such files carry, which pdf.js and the published MuPDF package draw through, halves the ink's chroma: a PANTONE image over the same PANTONE came out dull.

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
