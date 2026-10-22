// The physical book as numbers: where each leaf attaches, how it bends, how thick the
// block is. No Three.js here, so the shape logic stays readable and testable.
//
// Cross-section coordinates (mm): x across the book, y up from the table. The spine
// runs along z. A leaf's direction is an angle φ from vertical: +90° lies flat to the
// right, -90° flat to the left. A leaf is a ribbon: it leaves its attach point at angle
// α, bends over `bend` mm to its resting angle θ, then runs straight to the fore-edge.


const BINDING_STYLES = {
  // open: angle of the visible pages; stackLimit: how flat the stacks beneath lie;
  // bend: how far from the spine the page curves; rootFollow: how much the root of the
  // page follows its resting angle (0 = rises vertically out of the spine, 1 = rigid).
  // gutter: [width in mm, depth] of the shade toward the fold; deeper for bindings that
  // don't open flat.
  // Opened as far as each binding really goes: stitched and sewn books lie almost flat;
  // a glued spine keeps the pages rising out of the fold (rootFollow, bend), so content near
  // the gutter visibly slips into it.
  // rootAngle, stripBend: open, a pile's sheets leave the spine straight up and turn to this
  // angle from vertical (degrees) within this far (mm), as far as the binding lets them
  // open (a glued spine hardly, sewn signatures more, a stitched fold most); from there the
  // paper's own stiffness shapes them (see openShape).
  saddle: { open: 82, stackLimit: 89.5, bend: 3, rootFollow: 0.55, spine: "fold", gutter: [14, 0.14], rootAngle: 55, stripBend: 2.5 },
  perfect: { open: 72, stackLimit: 88, bend: 22, rootFollow: 0.15, spine: "flat", gutter: [22, 0.22], rootAngle: 12, stripBend: 3 },
  sewn: { open: 80, stackLimit: 89, bend: 14, rootFollow: 0.35, spine: "flat", gutter: [18, 0.17], rootAngle: 30, stripBend: 4 },
  // Case-bound, square back: the block (sewn signatures) in a case of two boards and a flat
  // spine board. board: the boards' thickness unless the spec sets it (mm, = BOARD_MM in
  // core/spine.js); square: how far they overhang the pages at head, foot and fore-edge;
  // joint: the hinge between board and spine. Bookbinding standards; the same as core/spine.js's
  // CASE_SQUARE_MM and CASE_JOINT_MM (a case wrap is read by them), written out here: the
  // viewer's bundle holds no core code (see tests/bundle.test.js).
  hardcover: { open: 78, stackLimit: 89, bend: 14, rootFollow: 0.35, spine: "case", gutter: [18, 0.17], board: 2.5, square: 3, joint: 7, rootAngle: 30, stripBend: 4 },
  // Coils: pitch (4:1 and 3:1 per inch), round holes for a spiral, square ones for wire-o
  // (holeRadius: half the hole's width), wire: radius of the wire.
  // coil: the coil's diameter (mm) for a block this thick, as the binders' size charts have it
  // (spiral 6 to 50 mm for 3 to 41 mm of block: 1.2 x the block + 2.5; wire-o 6.4 to 31.8 mm
  // for 3 to 28 mm: 1.1 x + 2).
  spiral: { open: 88.5, stackLimit: 90, bend: 0, rootFollow: 1, spine: "coil", pitch: 6.35, holeRadius: 2.2, squareHoles: false, wire: 0.55, gutter: [7, 0.06], coil: [1.2, 2.5] },
  "wire-o": { open: 88.5, stackLimit: 90, bend: 0, rootFollow: 1, spine: "coil", pitch: 8.467, holeRadius: 2.1, squareHoles: true, wire: 0.42, gutter: [7, 0.06], coil: [1.1, 2] },
};

export const HOLE_OFFSET_MM = 4.5; // centre of punched holes from the spine edge
/** From the signatures' folds to the inside of a case's spine (mm): the hollow, which the headband's bead fills. */
export const CASE_HOLLOW = 1.7;
/** The covering over a case's thin spine board (mm), flush with the boards' outsides. */
export const CASE_COVER_MM = 1.2;
const CURL_DEG = 55; // how far the fore-edge leads, then trails, during a turn

const DEG = Math.PI / 180;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * A leaf's cross-section: points along it from the spine (x across the book, y up, mm) and
 * the angle it runs at each.
 * @typedef {{x: Float32Array, y: Float32Array, phi: Float32Array}} Profile
 */

/**
 * What a book is made from: page count and size (mm), binding, the paper's thickness and the
 * cover's (mm), the paper's weight and finish (how stiff its pages are), the pages in a
 * sewn signature, a hardcover's boards (mm; null = the usual), whether its block has
 * endpaper leaves (a flyleaf at each end) and a rounded back; side glue (mm from the spine:
 * the covers glued to the first and last page, see glueCovers; 0 none); a hardcover's case from
 * a case wrap (its boards show the wrap's faces whole, the case its joints and spine).
 * @typedef {{pageCount: number, binding: string, thickness: number, coverThickness: number,
 *            width: number, height: number, gsm?: number, finish?: string, signaturePages?: number,
 *            boardMm?: number | null, endpapers?: boolean, roundSpine?: boolean, glueMm?: number,
 *            caseWrap?: boolean}} BookSpec
 */

/**
 * A book (makeBook): its spec, each leaf's thickness and place across the block, a coil's
 * ring; and what layoutBook keeps on it from frame to frame.
 * @typedef {Omit<BookSpec, "thickness"> & {leafCount: number, style: any, thickness: number[],
 *            cum: number[], total: number, ground: number, signatureLeaves: number, foldDepth: number,
 *            firstBlockLeaf: number, rootShift: Float64Array, round: number,
 *            baseSamples?: Float64Array, piled?: any, scratch?: any,
 *            signatureSheets?: [number, number][], signatureTrim?: number} & Partial<ReturnType<typeof coilGeometry>>} Book
 */

/**
 * Static facts about a book: leaf thicknesses and cumulative positions.
 * @param {BookSpec} spec
 * @returns {Book}
 */
export function makeBook(spec) {
  const leafCount = Math.max(1, Math.ceil(spec.pageCount / 2));
  const style = BINDING_STYLES[spec.binding] ?? BINDING_STYLES.saddle;
  const coverMm = style.board ? spec.boardMm ?? style.board : spec.coverThickness; // a hardcover's covers are its boards
  const thickness = Array.from({ length: leafCount }, (_, i) =>
    i === 0 || i === leafCount - 1 ? coverMm : spec.thickness);
  const cum = []; // centre of each leaf across the block, from the front cover
  let acc = 0;
  for (const t of thickness) {
    cum.push(acc + t / 2);
    acc += t;
  }
  const total = acc;
  const ground = -total / 2 - 0.4;
  // A sewn block (sewn, hardcover) is folded signatures, not a flat stack cut at the spine:
  // each sheet is a U round the ones inside it, so every signature's fold reaches half its
  // thickness beyond the sheets' roots (foldDepth), where the cover or case meets it (see
  // writeSignatureFolds in extras.js).
  const signatureLeaves = Math.max(1, Math.round((spec.signaturePages ?? 16) / 2));
  const sewn = spec.binding === "sewn" || spec.binding === "hardcover";
  const foldDepth = sewn ? (Math.min(signatureLeaves, Math.max(1, leafCount - 2)) * spec.thickness) / 2 : 0;
  // The block's first leaf: after the cover, and a hardcover's flyleaf (endpapers: leaves 1
  // and leafCount - 2 are the endpaper stock, outside the sewn signatures).
  const firstBlockLeaf = spec.endpapers && style.spine === "case" && leafCount >= 6 ? 2 : 1;
  // A rounded back: closed, the block's spine bulges (a 130 degree arc, its sagitta 0.32 of
  // the thickness: bookbinding's usual): each leaf slides toward the spine by where it is
  // in the arc (rootShift; nothing at the block's outer leaves or the boards), so the
  // fore-edge goes concave by as much. Open, the back flattens (see layoutBook).
  // The arc spans the block (the boards are rigid, flat beside it).
  const blockMm = leafCount > 2 ? cum[leafCount - 2] - cum[1] + spec.thickness : 0;
  const round = spec.roundSpine && style.spine === "case" && blockMm > 0 ? 0.318 * blockMm : 0;
  const rootShift = new Float64Array(leafCount);
  if (round) {
    const R = (blockMm * blockMm / 4 + round * round) / (2 * round);
    const mid = (cum[1] + cum[leafCount - 2]) / 2;
    const sag = (d) => Math.sqrt(Math.max(0, R * R - d * d)) - (R - round);
    const base = sag(cum[1] - mid);
    for (let i = 1; i < leafCount - 1; i++) rootShift[i] = Math.max(0, sag(cum[i] - mid) - base);
  }
  const book = { ...spec, leafCount, style, thickness, cum, total, ground, signatureLeaves, foldDepth, firstBlockLeaf, rootShift, round };
  if (style.spine === "coil") Object.assign(book, coilGeometry(total, ground, style));
  return book;
}

