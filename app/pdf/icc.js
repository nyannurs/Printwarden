// Minimal ICC profile header reader: colour space, device class and description. Used for a
// PDF's output intent (structure.js) and, by the desktop shell (_build/main.cjs, which imports
// this file), for the CMYK profiles installed on the computer. Pure: no DOM, no Node.

/**
 * @param {Uint8Array} bytes the profile (its header and tag table are enough)
 * @returns {{colorSpace: string, deviceClass: string, name: string} | null} null for what isn't a
 *   profile, or is damaged; `name` "" when the profile has no description
 */
export function iccInfo(bytes) {
  if (!bytes || bytes.length < 132) return null;
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // (Names are padded with NUL characters.)
    const ascii = (at, len) => String.fromCharCode(...bytes.subarray(at, at + len)).replace(/\0+$/, "");
    if (ascii(36, 4) !== "acsp") return null; // not an ICC profile
    const colorSpace = ascii(16, 4).trim();
    const deviceClass = ascii(12, 4).trim();
    let name = "";
    const count = view.getUint32(128);
    for (let i = 0; i < count && 132 + 12 * i + 12 <= bytes.length; i++) {
      const at = 132 + 12 * i;
      if (ascii(at, 4) !== "desc") continue;
      const off = view.getUint32(at + 4);
      const type = ascii(off, 4);
      if (type === "desc") {
        const len = view.getUint32(off + 8);
        name = ascii(off + 12, Math.max(0, len - 1));
      } else if (type === "mluc") {
        const recLen = view.getUint32(off + 20);
        const recOff = view.getUint32(off + 24);
        let s = "";
        for (let k = 0; k + 1 < recLen; k += 2) s += String.fromCharCode(view.getUint16(off + recOff + k));
        name = s.replace(/\0+$/, "");
      }
      break;
    }
    return { colorSpace, deviceClass, name: name.trim() };
  } catch {
    return null; // a tag table pointing past the end: damaged
  }
}
