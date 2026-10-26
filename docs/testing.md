# Testing (`tests/`, `tools/`)

## Checks on every push

```bash
npm install
npm run check
```

`npm run check` runs ESLint and the TypeScript checker over the JavaScript; the code carries its types in JSDoc comments. GitHub runs the same on every push and pull request.

## The test suite

The tests run in a browser, because most of them need what only a browser has: WebGL, workers, canvas, ImageBitmap. To run them:

```bash
python tools/serve.py 8123
```

Then open <http://localhost:8123/tests/index.html>. The page lists every test as it runs and ends with "All passed" or the failures. Add `?only=staple` to run only the tests whose name contains that word. Results are also on `window.testResults`, for automation. The whole suite takes a few minutes.

`tests/fixtures.test.js` reads the test documents in `testfiles/`. Make them first:

```bash
node tools/make-testfiles.mjs
```

| File | What it proves |
|---|---|
| `core.test.js` | The arithmetic: pairing (including what adding one or two pages in InDesign does to every pair), parity, the center spread, page counts per binding, imposition and folding schemes against the classic tables, creep, setup detection, paper and spine figures, the side-glue rule. |
| `v2.test.js` | Odd setups, imposed files folded back, sheet plans, the 3D book model. |
| `pdf.test.js` | Real PDFs, made with pdf-lib: read back, imposed, folded back, rendered the same before and after imposition. |
| `press.test.js` | Pages drawn for a press: plain CMYK exact in the chosen profile and RGB converted through it, with an output intent or without; spot colours listed, drawn as channels of their own (four a page, a fifth composited), mixed in as MuPDF composites them (overprint and plates left out included), left out by name; a render thread that fails replaced. |
| `fixtures.test.js` | The generated test documents through the app's own import path: cover files (spine, flaps, outside only, hardcover), spine artwork widths, booklets' sheet counts, output intents, overprint and a spot image drawn by the render threads (MuPDF). |
| `geometry.test.js` | The geometry proof: no two sheets pass through each other, in any binding, at rest at any opening, closed on either cover, closing and opening, mid-turn, with several pages in the air, flipping fast forward and back. Every pair of sheets that could meet is tested, as outlines at their drawn thickness (`crossings.js`). |
| `turning.test.js` | Turning, opening and closing in every binding, frame by frame on the scene's own clock: no frame jumps. Single and double clicks, quick bursts, back and forth, closing from the middle, opening deep in, 80 pages. |
| `fold.test.js` | A stapled booklet's folds: each sheet's fold stays inside the one round it while opening and closing, at three paper thicknesses; no kink at the gutter mid-turn; the staples' legs only at the center spread. |
| `scene.test.js` | Every kind of sheet drawn once: three.js's shaders, changed as text, still compile. |
| `sharpness.test.js` | When a page keeps its base image and when it gets strips; strips reach the page's edges; a video's page images per frame, the turning page included; strips go to the graphics card like any page image. |
| `checklist.test.js` | Points from designer testing that numbers can settle: endpapers, boards and the headband on the spine, side glue in Preflight, staples and creep, signatures nesting with creep, switching bindings on one book. |
| `panel.test.js` | The side panel, built with the app's own stylesheets at several window sizes: every control and label on whole pixels. |
| `bundle.test.js` | The client viewer's bundle: the right modules, no import left pointing at a file. |
| `export.test.js` | The imposed export's dialog: the sheet layout chosen in it is the one exported, even with Export pressed at once; the last choice wins. |
| `drawn.test.js` | The geometry audit's own trustworthiness: the sheets it reads back are where the GPU draws them (every binding, at rest and mid-turn), its coil check finds a wire in the paper, its crossings check finds a sheet pushed through another, a view report rebuilds the scene it came from. |
| `reports.test.js` | The author's view reports, kept in `reports/` without their pictures: each rebuilt and played on frame by frame, with what looked wrong in it checked (a hardcover's board and case spine turning without a jump). |
| `harness.js` | The small test harness: `test`, `ok`, `eq`, `near`, `throws`. |
| `helpers.js` | Helpers only the tests use (`partnerMap`, `manualSetup`). The few things the app exports only for its tests say so where they are defined. |

### The geometry audit (`drawn.js`, `audit.html`)

