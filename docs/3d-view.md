# The 3D book (`app/viewer/`)

The 3D view is a physical model of the book, drawn with three.js. Every sheet has its real thickness. Each sheet bends out of the spine as its binding lets it, arches as its paper's stiffness makes it, and curls as it turns. No two sheets ever pass through each other; a geometry proof in the tests checks that frame by frame.

World space is millimeters. The book lies on a table, the spine along z, the head at −z. x runs across the book, y up from the table.

| File | What it does |
|---|---|
| `model.js` | The physical book as numbers: leaf thicknesses, where each leaf attaches, how it bends, every leaf's cross-section each frame. No three.js. |
| `layout.js` | A frame's layout: the model's cross-sections, row by row in a corner-led turn, the pages' bow, which faces show, which sheets go to the graphics card. |
| `leaf.js` | One sheet in 3D: its mesh, materials, cut edges, flaps, the sheets texture, picking. |
| `shaders.js` | The shaders: three.js's own, changed as text, plus the sheet builder, page shading, spot finishes, holes, show-through, soft shadows. |
| `extras.js` | What each binding adds: a spine slab, threads, signature folds, staples, a case with boards and headbands, a coil; the contact shadow and the table. |
| `scene.js` | The scene: lights, camera, animations, page images, the frame loop, motion resolution. The `BookScene` class is the 3D view's whole interface to the rest of the app. |
| `camera.js` | The camera presets and the camera's two modes. |
| `input.js` | Mouse and keyboard on the view. |
| `motion.js` | How small to draw while things move on a slow graphics card. |
| `draw.js` | Drawing a frame: shadows only when needed, sheets nearest first. |
| `detail.js` | Planning sharp strips for a page in view. |
| `vectortext.js` | Text drawn from its outlines, exact at any zoom. |
| `textures.js` | Placeholder and generated textures: white paper, grain, the contact shadow. |
| `capture.js` | Screenshots in tiles, videos frame by frame. |

## The model: a leaf as a ribbon

`model.js` describes each leaf by its cross-section, a curve across the book that is the same from head to foot. The curve runs from the spine to the fore-edge. Its direction at each point is an angle from vertical: +90° lies flat to the right, −90° flat to the left.

`makeBook` gives the book its fixed facts:
- every leaf's thickness, from the paper (the covers, and a hardcover's boards, from their own stock);
- every leaf's position across the block;
- the signatures;
- a sewn block's fold depth;
- a coil's ring.

### How each binding opens

Each binding has a style (`BINDING_STYLES`):

| Binding | Open pages at | Root | Gutter shade | Spine part |
|---|---|---|---|---|
| Staple binding | 82° | turns to 55° within 2.5 mm | 14 mm, light | the fold (U-shaped sheets) |
| Perfect binding | 72° | turns to 12° within 3 mm | 22 mm, deepest | a glued slab |
| Sewn binding | 80° | turns to 30° within 4 mm | 18 mm | a slab and signature folds |
| Hardcover | 78° | turns to 30° within 4 mm | 18 mm | a case: boards 2.5 mm, squares 3 mm, joint 7 mm |
| Spiral, wire-o | 88.5° | rigid, on the ring | 7 mm, slight | a coil: 4 or 3 loops per inch |

A glued spine opens least, so content near the gutter visibly slips into it, as on a real paperback. A stapled fold opens most.

### The paper's own shape

From the root, a sheet's shape is computed from the paper (`openShape`, `heavyElastica`). This is Euler's elastica with gravity: a sheet bound along one edge, with its other edges free, bending under its own stiffness and the load holding the book open. The sheet rises out of the spine, arches over and touches down smoothly on what it rests on.
- **Stiffness** = E·t³/12, with E about 4 GPa for paper, and t the thickness.
- **Load** = grammage × g × a hold factor (the hand or the book's own breaking-in).
- Their ratio gives a bend length: about 30 mm for 80 gsm uncoated, 39 mm for 120 gsm, 50 mm for 200 gsm.

Heavier stock is stiffer, as the cube of its thickness, for little more weight, so it arches higher.

### Piles, offsets and turning

`layoutBook` lays out every leaf each frame:
- **Each side's pile is one stack.** Its bottom sheet (the cover, or a hardcover's endpaper on the board) takes the shape above. Every sheet on it is that curve offset by the paper beneath it. Sheets in a pile are parallel and cannot cross.
- **Closing** turns the bottom curve flat and the spine strip upright, and the offsets follow.
- **A turning leaf** blends, point by point, from its shape in the right pile to its shape in the left. Its fore-edge leads as it lifts and trails as it settles, so it never dips into the pages beneath (`turnCurl`).
- **Ordering.** Several leaves in the air at once are kept in order by isotonic regression: the closest non-decreasing sequence of angles, each leaf weighted. One leaf weighing a million times more holds its place. A page underneath can then carry the one on it.
- **A stack turning together**, such as a pile swung over to close the book, is laid out as one stack.
- **A hardcover's boards** are rigid: flat under a pile, resting on top of one, turning about the joint.
- **Coil books** have their own model. Pages hang on the ring through their holes, every hole on the wire, sloping gently down to the table. Closed, the ring wraps the spine edge and the book rests tilted on it.