/**
 * The coil as a ring in the cross-section. Open, the ring rests on the table and each
 * page hangs on it with its hole at the side of the ring, where the wire runs vertically
 * down through the whole stack: every page's hole is on the wire, none is pierced. Pages
 * slope gently from the ring down to the table. Closed, the ring wraps the spine edge and
 * reaches below the block: the book rests on it, tilted (closedTilt, radians, from the
 * fore-edge, where it touches the table).
 */
function coilGeometry(total, ground, { wire, coil: [perMm, plus] }) {
  // As big as the coil a binder takes for a block this thick (the size charts, see the
  // styles: a 40 mm block in a 50 mm spiral), and big enough for the paper strip inside the
  // ring (hole to spine edge) to stop short of the centre, so left and right strips never
  // meet. (The block plus 4.4 mm until 1.1: a thick book's coil looked too small, the
  // designer said; a 40 mm block had a 44 mm ring.)
  const coilRadius = Math.max((perMm * total + plus) / 2, total / 2 + 2.2, HOLE_OFFSET_MM + 1.8);
  return {
    coilRadius,
    wireRadius: wire,
    psiFlat: Math.PI / 2, // a page lying flat right has its hole at the ring's side
    coilOpen: { x: 0, y: ground + coilRadius + wire },
    // How far the closed ring reaches below the block: the spine edge rests that high.
    closedLift: Math.max(0, coilRadius + wire - total / 2),
    coilClosed: {
      x: HOLE_OFFSET_MM - Math.sqrt(Math.max(0, coilRadius ** 2 - (total / 2) ** 2)),
      y: ground + total / 2,
    },
  };
}

/** Resting angle for leaf i when the book is open at `opening` (leaves before it are turned). */
export function restingAngle(book, i, opening) {
  const left = i < opening;
  if (book.style.spine === "coil") return coilRestingAngle(book, left, opening);
  // Glued, sewn, stitched and cased leaves lie on a side; their shape comes from the stack
  // they lie in (layoutBook). A turning leaf goes from 90 to -90 or back.
  return left ? -90 : 90;
}

/**
 * Coil pages on each side lie parallel, sloping from the ring (raised above the table
 * by the wire) down so the bottom page of the stack meets the table at its fore-edge.
 * A page sloping down has its hole below the ring's centre too, on the ring at its angle
 * (leafProfile): over a slope σ the top page's fore-edge comes down R sin σ at the hole
 * and (width − hole offset) sin σ along the page. (Figured from the page's length alone,
 * a 540-page book's thin side ran 3 mm under the table beside its 22 mm ring.)
 */
function coilRestingAngle(book, left, opening) {
  const split = opening === 0 ? 0 : book.cum[opening - 1] + book.thickness[opening - 1] / 2;
  const sideThickness = left ? split : book.total - split;
  const drop = book.coilOpen.y - (book.ground + sideThickness);
  const slope = Math.asin(Math.min(1, Math.max(0, drop) / (book.coilRadius + book.width - HOLE_OFFSET_MM))) / DEG;
  const a = 90 + slope;
  return left ? -a : a;
}

/**
 * The profile of one leaf: points along its centre line from spine to fore-edge.
 *
 * @param {ReturnType<typeof makeBook>} book
 * @param {number} i        leaf index
 * @param {number} theta    current resting angle (deg)
 * @param {number} closed   0 = open, 1 = closed
 * @param {number} split    cumulative thickness where the book is open (for coil stacking)
 * @param {number} curl     extra lag at the fore-edge (deg), for turning pages
 * @param {Float32Array} s  arc-length samples, 0 … width
 * @param {Profile} [out]   arrays to fill (x, y, phi), to avoid allocating per frame
 * @param {1 | -1} [side]   closed with the front cover up, right of the spine (1), or the
 *                          back cover up, left of it (-1: flipped through to the end)
 * @returns {{x: Float32Array, y: Float32Array, phi: Float32Array}}
 */
export function leafProfile(book, i, theta, closed, split, curl, s, out, side = 1) {
  const { style, width, cum, total, ground, thickness } = book;
  const c = smooth(closed);
  const th = lerp(theta, 90 * side, c) * DEG;
  const th0 = th; // the angle the leaf runs at beyond its bend
  const cu = curl * (1 - c) * DEG;
  let ax;
  let ay;
  let alpha;
  let bend = style.bend;

  if (style.spine === "coil") {
    // The hole rides on the wire: it travels round the ring as the page turns (over the
    // top when upright). Stacked pages sit beneath the top one along their normal; the
    // holes are wide enough that the wire still passes through all of them.
    const R = book.coilRadius;
    // The hole's place on the ring follows the page's angle: at the side when flat, over
    // the top when upright. The page runs radially through it (the wire crosses the page
    // at right angles), so the hole always sits on the wire.
    const psi = theta * DEG;
    const t0 = theta * DEG;
    const off = split - cum[i];
    // The pile a page lies in rests on the table. A thin pile hangs from the ring's side, its
    // top page at the ring's centre height sloping down to the fore-edge (coilRestingAngle).
    // A pile taller than that (a thick book open near a cover) is lifted so it still rests on
    // the table: its top page lies flat on it, above the centre, and the holes up there sit
    // on the ring where it is at that height, inside its side, as a thick spiral book's top
    // pages hug the coil. (Stacked down from the centre, a 540-page block sank 17 mm into the
    // table at its cover.) Pages in the air take the ring's point at their angle, as before:
    // the lift and the hug fade as a page rises, so a turn stays continuous.
    const s = Math.sin(psi) >= 0 ? 1 : -1; // the pile it lies in: right of the ring, or left
    const flat = Math.abs(Math.sin(psi));
    const pile = s > 0 ? total - split : split; // paper on that side
    const lift = Math.max(0, book.ground + pile - book.coilOpen.y) * flat;
    const holeY = book.coilOpen.y + R * Math.cos(psi) + Math.sin(t0) * off + lift;
    // Above or below the centre the ring is inside its side: the hole goes where the wire is at
    // that height. (Below the centre it stayed at the side until 2026-10-23: a thick pile resting
    // on the table had the wire through up to 4 mm of paper beside the holes of its lower pages.)
    // Kept clear of the centre while the other pile has paper (the two piles' strips mustn't meet).
    const dyRing = Math.min(R, Math.abs(holeY - book.coilOpen.y));
    const other = s > 0 ? split : total - split;
    const onRing = Math.max(other > 1e-6 ? HOLE_OFFSET_MM + 1 : 0, Math.sqrt(Math.max(0, R * R - dyRing * dyRing)));
    const holeX = book.coilOpen.x + s * (R - flat * (R - onRing)) + (R * Math.sin(psi) - s * R) - Math.cos(t0) * off;
    const openA = { x: holeX - Math.sin(t0) * HOLE_OFFSET_MM, y: holeY - Math.cos(t0) * HOLE_OFFSET_MM };
    // Closed front up, the first leaf on top; back up (flipped through to the end), the last.
    // Each page hangs on the wire: its hole where the ring is at the page's height. The ring
    // meets the hole line at the covers only; between them it bulges in towards the fore-edge,
    // so the pages there sit further in (a thick spiral book's spine side is a curve, its
    // fore-edge bulges). With the spine edges in line, as until 2026-10-23, the wire ran
    // through up to 4 mm of paper in the middle of an 18 mm block.
    const closedY = side > 0 ? ground + total - cum[i] : ground + cum[i];
    const dy = Math.min(R, Math.abs(closedY - book.coilClosed.y));
    const ringIn = book.coilClosed.x + Math.sqrt(Math.max(0, R * R - dy * dy)); // the ring's inner side at that height
    const closedA = { x: side * Math.max(0, ringIn - HOLE_OFFSET_MM), y: closedY };
    ax = lerp(openA.x, closedA.x, c);
    ay = lerp(openA.y, closedA.y, c);
    alpha = th;
    bend = 0;
  } else if (style.spine === "case" && (i === 0 || i === book.leafCount - 1)) {
    // A hardcover's board: rigid; open, it lies flat beside the block, the joint between;
    // closed, it lies on the block, its spine edge a joint's width in from the spine.
    const front = i === 0;
    const openA = { x: (front ? -1 : 1) * (total / 2 + style.joint), y: ground + thickness[i] / 2 };
    const closedA = { x: side * style.joint, y: side > 0 ? ground + total - cum[i] : ground + cum[i] };
    ax = lerp(openA.x, closedA.x, c);
    ay = lerp(openA.y, closedA.y, c);
    alpha = th;
    bend = 0;
  } else {
    // Glued, sewn or folded: leaves rise from a strip across the spine. Closed, they stack
    // with the cover that ends up on top highest.
    const openA = { x: cum[i] - total / 2, y: ground + (style.spine === "fold" ? total / 2 : book.coverThickness) };
    const closedA = { x: 0, y: side > 0 ? ground + total - cum[i] : ground + cum[i] };
    ax = lerp(openA.x, closedA.x, c);
    ay = lerp(openA.y, closedA.y, c);
    alpha = lerp(th * style.rootFollow, th, c);
  }

  const n = s.length;
  const x = out?.x ?? new Float32Array(n);
  const y = out?.y ?? new Float32Array(n);
  const phi = out?.phi ?? new Float32Array(n);
  x[0] = ax;
  y[0] = ay;
  const leafWidth = s[s.length - 1] || width; // a hardcover's boards differ from the pages
  const angle = (sv) => {
    const b = bend > 0 ? smooth(sv / bend) : 1;
    const u = sv / leafWidth;
    return alpha + (th0 - alpha) * b + cu * u * u;
  };
  phi[0] = angle(0);
  for (let k = 1; k < n; k++) {
    const ds = s[k] - s[k - 1];
    const mid = angle((s[k] + s[k - 1]) / 2);
    x[k] = x[k - 1] + Math.sin(mid) * ds;
    y[k] = y[k - 1] + Math.cos(mid) * ds;
    phi[k] = angle(s[k]);
  }
  return { x, y, phi };
}