The geometry proof checks the book's model; the audit checks what is drawn. The sheets are built on the graphics card from their cross-sections, so the audit reads every sheet's vertices back from it, through the very shader code the frame uses, and takes the coil, the spine and the folds from their meshes. On that:
- **Crossings**: the drawn surfaces sliced across the spine at every row of the sheets' meshes and between; two slices crossing are two solids passing through each other. Allowed: neighbors in a stack swung over together (drawn a hair thicker on purpose, `STACK_FILL`), and a spine's part meeting a sheet at its root (a joint, reported as such).
- **The coil**: along the wire, the clearance between its surface and the nearest paper, the punched holes cut out of the paper as the page shader cuts them.
- **Stretch**: how much a sheet's drawn faces differ from the paper's size.
- **Jumps**: frame by frame, a sheet or the coil moving far more in one frame than in the frames either side.
- **Sequences**: turns, closing and opening at random times (seeded), run frame by frame on the scene's clock; a failing sequence is cut down to the fewest actions that still fail.

Open `tests/audit.html` on the development server; `window.audit` has the book builder, the checks, `fuzz` (random sequences over the bindings) and `loadReport` (a view report rebuilt, with its checks and its picture drawn again).

### View reports

In the app, **Ctrl+Shift+G** (Cmd+Shift+G on a Mac) with a document open saves a view report: the scene's snapshot (the book as built, the paper, the camera, every sheet's motion at that moment), the setup, the file's name and size (not its contents) and a picture of the view. `loadReport` in the audit page rebuilds the same frame from it, without the PDF, and runs the checks on it. A report is what to send with "this looks wrong here".

### Writing a test

```js
import { test, eq, ok } from "./harness.js";

test("what it proves, in a sentence", () => {
  eq(actual, expected);
  ok(condition, "what went wrong, if it did");
});
```

Then add the file's import to `tests/index.html`. A test of the 3D view creates a `BookScene` in an element off-screen, sets `scene.clock` and calls `scene.debugStep()` to advance the animations without drawing. Every run gives the same result.

## Development tools (`tools/`)

They run the real app from source, off-screen and never focused, so you can keep working. They use the shell's smoke-run switches (see [The desktop app](desktop-app.md#development-switches)).

| Tool | What it does |
|---|---|
| `serve.py` | The development server: static files, no caching. |
| `smoke.py` | Shared by the others: start the app with a script and read back what it left. |
| `proof.mjs` | The geometry proof in Node, spread over all processor cores. `node tools/proof.mjs hardcover` runs the tests whose name contains "hardcover". |
| `replay.py` | Click sequences in the real app on its own clock, checking every frame for sheets passing through each other, row by row. |
| `input.py` | Mouse and keyboard on the app's clock: wheel, drag, pan, double space, clicks. Records where the camera and the book end up, to compare two versions. |
| `renders.py` | Fixed views of a document, saved and compared: a change that shouldn't alter the picture must leave every pixel within 1 or 2 levels. `sheet` makes a contact sheet of two sets: per view before, after, and the pixels that changed in red. |
| `exports.py` | A 4K screenshot and a short MP4 through the app's own save, timed. |
| `perf.py` | The frame loop at rest (no frames at all) and dragging (one per refresh), then the performance check's report. |
| `overdraw.py` | How many sheet layers are shaded per pixel in fixed views, with the occluder's sheets chosen several ways (`--every 0 8 4`): what a GPU that can't skip hidden points pays, counted exactly on any computer; a heat map a view. |
| `memory.py` | Memory and idle activity with every page visited. At rest the app should use no processor time. |
| `make-testfiles.mjs` | The test documents, each with what to expect printed on it. Deterministic: run again, the same bytes. |
| `make-long-pdf.mjs`, `prepare-long-photos.py`, `make-heavy-pdf.py` | Long and heavy test books: 240 pages of photos and layouts, and a file of large CMYK photos. |
| `mupdf/build.sh`, `mupdf/printwarden.c` | Printwarden's MuPDF build: MuPDF's released source with these glue functions added, built by the Build MuPDF workflow (see `tools/mupdf/README.md`). |
| `build-ffmpeg.sh` | Builds the shipped FFmpeg from source. |

## What a machine can't check

Some things need eyes, real files or other computers:
- how a page looks as it settles on a given screen;
- color against Acrobat;
- very large real files;
- a cover file's spine artwork the right way round;
- videos stepped frame by frame;
- a printed and folded sheet;
- the client viewer in other browsers and on phones.

The performance check exists so a report from another machine names what limits it.
