// Minimal ICC profile header reader: colour space, device class and description.
// (The desktop shell has a CommonJS copy of this in _build/main.cjs for system profiles.)

/** @returns {{colorSpace: string, deviceClass: string, name: string} | null} */
export function iccInfo(bytes) {
  if (!bytes || bytes.length < 132) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
      const recOff = view.getUint32(off + 20 + 4);
      const recLen = view.getUint32(off + 20);
      let s = "";
      for (let k = 0; k + 1 < recLen; k += 2) s += String.fromCharCode(view.getUint16(off + recOff + k));
      name = s;
    }
    break;
  }
  return { colorSpace, deviceClass, name: name.trim() };
}
