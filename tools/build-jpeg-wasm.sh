#!/bin/sh
# Builds the JPEG decoder pdf.js's parser thread uses (tools/jpegwasm, Rust) into
# vendor/jpeg-decoder.wasm. Needs Rust with the wasm32-unknown-unknown target
# (rustup target add wasm32-unknown-unknown). The result is committed: nobody needs
# Rust to run or build the app.
set -e
cd "$(dirname "$0")/jpegwasm"
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/printwarden_jpeg.wasm ../../vendor/jpeg-decoder.wasm
ls -l ../../vendor/jpeg-decoder.wasm
