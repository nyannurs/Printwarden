# User guide

This chapter walks through Printwarden as you meet it: the welcome screen, importing, the window's three areas, every setting in the side panel, and every export. For download and first start, see the [README](../README.md).

## The welcome screen

With no document open, the window shows four buttons:
- **Import** opens the import dialog.
- **Try out sample** opens a small synthetic document. Both pages of each spread share a color, so a correct pairing shows matching colors across the spine.
- **About** shows the version, the credits and, under **Licenses**, the license of every outside project inside the app.
- **Quit** (in the desktop app; on a Mac the menu's Quit works too).

When a newer release is on GitHub, an **Update available** link appears under the buttons. It opens the Releases page in your browser. The app never downloads or installs anything itself.

You can also drop a PDF anywhere on the window to import it.

## Importing

The **Import PDF** dialog asks three things.

1. **File.** The PDF to open. Printwarden never changes it and refuses to overwrite it when you export.
2. **This PDF contains:**
   - **Pages**: single pages or spreads, in reading order. This is a normal InDesign export.
   - **Imposed sheets**: printer spreads in press order, for example from InDesign's Print Booklet or from Printwarden's own export. Printwarden folds them back into a book, so a wrong imposition shows as pages out of place. For imposed sheets, choose how they are **Folded as** (a binding) and the **Signatures** size.
3. **Cover** (perfect, sewn and hardcover books): an optional separate cover file, as it goes to the printer. Page 1 is the outside as one spread: back cover, spine, front cover, and flaps beyond them if it has any. An optional page 2 is the inside. Printwarden takes the spine width from it and shows the flaps folded in. A hardcover's cover is the case wrap as the printer wants it, turn-ins included: Printwarden puts the boards' faces and the spine on the case, and the turn-ins round the endpapers inside.

A file exported by Printwarden carries its imposition settings, so the dialog fills itself in.

Large files are fine. A file over 24 MB is shared between the render threads instead of copied into each, and CMYK photos are decoded by a fast WebAssembly decoder.

## The window

The window has three areas:
- **The 3D view** fills the middle.
- **The side panel** sits on the right: everything about the document, the binding, the paper, and Preflight.
- **The timeline** runs along the bottom: every page, in reading order or as press sheets.

Along the top are **Import**, **Export** and the document's name.

### The 3D view

| Control | What it does |
|---|---|
| Drag | Turns the book. It springs back to the camera preset when you let go, without overshoot. |
| Space + drag | Moves the view. The view is now "free": it stays where you put it. |
| Space twice | Resets the view to the preset. |
| Mouse wheel | Zooms toward the middle of the view, gliding. Over a page, the camera stops at the paper instead of passing through. |
| Click a page | Turns it: right of the spine forward, left of it back. A closed book opens. |
| Ctrl+Shift+P (Cmd+Shift+P on a Mac) | Runs the performance check (see below). |

The buttons over the view:
- **Camera** opens the presets: **Reading view, Isometric, Top down, Front, Side, Floating**. Floating lifts the book off the table and tilts it in space. The reading view differs for an open and a closed book.
- **Left page / Spread / Right page** centers the view on one page or the whole spread. Each press shows the next choice. It has nothing to do while one page shows, closed or at a cover.
- **Close / Open** closes the book, turning back to the front cover first, or opens it.
- **Screenshot** and **Video** open their dialogs (see Exports).
- **Separations** opens a small window beside it, as Acrobat's Output Preview has them: a row per plate (Process plates, Cyan, Magenta, Yellow, Black, then each spot color of the document) with its ink's circle. Click a row to leave that plate out or print it again; Process plates switches the four at once. A process plate switches at once, on every page of the book and in the timeline; a spot plate takes a moment, as the pages with it are drawn again. Overprint shows this way: a black set to overprint leaves the color under it when the black plate is off, a knockout leaves paper.

Below them:
- **The zoom slider** steps through 50, 75, 100, 125, 150, 200, 300, 400, 600 and 800 %. 100 % is the preset's framing. A preset and a zoom step always frame the book the same way, so mockups are comparable. The wheel zooms freely in between.
- **The compass** shows the world's X, Y and Z as the camera sees them: X across the book, Y up from the table, Z along the spine.
- **The frame counter** in the top left shows frames per second while anything moves. It also shows the time each frame takes. At rest nothing is drawn, so it shows nothing.

The counter and the zoom value switch between black and white type, whichever reads better on what is under them.

### The timeline

The timeline has two views, switched above it:
- **Reading order**: facing pairs, as the reader sees them. The first and last cells are single pages (the covers). A single cell in the middle means the pairing broke.
- **Press sheets**: sheet sides as printed, for example 44 | 1, then 2 | 43. For an imposed file this is the file itself. For a normal file it is how it will be imposed.

Click a cell to turn the book to it. The cell for the open spread is highlighted.

## The side panel

The sections, top to bottom:

### Document

Facts about the file:
- the file name, and the cover file if any;
- the number of PDF pages or sheet sides;
- the book's pages;
- the page size, and its standard name when it matches one (A5, Letter and so on).

### Document setup

Modeled on InDesign's New Document dialog:
- **Page size, bleed and slug**, with bleed and slug per side: top, bottom, inside, outside. Inside is the spine side: left on a right-hand page, right on a left-hand page.
- The values are read from the PDF's boxes (TrimBox, BleedBox). The median over all pages is used, so one odd page doesn't skew them, and they are snapped to clean numbers.
- Change a value and the setup shows **Manual**.
- If you change the page size, the content is never scaled. The page grows or shrinks around it, away from the spine as a bound page would, and evenly at head and foot.
- **Pages are**: **Detect**, **Single pages** or **Spreads**. Detection compares page shapes. It is a suggestion, and Preflight says how it decided.

### Binding

| Binding | Label in the app | What it adds |
|---|---|---|
| Saddle stitch | Staple binding | One folded signature, two staples. Page count a multiple of 4. Creep shown in 3D and offered in export. |
| Perfect binding | Perfect binding | Glued block in signatures (default 4 pages), separate cover, side glue. |
| Sewn binding | Sewn binding | Sewn signatures (default 16), separate cover, side glue, threads at each signature's center. |
| Hardcover | Hardcover | Sewn signatures in a case: boards, endpapers with flyleaves, headbands, square or rounded spine. |
| Spiral binding | Spiral binding | A plastic coil through punched round holes. Any page count. |
| Wire-o binding | Wire-o binding | A double wire loop through square holes. Any page count. |

The fields that appear depend on the binding:
- **Signature** (perfect, sewn, hardcover): pages per signature, a multiple of 4.
- **Side glue** (perfect, sewn): how far from the spine the first and last page are glued to the cover. Default 6 mm. In 3D those pages stay shut along that strip, and the cover shows its hinge score.
- **Board** (hardcover): board thickness. Default 2.5 mm.
- **Headband** (hardcover): four colors and a color picker.
- **Spine shape** (hardcover): **Square** or **Rounded**.
- **Wire** (spiral, wire-o): silver, black, white, gold, or any color. Silver and gold are bare metal; the others are coated wire.
- **Book spine** (perfect, sewn, hardcover): opens the Book spine panel. A stapled booklet's fold shows its cover wrapping round it, so it has no spine to set.

### The Book spine panel

This panel doesn't block the window. Drag it aside by its title to watch the book while you change the spine.
- **Spine width**: calculated from the pages and paper, or the exact figure your printer gives. A printer's width also sets the 3D book's thickness. **Use calculated** goes back to the calculated width. A width thinner than the covers alone can't be built, so the calculated width is used.
- **Artwork** (glued, sewn, hardcover): **Import spine PDF** takes the first page's trim box, rendered with your color profile. **Rotate spine** turns it in quarter turns. If its size doesn't match the spine, it is stretched to fit and the panel says so.
- **Spine color**: the colors sampled from each cover's spine edge, white, black, or **Custom spine color**.

### Paper

The fields:
- **Paper color** and **Cover color**: Bright white, Natural white, Cream, Recycled gray, or any color.
- **Endpaper color** (hardcover): its own choice, not linked to the pages'.
- **Paper finish** and **Cover finish**: Uncoated, Matte coated, Gloss coated. These change the sheen in 3D and the paper's bulk, which sets its thickness.
- **Paper weight** and **Cover weight**, in gsm.
- **Paper thickness** and **Cover thickness**, in µm: calculated from the weight and finish, or the caliper your printer quotes. It sets the spine and the 3D book.
- **Spot finish**: opens the Spot finish dialog.

Heavier paper is stiffer: its pages arch higher in 3D. Thin paper lets strong, dark print on the back show through faintly. Above about 170 gsm, nothing shows through.

### The Spot finish dialog

Import a PDF of the finish layer alone, the separate file printers ask for. It has one page per document page, or one or two pages for the covers. Any ink in it marks the finished area. The **Finish** choices:
- **Spot UV (gloss)**: a smooth clear coat over the print.
- **Gold foil**, **Silver foil** and **Copper foil**: metal instead of the ink. Foil reflects the room.

### Background

The backdrop color behind the book, flat, exactly as chosen. It is remembered.

### Color

- **CMYK profile**: how CMYK is turned into screen color.
  - The default is **ISO Coated v2 (ECI)**, which ships with the app, so colors look the same on every computer.
  - A PDF with an output intent (PDF/X) can be shown **From PDF**, as Acrobat does.
  - Every CMYK profile installed on the computer is offered too, from the system's color folders and Adobe's.
  - The profile last chosen sticks for every file until you choose another.
  - A switch of profile is instant: every page and thumbnail shows through the new one at once.

### Preflight

Every finding, errors first, then warnings, then information. Each message says what to change in InDesign; pages are never added or removed in Printwarden. The full list is in [Print arithmetic](core.md#preflight).

## Exports

### Export: imposed PDF or HTML file

**Export** opens a choice of two:
- **Export imposed PDF** for the printer. It is grayed out for a file imported as imposed sheets, which is already imposed.
- **Export as HTML file** for a client.

### Export imposed PDF

| Setting | Choices |
|---|---|
| Sheet layout | **Spreads: 2 pages a side**, **8 pages a sheet, 2 folds**, or **16 pages a sheet, 3 folds** |
| Sheet size | **Automatic** (fits pages, bleed and marks), A4, A3, SRA3, Letter, Tabloid, or **Custom…** width and height |
| Include bleed | Bleed on the outer edges. The spine side never gets bleed: two pages butt at the fold there. |
| Printer marks | **Crop marks**, **Fold marks**, **Page information** (file name, sheet and side, date), and the **Offset from trim** |
| Creep compensation | Moves inner pages toward the spine, up to the amount shown, on the innermost leaf. Ask your printer first: most apply it themselves. |

Your pages are placed as vectors, never rasterized. Fonts, color and output intents survive, and each page is embedded once however often it is placed. The export refuses to run while Preflight shows errors.

### Export as HTML file (the client viewer)

One HTML file with the book in it, for a client. It opens in any browser, from a folder or hosted, with nothing else attached. The only setting is how tall the page images are: 1024 px (sharp on a phone), 1536 px, or 2048 px (sharp on a large screen). See [The client viewer](client-viewer.md).

### Render screenshot

A still of the current view:
- **Shape**: 1:1, 4:3, 16:9 or 9:16.
- **Resolution**: 1920, 3840, 7680 or 16384 px on the long side, as far as the graphics card allows.
- **Transparent background**: optional.

It is rendered in tiles. For each tile, the pages in it are drawn again from the PDF's vectors at exactly that tile's resolution, so the only limit on sharpness is the output size.

### Render video

The book closed on its front cover, turning page by page, closed on its back cover. The settings:
- **Shape**, and **Resolution** of 1920 or 3840 px on the long side.
- **Frames per second**: 30 or 60.
- **Page turn** and **Pause on each spread**, in seconds.
- **Transparent background**, which writes ProRes 4444 (.mov) with the FFmpeg that ships in the app.
- Without transparency it writes MP4 (H.264) with the computer's own encoder, at a **Quality** of **Master** (1 bit per pixel), **High** (0.5) or **Standard** (0.25).

The dialog shows the **Length** and the **File size** as you choose.

The camera stays fixed for the whole video, framed so every page stays in the picture in every frame. Frames are rendered one by one on the app's own clock, so every frame is evenly spaced whatever it costs to draw. Pages coming into view are rendered from the PDF at the video's resolution.

## The performance check

Press Ctrl+Shift+P (Cmd+Shift+P on a Mac) with a document open, or the **Performance check** button in a client viewer. It runs for about 35 seconds:
1. It pans the view where it is.
2. It drags the camera round the book, two seconds at a time, with one part of the image switched off each time: half the pixels, shadows, multisampling, and every sheet but the two open pages.
3. It turns pages quickly.
4. It asks you to pan by hand for four seconds. It measures how often the mouse reports a move, because a frame can only be drawn when one arrives.

The report opens in a window with a **Copy** button. The parts that change the result most are what limits that computer. Everything is put back as it was.

## Where settings are kept

Window size, camera preset, backdrop and color profile are remembered between starts, in the app's own data folder. Delete the `Printwarden Data` folder to reset the app; see [The desktop app](desktop-app.md).
