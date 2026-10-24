# Print arithmetic (`app/core/`)

Everything a printer would check lives here as plain functions of numbers: which pages face each other, which binding takes how many pages, which page goes where on a press sheet, how wide the spine is, and what Preflight reports. Nothing here touches the screen, a PDF library or three.js. A test enforces that, so all of it can be tested on its own. All lengths are millimeters.

| File | What it decides |
|---|---|
| `units.js` | Points to millimeters (1 pt = 25.4 / 72 mm), sizes and rectangles, the standard paper sizes (A3 to A6, B5, SRA3, Letter, Legal, Tabloid) and their names, the 0.5 mm tolerance under which two sizes count as the same. |
| `document.js` | A source page as the PDF describes it: its boxes and rotation. Plain data, so the core never depends on a PDF library. |
| `detect.js` | Whether the PDF's pages are single pages or spreads. |
| `setup.js` | The document setup: page size, bleed and slug per side, read from the PDF or typed in; where each finished page sits on its source page. |
| `binding.js` | The bindings, their page-count rules, wire and headband colors, the side-glue rule. |
| `book.js` | The finished book: source pages split into halves, numbered as folios, labeled. |
| `pairing.js` | Which pages face each other when the book is open. |
| `imposition.js` | Which folio goes where on the press sheets, and creep. |
| `folding.js` | The 8- and 16-page folding schemes, found by folding. |
| `sheets.js` | The press sheets' geometry for export: where every page lands, what of it shows, where the marks go. |
| `paper.js` | Paper stocks: color, weight, finish, thickness, show-through. |
| `spine.js` | Which bindings have a spine, how wide it is, the boards. |
| `analysis.js` | One call from a loaded document and settings to everything the interface shows. |
| `validate.js` | Preflight: every rule check and its message. |

## The book: folios and labels

Two numberings must never be mixed up (book.js):
- **The source index**: a page's position in the PDF.
- **The folio**: a page's position in the bound book, from 1. Folio 1 is always a right-hand page.

What you see as page numbers are **labels**: the PDF's own page labels (`/PageLabels`, which InDesign writes from Numbering & Section Options), with prefix, start number and style (decimal, roman, letters). Without labels, folios are counted from where the PDF's numbering starts. Labels never change folios.

`buildBook` splits each spread into a left and a right half, and numbers them. Each page records its source page, which half it is, and its label.

`buildImposedBook` folds an imposed file back. PDF page `i` is sheet side `i` (front, back, front, back…) and holds two folios, as the layout says. The result reads like the printed, folded, trimmed job. A wrong imposition shows as pages in the wrong place.

## Facing pages

`pairing.js` answers what the reader sees with the book open:
- `[null, 1]`: the front cover, alone on the right.
- Then `[2, 3]`, `[4, 5]` and so on.
- `[N, null]` at the end when the page count is even.
- The center spread exists when the count is a multiple of 4.

Facing pairs are not press-sheet pairs. In saddle stitch the two coincide only at the center spread. The tests' `partnerMap` (tests/helpers.js) keys each page by its content, so two versions of a book can be compared. Adding two pages near the front keeps every pair; adding one re-pairs everything after it.

## Spread or single pages

`detectSpreads` compares page shapes:
- If all pages share one shape (within 3 %), it can't tell. They are taken as single pages, with a note, and a hint if they are landscape.
- Otherwise the narrowest pages are singles, and pages about twice as wide are spreads.

The tolerance is wider than a naive 2 % because, without a TrimBox, bleed pulls a spread's ratio about 2 % below twice a single page's. With a manual setup, bleed and slug come off each page before the shapes are compared.

The pattern it finds:
- **All single** or **all spreads**.
- **Spreads with single covers**: InDesign's "export as spreads", a single first page, spreads, and usually a single last page.
- **Mixed**: an error.

You can force **Single pages** or **Spreads**. Forced spreads keep a clearly single first or last page single.

## The document setup

`setupFromPdf` reads the setup the way InDesign wrote it:
- Every value is the median over all pages, so a cover exported differently doesn't skew it.
- Values are snapped to clean numbers. InDesign's point conversions give 147.99993 mm for 148; a value within 0.02 mm of a whole or half millimeter is snapped to it.
- Inside and outside are measured on single pages, where they can be told apart.
- Any size is accepted, DIN or not.
- The area outside the BleedBox may be slug or printer marks; a PDF doesn't say which.

`trimRectFor` places a finished page on its source page:
- In auto mode it trusts the TrimBox.
- Without one, or in manual mode, it insets the MediaBox by bleed plus slug on each side.

