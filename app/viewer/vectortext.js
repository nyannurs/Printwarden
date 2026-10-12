// Vector text: glyphs drawn on the page from their outlines, in the page's own shader, so
// type stays exact at any zoom and any angle, on a bent page too. The Slug algorithm (Eric
// Lengyel, 2017; reference shaders MIT, notice in vendor/licenses/slug.txt; patent dedicated
// to the public domain in 2026):
// each pixel casts a horizontal and a vertical ray against only the curves of the glyph's
// bands that it lies in, and the curves' roots give exact, antialiased coverage.
//
// What comes in (from the render workers, see app/pdf/render-worker.js): each glyph's
// outline (pdf.js draw operations, in its own glyph space) and every place a glyph is drawn
// on the page (glyph → PDF user space, and its colour, already colour-managed). What goes
// out: two data textures per page (floats: curves and placements; integers: bands, and a
// grid over the page listing which placements touch each cell), drawn by VECTOR_TEXT_GLSL.

export const TEX_W = 4096;
const OP = { MOVE: 0, LINE: 1, CUBIC: 2, QUAD: 3, CLOSE: 4 };
const INSTANCE_TEXELS = 5;
const MAX_PER_CELL = 48; // placements a pixel looks at: the grid is made fine enough (more only cost time)

/**
 * A glyph outline as quadratic Bézier segments [x1, y1, x2, y2, x3, y3, ...]: cubic curves
 * split until a quadratic follows them within `tolerance`; lines as {p1, p2, p2}, as the
 * Slug notes advise; contours closed.
 */
export function quadsFromPath(ops, tolerance) {
  const out = [];
  let sx = 0;
  let sy = 0;
  let x = 0;
  let y = 0;
  let open = false;
  const line = (x1, y1, x2, y2) => {
    if (x1 !== x2 || y1 !== y2) out.push(x1, y1, x2, y2, x2, y2);
  };
  const cubic = (x0, y0, x1, y1, x2, y2, x3, y3, depth) => {
    // The best single quadratic, and how far it can be from the cubic (|P3 - 3P2 + 3P1 - P0|
    // times sqrt(3)/36).
    const ex = x3 - 3 * x2 + 3 * x1 - x0;
    const ey = y3 - 3 * y2 + 3 * y1 - y0;
    if (depth >= 8 || (Math.sqrt(3) / 36) * Math.hypot(ex, ey) <= tolerance) {
      out.push(x0, y0, (3 * (x1 + x2) - x0 - x3) / 4, (3 * (y1 + y2) - y0 - y3) / 4, x3, y3);
      return;
    }
    // Split in half (de Casteljau).
    const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2;
    const bx = (x1 + x2) / 2, by = (y1 + y2) / 2;
    const cx = (x2 + x3) / 2, cy = (y2 + y3) / 2;
    const dx = (ax + bx) / 2, dy = (ay + by) / 2;
    const ex2 = (bx + cx) / 2, ey2 = (by + cy) / 2;
    const mx = (dx + ex2) / 2, my = (dy + ey2) / 2;
    cubic(x0, y0, ax, ay, dx, dy, mx, my, depth + 1);
    cubic(mx, my, ex2, ey2, cx, cy, x3, y3, depth + 1);
  };
  const close = () => {
    if (open) line(x, y, sx, sy);
    x = sx;
    y = sy;
    open = false;
  };
  for (let i = 0; i < ops.length;) {
    switch (ops[i++]) {
      case OP.MOVE:
        close();
        x = sx = ops[i++];
        y = sy = ops[i++];
        open = true;
        break;
      case OP.LINE: {
        const nx = ops[i++];
        const ny = ops[i++];
        line(x, y, nx, ny);
        x = nx;
        y = ny;
        break;
      }
      case OP.CUBIC: {
        const x1 = ops[i++], y1 = ops[i++], x2 = ops[i++], y2 = ops[i++], x3 = ops[i++], y3 = ops[i++];
        cubic(x, y, x1, y1, x2, y2, x3, y3, 0);
        x = x3;
        y = y3;
        break;
      }
      case OP.QUAD: {
        const x1 = ops[i++], y1 = ops[i++], x2 = ops[i++], y2 = ops[i++];
        out.push(x, y, x1, y1, x2, y2);
        x = x2;
        y = y2;
        break;
      }
      case OP.CLOSE:
        close();
        break;
      default:
        return out; // unknown: what there is
    }
  }
  close();
  return out;
}

