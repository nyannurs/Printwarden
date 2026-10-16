//! A JPEG decoder for pdf.js's parser thread, in WebAssembly.
//!
//! pdf.js hands RGB and grey JPEGs to the browser's decoder but decodes CMYK ones (what
//! InDesign exports photos as) in JavaScript: 2–3 s for a full-page 300 ppi photo. This is
//! image-rs's jpeg-decoder instead, called from app/pdf/parser-profile.js for every JPEG
//! pdf.js decodes itself (vendor/pdf.worker.mjs is patched to ask: tools/patch-pdfjs.py).
//! The pixels come back laid out as pdf.js's own decoder (JpegImage.getData) lays them
//! out, so nothing after it changes: grey, RGB (YCbCr converted) or CMYK as stored in the
//! file (the PDF's Decode array inverts Adobe's CMYK, as it does for pdf.js's decoder).
//! Built by tools/build-jpeg-wasm.sh into vendor/jpeg-decoder.wasm.

use jpeg_decoder::{ColorTransform, Decoder, PixelFormat};
use std::alloc::{alloc, dealloc, Layout};

/// Memory for the caller: the JPEG's bytes go in through it, the pixels come out of it.
#[no_mangle]
pub extern "C" fn jpeg_alloc(n: usize) -> *mut u8 {
    // SAFETY: a byte layout is always valid; a null return is the caller's to check.
    unsafe { alloc(Layout::from_size_align_unchecked(n.max(1), 1)) }
}

/// Frees memory from `jpeg_alloc`, or pixels from `jpeg_decode` (by their length).
#[no_mangle]
pub extern "C" fn jpeg_free(p: *mut u8, n: usize) {
    if p.is_null() {
        return;
    }
    // SAFETY: `p` came from `jpeg_alloc(n)` or is a decoded slice of `n` bytes (align 1).
    unsafe { dealloc(p, Layout::from_size_align_unchecked(n.max(1), 1)) }
}

/// Decodes the JPEG at `ptr` (`len` bytes).
///
/// `transform`: pdf.js's ColorTransform (the PDF's DecodeParms): -1 as the file says,
/// 0 none, 1 YCbCr (three components) or YCCK (four). `want_w`/`want_h`: 0 for full
/// size, else the smallest size the decoder can give (1/8, 1/4, 1/2, 1) that still
/// covers them. `out` receives five u32: width, height, components (1, 3 or 4), the
/// pixels' pointer and their length (free them with `jpeg_free`). Returns 0 when decoded;
/// 1 when not (12-bit, arithmetic coding, a broken file): pdf.js's own decoder takes it.
#[no_mangle]
pub extern "C" fn jpeg_decode(
    ptr: *const u8,
    len: usize,
    transform: i32,
    want_w: u32,
    want_h: u32,
    out: *mut u32,
) -> i32 {
    if ptr.is_null() || out.is_null() {
        return 1;
    }
    // SAFETY: the caller allocated `len` bytes at `ptr` with `jpeg_alloc` and filled them.
    let data = unsafe { std::slice::from_raw_parts(ptr, len) };
    let mut decoder = Decoder::new(data);
    if decoder.read_info().is_err() {
        return 1;
    }
    let info = match decoder.info() {
        Some(info) => info,
        None => return 1,
    };
    let components: usize = match info.pixel_format {
        PixelFormat::L8 => 1,
        PixelFormat::RGB24 => 3,
        PixelFormat::CMYK32 => 4,
        PixelFormat::L16 => return 1,
    };
    // Set only when the PDF says so: otherwise the file's own markers decide, as in pdf.js.
    match (transform, components) {
        (0, 3) => decoder.set_color_transform(ColorTransform::None),
        (1, 3) => decoder.set_color_transform(ColorTransform::YCbCr),
        (0, 4) => decoder.set_color_transform(ColorTransform::CMYK),
        (1, 4) => decoder.set_color_transform(ColorTransform::YCCK),
        _ => {}
    }
    let (mut width, mut height) = (info.width as usize, info.height as usize);
    if want_w > 0 && want_h > 0 {
        match decoder.scale(want_w.min(65535) as u16, want_h.min(65535) as u16) {
            Ok((w, h)) => {
                width = w as usize;
                height = h as usize;
            }
            Err(_) => return 1,
        }
    }
    let mut pixels = match decoder.decode() {
        Ok(pixels) => pixels,
        Err(_) => return 1,
    };
    if pixels.len() != width * height * components {
        return 1;
    }
    if components == 4 {
        // jpeg-decoder turns Adobe's inverted CMYK the right way round (and YCCK into
        // the same); pdf.js wants the values as stored, its Decode array does the rest.
        for v in pixels.iter_mut() {
            *v = 255 - *v;
        }
    }
    let pixels = pixels.into_boxed_slice();
    let length = pixels.len();
    let pixels_ptr = Box::into_raw(pixels) as *mut u8;
    // SAFETY: `out` has room for five u32 (the caller allocated 20 bytes).
    unsafe {
        *out = width as u32;
        *out.add(1) = height as u32;
        *out.add(2) = components as u32;
        *out.add(3) = pixels_ptr as u32;
        *out.add(4) = length as u32;
    }
    0
}