In manual mode, `resizePage` then makes the page the size you set. The content is never scaled. Across, the page grows or shrinks away from the spine, as a bound book's would: a right-hand page at its right edge, a left-hand one at its left, a spread at both outer edges so it stays whole across the fold. Up and down, it changes evenly. Beyond the PDF's page is blank paper.

`bleedRectFor` grows the trim by the bleed on the three outer sides, never on the spine side. On a 2-up sheet two pages butt at the fold, and inner bleed would overlap the neighbor. This is what InDesign's Print Booklet gets wrong. Split spread halves are clipped the same way, so they meet exactly at the fold.

## Bindings and their rules

`ruleFor` gives each binding its constraints:

| Binding | Pages must be a multiple of | Signatures | Separate cover | Hints |
|---|---|---|---|---|
| Staple binding (saddle) | 4 | one, the whole book | no | warns above 64 pages |
| Perfect binding | the signature size (default 4) | yes | yes: 4 pages | warns under 32 pages |
| Sewn binding | the signature size (default 16) | yes | yes | |
| Hardcover | the signature size (default 16) | yes | yes, the case | adds 4 endpaper pages |
| Spiral binding | 1 | no | no | punch takes ~9 mm; coil holds ~40 mm |
| Wire-o binding | 1 | no | no | punch takes ~9 mm; wire holds ~27 mm |

Signature sizes must be a multiple of 4. For perfect, sewn and hardcover books, the PDF's first two and last two pages are the cover's outside and inside. Only the pages between them fold into signatures, and the multiple applies to those.

**Side glue** (`sideGlueMm`): perfect and sewn books of 6 pages or more glue the first and last page to the cover along the spine. The 3D view, the client viewer and Preflight all use this one rule.

**Hardcover endpapers**: a folded sheet at each end of the block. Half is pasted down inside the board (C2 and C3), half is a free flyleaf, unprinted (E1–E2, E3–E4). They are in the book but not on the press sheets, because they are stock, not pages to print.

## A separate cover file

`coverPages` (analysis.js) cuts four pages out of a cover file:
- **C1**, the front, and **C4**, the back, from page 1, which is the outside spread.
- **C2** and **C3**, the inside, from page 2. Without page 2, they are blank paper.

The spine is what is left of the cover's width beyond two pages, up to 80 mm. Wider than that, the cover has flaps: the spine is taken as set (or calculated), and what is left beyond it is two flaps of equal width. The cover's spine is compared with the calculated one in Preflight. Its spine strip becomes the spine's artwork, and its width the spine's.