/** Bounds of quadratic segments: [x0, y0, x1, y1] (control points included: conservative). */
function boundsOf(q) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < q.length; i += 2) {
    x0 = Math.min(x0, q[i]);
    x1 = Math.max(x1, q[i]);
    y0 = Math.min(y0, q[i + 1]);
    y1 = Math.max(y1, q[i + 1]);
  }
  return [x0, y0, x1, y1];
}

/**
 * Pack a page's vector text.
 * @param {{glyphs: Map<string, ArrayLike<number>>, instances: {glyph: string, m: number[], color: number[]}[]}} text
 *   glyph outlines (draw ops), and placements: `m` maps glyph space to the page's texture
 *   uv (a, b, c, d, e, f: u = a x + c y + e, v = b x + d y + f), colour in sRGB 0-1.
 * @returns {{floats: Float32Array, ints: Uint32Array, rowsF: number, rowsU: number,
 *            info: number[], count: number} | null} info: [instance start, grid w, grid h, grid start]
 */
export function packVectorText(text) {
  const F = []; // float texels, 4 numbers each
  const U = []; // uint texels, 2 numbers each
  const pushF = (a, b, c, d) => F.push(a, b, c, d);
  const glyphInfo = new Map();
  for (const [key, ops] of text.glyphs) {
    if (!ops || !ops.length) continue;
    const roughBox = boundsOf(coordsOf(ops));
    const size = Math.max(roughBox[2] - roughBox[0], roughBox[3] - roughBox[1], 1e-6);
    const q = quadsFromPath(ops, size * 1e-3);
    const n = q.length / 6;
    if (!n) continue;
    const box = boundsOf(q);
    const w = Math.max(box[2] - box[0], 1e-6);
    const h = Math.max(box[3] - box[1], 1e-6);
    // Curves: two texels each, never split across a row (p3 is read at the next texel).
    const loc = [];
    for (let k = 0; k < n; k++) {
      if ((F.length / 4) % TEX_W === TEX_W - 1) pushF(0, 0, 0, 0);
      loc.push(F.length / 4);
      const o = 6 * k;
      pushF(q[o], q[o + 1], q[o + 2], q[o + 3]);
      pushF(q[o + 4], q[o + 5], 0, 0);
    }
    // Bands: enough that each holds a handful of curves.
    const nb = Math.max(1, Math.min(16, Math.round(n / 6)));
    const eps = Math.max(w, h) / 1024;
    const bandsH = [];
    const bandsV = [];
    for (let j = 0; j < nb; j++) {
      const ya = box[1] + (h * j) / nb - eps;
      const yb = box[1] + (h * (j + 1)) / nb + eps;
      const xa = box[0] + (w * j) / nb - eps;
      const xb = box[0] + (w * (j + 1)) / nb + eps;
      const hb = [];
      const vb = [];
      for (let k = 0; k < n; k++) {
        const o = 6 * k;
        const cy0 = Math.min(q[o + 1], q[o + 3], q[o + 5]);
        const cy1 = Math.max(q[o + 1], q[o + 3], q[o + 5]);
        const cx0 = Math.min(q[o], q[o + 2], q[o + 4]);
        const cx1 = Math.max(q[o], q[o + 2], q[o + 4]);
        // Straight horizontal curves never cross a horizontal ray, vertical ones a vertical.
        if (cy1 >= ya && cy0 <= yb && !(q[o + 1] === q[o + 3] && q[o + 3] === q[o + 5])) hb.push([k, cx1]);
        if (cx1 >= xa && cx0 <= xb && !(q[o] === q[o + 2] && q[o + 2] === q[o + 4])) vb.push([k, cy1]);
      }
      // Sorted by the largest coordinate, descending: the shader stops at the first that ends
      // before the pixel.
      hb.sort((a, b) => b[1] - a[1]);
      vb.sort((a, b) => b[1] - a[1]);
      bandsH.push(hb.map((e) => loc[e[0]]));
      bandsV.push(vb.map((e) => loc[e[0]]));
    }
    // Band headers (count, where its list starts), then the lists.
    const base = U.length / 2;
    const headers = 2 * nb;
    for (let j = 0; j < headers; j++) U.push(0, 0);
    [...bandsH, ...bandsV].forEach((list, j) => {
      U[2 * (base + j)] = list.length;
      U[2 * (base + j) + 1] = U.length / 2;
      for (const c of list) U.push(c, 0);
    });
    glyphInfo.set(key, { base, nb, box, scale: [nb / w, nb / h], offset: [(-box[0] * nb) / w, (-box[1] * nb) / h] });
  }
  // Placements.
  const placed = text.instances.filter((p) => glyphInfo.has(p.glyph) && invertible(p.m));
  if (!placed.length) return null;
  const instanceStart = F.length / 4;
  const uvBoxes = [];
  for (const p of placed) {
    const g = glyphInfo.get(p.glyph);
    const [a, b, c, d, e, f] = p.m;
    // Where it lands in uv (its box's corners), for the grid; off the page (the other half
    // of a spread), left out.
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const [x, y] of [[g.box[0], g.box[1]], [g.box[2], g.box[1]], [g.box[0], g.box[3]], [g.box[2], g.box[3]]]) {
      const u = a * x + c * y + e;
      const v = b * x + d * y + f;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    if (u1 < 0 || u0 > 1 || v1 < 0 || v0 > 1) continue;
    uvBoxes.push([u0, v0, u1, v1]);
    const det = a * d - b * c;
    // uv -> glyph space: the inverse of [a c e; b d f].
    const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    const ie = -(ia * e + ic * f), iff = -(ib * e + id * f);
    pushF(ia, ib, ic, id);
    pushF(ie, iff, g.base, g.nb);
    pushF(g.scale[0], g.scale[1], g.offset[0], g.offset[1]);
    pushF(g.box[0], g.box[1], g.box[2], g.box[3]);
    pushF(p.color[0], p.color[1], p.color[2], 1);
  }
  if (!uvBoxes.length) return null;
  // The grid: fine enough that no cell holds more than MAX_PER_CELL placements, as far as
  // 256 × 256 cells allow.
  let gw = Math.max(16, Math.min(256, Math.ceil(Math.sqrt(placed.length / 2))));
  let cells;
  for (;;) {
    const gh = gw;
    cells = Array.from({ length: gw * gh }, () => []);
    uvBoxes.forEach(([u0, v0, u1, v1], k) => {
      // A pixel's footprint can reach a little past the glyph: half a cell of margin.
      const cx0 = Math.max(0, Math.floor(u0 * gw - 0.5)), cx1 = Math.min(gw - 1, Math.floor(u1 * gw + 0.5));
      const cy0 = Math.max(0, Math.floor(v0 * gh - 0.5)), cy1 = Math.min(gh - 1, Math.floor(v1 * gh + 0.5));
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cells[cy * gw + cx].push(k);
    });
    const most = cells.reduce((m, c) => Math.max(m, c.length), 0);
    if (most <= MAX_PER_CELL || gw >= 256) break;
    gw = Math.min(256, gw * 2);
  }
  const gh = gw;
  const gridStart = U.length / 2;
  for (let k = 0; k < cells.length; k++) U.push(0, 0);
  cells.forEach((list, k) => {
    U[2 * (gridStart + k)] = list.length; // all of them: the page's image leaves them out
    U[2 * (gridStart + k) + 1] = U.length / 2;
    for (const idx of list) U.push(idx, 0);
  });
  const rowsF = Math.max(1, Math.ceil(F.length / 4 / TEX_W));
  const rowsU = Math.max(1, Math.ceil(U.length / 2 / TEX_W));
  const floats = new Float32Array(rowsF * TEX_W * 4);
  floats.set(F);
  const ints = new Uint32Array(rowsU * TEX_W * 2);
  ints.set(U);
  return { floats, ints, rowsF, rowsU, info: [instanceStart, gw, gh, gridStart], count: uvBoxes.length };
}

