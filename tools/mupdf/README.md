# Printwarden's MuPDF build

Printwarden reads and renders PDFs with [MuPDF](https://mupdf.com) (Artifex Software, AGPL-3.0 or later), as its WebAssembly build, the same one Artifex publishes as the npm package `mupdf`. That package's glue leaves out three things a print proof needs, so Printwarden builds MuPDF itself with a few functions added:

- **A page's separations** (its spot colours), and pixmaps made with them. A pixmap with separations is also what makes MuPDF's draw device honour overprint; the stock package never makes one, so it draws every object knocking out, and a spot image through its tint transform instead of as its ink.
- **A page drawn for a press**: plain CMYK read as the chosen CMYK profile, which is also the ink pixmap's, so plain CMYK keeps its ink values exactly while RGB content is converted through that profile, as Acrobat's Output Preview does. MuPDF's PDF interpreter sets a draw device's default colour spaces from the document for every page and every form XObject with colour spaces of its own (the output intent included), over whatever was set before; a passthrough device of ours in front of the draw device makes DeviceCMYK (and the output intent) the chosen profile each time.

The added functions are in `printwarden.c` here (about 170 lines, `wasm_pw_*`). The build appends them to MuPDF's own glue (`platform/wasm/lib/mupdf.c`, so they share its context and macros) and appends an export of the module instance (`libmupdfModule`) to its JS API (`lib/mupdf.ts`), so Printwarden's own wrapper can call them on the same module instance.

Three changes to MuPDF itself, as patches here, applied by the build:

- `overprint-disabled-separations.patch` (source/fitz/draw-device.c): a fill in a separation that is disabled overprinted nothing: MuPDF took its colorant, mapped nowhere, for one mapped onto the process colours, and painted them (with nothing: paper). It now protects them as overprint should: a spot plate left out leaves the inks under an overprinting spot fill as they are.
- `separation-disabled-images.patch` (source/fitz/separation.c): MuPDF leaves a disabled separation out of a fill but drew an image in that ink through its alternate colour space, so an image in a spot colour stayed visible with its plate switched off. With the patch it is left out of images too, as Acrobat's Output Preview does.
- `separation-spot-channels.patch` (source/fitz/separation.c): where a pixmap's spot channels are mapped onto another's, or composited into the process colours (`fz_copy_pixmap_area_converting_seps`), MuPDF took a separation's place among all separations, or among those composited, for its channel; its channel is its place among those that have one. A page drawn with its first spots as channels and a further one composited (Printwarden's ink images: four spot channels) had that one read from the first spot's channel. With the patch each is read from its own.

Nothing else of MuPDF is changed.

## Building

`.github/workflows/mupdf.yml` builds it on GitHub's machines: Actions tab, "Build MuPDF", "Run workflow", with MuPDF's tag. The run's artifact `mupdf-wasm` holds the built files; they go into `vendor/mupdf/` as they are (`VERSION.txt` says which tag and what was added). By hand, `tools/mupdf/build.sh` does the same with an Emscripten SDK checkout (`EMSDK`), git, make, node and python3; it takes about ten minutes.

## Licence

MuPDF is AGPL-3.0 or later, and so is Printwarden since 1.1 (see the repository's `LICENSE`). The corresponding source of the built files is MuPDF's repository at the tag in `VERSION.txt` plus the patches, `printwarden.c` and `build.sh` here.