**A hardcover's cover is a case wrap** (`caseWrapPages`). It is bigger than what shows: a turn-in on every side wraps round the boards' edges and ends under the endpapers. The turn-in is half of what the file's height has beyond the boards' (the pages' height and a 3 mm square above and below, `CASE_SQUARE_MM`). Inside the turn-ins, the boards' faces (the page's width, a square, less the 7 mm joint, `CASE_JOINT_MM`) sit at each end; between them are the joints and the case spine, which is the rest. Preflight compares that spine with the calculated one (within 1 mm) and names the turn-ins. A hardcover's page size is taken from the document, never from the cover (`pageSizeOf`).

## Imposition: which page goes where

`imposition.js` lays out the sheets.

**2-up spreads.** Each signature is a nested saddle-stitched booklet. For a signature of `S` pages starting after `o` pages, sheet `k` (1 is the outermost) holds:

```
front:  o + S − 2(k−1)   |  o + 2(k−1) + 1
back:   o + 2(k−1) + 2   |  o + S − 2(k−1) − 1
```

The back is printed turned over on the short edge, so the back's left position sits behind the front's right.

**Folding schemes** (folding.js) put 8 pages (two by two a side, two folds) or 16 pages (two rows of four, three folds) on a sheet. The scheme isn't stored as a table. It is found by folding a sheet of panels as a folding machine does: right half onto left, top half down, right onto left again. The resulting stack is read like a booklet. The 16-page result comes out as the classic table: page 1 lower right on the front, upright, with 5 12 9 8 upside down above 4 13 16 1. That match is the check that the folding is right. A scheme must divide the signature: 8 folds signatures of 8, 16 or 32 pages, and 16 folds 16 or 32.

**Covers.** Perfect, sewn and hardcover books put the cover on a sheet of its own, after the block: outside back | front, inside front | back.

**Creep** (`creepMm`). A sheet nested `depth` sheets inside its signature is pushed out at the fore-edge by `depth × paper thickness`. Compensation moves its pages that far toward the spine. It is zero on the outermost sheet.

## The press sheet's geometry

`planSheets` (sheets.js) turns the layout into geometry the PDF writer executes, sheet origin bottom left:
- **Cells.** Pairs of columns meet at a spine fold. Between pairs, the fore-edges face each other with their bleed between. Two rows meet head to head at the top fold, their head bleed between.
- **The visible region** of each page: bleed on the three outer sides, cut at the fold on the spine side. An upside-down page's head is at its bottom.
- **Marks.**
  - Crop marks and fold marks start outside the bleed, never inside it.
  - They sit at the offset you set (default 3 mm) and are 5 mm long.
  - The page information line (file name, sheet and side, date) needs 4 mm more.
- **The sheet size.**
  - **Automatic** fits pages, bleed and marks exactly.
  - A chosen size is turned landscape and checked: too small for pages and bleed is an error; too small for marks says so.
- **Errors** stop the export: an already imposed file, no layout, or errors in Preflight.

## Paper

`paper.js` holds the stocks:
- **Colors**: Bright white, Natural white, Cream, Recycled gray, or any.
- **Finishes**: Uncoated (bulk 1.25 cm³/g), Matte coated (1.0), Gloss coated (0.9). Each also sets the 3D sheen: roughness, specular, clear coat.
- **Thickness** (mm) = gsm ÷ 1000 × bulk. 120 gsm uncoated is 0.15 mm. The caliper you type in sets a stock's own bulk instead.
- **Show-through** = 0.09 × e^−(gsm − 60)/28, at most 0.12, and 30 % less on coated stock. That is about 9 % visible at 60 gsm, nearly nothing above 170.

The cover has its own color, finish and weight, falling back to the pages'.

## The spine

`spine.js`:
- **Which bindings have a spine** you can color: perfect, sewn and hardcover. These also take artwork. A stapled fold shows its cover wrapping round it.
- **The calculated width** = inner leaves × paper thickness + covers × cover thickness. A leaf is two pages. A hardcover's covers are its boards: 2.5 mm unless set.
- **A printer's width** replaces the calculated one, and sets the 3D book's thickness too. `paperForSpine` finds the paper thickness that makes the book exactly that thick. Where the covers alone are thicker than the width, the calculated width is used.

## Preflight

`validate.js` runs every check and sorts the findings: errors first, then warnings, then information. Every message says what to change in InDesign.

| Code | Level | When |
|---|---|---|
| empty | error | The document has no pages. |
| mixed-spreads | error | Some PDF pages are spreads, others single. Usually a wrong export. |
| spreads, detection | info | How pages were taken: spreads split, or why single. |
| imposed-binding | error | An imposed file with a binding that can't be folded from sheets. |
| imposed-odd | error | An odd number of sheet sides: a sheet is missing its back. |
| imposed-count | error | The sheet sides don't fit the binding's multiple. |
| imposed | info | An imposed file, folded: flip through to check it. |
| setup-mismatch | error | Imposed sheets smaller than two pages of the set size. |
| page-resized | info | The page size set differs from the PDF's: the content isn't scaled. |
| no-trimbox | info | The PDF records no trim size: pages taken as they are. |
| no-bleed | warning | No bleed at all. |
| thin-bleed | info | Bleed under 3 mm on a side. |
| slug | info | A slug area, which is trimmed off. |
| spread-split | error | A spread whose halves would land on different openings. |
| mixed-sizes, mixed-orientation | error | Pages of different sizes or orientations. |
| sheet-pages | error | The folding scheme doesn't divide the signature (or the booklet). |
| page-count | error | The page count doesn't fit the binding: how many pages to add, and the total. |
| cover-file | error | The cover file can't be used, and why. |
| cover-spine | warning | The cover's spine differs from the calculated one by more than 0.5 mm. |
| cover-height | warning | The cover is taller or shorter than the pages (a hardcover's case may be taller). |
| cover-flaps, cover-inside, cover-spine-art | info | What the cover file brings: flaps, no inside, the spine's artwork. |
| too-thick, too-thin | warning | Past a binding's practical page count, or a block thicker than the largest coil. |
| punch | info | The punch takes about 9 mm of the inner edge. |
| side-glue | info | What the side glue hides. |
| fold | info | Saddle stitch from 8 pages: how much the fold takes from the cover's inner margin, and the creep. |
| folio-parity | warning | The PDF numbers its first page with an even number. |
| centre-spread | info | Which pages are the center spread. |
| endpapers | info | A hardcover's endpapers, left off the sheets. |
| sheets | info | How many sheets, in how many signatures, and the spine's width. |

## Putting it together: `analyse`

`analyse(document, settings)` returns everything the interface shows, in one pass:
- the detection;
- the setup;
- the binding's rule;
- the book, with any cover file's pages and a hardcover's endpapers;
- each page's geometry on its source page;
- the sheet layout;
- the cover file's figures;
- the findings.

It is fast and has no side effects, so the app simply runs it again whenever a setting changes.