/**
 * Lay out every leaf of a book (fills each leaf's `profile`).
 *
 * Glued, sewn, stitched and cased books: each side's pile is one stack. Its bottom sheet
 * (the cover, or for a hardcover the endpaper on the board) rises from the spine strip,
 * turns over, comes back down and lies flat (on the table, or on a hardcover's board).
 * Every sheet above it is that curve offset by the paper beneath it (the leaves' strip
 * positions are exactly those offsets), so sheets are parallel and never cross, and their
 * roots sit on the strip. Closing turns the bottom curve flat and the strip upright; the
 * offsets follow. A leaf in mid-turn blends from its shape in the right pile to its shape
 * in the left one. A hardcover's boards are rigid: flat under a pile, resting on top of
 * one, turning about the joint between. Coil books keep their own model (pages on the
 * ring, parallel by construction).
 *
 * @param {ReturnType<typeof makeBook>} book
 * @param {{theta: number, curl: number, s: Float32Array, profile: Profile, group?: string | null,
 *          start?: number | null, from?: number, to?: number}[]} leaves
 *   by index; `group`: leaves turning together (one motion, e.g. a pile swung over to close
 *   the book) share it, and are laid out as one stack; `start`, `from`, `to`: a turning
 *   leaf's (coil books: how far it is in the air)
 * @param {{closed: number, side: 1 | -1, opening: number}} state
 * @param {{cache?: any, only?: Set<number>, turning?: Set<number>}} [options] `cache`: an
 *   object kept for one frame, so the rows of a corner-led turn (several layouts of the same
 *   moment) know where the whole layout put each leaf; `only`: lay out just
 *   these leaves (the others, and the boards, keep what they have); `turning`: leaves sent
 *   turning, in the air even while still lying on their pile (waiting to go, or about to
 *   land), so a page in the air under one can carry it (with `only`, those are turning)
 */
/** How far a stapled sheet peels off its pile before running at its own angle (mm; see layoutBook). */
const PEEL_MM = 5;

