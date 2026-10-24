#!/bin/bash
# Builds Printwarden's MuPDF (WebAssembly): MuPDF at tag $MUPDF_TAG with the patches here
# (tools/mupdf/*.patch) applied, its WASM glue with
# tools/mupdf/printwarden.c appended and its JS API exporting the module instance, built as MuPDF
# builds its own npm package (platform/wasm/tools/build.sh: Emscripten 4.0.8). The built files go
# to $OUT (vendor/mupdf/ by default). Run by .github/workflows/mupdf.yml on GitHub's machines; by
# hand it needs git, make, node, python3 and an Emscripten SDK checkout at $EMSDK.
#   EMSDK      the emsdk checkout (default /opt/emsdk; the SDK version is installed by the build)
#   MUPDF_TAG  MuPDF's git tag (default 1.28.1)
#   WORK       where MuPDF is cloned and built (default: a temporary directory)
#   OUT        where the built files go (default: vendor/mupdf/ of this repository)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
MUPDF_TAG=${MUPDF_TAG:-1.28.1}
SRC=${WORK:-$(mktemp -d)/mupdf}
DEST=${OUT:-$HERE/../../vendor/mupdf}
# Not passed on: MuPDF's Makefile takes OUT (and others) from the environment as its own build
# directory, and then the link step doesn't find the library where it expects it.
unset OUT WORK
export EMSDK=${EMSDK:-/opt/emsdk}

echo "MuPDF $MUPDF_TAG into $SRC"
git clone --quiet --depth 1 --branch "$MUPDF_TAG" --recurse-submodules https://github.com/ArtifexSoftware/mupdf.git "$SRC"
cd "$SRC"
for patch in "$HERE"/*.patch; do
  echo "Patch: $(basename "$patch")"
  git apply --verbose "$patch"
done
cd "$SRC/platform/wasm"

echo "Printwarden's glue"
cat "$HERE/printwarden.c" >> lib/mupdf.c
printf '\n// Printwarden: the module instance, for its own bindings (tools/mupdf/printwarden.c).\nexport const libmupdfModule: any = libmupdf\n' >> lib/mupdf.ts

echo "Emscripten 4.0.8 (MuPDF's build.sh expects it on the PATH)"
"$EMSDK/emsdk" install 4.0.8 >/dev/null
"$EMSDK/emsdk" activate 4.0.8 >/dev/null
export EMSDK_QUIET=1
source "$EMSDK/emsdk_env.sh"
emcc --version | head -1

echo "Building"
npm install --silent
bash tools/build.sh
test -s dist/mupdf-wasm.wasm || { echo "MuPDF's build.sh produced no dist/mupdf-wasm.wasm"; exit 1; }
test -s dist/mupdf.js || { echo "MuPDF's build.sh produced no dist/mupdf.js"; exit 1; }

echo "Collecting into $DEST"
mkdir -p "$DEST/licenses"
cp dist/mupdf-wasm.js dist/mupdf-wasm.wasm dist/mupdf.js dist/mupdf.d.ts dist/mupdf-wasm.d.ts "$DEST"/
cp ../../COPYING "$DEST/LICENSE.txt"
# The licences of the libraries built into it (those with objects in the build): each as
# licenses/<library>.txt, the list in licenses/INDEX.txt.
: > "$DEST/licenses/INDEX.txt"
for dir in ../../thirdparty/*/; do
  lib=$(basename "$dir")
  [ -d "../../build/wasm/small/thirdparty/$lib" ] || continue
  for name in LICENSE LICENSE.txt LICENSE.TXT LICENSE.md COPYING COPYING.txt COPYING.LESSER README; do
    if [ -f "$dir/$name" ]; then
      cp "$dir/$name" "$DEST/licenses/$lib.txt"
      echo "$lib: $name" >> "$DEST/licenses/INDEX.txt"
      break
    fi
  done
done
cat "$DEST/licenses/INDEX.txt"
{
  echo "MuPDF $MUPDF_TAG (https://github.com/ArtifexSoftware/mupdf, tag $MUPDF_TAG), the WebAssembly build of"
  echo "platform/wasm, with Printwarden's patches applied ($(cd "$HERE" && echo *.patch)),"
  echo "its tools/mupdf/printwarden.c appended to lib/mupdf.c and"
  echo "'export const libmupdfModule: any = libmupdf' appended to lib/mupdf.ts, built by tools/mupdf/build.sh"
  echo "(Emscripten 4.0.8). License: GNU Affero General Public License 3.0 or later (LICENSE.txt)."
} > "$DEST/VERSION.txt"
ls -la "$DEST"