function invertible(m) {
  return Math.abs(m[0] * m[3] - m[1] * m[2]) > 1e-30;
}

/** All coordinates of a draw-op list, flat [x, y, ...] (for its rough size). */
function coordsOf(ops) {
  const out = [];
  for (let i = 0; i < ops.length;) {
    const op = ops[i++];
    const n = op === OP.MOVE || op === OP.LINE ? 2 : op === OP.CUBIC ? 6 : op === OP.QUAD ? 4 : 0;
    for (let k = 0; k < n; k++) out.push(ops[i++]);
    if (op > OP.CLOSE) break;
  }
  return out;
}

// --- the same coverage, in JavaScript (tests) ----------------------------------------

/**
 * Coverage of one placement at uv (as VECTOR_TEXT_GLSL computes it), with the pixel's uv
 * footprint `du`, `dv` (uv per pixel along screen x and y).
 */
export function coverageAt(packed, instance, u, v, du, dv) {
  const Fv = (i) => packed.floats.subarray(4 * i, 4 * i + 4);
  const Uv = (i) => [packed.ints[2 * i], packed.ints[2 * i + 1]];
  const b = packed.info[0] + INSTANCE_TEXELS * instance;
  const t0 = Fv(b), t1 = Fv(b + 1), t2 = Fv(b + 2), t3 = Fv(b + 3);
  const px = t0[0] * u + t0[2] * v + t1[0];
  const py = t0[1] * u + t0[3] * v + t1[1];
  const dpx = [t0[0] * du[0] + t0[2] * du[1], t0[1] * du[0] + t0[3] * du[1]];
  const dpy = [t0[0] * dv[0] + t0[2] * dv[1], t0[1] * dv[0] + t0[3] * dv[1]];
  const epp = [Math.abs(dpx[0]) + Math.abs(dpy[0]), Math.abs(dpx[1]) + Math.abs(dpy[1])];
  if (px < t3[0] - epp[0] || px > t3[2] + epp[0] || py < t3[1] - epp[1] || py > t3[3] + epp[1]) return 0;
  return slugCoverage(Fv, Uv, px, py, 1 / epp[0], 1 / epp[1], t1[2], t1[3], t2);
}