export function layoutBook(book, leaves, { closed, side }, { cache = null, only = null, turning = null } = {}) {
  const { style, cum, thickness, total, ground, leafCount: n } = book;
  if (style.spine === "coil") {
    // Pages run straight from the ring, bent by their curl toward the fore-edge: kept in
    // order at the ring (angle) and at the fore-edge (angle plus curl), so a page left
    // behind in a fast flip is carried along instead of passing through the next. Pages at
    // rest hold (weighted fit). Pages in the air also fan out a little at the fore-edge
    // (FAN degrees each): pages bent alike from a ring are shifted copies, not offsets, and
    // where they bend the paper's thickness between them would shrink below what's drawn.
    // How much in the air each leaf is: 0 on its pile, 1 once it is AIR_DEG from both where it
    // left and where it lands, between those smoothly. A leaf yields to the order and fans out
    // as much as it is in the air. (Until 0.17.82 a leaf counted as in the air until the frame
    // it landed, then at once held fast with no fan: 40 pages swung over to close the book
    // landed together and the cover jumped 6 mm in that frame.)
    const FAN = 0.3;
    const AIR_DEG = 9;
    const air = leaves.map((l) => (l.start == null || l.from == null || l.to == null ? (l.curl ? 1 : 0)
      : Math.min(1, Math.min(Math.abs(l.theta - l.from), Math.abs(l.theta - l.to)) / AIR_DEG)));
    const weight = air.map((a) => 1e6 ** (1 - a)); // held fast on a pile, yielding in the air
    const theta = isotonic(leaves.map((l) => l.theta), weight);
    const fan = [0];
    for (let i = 1; i < leaves.length; i++) fan.push(fan[i - 1] + FAN * Math.min(air[i], air[i - 1]));
    const tip = isotonic(leaves.map((l, i) => l.theta + l.curl - fan[i]), weight).map((v, i) => v + fan[i]);
    // Where the block divides (how much paper lies left of the ring, which places every page on
    // it): from the leaves as they lie now, each counting as it crosses over, not from the
    // opening asked for. (From that, pressing Close jumped it to every page lying right while
    // they still lay as before: the right pile dropped below the table, 0.9 mm from pages 26/27,
    // and the table's footprint shadow showed on it as a band with a sharp edge.) At rest the
    // same as the opening's.
    const split = leaves.reduce((sum, _, i) => sum + thickness[i] * Math.min(1, Math.max(0, (90 - theta[i]) / 180)), 0);
    for (const [i, l] of leaves.entries()) leafProfile(book, i, theta[i], closed, split, tip[i] - theta[i], l.s, l.profile, side);
    return;
  }
  const boards = style.spine === "case" && n > 2;
  const lo = boards ? 1 : 0; // the piles' bottom sheets: covers, or a hardcover's endpapers
  const hi = boards ? n - 2 : n - 1;
  const c = smooth(closed);
  const W = book.width;
  const base = ground + (boards ? thickness[0] : 0); // what the piles lie on: table or board
  // The strip across the spine, open: glued books on their spine (a hardcover's on its
  // spine board), a sewn block's roots above its signatures' folds, a stitched one above
  // its folds.
  const stripY = style.spine === "fold" ? ground + total / 2 : base + thickness[lo] + book.foldDepth;
  const length = W * 1.25; // so every leaf's offset curve reaches its full length
  // The base curve, finer than the leaves through the spine's bend: the sheets offset
  // outside it run longer there, and their pieces must stay as fine as the leaves' own.
  book.baseSamples ??= Float64Array.from([...Array.from({ length: 160 }, (_, k) => k * 0.05), ...samples(length).filter((v) => v >= 8)]);
  const sb = book.baseSamples;
  const M = sb.length - 1;
  const bottom = (sigma, at = null) => {
    const b = sigma > 0 ? hi : lo;
    // Both piles close: the side the book lies on flattens into the block; the other side
    // becomes the cover lying open at the height of the spine's top edge, so a cover turning
    // while the book opens or closes swings about that edge, as a real cover hinges.
    const k = c;
    const openRoot = { x: cum[b] - total / 2, y: stripY };
    const closedRoot = { x: 0, y: side > 0 ? ground + total - cum[b] : ground + cum[b] };
    const root = at ?? { x: lerp(openRoot.x, closedRoot.x, k), y: lerp(openRoot.y, closedRoot.y, k) };
    const landing = base + thickness[b] / 2;
    // Open, the paper's own shape (openShape: a heavy elastica, landing exactly where it
    // lies). Closing flattens it; beta, a gentle tip past level over most of the page, is
    // found so the sheet still comes down exactly where it lies.
    const open = openShape(book, stripY - landing);
    const slopeFrom = style.stripBend ?? 3;
    const slopeLen = W * 0.8;
    const shape = (sv, beta) => {
      const u = Math.min(1, Math.max(0, (sv - slopeFrom) / slopeLen));
      const a = open(sv) + beta * Math.sin(Math.PI * u) ** 2;
      return sigma * lerp(a, Math.PI / 2, k);
    };
    // How far the sheet comes down over its width: the same sums as shape() (cos is even,
    // so without sigma), on the parts that don't depend on beta or k, kept with the shape.
    open.drop ??= (() => {
      const a = [];
      const w = [];
      const ds = [];
      for (let j = 1; j <= M && sb[j - 1] < W; j++) {
        const s1 = Math.min(W, sb[j]);
        const sv = (sb[j - 1] + s1) / 2;
        const u = Math.min(1, Math.max(0, (sv - slopeFrom) / slopeLen));
        a.push(open(sv));
        w.push(Math.sin(Math.PI * u) ** 2);
        ds.push(s1 - sb[j - 1]);
      }
      return { a: Float64Array.from(a), w: Float64Array.from(w), ds: Float64Array.from(ds) };
    })();
    const terms = open.drop;
    const drop = (beta) => {
      let y = 0;
      for (let j = 0; j < terms.a.length; j++) y += Math.cos(lerp(terms.a[j] + beta * terms.w[j], Math.PI / 2, k)) * terms.ds[j];
      return y;
    };
    const want = landing - root.y;
    let beta = 0;
    if (Math.abs(drop(0) - want) > 1e-4) {
      // The drop falls as beta grows (the sheet tips further down).
      let a = -1;
      let z = 1.2;
      for (let it = 0; it < 32; it++) {
        const mid = (a + z) / 2;
        if (drop(mid) > want) a = mid;
        else z = mid;
      }
      beta = (a + z) / 2;
    }
    const x = new Float64Array(M + 1);
    const y = new Float64Array(M + 1);
    const phi = new Float64Array(M + 1);
    x[0] = root.x;
    y[0] = root.y;
    phi[0] = shape(0, beta);
    for (let j = 1; j <= M; j++) {
      const s0 = sb[j - 1];
      const s1 = sb[j];
      const mid = shape((s0 + s1) / 2, beta);
      x[j] = x[j - 1] + Math.sin(mid) * (s1 - s0);
      y[j] = y[j - 1] + Math.cos(mid) * (s1 - s0);
      phi[j] = shape(s1, beta);
    }
    // Toward the pages: the right pile lies on its bottom sheet's front, the left on its back.
    // The normal's parts too, shared by every sheet offset from it (see inPile).
    return { b, x, y, phi, cos: phi.map(Math.cos), sin: phi.map(Math.sin), up: sigma > 0 ? 1 : -1 };
  };
  // The side the book lies on first; the other side's bottom sheet (the cover that lifts)
  // starts exactly where that sheet lies in it: one hinge for both, open or closed. The
  // piles, and every leaf's shape in them, depend only on how closed the book is and which
  // side it lies on: kept on the book, so a page turning (which changes neither) doesn't
  // lay out every sheet of a thick book again each frame.
  // While the book opens or closes they change every frame: last frame's shapes are then
  // written over (`spare`), not dropped (fresh arrays for every sheet each frame, megabytes
  // of them in a thick book, had the garbage collector stop frames).
  const pilesKey = `${closed}|${side}`;
  if (book.piled?.key !== pilesKey) book.piled = { key: pilesKey, piles: null, shapes: new Map(), spare: book.piled?.shapes ?? null };
  const piled = book.piled;
  book.scratch ??= { ox: new Float64Array(M + 1), oy: new Float64Array(M + 1), len: new Float64Array(M + 1) };
  if (!piled.piles) {
    const piles = { [side]: bottom(side) };
    const P = piles[side];
    const d = cum[hi] - cum[lo];
    piles[-side] = bottom(-side, {
      x: P.x[0] - Math.cos(P.phi[0]) * d * P.up,
      y: P.y[0] + Math.sin(P.phi[0]) * d * P.up,
    });
    piled.piles = piles;
  }
  const piles = piled.piles;
  // A leaf's centre line in a pile: the bottom curve offset by the paper beneath it (plus
  // `extra`), measured along the offset curve (sheets outside a bend run a little longer).
  // Read only by its users: kept (see piled).
  const inPile = (i, sigma, sv, extra = 0) => {
    const id = extra === 0 ? `${i}|${sigma}` : null;
    const kept = id && piled.shapes.get(id);
    if (kept && kept.sv === sv) return kept;
    const B = piles[sigma];
    const d = (sigma > 0 ? cum[B.b] - cum[i] : cum[i] - cum[B.b]) + extra;
    const { ox, oy, len } = book.scratch;
    for (let j = 0; j <= M; j++) {
      ox[j] = B.x[j] - B.cos[j] * d * B.up;
      oy[j] = B.y[j] + B.sin[j] * d * B.up;
      if (j) {
        const ex = ox[j] - ox[j - 1];
        const ey = oy[j] - oy[j - 1];
        len[j] = len[j - 1] + Math.sqrt(ex * ex + ey * ey); // Math.hypot is several times slower
      }
    }
    let out = id && piled.spare?.get(id);
    if (out && out.x.length === sv.length) {
      piled.spare.delete(id);
      out.stale = true; // its integrated twin (see below) is last frame's
    } else {
      out = { x: new Float64Array(sv.length), y: new Float64Array(sv.length), phi: new Float64Array(sv.length) };
    }
    // A rounded back, closing: the leaf slides back along its own curve into the spine's
    // bulge, its root onto the curve's straight continuation behind the strip. Every sheet
    // stays an offset of the one base curve, each covering its own stretch of it, so none
    // can cross another (translated instead, sheets bent over the strip had).
    const slide = book.rootShift[i] * c;
    const tx = Math.sin(B.phi[0]);
    const ty = Math.cos(B.phi[0]);
    let j = 0;
    for (let k = 0; k < sv.length; k++) {
      const sk = sv[k] - slide;
      if (sk <= 0) {
        out.x[k] = ox[0] + tx * sk;
        out.y[k] = oy[0] + ty * sk;
        out.phi[k] = B.phi[0];
        continue;
      }
      while (j < M - 1 && len[j + 1] < sk) j++;
      const t = Math.min(1, Math.max(0, (sk - len[j]) / ((len[j + 1] - len[j]) || 1)));
      out.x[k] = ox[j] + (ox[j + 1] - ox[j]) * t;
      out.y[k] = oy[j] + (oy[j + 1] - oy[j]) * t;
      // An offset curve runs the way its base does at the same point (no atan2 per point).
      out.phi[k] = B.phi[j] + (B.phi[j + 1] - B.phi[j]) * t;
    }
    if (id) {
      out.sv = sv;
      piled.shapes.set(id, out);
    }
    return out;
  };
  const sideOf = (theta) => Math.min(1, Math.max(0, (90 - theta) / 180)); // 0 right … 1 left
  // Where each leaf is between its two piles, point by point along it (0 its shape in the
  // right pile, 1 in the left; curl moves the fore-edge ahead or behind). Leaves in the
  // air each keep their own timing, so clicking back and forth fast could leave one behind
  // the next, and they would pass through each other. So the order is kept: no leaf is
  // less far over than the one after it, by a hair (ORDER_GAP); one that would fall behind
  // is carried along with it, as a page pushes the next (pool adjacent violators, the
  // standard least-squares fit of an ordered sequence), within the piles at either end.
  // The hair only between leaves moving on their own, and fading out as either comes within
  // AIR of a pile: leaves turning together are one stack (below), kept apart by their paper,
  // and on a pile the piles' own offsets keep them apart. (Until 0.17.82 a hair between every
  // two: 35 leaves swung over to close the book held their top one 35 hairs, about 9 degrees,
  // short of its pile, and it fell the rest in the frame they landed, 16 mm at the
  // fore-edge; opening, the same jump the other way in the first frame.)
  const ORDER_GAP = 0.0015;
  const AIR = 0.05;
  const info = [];
  for (let i = lo; i <= hi; i++) {
    const l = leaves[i];
    const e = sideOf(l.theta);
    // A turning leaf stays in the air even where it lies on a pile: a page in the air under
    // it carries it (as the rows of a corner-led turn do, which must agree), and by row a
    // board still coming down under that pile bounds it (see below).
    if ((e <= 0 || e >= 1) && !(only ?? turning)?.has(i)) {
      info.push({ i, e, still: true });
      continue;
    }
    if (only && !only.has(i)) {
      // Laid out already (this frame's full layout): it holds where it is, point by point.
      info.push({ i, e, still: true, f: cache?.f?.get(i) ?? null });
      continue;
    }
    const sv = l.s;
    const R = inPile(i, 1, sv);
    const L = inPile(i, -1, sv);
    // Pages swung over together with a hardcover's board ride on the board: no curl of their
    // own (a paperback's soft cover bends with them instead).
    const carried = boards && !!l.group && (l.group === leaves[0].group || l.group === leaves[n - 1].group);
    const cu = carried ? 0 : l.curl * (1 - c) * DEG;
    const f = new Float64Array(sv.length);
    for (let k = 0; k < sv.length; k++) {
      const span = L.phi[k] - R.phi[k];
      f[k] = Math.abs(span) > 1e-3 ? e + (cu * (sv[k] / W) ** 2) / span : e;
    }
    if (style.spine === "fold" && c > 0) {
      // A stapled sheet peels off its pile: over its first PEEL_MM it runs along the pile it
      // is nearer, the far pile's way only past halfway, turning to its own angle beyond.
      // Its fold at the spine is drawn from the way it leaves its root (see
      // writeFoldGeometry), and the folds inside it from their own roots: leaving at its
      // turned angle at once, a lifting cover's fold dived across the first sheet's, whose
      // white showed outside it at the spine (the author's recording; 0.26 mm out with 44
      // pages of 0.15 mm paper, 0.52 with 0.3 mm, 0.17.98). The switch costs nothing: a
      // cover opening or closing the book stands upright as the book is fully open, where
      // both piles leave the spine the same way; a page turning in an open book likewise.
      // (Mixing in the far pile's way by its turn, cubed, still left 12 % of it a third of
      // the way over: 5 degrees, 0.09 mm out with 80 pages.) Only while the book opens or
      // closes, fading out as it is fully open: a page turning in an open booklet needs none
      // (its folds stayed nested before) and keeps its gentle bend at the gutter (peeled,
      // its first few millimetres bent 60 degrees one way, then the other).
      const eRoot = smooth((e - 0.45) / 0.1);
      const w = smooth(c / 0.02); // the last hair before fully open (from 0.1, the cover's fold came 0.05 mm out with 80 pages)
      for (let k = 0; k < sv.length && sv[k] < PEEL_MM; k++) {
        const peeled = eRoot + (f[k] - eRoot) * smooth(sv[k] / PEEL_MM);
        f[k] += (peeled - f[k]) * w;
      }
    }
    info.push({ i, e, still: false, R, L, f, cu });
  }
  const K = leaves[lo].s.length;
  // Where a leaf that holds bounds the ones in the air next to it: a pile at its side, or a
  // leaf in the air (by a hair).
  const bound = (q, k, d) => (q.f ? q.f[k] + d : q.e);
  // Laying out only some leaves (a corner-led row), a board turning on its own bounds the
  // page next to it too: the board was placed on that page's full layout, never behind it.
  const boardBound = (b, page, k, d, pick) => {
    const e = sideOf(leaves[b].theta);
    if (!only || !boards || e <= 0 || e >= 1 || (leaves[b].group && leaves[b].group === leaves[page].group)) return null;
    const f = cache?.f?.get(page);
    return pick(e, f ? f[k] : e) + d;
  };
  if (info.every((q) => q.still || q.f.length === K)) {
    const sums = new Float64Array(info.length); // the blocks being pooled (no objects per point)
    const counts = new Int32Array(info.length);
    const offsets = new Float64Array(info.length);
    // The hair between each leaf and the next (see ORDER_GAP).
    const air = (q) => Math.min(1, Math.max(0, Math.min(q.e, 1 - q.e)) / AIR);
    const gapAfter = info.map((q, r) => {
      const next = info[r + 1];
      if (!next || q.still || next.still) return 0;
      const g = leaves[q.i].group;
      if (g && g === leaves[next.i].group) return 0;
      return ORDER_GAP * Math.min(air(q), air(next));
    });
    for (let k = 0; k < K; k++) {
      let m = 0;
      while (m < info.length) {
        if (info[m].still) {
          m++;
          continue;
        }
        let end = m;
        while (end < info.length && !info[end].still) end++;
        // The leaf before is at least as far over; and none further than lying on a pile
        // (the table or a board is under each pile's bottom sheet).
        const upper = m > 0 ? bound(info[m - 1], k, -ORDER_GAP) : boardBound(0, lo, k, -ORDER_GAP, Math.max) ?? 1;
        const lower = end < info.length ? bound(info[end], k, ORDER_GAP) : boardBound(n - 1, hi, k, ORDER_GAP, Math.min) ?? 0;
        // Non-increasing with the gaps: g = f + (the gaps before it) must not increase.
        offsets[m] = 0;
        for (let r = m + 1; r < end; r++) offsets[r] = offsets[r - 1] + gapAfter[r - 1];
        let blocks = 0;
        for (let r = m; r < end; r++) {
          sums[blocks] = info[r].f[k] + offsets[r];
          counts[blocks++] = 1;
          while (blocks > 1 && sums[blocks - 2] / counts[blocks - 2] < sums[blocks - 1] / counts[blocks - 1]) {
            blocks--;
            sums[blocks - 1] += sums[blocks];
            counts[blocks - 1] += counts[blocks];
          }
        }
        let r = m;
        for (let b = 0; b < blocks; b++) {
          for (let q = 0; q < counts[b]; q++, r++) {
            const v = sums[b] / counts[b] - offsets[r];
            info[r].f[k] = Math.min(upper, Math.max(lower, v));
          }
        }
        m = end;
      }
    }
  }
  if (cache && !only) cache.f = new Map(info.filter((q) => !q.still).map((q) => [q.i, q.f])); // for the rows (above)
  // Leaves turning together are one stack: the reference sheet (a cover or endpaper if in
  // it, else its first) is laid out as above, the others as its curve offset by the paper
  // between them, so the stack holds together in any pose, also over a block that is
  // closing (where sheets laid out one by one can't be kept apart).
  const members = new Map();
  for (const q of info) {
    const g = !q.still && leaves[q.i].group;
    if (!g) continue;
    if (!members.has(g)) members.set(g, []);
    members.get(g).push(q);
  }
  const refOf = new Map(); // follower info -> its reference's index
  for (const list of members.values()) {
    if (list.length < 2) continue;
    const ref = list.find((q) => q.i === lo) ?? list.find((q) => q.i === hi) ?? list[0];
    for (const q of list) if (q !== ref) refOf.set(q, ref.i);
  }
  const followers = [];
  for (const q of info) {
    if (only && !only.has(q.i)) continue;
    if (refOf.has(q)) {
      followers.push(q);
      continue;
    }
    const l = leaves[q.i];
    const p = l.profile;
    const sv = l.s;
    let shape;
    if (q.still) {
      shape = inPile(q.i, q.e >= 1 ? -1 : 1, sv);
    } else {
      // Mid-turn: its shapes in the two piles, blended point by point as found above,
      // integrated from its root. Summing angles drifts a little from the piles' exact
      // offset curves (hundredths of a millimetre, as much as paper is thin): that drift,
      // measured on each pile's shape, is taken back out in the same blend, so a leaf
      // lifting off or landing lies exactly on its pile.
      const { R, L, f, cu } = q;
      // Kept with the pile shape; one written over (see spare) is worked out again in place.
      for (const P of [R, L]) {
        if (P.integrated && !P.stale) continue;
        P.integrated = integrate(sv, (k) => P.phi[k], P.x[0], P.y[0], P.integrated);
        P.stale = false;
      }
      const iR = R.integrated;
      const iL = L.integrated;
      const ang = (k) => {
        const span = L.phi[k] - R.phi[k];
        return Math.abs(span) > 1e-3 ? R.phi[k] + span * f[k] : R.phi[k] + span * q.e + cu * (sv[k] / W) ** 2;
      };
      shape = integrate(sv, ang, R.x[0] + (L.x[0] - R.x[0]) * f[0], R.y[0] + (L.y[0] - R.y[0]) * f[0]);
      for (let k = 0; k < sv.length; k++) {
        shape.x[k] += (R.x[k] - iR.x[k]) * (1 - f[k]) + (L.x[k] - iL.x[k]) * f[k];
        shape.y[k] += (R.y[k] - iR.y[k]) * (1 - f[k]) + (L.y[k] - iL.y[k]) * f[k];
      }
    }
    for (let k = 0; k < sv.length; k++) {
      p.x[k] = shape.x[k];
      p.y[k] = shape.y[k];
      p.phi[k] = shape.phi[k];
    }
  }
  // The references' curves, finer where they bend: offset outside a tight bend (a stitched
  // fold), the sheets run longer and their samples spread apart. Each piece is cut until,
  // offset as far as the block is thick, it strays from the true curve by DENSE_TOL at
  // most (a piece turning by `a` at radius rho bulges rho a^2 / 8 off its chord); a straight
  // piece needs no cuts. (Cut every 0.05 mm whatever its bend, a page took 3,000 points,
  // offset again for every sheet of a stack and every row: a pile swung over to close the
  // book took 40 ms a frame.)
  const DENSE_TOL = 5e-4; // mm
  const dense = new Map();
  const denseOf = (i) => {
    if (dense.has(i)) return dense.get(i);
    const r = leaves[i].profile;
    const xs = [r.x[0]];
    const ys = [r.y[0]];
    const ps = [r.phi[0]];
    for (let k = 1; k < r.x.length; k++) {
      const dx = r.x[k] - r.x[k - 1];
      const dy = r.y[k] - r.y[k - 1];
      const seg = Math.sqrt(dx * dx + dy * dy);
      const turn = Math.abs(r.phi[k] - r.phi[k - 1]);
      const m = Math.max(1, Math.min(256, Math.ceil(Math.sqrt((seg * turn + total * turn * turn) / (8 * DENSE_TOL)))));
      // Along the arc between the samples (the angle turning evenly), then the small
      // difference to the next sample spread over the way, so the curve passes through it.
      let x = r.x[k - 1];
      let y = r.y[k - 1];
      const px = [];
      const py = [];
      for (let j = 1; j <= m; j++) {
        const a = r.phi[k - 1] + (r.phi[k] - r.phi[k - 1]) * ((j - 0.5) / m);
        x += Math.sin(a) * (seg / m);
        y += Math.cos(a) * (seg / m);
        px.push(x);
        py.push(y);
      }
      const ex = r.x[k] - x;
      const ey = r.y[k] - y;
      for (let j = 1; j <= m; j++) {
        xs.push(px[j - 1] + (ex * j) / m);
        ys.push(py[j - 1] + (ey * j) / m);
        ps.push(r.phi[k - 1] + (r.phi[k] - r.phi[k - 1]) * (j / m));
      }
    }
    // The normal's parts, shared by every sheet offset from it.
    const cos = new Float64Array(ps.length);
    const sin = new Float64Array(ps.length);
    for (let k = 0; k < ps.length; k++) {
      cos[k] = Math.cos(ps[k]);
      sin[k] = Math.sin(ps[k]);
    }
    const out = { x: xs, y: ys, phi: ps, cos, sin };
    dense.set(i, out);
    return out;
  };
  let ox = null;
  let oy = null;
  let len = null;
  for (const q of followers) {
    const r = denseOf(refOf.get(q));
    const l = leaves[q.i];
    const sv = l.s;
    // Higher leaves lie on the back side of lower ones: away from the front's normal.
    const d = cum[q.i] - cum[refOf.get(q)];
    const K = r.x.length;
    if (!len || len.length < K) {
      ox = new Float64Array(K);
      oy = new Float64Array(K);
      len = new Float64Array(K);
    }
    for (let k = 0; k < K; k++) {
      ox[k] = r.x[k] + r.cos[k] * d;
      oy[k] = r.y[k] - r.sin[k] * d;
      if (k) {
        const ex = ox[k] - ox[k - 1];
        const ey = oy[k] - oy[k - 1];
        len[k] = len[k - 1] + Math.sqrt(ex * ex + ey * ey);
      }
    }
    const p = l.profile;
    let j = 0;
    for (let k = 0; k < sv.length; k++) {
      while (j < K - 2 && len[j + 1] < sv[k]) j++;
      const seg = (len[j + 1] - len[j]) || 1;
      const t = (sv[k] - len[j]) / seg; // past the end: carried on straight
      p.x[k] = ox[j] + (ox[j + 1] - ox[j]) * t;
      p.y[k] = oy[j] + (oy[j + 1] - oy[j]) * t;
      // An offset curve runs the way its reference does at the same point (no atan2 per
      // point: most of a stack's time).
      p.phi[k] = r.phi[j] + (r.phi[j + 1] - r.phi[j]) * Math.min(1, Math.max(0, t));
    }
  }
  if (!boards || only) return;

  // The boards. Rigid, each resting along the outside of a sheet: the page it covers when
  // they turn together (the board carries it), else a stand-in sheet just outside that page
  // that turns as far as the board, as any page does, never further back than the page
  // (front) or ahead of it (back). Turned like a page, the stand-in never cuts through the
  // pages, so neither does the board resting on it; and its opening and closing come from
  // the piles, as the pages' do. (Placed on their own, sliding between lying under a pile
  // and resting on one, the boards cut through the first page where it rises from the spine,
  // and a search for a clear place made them jump about while turning.)
  const restOn = (bi, q, lift) => {
    const last = q.x.length - 1;
    const len = leaves[bi].s[leaves[bi].s.length - 1];
    const sideSign = bi === 0 ? 1 : -1; // the front board on the sheet's front, the back one on its back
    const nOut = (k) => ({ x: -Math.cos(q.phi[k]) * sideSign, y: Math.sin(q.phi[k]) * sideSign });
    const S = (k) => ({ x: q.x[k] + nOut(k).x * lift, y: q.y[k] + nOut(k).y * lift });
    const E = S(last);
    // A frame at the fore-edge: X back toward the spine, Y away from the sheet. The board
    // rests on the sheet's fore-edge and on wherever the sheet bulges toward it.
    const X = { x: -Math.sin(q.phi[last]), y: -Math.cos(q.phi[last]) };
    const Y = nOut(last);
    let alpha = 0;
    for (let k = 0; k < last; k++) {
      const v = S(k);
      const px = (v.x - E.x) * X.x + (v.y - E.y) * X.y;
      const py = (v.x - E.x) * Y.x + (v.y - E.y) * Y.y;
      if (px > 1e-6 && px <= len) alpha = Math.max(alpha, Math.atan2(py, px));
    }
    const back = { x: X.x * Math.cos(alpha) + Y.x * Math.sin(alpha), y: X.y * Math.cos(alpha) + Y.y * Math.sin(alpha) };
    // Hung from the case's spine corner by the covering across its joint, which doesn't
    // stretch: along its own line, the board's inner edge as far from that corner as when the
    // book is shut (a joint's width and the depth behind the block's spine). Pages arching up
    // out of the gutter draw their fore-edge in; the board stays where it is, overhanging them
    // more. (Until 1.1 the inner edge was a joint's width along the board from where the sheet
    // leaves the spine: as the board swung, the case's outside grew 27.2 to 27.5 mm and then
    // shrank to 20.7 open, its joints 9.8, 12.4, 6.9 mm: "the spine extends", the author.)
    const S0 = S(0);
    const toRoot = (S0.x - E.x) * back.x + (S0.y - E.y) * back.y;
    let reach = Math.max(0, toRoot - style.joint);
    const H = hinge(bi);
    if (H) {
      const dx = E.x - H.x;
      const dy = E.y - H.y;
      const along = dx * back.x + dy * back.y;
      const disc = along * along - (dx * dx + dy * dy) + H.length * H.length;
      if (disc >= 0) reach = Math.max(0, -along - Math.sqrt(disc));
    }
    return { x: E.x + back.x * reach, y: E.y + back.y * reach, phi: Math.atan2(-back.x, -back.y) };
  };
  // The case's spine corner at board `bi`'s side (as writeCaseSpine in extras.js builds it:
  // across the block's outer sheets by the boards' thickness, behind its spine by the folds,
  // the hollow and half the covering) and the covering's length from there to the board.
  const hinge = (bi) => {
    const pl = leaves[1]?.profile;
    const ph = leaves[n - 2]?.profile;
    if (style.spine !== "case" || n < 4 || !pl || !ph) return null;
    let ax = ph.x[0] - pl.x[0];
    let ay = ph.y[0] - pl.y[0];
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    let ox = -ay;
    let oy = ax;
    if (ox * Math.sin(pl.phi[0]) + oy * Math.cos(pl.phi[0]) > 0) {
      ox = -ox;
      oy = -oy;
    }
    const depth = book.foldDepth + CASE_HOLLOW + CASE_COVER_MM / 2;
    const wide = (t) => t / 2 + thickness[0] - CASE_COVER_MM / 2;
    const [p, t, sign] = bi === 0 ? [pl, thickness[1], -1] : [ph, thickness[n - 2], 1];
    return { x: p.x[0] + sign * ax * wide(t) + ox * depth, y: p.y[0] + sign * ay * wide(t) + oy * depth, length: style.joint + depth };
  };
  // A sheet between its two pile shapes, `f` of the way at each point (as the pages are).
  const between = (R, L, f, sv) => {
    const iR = integrate(sv, (k) => R.phi[k], R.x[0], R.y[0]);
    const iL = integrate(sv, (k) => L.phi[k], L.x[0], L.y[0]);
    const out = integrate(sv, (k) => R.phi[k] + (L.phi[k] - R.phi[k]) * f[k], R.x[0] + (L.x[0] - R.x[0]) * f[0], R.y[0] + (L.y[0] - R.y[0]) * f[0]);
    for (let k = 0; k < sv.length; k++) {
      out.x[k] += (R.x[k] - iR.x[k]) * (1 - f[k]) + (L.x[k] - iL.x[k]) * f[k];
      out.y[k] += (R.y[k] - iR.y[k]) * (1 - f[k]) + (L.y[k] - iL.y[k]) * f[k];
    }
    return out;
  };
  for (const bi of [0, n - 1]) {
    const l = leaves[bi];
    const front = bi === 0;
    const page = front ? lo : hi;
    let q;
    let lift;
    if (l.group && l.group === leaves[page].group) {
      q = leaves[page].profile;
      lift = (thickness[bi] + thickness[page]) / 2;
    } else {
      const sv = leaves[page].s;
      const half = thickness[page] / 2;
      // The stand-in: at the page's outer surface, in each pile.
      const R = inPile(page, 1, sv, front ? half : -half);
      const L = inPile(page, -1, sv, front ? -half : half);
      const pq = info[front ? 0 : info.length - 1];
      const over = sideOf(l.theta);
      const f = new Float64Array(sv.length);
      for (let k = 0; k < sv.length; k++) {
        const fp = pq.still ? pq.e : Math.min(1, Math.max(0, pq.f[k]));
        f[k] = front ? Math.max(over, fp) : Math.min(over, fp);
      }
      q = f.every((v) => v <= 0) ? R : f.every((v) => v >= 1) ? L : between(R, L, f, sv);
      lift = thickness[bi] / 2;
    }
    const a = restOn(bi, q, lift);
    const p = l.profile;
    for (let k = 0; k < l.s.length; k++) {
      p.x[k] = a.x + Math.sin(a.phi) * l.s[k];
      p.y[k] = a.y + Math.cos(a.phi) * l.s[k];
      p.phi[k] = a.phi;
    }
  }
  glueCovers(book, leaves);
}