### The stapled peel

In a saddle-stitched booklet each sheet is one piece of paper folded round the ones inside it. While the booklet opens or closes, a turning sheet's first 5 mm follow the pile it is nearer and only then turn to its own angle (`PEEL_MM`). Without this, a lifting cover's fold dived across the first sheet's fold, whose white showed outside it at the spine. The peel applies only while the book opens or closes. A page turning in an open booklet keeps its gentle bend at the gutter.

### Corner-led turns

A page is turned by its corner. While pages turn, the foot of a turning leaf runs up to 10° ahead of its middle and the head behind; the corner lifts first and lands first (`rowTurn`). Each of the sheet's nine rows, head to foot, is then laid out as a whole layout of its own, so no sheet passes through another row by row (layout.js `layoutRows`). Rigid sheets don't twist.

### Timing page turns

Turns are paced in the scene (`goTo`, `#pace`, `#inOrder`):
- A turn takes 720 ms. Clicks in quick succession turn in 360 ms.
- Opening or closing takes 900 ms.
- No page lifts before the one on it, and none lands before the one under it.
- A cover closing waits for pages still in the air.
- Pages under a lifting cover go once it is past upright.
- Closing from a spread turns back to the front cover first, so the book closes on its first page.

## Drawing the sheets on the graphics card