const sat = (x) => Math.min(1, Math.max(0, x));
function rootCode(y1, y2, y3) {
  const i1 = y1 < 0 || Object.is(y1, -0) ? 1 : 0;
  const i2 = y2 < 0 || Object.is(y2, -0) ? 2 : 0;
  const i3 = y3 < 0 || Object.is(y3, -0) ? 4 : 0;
  return (0x2e74 >> (i1 | i2 | i3)) & 0x0101;
}
function slugCoverage(Fv, Uv, rx, ry, ppeX, ppeY, base, nb, tf) {
  const bx = Math.min(nb - 1, Math.max(0, Math.floor(rx * tf[0] + tf[2])));
  const by = Math.min(nb - 1, Math.max(0, Math.floor(ry * tf[1] + tf[3])));
  let xcov = 0, xwgt = 0, ycov = 0, ywgt = 0;
  const [hc, ho] = Uv(base + by);
  for (let k = 0; k < hc; k++) {
    const c = Uv(ho + k)[0];
    const p12 = Fv(c), p3 = Fv(c + 1);
    const x1 = p12[0] - rx, y1 = p12[1] - ry, x2 = p12[2] - rx, y2 = p12[3] - ry, x3 = p3[0] - rx, y3 = p3[1] - ry;
    if (Math.max(x1, x2, x3) * ppeX < -0.5) break;
    const code = rootCode(y1, y2, y3);
    if (code) {
      const [r1, r2] = solve(x1, y1, x2, y2, x3, y3).map((r) => r * ppeX);
      if (code & 1) { xcov += sat(r1 + 0.5); xwgt = Math.max(xwgt, sat(1 - Math.abs(r1) * 2)); }
      if (code > 1) { xcov -= sat(r2 + 0.5); xwgt = Math.max(xwgt, sat(1 - Math.abs(r2) * 2)); }
    }
  }
  const [vc, vo] = Uv(base + nb + bx);
  for (let k = 0; k < vc; k++) {
    const c = Uv(vo + k)[0];
    const p12 = Fv(c), p3 = Fv(c + 1);
    const x1 = p12[0] - rx, y1 = p12[1] - ry, x2 = p12[2] - rx, y2 = p12[3] - ry, x3 = p3[0] - rx, y3 = p3[1] - ry;
    if (Math.max(y1, y2, y3) * ppeY < -0.5) break;
    const code = rootCode(x1, x2, x3);
    if (code) {
      const [r1, r2] = solve(y1, x1, y2, x2, y3, x3).map((r) => r * ppeY);
      if (code & 1) { ycov -= sat(r1 + 0.5); ywgt = Math.max(ywgt, sat(1 - Math.abs(r1) * 2)); }
      if (code > 1) { ycov += sat(r2 + 0.5); ywgt = Math.max(ywgt, sat(1 - Math.abs(r2) * 2)); }
    }
  }
  const cov = Math.max(Math.abs(xcov * xwgt + ycov * ywgt) / Math.max(xwgt + ywgt, 1 / 65536), Math.min(Math.abs(xcov), Math.abs(ycov)));
  return sat(cov);
}
// The x where the curve (relative to the sample) crosses y = 0, for both roots.
function solve(x1, y1, x2, y2, x3, y3) {
  const ax = x1 - 2 * x2 + x3, ay = y1 - 2 * y2 + y3;
  const bx = x1 - x2, by = y1 - y2;
  const d = Math.sqrt(Math.max(by * by - ay * y1, 0));
  let t1, t2;
  if (Math.abs(ay) < 1 / 65536) t1 = t2 = (y1 * 0.5) / by;
  else {
    t1 = (by - d) / ay;
    t2 = (by + d) / ay;
  }
  return [(ax * t1 - bx * 2) * t1 + x1, (ax * t2 - bx * 2) * t2 + x1];
}