/**
 * Side glue (perfect, sewn: `glueMm`): each cover glued to the page next to it for that far
 * from the spine. Opening a side-glued paperback, the cover hinges at the end of the glue (its
 * score line), and its first strip stays with the page: here the cover's first `glueMm` lies on
 * that page's outer surface, wherever the page is, and the rest of the cover keeps its own
 * shape, carried from where the strip ends (a crease there). While cover and page lie in one
 * pile (closed, or both turned) the strip is where the cover lay anyway and nothing moves.
 * (Until 1.1 the cover rose free from the spine, parting from the page where it is glued.)
 */
function glueCovers(book, leaves) {
  const g = book.glueMm ?? 0;
  const n = leaves.length;
  if (!(g > 0) || book.style.spine !== "flat" || n < 4) return;
  for (const [ci, pi] of [[0, 1], [n - 1, n - 2]]) {
    const c = leaves[ci].profile;
    const p = leaves[pi].profile;
    const cs = leaves[ci].s;
    const ps = leaves[pi].s;
    if (!c || !p || cs[cs.length - 1] <= g) continue;
    // The page's centre line and its normal at arc length v (interpolated).
    const on = (v) => {
      let k = 0;
      while (k < ps.length - 2 && ps[k + 1] < v) k++;
      const t = Math.max(0, Math.min(1, (v - ps[k]) / Math.max(1e-9, ps[k + 1] - ps[k])));
      const phi = p.phi[k] + (p.phi[k + 1] - p.phi[k]) * t;
      return { x: p.x[k] + (p.x[k + 1] - p.x[k]) * t, y: p.y[k] + (p.y[k + 1] - p.y[k]) * t, phi, nx: -Math.cos(phi), ny: Math.sin(phi) };
    };
    // The cover's side of the page (its normal, toward the cover's root) and how far out:
    // half of each sheet.
    const r0 = on(0);
    const side = Math.sign((c.x[0] - r0.x) * r0.nx + (c.y[0] - r0.y) * r0.ny) || 1;
    const off = side * (book.thickness[ci] + book.thickness[pi]) / 2;
    // Where the strip ends, on the page, and where the cover's own shape is there.
    const end = on(g);
    let k = 0;
    while (k < cs.length - 2 && cs[k + 1] < g) k++;
    const t = Math.max(0, Math.min(1, (g - cs[k]) / Math.max(1e-9, cs[k + 1] - cs[k])));
    const dx = end.x + end.nx * off - (c.x[k] + (c.x[k + 1] - c.x[k]) * t);
    const dy = end.y + end.ny * off - (c.y[k] + (c.y[k + 1] - c.y[k]) * t);
    for (let j = 0; j < cs.length; j++) {
      if (cs[j] <= g) {
        const q = on(cs[j]);
        c.x[j] = q.x + q.nx * off;
        c.y[j] = q.y + q.ny * off;
        c.phi[j] = q.phi;
      } else {
        c.x[j] += dx;
        c.y[j] += dy;
      }
    }
  }
}

