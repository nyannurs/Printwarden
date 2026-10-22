# Glossary

## Print terms

| Term | Meaning |
|---|---|
| Bleed | Print that runs past the trim edge, so nothing white shows after cutting. Usually 3 mm. |
| Bulk | How much space a paper takes for its weight (cm³/g). Uncoated stock is bulkier than coated at the same weight. |
| Caliper | A sheet's thickness, as printers quote it, in µm. |
| Case binding | Hardcover: a sewn block glued into a case of boards and a spine. |
| Case wrap | A hardcover's printed cover: the boards' faces, the joints and the spine, with a turn-in all round. |
| Center spread | The middle opening of a saddle-stitched booklet, where one sheet shows both its inner pages side by side. |
| Creep | In a saddle stitch, inner sheets stick out further at the fore-edge than outer ones, because each wraps round the ones inside it. Trimming then cuts more off the inner pages. Compensation moves their content toward the spine. |
| Endpapers | A hardcover's folded sheets at each end of the block: half pasted to the board (the pastedown), half free (the flyleaf). |
| Folio | A page's number in the bound book, counted from the first page. In Printwarden, its position, whatever is printed on it. |
| Folding scheme | Where pages go on a sheet that a folding machine folds into a signature: 8 pages (two folds) or 16 (three folds). |
| Fore-edge | The edge of the book opposite the spine. |
| gsm | Grams per square meter: paper weight. |
| Gutter | The inner margins where two facing pages meet at the spine. |
| Head, foot | The top and bottom edges of the book. |
| Headband | A cotton cord with cloth glued across a hardcover's spine at head and foot. |
| Hinge score | A groove pressed into a softcover's cover near the spine, so it opens without cracking. |
| Imposition | Arranging pages on press sheets so that, printed, folded and trimmed, they read in order. |
| Joint | The flexible strip of a hardcover's case between a board and the spine. |
| Output intent | The printing condition a PDF/X file was made for, with its CMYK profile. |
| Overprint | Ink printed over other ink instead of knocking it out. |
| Perfect binding | A softcover with the pages glued at the spine into a wraparound cover. |
| Recto, verso | The right-hand page (odd number) and the left-hand page (even number). |
| Saddle stitch | A booklet of folded sheets nested together and stapled through the fold. Printwarden calls it Staple binding. |
| Side glue | A strip of glue joining a softcover's first and last page to the cover along the spine. |
| Signature | Sheets folded and nested together, gathered with the others into the book block. |
| Slug | An area outside the bleed for notes and marks, cut off. |
| Spine | The bound edge of the book, and its outside face. |
| Spot finish | A varnish or foil printed only in chosen areas, from a separate file. |
| Spot UV | A gloss varnish in chosen areas, cured with UV light. |
| Spread | Two facing pages, or a PDF page holding both. |
| Square (of a hardcover) | How far the boards overhang the pages at head, foot and fore-edge. |
| Turn-in | The edge of a case wrap folded round the boards onto their insides, where the endpapers cover most of it. Usually 15 mm. |
| Trim | The finished page edge, after cutting. |
| Wire-o, spiral | Bindings through punched holes: a double wire loop with square holes, or a single plastic or wire coil with round ones. |

## Code terms

| Term | Meaning |
|---|---|
| Base image | The one image of a page every page has, sized so the whole book fits in memory. |
| Cross-section, profile | A leaf's shape seen from its head: a curve from the spine to the fore-edge, the same along the spine except during a corner-led turn. |
| Frame | One picture the graphics card draws: as many a second as the screen shows (60 to 120) while things move, none at rest. |
| Texture key | The identity of a page's image (`textureKey` in ui/pages.js): the color profile, overprint, source page and trim. When it is unchanged, the image is reused. |
| GPU | The graphics card. |
| Leaf | One sheet in the book: two pages. |
| Main thread | The thread that runs the window. Work that would freeze it runs in background threads (workers). |
| Motion resolution | The smaller picture drawn while things move on a slow graphics card. |
| Opening | Which pages lie open: 0 is the front cover. |
| Render thread, worker | A background thread drawing PDF pages with pdf.js. |
| Shader | A small program the graphics card runs per vertex or per pixel. |
| Sharp strip | A part of a page rendered again from the PDF at the resolution the screen needs, laid over the base image. |
| Texture | An image on the graphics card. |
| Vector text | Type drawn on the 3D page from its outlines rather than from an image: exact at any zoom. |