// --- the shader -----------------------------------------------------------------------

/**
 * GLSL for the page shader: `vec3 pvVectorText(vec3 color, vec2 uv, vec2 duv_dx, vec2 duv_dy)`
 * composites the page's vector glyphs over `color` (stored sRGB, as the page images are,
 * so it blends as a canvas does). Uniforms: uVecF (RGBA32F), uVecU (RG32UI), uVecInfo
 * (instance start, grid w, grid h, grid start), uVecOn.
 */
export const VECTOR_TEXT_GLSL = /* glsl */ `
uniform highp sampler2D uVecF;
uniform highp usampler2D uVecU;
uniform ivec4 uVecInfo;
uniform float uVecOn;
vec4 pvF( int i ) { return texelFetch( uVecF, ivec2( i & 4095, i >> 12 ), 0 ); }
uvec2 pvU( int i ) { return texelFetch( uVecU, ivec2( i & 4095, i >> 12 ), 0 ).xy; }
uint pvRootCode( float y1, float y2, float y3 ) {
  uint i1 = floatBitsToUint( y1 ) >> 31u;
  uint i2 = floatBitsToUint( y2 ) >> 30u;
  uint i3 = floatBitsToUint( y3 ) >> 29u;
  uint shift = ( i2 & 2u ) | ( i1 & ~2u );
  shift = ( i3 & 4u ) | ( shift & ~4u );
  return ( 0x2E74u >> shift ) & 0x0101u;
}
vec2 pvSolveH( vec4 p12, vec2 p3 ) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.y;
  float rb = 0.5 / b.y;
  float d = sqrt( max( b.y * b.y - a.y * p12.y, 0.0 ) );
  float t1 = ( b.y - d ) * ra;
  float t2 = ( b.y + d ) * ra;
  if ( abs( a.y ) < 1.0 / 65536.0 ) t1 = t2 = p12.y * rb;
  return vec2( ( a.x * t1 - b.x * 2.0 ) * t1 + p12.x, ( a.x * t2 - b.x * 2.0 ) * t2 + p12.x );
}
vec2 pvSolveV( vec4 p12, vec2 p3 ) {
  vec2 a = p12.xy - p12.zw * 2.0 + p3;
  vec2 b = p12.xy - p12.zw;
  float ra = 1.0 / a.x;
  float rb = 0.5 / b.x;
  float d = sqrt( max( b.x * b.x - a.x * p12.x, 0.0 ) );
  float t1 = ( b.x - d ) * ra;
  float t2 = ( b.x + d ) * ra;
  if ( abs( a.x ) < 1.0 / 65536.0 ) t1 = t2 = p12.x * rb;
  return vec2( ( a.y * t1 - b.y * 2.0 ) * t1 + p12.y, ( a.y * t2 - b.y * 2.0 ) * t2 + p12.y );
}
float pvSlug( vec2 rc, vec2 ppe, int base, int nb, vec4 tf ) {
  ivec2 band = clamp( ivec2( rc * tf.xy + tf.zw ), ivec2( 0 ), ivec2( nb - 1 ) );
  float xcov = 0.0, xwgt = 0.0, ycov = 0.0, ywgt = 0.0;
  uvec2 hb = pvU( base + band.y );
  for ( int k = 0; k < int( hb.x ); k++ ) {
    int c = int( pvU( int( hb.y ) + k ).x );
    vec4 p12 = pvF( c ) - vec4( rc, rc );
    vec2 p3 = pvF( c + 1 ).xy - rc;
    if ( max( max( p12.x, p12.z ), p3.x ) * ppe.x < -0.5 ) break;
    uint code = pvRootCode( p12.y, p12.w, p3.y );
    if ( code != 0u ) {
      vec2 r = pvSolveH( p12, p3 ) * ppe.x;
      if ( ( code & 1u ) != 0u ) { xcov += clamp( r.x + 0.5, 0.0, 1.0 ); xwgt = max( xwgt, clamp( 1.0 - abs( r.x ) * 2.0, 0.0, 1.0 ) ); }
      if ( code > 1u ) { xcov -= clamp( r.y + 0.5, 0.0, 1.0 ); xwgt = max( xwgt, clamp( 1.0 - abs( r.y ) * 2.0, 0.0, 1.0 ) ); }
    }
  }
  uvec2 vb = pvU( base + nb + band.x );
  for ( int k = 0; k < int( vb.x ); k++ ) {
    int c = int( pvU( int( vb.y ) + k ).x );
    vec4 p12 = pvF( c ) - vec4( rc, rc );
    vec2 p3 = pvF( c + 1 ).xy - rc;
    if ( max( max( p12.y, p12.w ), p3.y ) * ppe.y < -0.5 ) break;
    uint code = pvRootCode( p12.x, p12.z, p3.x );
    if ( code != 0u ) {
      vec2 r = pvSolveV( p12, p3 ) * ppe.y;
      if ( ( code & 1u ) != 0u ) { ycov -= clamp( r.x + 0.5, 0.0, 1.0 ); ywgt = max( ywgt, clamp( 1.0 - abs( r.x ) * 2.0, 0.0, 1.0 ) ); }
      if ( code > 1u ) { ycov += clamp( r.y + 0.5, 0.0, 1.0 ); ywgt = max( ywgt, clamp( 1.0 - abs( r.y ) * 2.0, 0.0, 1.0 ) ); }
    }
  }
  float cov = max( abs( xcov * xwgt + ycov * ywgt ) / max( xwgt + ywgt, 1.0 / 65536.0 ), min( abs( xcov ), abs( ycov ) ) );
  return clamp( cov, 0.0, 1.0 );
}
vec3 pvVectorText( vec3 color, vec2 uv, vec2 dx, vec2 dy ) {
  if ( uVecOn < 0.5 ) return color;
  ivec2 cell = clamp( ivec2( uv * vec2( uVecInfo.yz ) ), ivec2( 0 ), uVecInfo.yz - 1 );
  uvec2 list = pvU( uVecInfo.w + cell.y * uVecInfo.y + cell.x );
  for ( int k = 0; k < int( list.x ); k++ ) {
    int b = uVecInfo.x + ${INSTANCE_TEXELS} * int( pvU( int( list.y ) + k ).x );
    vec4 t0 = pvF( b );
    vec4 t1 = pvF( b + 1 );
    vec2 rc = vec2( t0.x * uv.x + t0.z * uv.y + t1.x, t0.y * uv.x + t0.w * uv.y + t1.y );
    vec2 ex = vec2( t0.x * dx.x + t0.z * dx.y, t0.y * dx.x + t0.w * dx.y );
    vec2 ey = vec2( t0.x * dy.x + t0.z * dy.y, t0.y * dy.x + t0.w * dy.y );
    vec2 epp = abs( ex ) + abs( ey ); // glyph units per pixel (fwidth)
    vec4 box = pvF( b + 3 );
    if ( rc.x < box.x - epp.x || rc.x > box.z + epp.x || rc.y < box.y - epp.y || rc.y > box.w + epp.y ) continue;
    float cov = pvSlug( rc, 1.0 / max( epp, vec2( 1e-12 ) ), int( t1.z ), int( t1.w ), pvF( b + 2 ) );
    color = mix( color, pvF( b + 4 ).rgb, cov );
  }
  return color;
}
`;