/**
 * A centre line from its angle at each sample (`ang(k)`), summed from (x0, y0) along the
 * arc lengths `sv`; into `out` if given.
 */
function integrate(sv, ang, x0, y0, out = null) {
  out ??= { x: new Float64Array(sv.length), y: new Float64Array(sv.length), phi: new Float64Array(sv.length) };
  out.x[0] = x0;
  out.y[0] = y0;
  out.phi[0] = ang(0);
  for (let k = 1; k < sv.length; k++) {
    const mid = (ang(k) + ang(k - 1)) / 2;
    const ds = sv[k] - sv[k - 1];
    out.x[k] = out.x[k - 1] + Math.sin(mid) * ds;
    out.y[k] = out.y[k - 1] + Math.cos(mid) * ds;
    out.phi[k] = ang(k);
  }
  return out;
}

/**
 * The closest non-decreasing sequence to `values` (least squares; pool adjacent
 * violators), each entry by its weight: one weighing a million times more holds.
 */
function isotonic(values, weights) {
  const blocks = [];
  for (const [i, v] of values.entries()) {
    const w = weights[i];
    blocks.push({ sum: v * w, weight: w, count: 1 });
    while (blocks.length > 1) {
      const a = blocks[blocks.length - 2];
      const b = blocks[blocks.length - 1];
      if (a.sum / a.weight <= b.sum / b.weight) break;
      blocks.pop();
      a.sum += b.sum;
      a.weight += b.weight;
      a.count += b.count;
    }
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.count; k++) out.push(b.sum / b.weight);
  return out;
}

