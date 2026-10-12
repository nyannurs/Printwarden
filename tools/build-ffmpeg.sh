#!/bin/sh
# Builds the FFmpeg that ships with Printwarden, for Windows x64, macOS arm64 and macOS x64,
# from the official FFmpeg source, with only what Printwarden uses: raw RGBA frames in on a
# pipe, the scaler (to 10-bit 4:4:4:4 YUV), the ProRes 4444 encoder, the MOV container. No
# other libraries, no network, nothing under the GPL: FFmpeg's own LGPL 2.1 (or later) only.
# The results, each with its license and a notice of how it was made, go to
# _build/ffmpeg-lgpl/<platform>-<arch>/, which the app builds copy (see _build/ffmpeg.mjs).
#
# For development only; run from Git Bash on Windows:  sh tools/build-ffmpeg.sh
# Needs in _build/ffmpeg-cache/toolchain/ (checked here against these SHA-256):
#   ffmpeg-9.0.2.tar.xz           https://ffmpeg.org/releases/ (signed by the FFmpeg release
#                                 key FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8)
#   w64devkit-x64-2.10.0.7z.exe   https://github.com/skeeto/w64devkit (GCC, GNU make, a shell)
#   zig-x86_64-windows-0.17.0.zip https://ziglang.org/download/ (C compiler for the Macs)
#   nasm-3.02-win64.zip           https://www.nasm.us/ (x86 assembly)
# They are unpacked and built in WORK, a folder without spaces in its path (FFmpeg can't
# build where there are any): by default the system's temporary folder.
set -e
VERSION=9.0.2
SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
JOBS=${JOBS:-8}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/_build/ffmpeg-lgpl"
if [ -z "$IN_W64DEVKIT" ]; then
  # In Git Bash: check and unpack, then build in w64devkit's own shell (its make takes
  # Windows paths; Git Bash's /c/... and /tmp/... confused it).
  CACHE="$ROOT/_build/ffmpeg-cache/toolchain"
  WORK=${WORK:-${TMPDIR:-/tmp}/printwarden-ffmpeg}
  case "$WORK" in *" "*) echo "WORK must have no spaces in its path: $WORK"; exit 1 ;; esac
  (cd "$CACHE" && sha256sum -c - <<EOF) || { echo "A download doesn't match its checksum."; exit 1; }
$SHA256 *ffmpeg-$VERSION.tar.xz
18d0a4c71a166f8401ab6305781bec5882b40b5e06ba9807c61cb5f3b3c6325e *w64devkit-x64-2.10.0.7z.exe
b5663f69581dcf391293fbf16c06cb80d81d806545ce618b4d0bab7f0eb8c428 *zig-x86_64-windows-0.17.0.zip
161d0bfaff53c2f9e9f3e69fd0672323ebabafd1268976a5cec11be92a19aee7 *nasm-3.02-win64.zip
EOF
  mkdir -p "$WORK/tmp"
  [ -d "$WORK/ffmpeg-$VERSION" ] || tar -xf "$CACHE/ffmpeg-$VERSION.tar.xz" -C "$WORK"
  [ -d "$WORK/w64devkit" ] || "$CACHE/w64devkit-x64-2.10.0.7z.exe" -o"$(cygpath -w "$WORK")" -y > /dev/null
  [ -d "$WORK/zig-x86_64-windows-0.17.0" ] || unzip -q -o "$CACHE/zig-x86_64-windows-0.17.0.zip" -d "$WORK"
  [ -d "$WORK/nasm-3.02" ] || unzip -q -o "$CACHE/nasm-3.02-win64.zip" -d "$WORK"
  IN_W64DEVKIT=1 WORK=$(cygpath -m "$WORK") exec "$WORK/w64devkit/bin/sh.exe" "$(cygpath -m "$0")"
fi
TC="$WORK"
export TMPDIR="$WORK/tmp" # configure's scratch files
SRC="$TC/ffmpeg-$VERSION"
ZIG="$TC/zig-x86_64-windows-0.17.0/zig.exe"
export PATH="$TC/w64devkit/bin:$TC/nasm-3.02:$PATH"

