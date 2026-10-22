# Printwarden's MuPDF build

Printwarden reads and renders PDFs with [MuPDF](https://mupdf.com) (Artifex Software, AGPL-3.0 or later), as its WebAssembly build, the same one Artifex publishes as the npm package `mupdf`. That package's glue leaves out three things a print proof needs, so Printwarden builds MuPDF itself with a few functions added:

- **A page's separations** (its spot colours), and pixmaps made with them. A pixmap with separations is also what makes MuPDF's draw device honour overprint; the stock package never makes one, so it draws every object knocking out, and a spot image through its tint transform instead of as its ink.
- **The default colour spaces of a draw device**: plain CMYK content read in the chosen CMYK profile, which is also the pixmap's, so plain CMYK keeps its ink values exactly while RGB content is converted through that profile, as Acrobat's Output Preview does.
- **Whether a page uses overprint**, and **a document's output intent**.

The added functions are in `printwarden.c` here (about 150 lines, `wasm_pw_*`). The build appends them to MuPDF's own glue (`platform/wasm/lib/mupdf.c`, so they share its context and macros) and appends an export of the module instance (`libmupdfModule`) to its JS API (`lib/mupdf.ts`), so Printwarden's own wrapper can call them on the same module instance. Nothing else of MuPDF is changed.

## Building

`.github/workflows/mupdf.yml` builds it on GitHub's machines: Actions tab, "Build MuPDF", "Run workflow", with MuPDF's tag. The run's artifact `mupdf-wasm` holds the built files; they go into `vendor/mupdf/` as they are (`VERSION.txt` says which tag and what was added). By hand, `tools/mupdf/build.sh` does the same with an Emscripten SDK checkout (`EMSDK`), git, make, node and python3; it takes about ten minutes.

## Licence

MuPDF is AGPL-3.0 or later, and so is Printwarden since 1.1 (see the repository's `LICENSE`). The corresponding source of the built files is MuPDF's repository at the tag in `VERSION.txt` plus `printwarden.c` and `build.sh` here.