// --- the paper's own shape -------------------------------------------------------------

// Young's modulus of paper (GPa): about 4 for uncoated stock, a little more coated.
const PAPER_MODULUS_GPA = { uncoated: 4, matte: 4.5, gloss: 4.5 };
// The load holding an open book open (a hand, the reader, the book's own breaking-in), as a
// multiple of the paper's weight. Left to gravity alone a paperback springs shut; with it
// the pages lie as an open book does, and the paper still decides how: heavier stock is
// stiffer (as the cube of its thickness) for little more weight, so it arches higher.
const HOLD = 16;

/**
 * The elasto-gravity length of a stock (mm): how far a sheet holds its own shape against
 * its load. Bending stiffness B = E t^3 / 12 against weight w = grammage * g * HOLD:
 * (B / w)^(1/3). About 30 mm for 80 g/m2 uncoated, 39 mm for 120 g/m2, 50 mm for 200.
 */
function bendLength(gsm, thicknessMm, finish = "uncoated") {
  const E = (PAPER_MODULUS_GPA[finish] ?? 4) * 1e9;
  const t = thicknessMm / 1000;
  const B = (E * t ** 3) / 12;
  const w = (gsm / 1000) * 9.81 * HOLD;
  return Math.cbrt(B / w) * 1000;
}

/**
 * The heavy elastica: the shape of a sheet rising from the spine, arching over and lying
 * down on what it rests on, under its stiffness and load (Euler's elastica with gravity; a
 * page bound along one edge with its other edges free bends in one direction only, so its
 * cross-section is the whole story). Measured from where it touches down, toward the
 * spine, with q in bend lengths: theta'' = (rho - q) cos(theta), theta the slope; it touches
 * down smoothly (theta = theta' = 0), and the reaction there, rho, is found so the sheet
 * reaches its root `rise` (bend lengths) above where it lies, leaving the root at
 * `rootSlope` (theta, radians, below level toward the spine). Returns the slope every `dq`
 * from the touchdown, the lifted length, and the tightest radius where it curves up toward
 * the table.
 */