# Only what Printwarden's one command needs (see "video-begin" in _build/main.cjs):
#   -f rawvideo -pix_fmt rgba -i pipe:0 -c:v prores_aw -profile:v 4 -pix_fmt yuva444p10le -vendor apl0 out.mov
COMMON="--disable-everything --disable-autodetect --disable-network --disable-doc --disable-debug
  --disable-ffplay --disable-ffprobe --disable-avdevice --disable-swresample
  --enable-protocol=file,pipe --enable-demuxer=rawvideo --enable-decoder=rawvideo
  --enable-encoder=prores_aw --enable-muxer=mov --enable-filter=scale
  --pkg-config=false"

TOOLS="$TC/tools"
mkdir -p "$TOOLS"
# Zig's C compiler for each Mac (without the linker's -dynamic, which configure adds on macOS
# and Zig refuses: it is the default anyway), and its archiver; and a stand-in for nm, which
# configure only asks for the symbol prefix C names get (an underscore on macOS).
for t in aarch64 x86_64; do
  cat > "$TOOLS/cc-$t-macos" <<EOF
#!/bin/sh
for a; do
  shift
  case "\$a" in
    -Wl,-dynamic,-search_paths_first) set -- "\$@" -Wl,-search_paths_first ;;
    *) set -- "\$@" "\$a" ;;
  esac
done
exec "$ZIG" cc -target $t-macos.11.0 "\$@"
EOF
done
printf '#!/bin/sh\nexec "%s" ar "$@"\n' "$ZIG" > "$TOOLS/zig-ar"
printf '#!/bin/sh\nexec "%s" ranlib "$@"\n' "$ZIG" > "$TOOLS/zig-ranlib"
printf '#!/bin/sh\necho "0000000000000000 S _ff_extern"\n' > "$TOOLS/macho-nm"
chmod +x "$TOOLS"/*

build() { # key, configure options...
  key=$1; shift
  dir="$TC/build-$key"
  rm -rf "$dir" && mkdir -p "$dir" && cd "$dir"
  echo "== $key: configure"
  "$SRC/configure" $COMMON "$@" > configure.log 2>&1 || { tail -30 configure.log; exit 1; }
  echo "== $key: make"
  make -j"$JOBS" > make.log 2>&1 || { tail -30 make.log; exit 1; }
  mkdir -p "$OUT/$key"
  exe=ffmpeg; [ -f ffmpeg.exe ] && exe=ffmpeg.exe
  cp "$exe" "$OUT/$key/$exe"
  cp "$SRC/COPYING.LGPLv2.1" "$OUT/$key/LICENSE.txt"
  # Windows: GCC's runtime from w64devkit is linked in; its license asks for this file with it.
  case $key in win*) cp "$TC/w64devkit/COPYING.MinGW-w64-runtime.txt" "$OUT/$key/" ;; esac
  {
    echo "FFmpeg $VERSION, built for Printwarden ($key), from the official source release:"
    echo "  https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz"
    echo "  SHA-256 $SHA256"
    echo "Unmodified. License: GNU Lesser General Public License 2.1 or later (LICENSE.txt);"
    echo "nothing under the GPL is built in, and no other library."
    echo "Built with tools/build-ffmpeg.sh from the Printwarden source; configured with:"
    grep -m1 "^#define FFMPEG_CONFIGURATION" config.h | sed 's/^#define FFMPEG_CONFIGURATION /  /'
    echo
    echo "Printwarden uses it to write ProRes 4444 videos: it starts it with fixed arguments and"
    echo "passes it frames; it is not linked into Printwarden. You may replace it with your own"
    echo "build of FFmpeg (keep the name and place)."
  } > "$OUT/$key/NOTICE.txt"
  ls -la "$OUT/$key"
}

# The Mac tools by name, found on the PATH: FFmpeg keeps its configure line in the program and
# in NOTICE.txt, and full paths there showed the build computer's folders (a user name too).
export PATH="$TOOLS:$PATH"
mac() { # arch
  echo --enable-cross-compile --target-os=darwin --arch=$1 --cc=cc-$1-macos --host-cc=gcc     --ar=zig-ar --ranlib=zig-ranlib --nm=macho-nm --disable-stripping --extra-ldflags=-s
}
# TARGETS: some of them only (default all).
for key in ${TARGETS:-win32-x64 darwin-arm64 darwin-x64}; do
  case $key in
    win32-x64) build win32-x64 --target-os=mingw32 --arch=x86_64 --extra-ldflags=-static ;;
    darwin-arm64) build darwin-arm64 $(mac aarch64) ;;
    darwin-x64) build darwin-x64 $(mac x86_64) ;;
  esac
done
echo "Done: $OUT"