Sending every sheet's full 3D shape every frame would be too slow for a thick book. Instead:
- **The sheets texture** (leaf.js `makeSheets`, `packSheet`) holds, per sheet, a few numbers and its middle cross-section: x, y and angle per point. During a corner-led turn it also holds the other rows. A book closing moves every sheet with only its middle row: one upload.
- **The sheet builder** (shaders.js `SHEET_VERTEX`) builds every vertex on the graphics card from it. A vertex knows only its place on its sheet: which point, which row, which surface. Its position is the cross-section's point, out along the normal by half the paper, plus the bow.
- **Only sheets whose shape changed are uploaded** (`shapeChanged`, `uploadSheets`). While one page turns, the rest hold still. Runs of neighbors go up together, straight to WebGL.
- **Thickness.** Sheets are drawn at 90 % of their thickness (`LEAF_FILL`), so neighbors never share a surface (which flickers at grazing angles), and a stack's edges show the fine lines of real paper. The sheets of a stack swung over together are drawn at 102 % (`STACK_FILL`), so their edges overlap by a hair and no crack shows through.
- **Picking** (a click, the zoom's aim) needs the sheet where the graphics card draws it. Its shape is written on the processor only when a ray could meet it, into a mesh that is never drawn.

### Faces that can't be seen

In a stack turning together, a sheet's face against the next sheet can't be seen. Those faces are drawn unlit with their page's own image (`inkFiller`), not shaded as pages: shading them cost most of a frame on a thick book standing up. They are drawn at all because the edge faces in front of them drop pixels on some graphics cards (ANGLE over Metal, without multisampling); a face behind fills what an edge drops. This is also why a stack's edges keep their "ink" in flight.

### Order and depth

- **Nearest first** (draw.js `drawOrder`): sheets are sorted by distance from the camera, so the graphics card skips what lies behind a sheet already drawn.
- **Depth first on Apple GPUs** (`depthFirst`): the sheets' depth is drawn in a pass before their color. Apple's tile-based GPUs otherwise shade every hidden sheet of a stack. Without the pass, the open book's stacks dropped to 15 to 20 fps on an iPhone and in Safari. Every renderer whose name contains "Apple" gets it.

## Shading

Pages are shaded as ink on paper (shaders.js):
- **Lighting**: a studio environment (three.js's RoomEnvironment) and a key light, with no tone mapping. All light is scaled so white paper peaks just under the screen's white, about 247 to 250 of 255. It shades instead of clipping flat. Where a page faces the light more squarely, the extra light rolls off into the few levels left (`PAPER_ROLLOFF`).
- **The page image multiplies the paper's color**, as ink on stock. Images are filtered as stored (sRGB) and only then turned into light, so type keeps its weight, as browsers and Acrobat antialias it.
- **The gutter** darkens toward the fold, by the binding's width and depth.
- **Show-through**: the other side of the leaf, faintly, mirrored and softened, by the paper's weight.
- **Paper grain**: a tileable bump of fibers.
- **Finish**: roughness, sheen and clear coat by finish (uncoated, matte, gloss).
- **Spot finishes**: where the finish PDF has ink, gloss varnish is a smooth clear coat over the print, and foil is metal instead of the ink. Foil's highlights are scaled down as a whole, so gold doesn't clip to white.
- **Side glue and the hinge score**: a crease at the glue's edge, a groove on the cover.
- **Holes**: spiral and wire-o pages are punched in the shader: round or square holes at the binding's pitch.
- **Cut edges**: a sheet's head, foot and fore-edge take the ink at its pages' edges, read a hair inside. Bleed shows on the trimmed block as on a printed book.

### Shadows

- **Soft shadows** that harden where things touch (percentage-closer soft shadows), as under a large window rather than a point of light. A 4096 × 4096 shadow map.
- **Drawn only when needed** (draw.js `shadows`): only when the layout, the book's placement or the light changed. Turning the camera leaves it as it is; redrawing it every frame cost a tenth of a frame.
- **A shortcut for the search** (`nearestCasters`): for each 8 × 8 block of the shadow map, the nearest caster's depth is found once per still shadow map.
- **Cut edges take no shadow**: 0.15 mm faces at a grazing angle are the one place a shadow map's precision shows.
- **The contact shadow** under the book follows wherever leaves lie low, and the table under it.

## What each binding adds (`extras.js`)

| Binding | Parts |
|---|---|
| Staple binding | Every sheet's fold at the spine, a U drawn from its two halves' roots, each kept inside the fold round it. Two staples: the crown outside, the legs inside, shown only where the center spread's crease opens. Every fold carries its pages' print (see below). |
| Perfect, sewn | A slab at the spine, a hair inside the head and foot: the outside in the spine's color or artwork, printed on the cover's stock; its narrow sides take the artwork's edge columns at each corner; its ends the cover's cut edge. Side glue: the cover's first strip lies on the first and last page wherever they go, and the cover hinges where the glue ends. |
| Sewn, hardcover | Signature folds at head and foot: each sheet a U round the ones inside it. Each signature nests as a booklet does: its pages are printed from the fold, and the block is trimmed as one at the fore-edge (creep). Every fold carries its pages' print. A sewn book also shows the threads through each signature's center; a hardcover doesn't draw them. |
| Hardcover | The case spine: the covering across the joints (a pressed groove), round the corners, across the spine board, kraft lining inside. From a case wrap (a cover file with turn-ins), its artwork runs from one board's edge to the other's, joints included; otherwise the joints take the covers' colors and the spine its artwork or color. Inside each board, the endpaper pasted down with the cover's turn-in round it. Boards are opaque. Rounded board edges. Headbands: a cord and its cloth tail at head and foot, filling the hollow's mouth. Square or rounded back. |
| Spiral, wire-o | The coil through the holes, bare metal or coated, sized for the block: about 1.2 mm of coil a millimeter of spiral block, 1.1 of wire-o. |

**Printed folds** (`foldSheetMaterial`): each folded sheet's fold has a material of its own, one draw a sheet, reading its two halves' page images where the fold takes them (the strip of each page between its root and the fold's apex). Its outside shows the first half's front and the second half's back (a booklet's cover round its spine), its inside the first half's back and the second half's front (a center spread running into the fold), and its cut ends at head and foot take the ink at the pages' edge, as a leaf's cut edges do. Sewn folds cast no shadow: they lie inside the slab or the case.

**Flaps** are drawn only while their cover is open to them or turning: folded in, they would stand over the pages beside them.

Meshes rebuilt every frame are written into their own buffers in place (`commitGeometry`). New buffers each frame got new graphics memory that three.js never freed.

## Keeping pages sharp

A page's look comes from four sources:
1. **A base image** for every page, at a height that lets the whole book fit in a 480 MB budget (700 to 1600 px).
2. **A small image**, 200 px tall, where the page is small on screen.
3. **Sharp strips** when the view comes to rest (detail.js, ui/pages.js):
   - The visible region of each page is cut into strips across the direction in which the need changes most. A page seen at an angle needs far more resolution near the camera than far away.
   - Each strip is rendered from the PDF at what its own part of the screen needs, 1.25 image pixels per screen pixel at its densest point, up to 8192 px a side.
   - If the base image already gives that everywhere, it stays (`baseSuffices`).
   - New strips fade in over 220 ms, so the swap doesn't read as the page's pixels shifting.

How much of each page is on screen, and at what density, is measured by casting rays from a grid of screen points onto the pages (`visiblePages`). The rays meet the cross-section curve itself, not the triangles, so the result is exact at any zoom and angle.

Image uploads are spread over frames, two a frame (`UPLOADS_PER_FRAME`), and a page image is freed from memory once it is on the graphics card. Strips are made only once the view rests: 120 ms after it stops, 350 ms after a page turn, so pages only flipped past aren't sharpened.

## The scene and its frame loop

`BookScene` (scene.js) is everything the rest of the app calls:
- **Building**: `setBook`, `setPaper`, `setSpine`, `setWire`, `setHeadband`, `setFinish`, `setPageGlue`, `setCoverScore`, `setPageFlap`.
- **Page images**: `setPageTexture`, `setPageDetails`, `showPageImage`.
- **Moving the book**: `goTo`, `open`, `close`, `setClosed`, `setFocus`.
- **The view**: `setPreset`, `setZoomPercent`, `resetView`, `setBackground`, `setPixelBudget`.
- **Exports**: `captureImage`, `recordVideo`.
- **Reading back**: `visiblePages`, `sampleUnder`, `frameStats`.

Each frame (`#frame`):
1. **Update**: animations to the clock, the camera, the layout.
2. **Fades**: the sharp strips' fade-in, the motion resolution.
3. **Draw**, only if something changed: an animation, input, a page image arriving, a fade. At rest nothing is drawn, and back at rest after motion drawn small, one more frame at full resolution.
4. **Uploads**: the next page images.

Multisampling is 4× on a high-density screen, 8× otherwise, as far as the card allows. The canvas is drawn at the screen's resolution, up to twice the CSS pixels, within the pixel budget.

### Motion resolution

A graphics card too slow for the screen draws motion a step smaller: 100, 85, 70, 60 or 50 % (motion.js). Still frames, screenshots and videos are always full size.
- **What it measures**: over 30 frames in motion, the card's own time per frame where it can be timed (else the time between frames), and the share of frames that reached the screen a refresh or more late.
- **Stepping down**: when the drawing takes over 70 % of a refresh, or more than a tenth of frames are late.
- **Stepping up**: after four easy rounds, under 40 % with almost no late frames.
- **Taking a step back**: a step down that made frames neither a tenth faster nor late half as often is undone, and no smaller step is tried until the window size changes. The frames were waiting on something other than drawing.
- Screens faster than 120 Hz aren't chased with a smaller picture.

## The camera and input

`camera.js` has two modes:
- **Default**: dragging rotates freely, and on release the view springs back to the preset, critically damped (no overshoot; a wobble reads as a bug). The zoom stays.
- **Free**: entered by panning. Nothing springs back until you return to the preset (space twice).

Zoom runs from 50 to 800 % of the preset's framing.

`input.js`:
- **Orbiting stops at pages like a wall.** A movement that would put a page between the pivot and the camera is refused, sliding along it where it can. Book animations never move the camera.
- **Panning re-pivots onto the paper.** After each pan step, the point the camera turns about moves onto the paper at the middle of the view, without the camera moving. Pages slope, and a pan could otherwise slide the pivot under one, taking the camera with it. Only the sheets a ray can meet first are tested: each pile's top sheet, the covers, the pages in the air. Testing all of them was most of a pan step on a thick book. The zoom value doesn't change from re-pivoting (`zoomBias`).
- **The wheel glides toward a goal** that each notch moves, toward the middle of the view. Over a page the goal stops short of the paper, never closer than 8 mm.
- **A click turns the page**: right of the spine forward, left back. A click beside the book does nothing.

## Screenshots and videos (`capture.js`)

**Screenshots** (`captureImage`) are rendered tile by tile at the output size. Before each tile, the app gets the pages in it with their densities in output pixels, and renders them from the PDF at exactly that resolution. Resolution is limited only by the output size.

**Videos** (`recordVideo`) are rendered offline, frame by frame on the scene's own clock, so frames are evenly spaced whatever they cost to draw. The video is planned first by running its timeline without drawing, which is cheap: the layout only (`planVideo`).
- **The camera is fixed**: an artboard the book moves in. It keeps the direction, aim and zoom of the first open spread at rest.
- **The distance** is the farthest any frame needs to keep every page in the picture. The picture is centered: the room above the book equals the room below, and left equals right, measured as the camera projects it.
- **Page images** are rendered for every frame's need, for every page that can be in the picture, including the turning one (`sharpenForVideo` in ui/capture.js). A page coming nearer is rendered again as soon as a frame needs it sharper.
