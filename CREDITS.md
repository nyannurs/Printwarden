# Credits

Every outside project Printwarden includes code from, with its license. The licenses of the code shipped in the app also show in the app (About > Licenses).

## Code included in the app

| Project | License | What it's used for | Where |
| --- | --- | --- | --- |
| [three.js](https://github.com/mrdoob/three.js) r170 | MIT | 3D rendering, plus addons (RoomEnvironment, EffectComposer, OutputPass) | `vendor/three.module.js`, `vendor/three-addons/` |
| [pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | Reading and rendering PDFs; its WebAssembly decoders (JBIG2, OpenJPEG) and qcms colour management | `vendor/pdf.mjs`, `vendor/pdf.worker.mjs`, `vendor/pdf-wasm/`, `vendor/pdf-cmaps/`, `vendor/pdf-standard-fonts/`, `vendor/pdf-iccs/` |
| [qcms](https://github.com/FirefoxGraphics/qcms) (via pdf.js) | MIT | ICC colour conversion (embedded profiles, plain CMYK) | `vendor/pdf-wasm/qcms_bg.wasm` |
| [pdf-lib](https://github.com/Hopding/pdf-lib), with @pdf-lib/standard-fonts, UPNG.js and pako bundled in | MIT | Writing the imposed PDF | `vendor/pdf-lib.esm.js` (notices in `vendor/licenses/pdf-lib.txt`), `app/impose/writer.js` |
| [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) | MIT | Writing MP4 video | `vendor/mp4-muxer/` |
| [FFmpeg](https://ffmpeg.org) 9.0.2 | LGPL 2.1 or later (built with nothing under the GPL) | ProRes .mov export | built by `tools/build-ffmpeg.sh` into `_build/ffmpeg-lgpl/` with its license and a NOTICE of how |
| [w64devkit](https://github.com/skeeto/w64devkit), [Zig](https://ziglang.org), [NASM](https://www.nasm.us) | Unlicense; MIT; BSD-2 | Tools that build FFmpeg (not shipped; w64devkit's GCC runtime is in the Windows ffmpeg.exe: GCC Runtime Library Exception, mingw-w64 runtime) | `tools/build-ffmpeg.sh` |
| [Space Grotesk](https://github.com/floriankarsten/space-grotesk) 2.0 (Florian Karsten) | SIL Open Font License 1.1 | The interface's typeface, Medium (variable font) | `vendor/fonts/SpaceGrotesk-Variable.woff2`, license `vendor/fonts/OFL-SpaceGrotesk.txt` |
| [Space Mono](https://github.com/googlefonts/spacemono) (Colophon Foundry) | SIL Open Font License 1.1 | Labels and readouts, Regular | `vendor/fonts/SpaceMono-Regular.woff2`, license `vendor/fonts/OFL-SpaceMono.txt` |
| ISO Coated v2 (ECI) ICC profile, [European Color Initiative](https://www.eci.org) | Copyright 2026 by European Color Initiative, www.eci.org; distributed by the ECI's permission (2026-10-13), not under the Apache License | The default CMYK profile | `vendor/icc/ISOcoated_v2_eci.icc`, notice `vendor/icc/README.txt` |
| [Slug](https://github.com/EricLengyel/Slug) reference shaders (Eric Lengyel) | MIT or Apache 2.0, used under MIT (the patent was dedicated to the public domain on 2026-03-17) | Drawing glyphs from their outlines on the GPU: root codes, the curve solvers and the coverage from two rays, ported from HLSL to GLSL (2026-10-05). Its MIT notice ships with the app (vendor/licenses/slug.txt, About > Licenses) | `VECTOR_TEXT_GLSL` and `coverageAt` in `app/viewer/vectortext.js` |

## Development tools (not part of the app)

Installed with `npm install` in the project folder, for `npm run check` (2026-10-07). Nothing of these ships in the app; the type packages describe the libraries above, at the versions in `vendor/`.

| Project | License | What it's used for |
| --- | --- | --- |
| [ESLint](https://eslint.org), [@eslint/js](https://github.com/eslint/eslint), [globals](https://github.com/sindresorhus/globals) | MIT | The linter (`eslint.config.mjs`) |
| [TypeScript](https://www.typescriptlang.org) 7 | Apache-2.0 | The type check of the JavaScript (`jsconfig.json`, `jsconfig.workers.json`) |
| [@types/three](https://github.com/DefinitelyTyped/DefinitelyTyped) 0.170.0 | MIT | three.js r170's types |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) 6.3.289, [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1, [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) 5.2.2 | Apache-2.0; MIT; MIT | Their types, for the files in `vendor/` (byte for byte these releases) |