function heavyElastica(rootSlope, rise) {
  const dq = 0.002;
  const shoot = (rho, record) => {
    let th = 0;
    let dth = 0;
    let y = 0;
    let q = 0;
    let up = 0; // largest curvature while bending up toward the table
    let crested = false;
    let steepest = 0;
    const slopes = record ? [0] : null;
    const f = (qq, a, da) => [da, (rho - qq) * Math.cos(a), Math.sin(a)];
    for (let step = 0; step < 40000; step++) {
      // Runge-Kutta 4 on (theta, theta', y).
      const k1 = f(q, th, dth);
      const k2 = f(q + dq / 2, th + (dq / 2) * k1[0], dth + (dq / 2) * k1[1]);
      const k3 = f(q + dq / 2, th + (dq / 2) * k2[0], dth + (dq / 2) * k2[1]);
      const k4 = f(q + dq, th + dq * k3[0], dth + dq * k3[1]);
      th += (dq / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
      dth += (dq / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
      y += (dq / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
      q += dq;
      if (q <= rho) up = Math.max(up, dth);
      if (record) slopes.push(th);
      if (th > 0) crested = true;
      steepest = Math.max(steepest, th);
      // Past upright it would roll over itself: not a sheet lying open.
      if (steepest >= Math.PI / 2) return null;
      if (crested && th <= rootSlope) return { y, q, slopes, up };
    }
    return null;
  };
  // A larger reaction lifts the arch higher, until the sheet would roll over itself: walk up
  // to the first reaction whose root comes out high enough, then narrow it down.
  let a = 0;
  let z = 0;
  for (let rho = 0.02; rho < 12; rho += 0.02) {
    const r = shoot(rho, false);
    if (!r) break;
    if (r.y >= rise) {
      z = rho;
      break;
    }
    a = rho;
  }
  if (z === 0) z = a; // as high as it goes
  for (let it = 0; it < 30 && z > a; it++) {
    const mid = (a + z) / 2;
    const r = shoot(mid, false);
    if (r && r.y < rise) a = mid;
    else z = mid;
  }
  const out = shoot(z, true) ?? shoot(a, true);
  return { slopes: out.slopes, dq, length: out.q, tightest: out.up > 0 ? 1 / out.up : Infinity };
}

/**
 * The open shape of a pile's bottom sheet, as its angle from vertical along its length from
 * the root (radians; pi/2 lies flat): straight up out of the spine, turning to the binding's
 * root angle within its strip bend, then the paper's heavy elastica down to where it lies,
 * `rise` mm below the root. Cached on the book. A pile stacks on the inside of the curve
 * where it bends up toward the table: there the bend length is lengthened so the curve stays
 * gentler than the whole block is thick (a thick block is stiffer, too).
 */
function openShape(book, rise) {
  book.openShapes ??= new Map();
  const key = rise.toFixed(4);
  if (book.openShapes.has(key)) return book.openShapes.get(key);
  const { style } = book;
  const phi0 = (style.rootAngle ?? 30) * DEG;
  const strip = style.stripBend ?? 3;
  const page = book.thickness[Math.min(1, book.leafCount - 1)];
  const gsm = book.gsm ?? (page * 1000) / 1.25; // without a grammage: uncoated bulk
  // The strip bend: angle phi0 * smooth(s / strip) from vertical; how high it climbs.
  let climb = 0;
  for (let k = 0; k < 64; k++) climb += Math.cos(phi0 * smooth((k + 0.5) / 64)) * (strip / 64);
  let lb = bendLength(gsm, page, book.finish);
  let solved;
  for (let pass = 0; pass < 4; pass++) {
    solved = heavyElastica(phi0 - Math.PI / 2, Math.max(0, rise + climb) / lb);
    // Pages come down to lie within 85 % of their width (held open a little harder for
    // very stiff stock: otherwise they'd hover over the table, or a hardcover's board)...
    const reach = book.width * 0.85;
    let scale = Math.min(1, reach / (solved.length * lb));
    // ...but never curve up toward the table more tightly than the block is thick (it
    // stacks on that side).
    const need = book.total * 1.25;
    scale = Math.max(scale, need / (solved.tightest * lb));
    if (Math.abs(scale - 1) < 0.01) break;
    lb *= scale;
  }
  const { slopes, dq, length } = solved;
  const lifted = length * lb;
  const shape = (s) => {
    if (s <= strip) return phi0 * smooth(s / strip);
    const from = s - strip; // along the arch from its root
    if (from >= lifted) return Math.PI / 2;
    const q = (lifted - from) / (lb * dq); // steps from the touchdown
    const i = Math.min(slopes.length - 2, Math.floor(q));
    const t = q - i;
    return Math.PI / 2 + slopes[i] + (slopes[i + 1] - slopes[i]) * t;
  };
  shape.bendLength = lb;
  shape.lifted = lifted;
  book.openShapes.set(key, shape);
  return shape;
}

/** Centre of the coil ring for a given closedness. */
export function coilCentre(book, closed, side = 1) {
  const c = smooth(closed);
  return { x: lerp(book.coilOpen.x, side * book.coilClosed.x, c), y: lerp(book.coilOpen.y, book.coilClosed.y, c) };
}

/**
 * A leaf's shape: arc-length samples along it, its flat width and height (mm), where on the
 * page its content starts (uStart, mm: what a fold or a joint takes), and whether it is a board.
 * @typedef {{s: Float32Array, width: number, height: number, uStart: number, board: boolean}} LeafShape
 */

/**
 * A leaf's size, its page image's place on it, and its samples along it (shared by every
 * leaf of the same kind). Pages: the trim. A hardcover's boards: from the joint to a square
 * past the fore-edge, a square taller at head and foot; the flat face, as the edges are
 * rolls of the covering as thick as the board, adding half of it back on every side (the
 * page image keeps its size in millimetres: the joint hides its spine strip, the squares
 * repeat its edge). Coil pages run straight from the ring, no fold to follow: evenly, every
 * 2 mm (half the points to lay out and draw, for every page of a coil book moves as one
 * turns).
 * @returns {LeafShape}
 */
export function leafShape(book, i) {
  const st = book.style;
  const n = book.leafCount;
  const board = st.spine === "case" && (i === 0 || i === n - 1);
  book.leafShapes ??= /** @type {Map<string, LeafShape>} */ (new Map());
  // One shape for pages and one for boards; a stitched book's sheets one per depth (below),
  // a sewn block's one per fold (by what the fold takes).
  const depth = st.spine === "fold" ? Math.min(i, n - 1 - i) : null;
  const partner = board ? null : signaturePartner(book, i);
  const sigFold = partner === null ? 0 : (Math.PI / 4) * Math.abs(book.cum[partner] - book.cum[i]);
  const kind = board ? "board" : depth !== null ? `fold:${depth}` : partner !== null ? `sig:${sigFold.toFixed(6)}` : "page";
  if (!book.leafShapes.has(kind)) {
    if (board) {
      const r = st.board / 2;
      const width = book.width + st.square - st.joint - r;
      book.leafShapes.set(kind, { s: samples(width), width, height: book.height + 2 * st.square - 2 * r, uStart: st.joint, board: true });
    } else if (depth !== null) {
      // A stitched sheet folds round the sheets inside it, and the fold takes paper from each
      // half: a quarter turn of radius half the gap between its two halves, closed. The page's
      // content starts that far along (uStart: hidden in the fold, the cover's most), and the
      // trim leaves every half the flat width the cover's has, so the inner pages lose the
      // difference at their fore-edge: the creep a trimmed booklet shows. (Every half was the
      // page's whole width from its root: no creep, and nothing in the fold.)
      const folded = (d) => (n - 1 - d > d ? (Math.PI / 4) * (book.cum[n - 1 - d] - book.cum[d]) : 0);
      const width = book.width - folded(0);
      book.leafShapes.set(kind, { s: samples(width), width, height: book.height, uStart: folded(depth), board: false });
    } else if (partner !== null) {
      // A sewn block's signatures are booklets: each sheet folds round the ones inside it (a
      // half circle past the roots, see writeSignatureFolds in extras.js), the pages printed
      // from the fold, and the block trimmed at the fore-edge as one. So as above, within each
      // signature: the content starts where its fold ends, and every page is as wide as the
      // outermost sheets' (the creep cut off). (Until 1.1 every page started at its root, the
      // folds blank paper beyond: print not all the way to the spine, the designer's sewn
      // book and hardcover, 2026-10-22.)
      const width = book.width - signatureTrim(book);
      book.leafShapes.set(kind, { s: samples(width), width, height: book.height, uStart: sigFold, board: false });
    } else {
      // A sewn block's covers and flyleaves are trimmed with it.
      const width = book.width - signatureTrim(book);
      const s = st.spine === "coil" ? evenly(book.width, 2) : samples(width);
      book.leafShapes.set(kind, { s, width: st.spine === "coil" ? book.width : width, height: book.height, uStart: 0, board: false });
    }
  }
  return book.leafShapes.get(kind);
}

/**
 * The sheets of a sewn block (sewn, hardcover): within each signature of the block (the
 * covers or boards, and a hardcover's flyleaves, apart), the k-th leaf from its front with the
 * k-th from its back, as [first, last] leaf pairs from the front. Empty for other bindings.
 * @returns {[number, number][]}
 */
export function signatureSheets(book) {
  if (book.signatureSheets) return book.signatureSheets;
  const n = book.leafCount;
  const sewn = book.style.spine === "case" || (book.style.spine === "flat" && book.binding === "sewn");
  const pairs = /** @type {[number, number][]} */ ([]);
  const first = book.firstBlockLeaf;
  for (let a = first; sewn && a < n - first; a += book.signatureLeaves) {
    const b = Math.min(n - 1 - first, a + book.signatureLeaves - 1);
    for (let k = 0; a + k < b - k; k++) pairs.push([a + k, b - k]);
  }
  return (book.signatureSheets = pairs);
}

/** The leaf a sewn block's leaf `i` is one sheet with (itself: the odd leaf at a signature's centre), or null. */
function signaturePartner(book, i) {
  if (!signatureSheets(book).length) return null;
  const n = book.leafCount;
  const first = book.firstBlockLeaf;
  if (i < first || i > n - 1 - first) return null;
  const a = first + Math.floor((i - first) / book.signatureLeaves) * book.signatureLeaves;
  const b = Math.min(n - 1 - first, a + book.signatureLeaves - 1);
  return a + b - i;
}

/** What a sewn block loses at the fore-edge (mm): the most any signature's outer fold takes. */
function signatureTrim(book) {
  if (book.signatureTrim === undefined) {
    let most = 0;
    for (const [a, b] of signatureSheets(book)) most = Math.max(most, (Math.PI / 4) * (book.cum[b] - book.cum[a]));
    book.signatureTrim = most;
  }
  return book.signatureTrim;
}

/** Samples along `width` at most `step` apart, evenly. */
function evenly(width, step) {
  const count = Math.max(1, Math.ceil(width / step));
  return Float32Array.from({ length: count + 1 }, (_, k) => (width * k) / count);
}

/**
 * Arc-length samples: every 0.2 mm through a fold's tight bend at the spine, every 0.5 mm
 * through the arch out of the spine, then every 1.5 mm or so to the fore-edge (an open
 * page still curves gently where it comes down to lie flat; the straight pieces between
 * samples must stay well inside the 0.1 mm between sheets).
 */
export function samples(width) {
  const out = [0];
  const FOLD = Math.min(width, 4);
  const BEND = Math.min(width, 24);
  while (out[out.length - 1] < FOLD - 1e-6) out.push(Math.min(FOLD, out[out.length - 1] + 0.2));
  while (out[out.length - 1] < BEND - 1e-6) out.push(Math.min(BEND, out[out.length - 1] + 0.5));
  const far = width > BEND ? Math.ceil((width - BEND) / 1.5) : 0;
  for (let k = 1; k <= far; k++) out.push(BEND + ((width - BEND) * k) / far);
  return Float32Array.from(out);
}

/**
 * Turns led by a corner: a page is turned by its corner, so the foot of a turning leaf runs
 * ahead of its middle and the head behind (the corner lifts first and lands first), by up to
 * LEAD_DEG, never past where the turn starts or ends; the leading corner curls a little
 * more. Each row from head (zz = -1) to foot (1) is laid out as its own cross-section, so
 * no sheet passes through another row by row (see the proof). Rigid sheets (a hardcover's
 * boards, and the pages a board carries) don't twist.
 */
const LEAD_DEG = 10;
export function rowTurn(theta, from, to, curl, zz) {
  if (from === to) return { theta, curl };
  const lead = Math.sign(to - from) * Math.min(Math.abs(theta - from), Math.abs(to - theta), LEAD_DEG);
  return { theta: theta + lead * zz, curl: curl * (1 + 0.35 * zz) };
}

/**
 * Bend of a turning leaf, `p` of the way through its turn. The fore-edge leads while the
 * page lifts off its stack, then trails as it settles on the other side, so it never
 * dips into the pages beneath.
 */
export function turnCurl(from, to, p) {
  const travel = Math.min(1, Math.abs(to - from) / 90);
  return Math.sign(to - from) * CURL_DEG * travel * Math.sin(Math.PI * p) * Math.cos(Math.PI * p);
}
