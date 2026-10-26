// What the binding adds round the leaves, built with the book and laid out with it every
// frame: a glued or sewn spine's slab (and sewing threads), a saddle stitch's folds and
// staples, a case's spine, rounded boards and headbands, a coil; and the contact shadow
// under the book and the table it lies on.

import * as THREE from "three";
import { CASE_COVER_MM, CASE_HOLLOW, COIL_SEAM, coilCentre, leafShape, signatureSheets } from "./model.js";
import { EDGE_INK_SHARE, EDGE_INSET_MM, INK_GLSL, inkUniforms, LEAF_FILL, PAGE_DATA_GLSL, pageDataUniforms, patchShader } from "./shaders.js";

// Booklet stitching wire (mm): crown width, clinched leg length, flattened cross-section.
const STAPLE = { crown: 12.7, leg: 5.2, width: 0.62, thickness: 0.42 };

const lerp = (a, b, t) => a + (b - a) * t;
// A glued spine's slab ends this far inside the book's head and foot together (mm), see layoutExtras.
const SLAB_INSET_MM = 0.1;

export function makeExtras(scene) {
  const group = new THREE.Group();
  scene.block.add(group);
  const { style, height: h } = scene.model;
  const extras = { group };

  if (style.spine === "flat") {
    // Box faces: +x (the back cover's side), -x (the front cover's), +y (against the pages),
    // -y (the spine's outside, v running from head to foot, see layoutExtras), +z and -z
    // (foot and head: cut paper edges).
    // Its ends at head and foot are the cover's cut edge, in the same shade as the leaves'
    // edges; its face toward the pages shows only in the slit between a cover's root and the
    // signatures' folds (a sewn block's slab stands a fold's depth behind the roots), as the
    // cover's wrap does there: the cover's colour. Its narrow sides, the spine's corners
    // where the cover folds round onto the spine, carry the spine's own tone (see
    // spineSideFrontMat): in the cover's edge colour (to 0.17.84) a white cover on a black
    // spine drew a white line along the corner, the cover stock's white before that.
    extras.slab = new THREE.Mesh(spineSlabGeometry(),
      [scene.spineSideBackMat, scene.spineSideFrontMat, scene.frontWrapMat, scene.spineMat, scene.coverEdgeMat, scene.coverEdgeMat]);
    extras.slab.castShadow = extras.slab.receiveShadow = true;
    group.add(extras.slab);
    if (scene.model.binding === "sewn") {
      extras.threads = makeThreads(scene, group);
      extras.signatureFolds = makeSignatureFolds(scene, group);
    }
  } else if (style.spine === "fold") {
    // Each sheet folds round the ones inside it: nested U's at the spine, cut paper at head
    // and foot, printed as its pages are (see foldSheetMaterial): the cover round the spine,
    // the centre spread into the fold.
    const n = scene.model.leafCount;
    extras.fold = foldMesh(scene, Array.from({ length: Math.floor(n / 2) }, (_, k) => [k, n - 1 - k]));
    extras.fold.castShadow = extras.fold.receiveShadow = true;
    extras.fold.frustumCulled = false;
    group.add(extras.fold);
    // Two staples, as a stitching head forms them from flattened wire: outside, the crown
    // pressed onto the fold, turning square into the paper at both ends; inside the
    // centre spread, the legs coming out and clinched flat toward each other.
    // The crown's ends and the legs' turn each reach half way through the block, where they
    // meet; a block thinner than the wire gets a flatter staple (squashed in its thickness),
    // so nothing sticks out through the covers. (Built for a thick block, the wire poked
    // through an 8-page 60 gsm booklet, 0.3 mm thick, as a ghost of a staple on its cover.)
    const into = Math.max(0.2, Math.min(1.2, scene.model.total / 2));
    const bend = Math.min(0.45, 0.9 * into);
    extras.stapleSquash = Math.min(1, scene.model.total / (1.5 * STAPLE.thickness));
    const crown = stapleGeometry([[-STAPLE.crown / 2, -into], [-STAPLE.crown / 2, 0], [STAPLE.crown / 2, 0], [STAPLE.crown / 2, -into]], bend);
    const legs = stapleGeometry([[-STAPLE.crown / 2, -into], [-STAPLE.crown / 2, 0], [-STAPLE.crown / 2 + STAPLE.leg, 0]], bend);
    const legs2 = stapleGeometry([[STAPLE.crown / 2, -into], [STAPLE.crown / 2, 0], [STAPLE.crown / 2 - STAPLE.leg, 0]], bend);
    extras.staples = [-1, 1].map((sgn) => {
      const z = sgn * h * 0.27;
      const outer = new THREE.Mesh(crown, scene.stapleMat);
      const inner = new THREE.Group();
      inner.add(new THREE.Mesh(legs, scene.stapleMat), new THREE.Mesh(legs2, scene.stapleMat));
      outer.scale.y = inner.scale.y = extras.stapleSquash;
      outer.position.z = inner.position.z = z;
      outer.castShadow = true;
      inner.children.forEach((m) => { m.castShadow = true; });
      group.add(outer, inner);
      return { outer, inner };
    });
  } else if (style.spine === "case") {
    // The case's spine: covering material from board to board round the block's square
    // back (outside: the spine artwork or colour), and the headbands at head and foot of
    // the block's spine.
    // Inside: the endpaper across the joints (paper; see liningMat).
    // Outside: the spine artwork or colour across the spine and round its corners; the
    // joints, from the corners to the boards, in each cover's colour at its spine edge (the
    // artwork's edge columns stretched across them, to 0.17.84, drew its lettering as
    // streaks up the boards).
    // Inside: the endpaper across the joints, kraft lining across the spine panel (the
    // hollow's tunnel is dark, as a real one; lit in endpaper white, to 0.17.85, the far
    // headband showed through it and the near one looked afloat).
    extras.caseSpine = new THREE.Mesh(new THREE.BufferGeometry(), [scene.spineMat, scene.liningMat, scene.spineMat, scene.frontWrapMat, scene.backWrapMat, scene.kraftMat]);
    extras.caseSpine.castShadow = extras.caseSpine.receiveShadow = true;
    extras.caseSpine.frustumCulled = false;
    group.add(extras.caseSpine);
    extras.signatureFolds = makeSignatureFolds(scene, group);
    // Each board's covering rolls round its head, foot and fore-edge: rounded edges, as a
    // cased book's are (rolls as thick as the board, flat-ended: along the head and foot
    // from the joint to the fore-edge, down the fore-edge from head to foot), rounded only
    // where head and foot meet the fore-edge. (Capsules until 0.17.83: domed ends that stood
    // out past the spine's corner like pipes.)
    const r = scene.model.thickness[0] / 2; // the boards' thickness
    const faceW = leafShape(scene.model, 0).width;
    const faceH = leafShape(scene.model, 0).height;
    const along = new THREE.CylinderGeometry(r, r, faceW, 16, 1);
    const down = new THREE.CylinderGeometry(r, r, faceH, 16, 1).rotateX(Math.PI / 2);
    const corner = new THREE.SphereGeometry(r, 16, 10);
    extras.boardEdges = [scene.frontWrapMat, scene.backWrapMat].map((mat) => {
      const g = new THREE.Group();
      const head = new THREE.Mesh(along, mat);
      const foot = new THREE.Mesh(along, mat);
      const fore = new THREE.Mesh(down, mat);
      const corners = [new THREE.Mesh(corner, mat), new THREE.Mesh(corner, mat)];
      head.position.z = -faceH / 2;
      foot.position.z = faceH / 2;
      for (const m of [head, foot, fore, ...corners]) {
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
      g.userData = { head, foot, fore, corners, faceW };
      group.add(g);
      return g;
    });
    // A headband at head and foot: a cord (the bead) across the block's spine, sitting on
    // the spine's corner at the cut edge, half above it, and the cloth it is sewn to,
    // glued down the spine (see HEADBAND). The bead's own mesh and the tail's.
    extras.headbands = [-1, 1].map((sgn) => {
      const bead = new THREE.Mesh(new THREE.BufferGeometry(), scene.headbandMat);
      const tail = new THREE.Mesh(new THREE.BufferGeometry(), scene.headbandMat);
      // The bead's ends, cut flat: a disc across the cord at each end (a tube is open at both
      // ends: seen from the spine's end the headband looked hollow, 0.17.83; round caps made it
      // a pill, 1.1.0).
      const cut = new THREE.CircleGeometry(HEADBAND.beadRadius, 12);
      const ends = [new THREE.Mesh(cut, scene.headbandMat), new THREE.Mesh(cut, scene.headbandMat)];
      bead.castShadow = tail.castShadow = true;
      bead.userData = { sgn, z: sgn * (h / 2 - HEADBAND.beadRadius * HEADBAND.beadDrop), tail, ends };
      group.add(bead, tail, ...ends);
      return bead;
    });
  } else if (style.spine === "coil") {
    extras.coil = makeCoil(scene, style);
    group.add(extras.coil);
  }
  return extras;
}

/**
 * The glued spine's slab: a unit box (see makeExtras for its faces), its two narrow sides (the
 * spine's corners, x = ±0.5) mapped onto the spine artwork's edge columns: every point of a side
 * takes the texture coordinate the spine face (-y) has at the same x and z, so each corner shows
 * the artwork's own edge at that height, whatever the artwork's orientation.
 */
function spineSlabGeometry() {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const spine = geo.groups[3]; // -y, the spine's outside
  const at = new Map();
  for (let v = spine.start; v < spine.start + spine.count; v++) {
    const k = geo.index.getX(v);
    at.set(`${Math.sign(pos.getX(k))},${Math.sign(pos.getZ(k))}`, [uv.getX(k), uv.getY(k)]);
  }
  for (const side of [geo.groups[0], geo.groups[1]]) { // +x and -x
    for (let v = side.start; v < side.start + side.count; v++) {
      const k = geo.index.getX(v);
      const [u, w] = at.get(`${Math.sign(pos.getX(k))},${Math.sign(pos.getZ(k))}`);
      uv.setXY(k, u, w);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

function makeCoil(scene, style) {
  const { height: h, coilRadius: R } = scene.model;
  const coil = new THREE.Group();
  const loops = Math.max(1, Math.floor((h - 6) / style.pitch));
  const margin = (h - loops * style.pitch) / 2;
  const holeZ = (k) => -h / 2 + margin + (k + 0.5) * style.pitch;
  const wire = scene.model.wireRadius;
  if (scene.model.binding === "wire-o") {
    // One continuous wire, as Wire-O is made: through each hole a hairpin (two parallel
    // loops joined by a U at one end), and from each hairpin a bend along the spine to
    // the next. The bends sit at the bottom of the ring, where no page's hole ever comes
    // (COIL_SEAM), under the book. (Over the top until 2026-10-24: closed, the seam faced
    // the reader at the front of the spine, the author's view report.)
    const d = 0.85; // half the spacing of a hairpin's two loops
    const gap = (style.pitch - 2 * d) / 2; // half the length of a bend to the next hairpin
    const seam = COIL_SEAM;
    // The hairpins' tips and the bends to the next hairpin meet at the seam: kept apart.
    const aS = seam + 0.35;
    const aE = seam + 2 * Math.PI - 0.35;
    const parts = [];
    for (let k = 0; k < loops; k++) {
      const z = holeZ(k);
      parts.push(
        { len: R * (aE - aS), at: (s) => [aS + (aE - aS) * s, z - d] },
        { len: Math.PI * d, at: (s) => [aE + (d / R) * Math.sin(Math.PI * s), z - d * Math.cos(Math.PI * s)] },
        { len: R * (aE - aS), at: (s) => [aE - (aE - aS) * s, z + d] },
      );
      if (k < loops - 1) {
        parts.push({ len: Math.PI * gap, at: (s) => [aS - (gap / R) * Math.sin(Math.PI * s), z + d + gap * (1 - Math.cos(Math.PI * s))] });
      }
    }
    const total = parts.reduce((sum, p) => sum + p.len, 0);
    const curve = curveOf((t, target) => {
      let u = Math.min(1, Math.max(0, t)) * total;
      let part = parts[parts.length - 1];
      for (const p of parts) {
        if (u <= p.len) {
          part = p;
          break;
        }
        u -= p.len;
      }
      const [a, z] = part.at(Math.min(1, u / part.len));
      return target.set(R * Math.cos(a), R * Math.sin(a), z);
    });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.ceil(total / 0.25), wire, 12, false), scene.wireMat);
    tube.castShadow = true;
    coil.add(tube, ...wireEnds(curve, wire, scene.wireMat));
  } else {
    // An even helix, a pitch a turn, from the bottom of the ring (COIL_SEAM, where no hole
    // ever comes) to the bottom: through each hole at the top of the ring, beside it elsewhere,
    // where the page hangs that much lower or higher (coilRise in model.js). (Until 2026-10-24
    // level with its holes all round and climbing to the next over the top: a staircase, the
    // author's view report.)
    const turns = loops;
    const span = turns * 2 * Math.PI;
    const curve = curveOf((t, target) => {
      const a = COIL_SEAM + t * span;
      return target.set(R * Math.cos(a), R * Math.sin(a), holeZ(0) - style.pitch / 2 + (style.pitch * (a - COIL_SEAM)) / (2 * Math.PI));
    });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, turns * 128, wire, 14, false), scene.wireMat);
    tube.castShadow = true;
    coil.add(tube, ...wireEnds(curve, wire, scene.wireMat));
  }
  return coil;
}

/**
 * A sewn block's signatures, folded: each sheet a U round the ones inside it, at the
 * sheets' roots, reaching foldDepth beyond them toward the cover or case. Seen at head and
 * foot (a row of nested folds along the spine, where a glued block shows cut edges) and, open,
 * at the ends of the gutter. Paper throughout: the folds' outsides and their cut ends.
 */
function makeSignatureFolds(scene, group) {
  const m = foldMesh(scene, signatureSheets(scene.model));
  // In the spine's slab or the case but for their cut ends and a signature's centre spread:
  // nothing to shadow (a draw a sheet, saved for the shadows).
  m.receiveShadow = true;
  m.frustumCulled = false;
  group.add(m);
  return m;
}

/** Sewing threads through the centre fold of each signature. */
function makeThreads(scene, group) {
  const sig = scene.signatureLeaves; // leaves per signature (a 16-page one has 8)
  const threads = [];
  const piece = new THREE.CylinderGeometry(0.22, 0.22, 14, 6).rotateX(Math.PI / 2);
  const h = scene.model.height;
  const { leafCount: n, firstBlockLeaf: first } = scene.model;
  // At each signature's centre sheet (the block's leaves in signatures from its first; a
  // short last one at its own middle): between leaves centre - 1 and centre.
  for (let a = first; a + 1 <= n - 1 - first; a += sig) {
    const len = Math.min(sig, n - first - a);
    const centre = a + Math.floor(len / 2);
    const g = new THREE.Group();
    for (let z = -h / 2 + 18; z < h / 2 - 12; z += 26) {
      const m = new THREE.Mesh(piece, scene.threadMat);
      m.position.z = z;
      g.add(m);
    }
    g.userData.centre = centre;
    group.add(g);
    threads.push(g);
  }
  return threads;
}

export function layoutExtras(scene) {
  const ex = scene.extras;
  if (!ex) return;
  const m = scene.model;
  const first = scene.leaves[0].profile;
  const last = scene.leaves[scene.leaves.length - 1].profile;
  const P = new THREE.Vector2(first.x[0], first.y[0]);
  const Q = new THREE.Vector2(last.x[0], last.y[0]);
  // Outward from the block: down when open; closed, away from the side the book lies on.
  const out = new THREE.Vector2(lerp(0, -scene.closedSide, scene.closed), lerp(-1, 0, scene.closed)).normalize();
  const tc = m.coverThickness;

  if (ex.signatureFolds) writeSignatureFolds(ex.signatureFolds.geometry, scene.leaves, m, out);
  if (ex.slab) {
    // Flush against the leaves' roots (any gap shows the slab's inner face as a light
    // line). A sewn block's signatures fold a fold's depth past the roots: the slab takes
    // them in, as deep as the folds and the cover together, its outside where it was. (A
    // slab a cover's thickness deep standing behind the folds, to 0.17.85, left a slit the
    // fold's depth wide between the cover's root and the spine, the white folds in it: "the
    // white line where the cover meets the spine", 0.6 to 1.7 mm wide.)
    const deep = tc + m.foldDepth;
    const mid = P.clone().add(Q).multiplyScalar(0.5).addScaledVector(out, deep / 2);
    const along = Q.clone().sub(P);
    ex.slab.position.set(mid.x, mid.y, 0);
    ex.slab.rotation.z = Math.atan2(along.y, along.x);
    // Its ends a hair inside the head and foot: the signatures' folds end exactly there, and
    // at the same plane the slab's ends and theirs fought, the folds showing in patches through
    // the cover's colour (the designer's sewn book, 2026-10-22).
    ex.slab.scale.set(along.length() + tc, deep, m.height - SLAB_INSET_MM);
  }
  if (ex.fold) {
    const { outerApex, innerApex } = writeFoldGeometry(ex.fold.geometry, scene.leaves, m);
    for (const st of ex.staples) {
      // Each staple's local y points out of the paper it lies on, and rests on it: the
      // crown on the spine, the legs on the centre spread.
      const up = STAPLE.thickness * 0.5 * ex.stapleSquash;
      const legUp = STAPLE.width * 0.5; // clear of the centre fold's walls
      st.outer.position.set(outerApex.x + outerApex.nx * up, outerApex.y + outerApex.ny * up, st.outer.position.z);
      st.outer.rotation.z = Math.atan2(outerApex.ny, outerApex.nx) - Math.PI / 2;
      // The legs lie in the crease between the two centre pages, where they show.
      const c = Math.floor(scene.leaves.length / 2);
      const pa = scene.leaves[c - 1]?.profile;
      const pb = scene.leaves[c]?.profile;
      if (pa && pb) {
        // Where the centre spread's V is wide enough to show them.
        let k = 1;
        while (k < pa.x.length - 1 && scene.leaves[c].s[k] < 1.4) k++;
        const mx = (pa.x[k] + pb.x[k]) / 2;
        const my = (pa.y[k] + pb.y[k]) / 2;
        let nx = mx - (pa.x[0] + pb.x[0]) / 2;
        let ny = my - (pa.y[0] + pb.y[0]) / 2;
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl;
        ny /= nl;
        st.inner.position.set(mx, my, st.inner.position.z);
        st.inner.rotation.z = Math.atan2(ny, nx) - Math.PI / 2;
        // Only where the crease is open wider than the wire: closed (every spread but the
        // centre one, the centre pages lying on each other) the legs have no room, and showed
        // through the page lying on them as a grey line in the gutter (the author, booklet-16
        // at 6 | 7). As on paper: they show once the centre spread opens.
        const gap = Math.hypot(pa.x[k] - pb.x[k], pa.y[k] - pb.y[k]) - (m.thickness[c - 1] + m.thickness[c]) / 2;
        st.inner.visible = gap > STAPLE.thickness * ex.stapleSquash;
      } else {
        st.inner.position.set(innerApex.x + innerApex.nx * legUp, innerApex.y + innerApex.ny * legUp, st.inner.position.z);
        st.inner.rotation.z = Math.atan2(innerApex.ny, innerApex.nx) - Math.PI / 2;
      }
    }
  }
  if (ex.caseSpine) {
    const a = scene.leaves[0];
    const b = scene.leaves[scene.leaves.length - 1];
    writeCaseSpine(ex.caseSpine.geometry, a.profile, b.profile, scene.leaves[1].profile,
      scene.leaves[scene.leaves.length - 2].profile, m, m.height + 2 * m.style.square, scene.closed * scene.closed * (3 - 2 * scene.closed));
    // The boards' rounded edges follow the boards (rigid: from root to fore-edge).
    for (const [g, leaf] of [[ex.boardEdges[0], a], [ex.boardEdges[1], b]]) {
      const p = leaf.profile;
      const last = p.x.length - 1;
      const dx = p.x[last] - p.x[0];
      const dy = p.y[last] - p.y[0];
      const turn = Math.atan2(dy, dx) - Math.PI / 2;
      for (const e of [g.userData.head, g.userData.foot]) {
        e.position.x = (p.x[0] + p.x[last]) / 2;
        e.position.y = (p.y[0] + p.y[last]) / 2;
        e.rotation.z = turn;
      }
      g.userData.fore.position.set(p.x[last], p.y[last], 0);
      g.userData.corners[0].position.set(p.x[last], p.y[last], g.userData.head.position.z);
      g.userData.corners[1].position.set(p.x[last], p.y[last], g.userData.foot.position.z);
    }
    // Headbands: across the block's spine at head and foot, glued to it (see HEADBAND).
    // The path runs along the sheets' roots, offset outward: the bead's centre a little past
    // the signatures' folds (it caps the spine's corner), the tail on the folds' outside.
    const inner = scene.leaves.slice(1, -1);
    const stepBy = Math.max(1, Math.ceil(inner.length / 24));
    const picks = [];
    for (let k = 0; k < inner.length; k += stepBy) picks.push(inner[k].profile);
    if (inner.length && (inner.length - 1) % stepBy !== 0) picks.push(inner[inner.length - 1].profile);
    const at = (p, off) => new THREE.Vector2(p.x[0] - Math.sin(p.phi[0]) * off, p.y[0] - Math.cos(p.phi[0]) * off);
    const beadPath = picks.map((p) => at(p, m.foldDepth + HEADBAND.beadRadius * HEADBAND.beadOut));
    const tailPath = picks.map((p) => at(p, m.foldDepth + HEADBAND.tailLift));
    // The bead fills the hollow's mouth: as thick as the hollow is deep (it touches the
    // folds and the case), and carried on past the block's outer sheets into the case's
    // corners, so the tunnel between block and case is closed at head and foot. (Spanning
    // the block's spine alone, to 0.17.91, it left the case's corners open beside it: from
    // the end the bead read as afloat in a dark slot, and the far headband showed through.)
    if (beadPath.length >= 2 && ex.caseSpine) {
      const a = beadPath[beadPath.length - 1].clone().sub(beadPath[0]).normalize();
      // Into the corner, no further than a millimetre: with thick boards the case's corners
      // stand well beyond the block, and a headband wider than the block would read as one.
      // Shut, into the case's side wall (its inside: the outer sheet's half, the board less the
      // covering, past the sheet's root) and half its radius on, its ends hidden in the
      // covering: it meets the case at the shoulders. Open, the block leaves the case (the
      // headband is glued to the block, not the case) and it ends at the block's sides, cut
      // flat. (Until 1.1.0 it stopped in the corners, a millimetre at most, closed there with
      // round caps: "a pill", the author.)
      const shut = scene.closed * scene.closed * (3 - 2 * scene.closed);
      const reach = (t) => t / 2 + shut * (m.thickness[0] - CASE_COVER_MM + HEADBAND.beadRadius / 2);
      beadPath.unshift(beadPath[0].clone().addScaledVector(a, -reach(m.thickness[1] ?? 0)));
      beadPath.push(beadPath[beadPath.length - 1].clone().addScaledVector(a, reach(m.thickness[m.leafCount - 2] ?? 0)));
    }
    // Rebuilt only when the spine moved (a page turning over the block leaves it as it is).
    const along = beadPath.flatMap((q) => [q.x, q.y]);
    for (const band of ex.headbands) {
      const { tail, sgn, z, ends } = band.userData;
      band.visible = tail.visible = ends[0].visible = ends[1].visible = beadPath.length >= 2;
      if (!band.visible) continue;
      const was = band.userData.along;
      if (was && was.length === along.length && was.every((v, k) => v === along[k])) continue;
      band.userData.along = along;
      const curve = new THREE.CatmullRomCurve3(beadPath.map((q) => new THREE.Vector3(q.x, q.y, z)));
      band.geometry.dispose();
      band.geometry = new THREE.TubeGeometry(curve, Math.max(4, beadPath.length * 2), HEADBAND.beadRadius, 10, false);
      for (const [end, t, out] of [[ends[0], 0, -1], [ends[1], 1, 1]]) {
        end.position.copy(curve.getPoint(t));
        end.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangent(t).multiplyScalar(out)); // (a circle faces +z)
      }
      tail.geometry.dispose();
      tail.geometry = tailGeometry(tailPath, z, z - sgn * HEADBAND.tailLength);
    }
  }
  if (ex.coil) {
    const c = coilCentre(m, scene.closed, scene.closedSide);
    ex.coil.position.set(c.x, c.y, 0);
  }
  layoutContact(scene);
  // A closed coil book rests on its coil at the spine and on its fore-edge: tilted about
  // the fore-edge's lower corner.
  const sc = scene.closed * scene.closed * (3 - 2 * scene.closed); // as the coil moves (model.js)
  const lift = (m.closedLift ?? 0) * sc;
  const tilt = -scene.closedSide * Math.atan2(lift, m.width);
  const pivot = new THREE.Vector3(scene.closedSide * m.width, m.ground, 0);
  scene.block.rotation.set(0, 0, tilt);
  scene.block.position.copy(pivot).sub(pivot.clone().applyEuler(scene.block.rotation));
  if (ex.threads) {
    for (const g of ex.threads) {
      const c = g.userData.centre;
      const a = scene.leaves[c - 1].profile;
      const b = scene.leaves[c].profile;
      g.position.set((a.x[1] + b.x[1]) / 2, (a.y[1] + b.y[1]) / 2, 0);
      g.visible = scene.closed < 0.5;
    }
  }
}

/**
 * The contact shadow's footprint: wherever the leaves lie low, plus a soft margin. Every
 * leaf counts, turning or not, up to where it rises past the block's height (found
 * between samples, so the footprint follows a lifting pile smoothly; leaving turning
 * leaves out made it snap to a sliver when a whole pile swung over to close).
 */
function layoutContact(scene) {
  const m = scene.model;
  const top = m.ground + m.total + 3;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const leaf of scene.leaves) {
    const { x, y } = leaf.profile;
    for (let k = 0; k < x.length; k++) {
      if (y[k] <= top) {
        x0 = Math.min(x0, x[k]);
        x1 = Math.max(x1, x[k]);
      }
      if (k > 0 && (y[k] <= top) !== (y[k - 1] <= top)) {
        const t = (top - y[k - 1]) / (y[k] - y[k - 1]);
        const xc = x[k - 1] + (x[k] - x[k - 1]) * t;
        x0 = Math.min(x0, xc);
        x1 = Math.max(x1, xc);
      }
    }
  }
  if (!Number.isFinite(x0)) return;
  // The map's soft edge is a fixed share of the plane: a margin of 8 mm around the book.
  const margin = 8;
  const p = scene.block.localToWorld(new THREE.Vector3((x0 + x1) / 2, m.ground, 0));
  scene.contact.position.set(p.x, m.ground - 0.03, p.z);
  scene.contact.scale.set(x1 - x0 + 2 * margin, 1, m.height + 2 * margin);
}

export function layoutGround(scene) {
  const m = scene.model;
  const size = Math.max(m.width, m.height) * 10;
  scene.ground.scale.set(size, 1, size);
  scene.ground.position.y = m.ground - 0.05;
}

/** A staple's wire along a path in its own plane (z along the spine, y out of the paper),
 * corners rounded as wire bends; flattened cross-section, closed ends. */
function stapleGeometry(points, BEND = 0.45) {
  const path = [];
  for (let i = 0; i < points.length; i++) {
    const [pz, py] = points[i];
    if (i === 0 || i === points.length - 1) {
      path.push(new THREE.Vector2(pz, py));
      continue;
    }
    const prev = new THREE.Vector2(...points[i - 1]);
    const here = new THREE.Vector2(pz, py);
    const next = new THREE.Vector2(...points[i + 1]);
    const a = prev.clone().sub(here).normalize();
    const b = next.clone().sub(here).normalize();
    const p0 = here.clone().addScaledVector(a, BEND);
    const p1 = here.clone().addScaledVector(b, BEND);
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      // Quadratic from p0 through the corner to p1: a rounded bend.
      path.push(p0.clone().multiplyScalar((1 - t) ** 2).addScaledVector(here, 2 * t * (1 - t)).addScaledVector(p1, t * t));
    }
  }
  // Cross-section: a rounded rectangle, wider across the spine (x) than thick (y).
  const ring = [];
  const W = STAPLE.width / 2;
  const T = STAPLE.thickness / 2;
  const rr = Math.min(W, T) * 0.8;
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    const sx = Math.sign(cx) * (W - rr) + cx * rr;
    const sy = Math.sign(cy) * (T - rr) + cy * rr;
    ring.push([sx, sy]);
  }
  const pos = [];
  const idx = [];
  for (let i = 0; i < path.length; i++) {
    const t = (i < path.length - 1 ? path[i + 1].clone().sub(path[i]) : path[i].clone().sub(path[i - 1])).normalize();
    const nrm = new THREE.Vector2(-t.y, t.x); // in the staple's plane, across the wire
    for (const [sx, sy] of ring) {
      // x across the spine; the wire's thickness along nrm (in the z-y plane).
      pos.push(sx, path[i].y + nrm.y * sy, path[i].x + nrm.x * sy);
    }
  }
  const m = ring.length;
  for (let i = 0; i < path.length - 1; i++) {
    for (let k = 0; k < m; k++) {
      const a = i * m + k;
      const b = i * m + ((k + 1) % m);
      idx.push(a, b, a + m, b, b + m, a + m); // facing out of the wire
    }
  }
  // Flat cut ends, with vertices of their own (shared ones would shade them as cones).
  for (const { end, flip } of [{ end: 0, flip: true }, { end: path.length - 1, flip: false }]) {
    const c = pos.length / 3;
    pos.push(0, path[end].y, path[end].x);
    for (let k = 0; k < m; k++) pos.push(pos[3 * (end * m + k)], pos[3 * (end * m + k) + 1], pos[3 * (end * m + k) + 2]);
    for (let k = 0; k < m; k++) {
      const a = c + 1 + k;
      const b = c + 1 + ((k + 1) % m);
      idx.push(...(flip ? [c, b, a] : [c, a, b]));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Folded sheets, one mesh: `pairs` the sheets' halves, [first leaf, last]. Two materials (and
 * two draws, however many sheets): the cover's fold, when the first pair is the cover's, and
 * the pages' (see foldSheetMaterial; the geometry's groups, see writeFoldGeometry).
 */
function foldMesh(scene, pairs) {
  const geo = new THREE.BufferGeometry();
  geo.userData.pairs = pairs;
  return new THREE.Mesh(geo, [foldSheetMaterial(scene, true), foldSheetMaterial(scene, false)]);
}

/**
 * A folded sheet's fold (stitched and sewn books), printed: its two halves' page images where
 * the fold takes them (the strip of each page from its root to the fold's apex, the uStart
 * leafShape gives them), read from the page array by folio (its halves' leaves come with the
 * vertex, `foldPair`). Per vertex (`fold`): x where across the page, negative on the first
 * half (leaf `a`, root to apex), positive on the second (leaf `b`, apex to root); y down it (0
 * at the head); z the surface: 0 the outside (a's front, b's back: a booklet's cover round its
 * spine), 1 the inside (a's back, b's front: the centre spread running into the fold), 2 the
 * cut at head and foot (the ink at the page's edge, both sides, as a leaf's cut shows it, see
 * EDGE_INK). Page images are stored as sRGB (see PAGE_COLOR_SPACE in scene.js): decoded here
 * as the pages do. `cover`: the cover's fold (its stock and edge colour, syncFoldStock), else
 * the pages'. (Until 1.1 only a booklet's cover was printed round its fold; every other fold
 * was blank paper, at the centre spreads and at the cut: "print not all the way to the
 * spine", the designer, 2026-10-22.)
 */
function foldSheetMaterial(scene, cover) {
  const m = new THREE.MeshPhysicalMaterial({ roughness: 0.8, side: THREE.DoubleSide });
  m.userData.uniforms = { uFoldEdge: { value: new THREE.Color() } };
  m.userData.foldCover = cover;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, m.userData.uniforms);
    inkUniforms(shader, scene.shared);
    pageDataUniforms(shader, scene.shared);
    shader.vertexShader = patchShader(shader.vertexShader, [
      ["void main() {", "attribute vec3 fold;\nattribute vec2 foldPair;\nvarying vec3 vFold;\nflat varying vec2 vFoldPair;\nvoid main() {\n  vFold = fold;\n  vFoldPair = foldPair;"],
    ]);
    shader.fragmentShader = patchShader(shader.fragmentShader, [
      ["void main() {", FOLD_FRAGMENT_HEADER + "void main() {"],
      ["#include <map_fragment>", FOLD_INK],
      ["#include <roughnessmap_fragment>", (line) => line + "\n  if ( vFold.z > 1.5 ) roughnessFactor = 1.0;"],
    ]);
  };
  m.customProgramCacheKey = () => "bookview-fold-sheet";
  m.userData.disposable = true; // the scene's own (see BookScene's dispose)
  return m;
}

const FOLD_FRAGMENT_HEADER = /* glsl */ `
${INK_GLSL}
${PAGE_DATA_GLSL}
uniform vec2 uPageSize;
uniform vec3 uFoldEdge;
varying vec3 vFold;
flat varying vec2 vFoldPair;
const float PV_FOLD_INSET_MM = ${EDGE_INSET_MM.toFixed(2)};
const float PV_FOLD_INK = ${EDGE_INK_SHARE.toFixed(2)};
`;
// All four read every time: a texture read in a branch has no derivatives to pick its level by.
const FOLD_INK = /* glsl */ `
  {
    bool first = vFold.x < 0.0;
    vec2 inset = vec2( PV_FOLD_INSET_MM ) / uPageSize;
    vec2 at = clamp( vec2( abs( vFold.x ), vFold.y ), inset, 1.0 - inset );
    vec2 mirrored = vec2( 1.0 - at.x, at.y );
    int frontA = 2 * int( vFoldPair.x + 0.5 ) + 1;
    int frontB = 2 * int( vFoldPair.y + 0.5 ) + 1;
    vec4 pFA = pvPageTexel( frontA, 0 );
    vec4 pBA = pvPageTexel( frontA + 1, 0 );
    vec4 pFB = pvPageTexel( frontB, 0 );
    vec4 pBB = pvPageTexel( frontB + 1, 0 );
    vec4 inkFrontA = sRGBTransferEOTF( pvPageColor( pvImageAt( pFA.x, pFA.zw, at ), pvSpotsAt( pFA.y, pFA.zw, at ), pvSpotInk( frontA ) ) );
    vec4 inkBackA = sRGBTransferEOTF( pvPageColor( pvImageAt( pBA.x, pBA.zw, mirrored ), pvSpotsAt( pBA.y, pBA.zw, mirrored ), pvSpotInk( frontA + 1 ) ) );
    vec4 inkFrontB = sRGBTransferEOTF( pvPageColor( pvImageAt( pFB.x, pFB.zw, at ), pvSpotsAt( pFB.y, pFB.zw, at ), pvSpotInk( frontB ) ) );
    vec4 inkBackB = sRGBTransferEOTF( pvPageColor( pvImageAt( pBB.x, pBB.zw, mirrored ), pvSpotsAt( pBB.y, pBB.zw, mirrored ), pvSpotInk( frontB + 1 ) ) );
    if ( vFold.z > 1.5 ) {
      vec3 ink = 0.5 * ( first ? inkFrontA.rgb + inkBackA.rgb : inkFrontB.rgb + inkBackB.rgb );
      diffuseColor.rgb = uFoldEdge * mix( vec3( 1.0 ), ink, PV_FOLD_INK );
    } else {
      bool inside = vFold.z > 0.5;
      diffuseColor *= first ? ( inside ? inkBackA : inkFrontA ) : ( inside ? inkFrontB : inkBackB );
    }
  }
`;

/** The folds take their stock as the pages (and the cover) have it now, and the cut edges' colour (see setPaper). */
export function syncFoldStock(scene) {
  for (const mesh of [scene.extras?.fold, scene.extras?.signatureFolds]) {
    if (!mesh) continue;
    for (const m of /** @type {THREE.MeshPhysicalMaterial[]} */ (mesh.material)) {
      const cover = m.userData.foldCover;
      const stock = cover ? scene.paper.cover : scene.paper;
      m.color.set(stock.color);
      m.roughness = stock.roughness;
      m.specularIntensity = stock.specular ?? 0.2;
      m.clearcoat = Math.max(0.001, stock.clearcoat); // as the pages' (see setPaper)
      m.clearcoatRoughness = 0.3;
      m.userData.uniforms.uFoldEdge.value.copy((cover ? scene.coverEdgeMat : scene.edgeMat).color);
    }
  }
}

/**
 * A fold mesh's groups and its sheets' halves per vertex: the first pair's fold in the cover's
 * material (group 0) when that pair is the cover's, every other in the pages' (group 1), one
 * draw each; `foldPair`: each vertex's pair, [first leaf, last] (see foldSheetMaterial).
 */
function foldGroups(geo, pairs, SHEET, SEGS) {
  geo.clearGroups();
  const coverFirst = pairs.length > 0 && pairs[0][0] === 0;
  if (coverFirst) geo.addGroup(0, 24 * SEGS, 0);
  const from = coverFirst ? 1 : 0;
  if (pairs.length > from) geo.addGroup(from * 24 * SEGS, (pairs.length - from) * 24 * SEGS, 1);
  const pair = new Float32Array(pairs.length * SHEET * 2);
  pairs.forEach(([a, b], k) => {
    for (let v = 0; v < SHEET; v++) pair.set([a, b], (k * SHEET + v) * 2);
  });
  geo.setAttribute("foldPair", new THREE.BufferAttribute(pair, 2));
}

/** Across the page at a fold's point j of `segs` (see foldSheetMaterial): `us` the page's share it takes. */
const foldU = (j, segs, us) => (2 * j < segs ? -us * (1 - (2 * j) / segs) : us * ((2 * j) / segs - 1));

/**
 * Saddle stitch: each sheet is one piece of paper folded round the ones inside it. Its two
 * halves are leaves k and n - 1 - k; between their roots it bends in a U, leaving each
 * root in the direction that leaf starts in, so the paper runs on without a kink. Built as
 * one mesh: outside, inside and the cut edges at head and foot of every sheet's fold, a
 * material group a sheet (see foldSheetMaterial). Returns the outside of the cover's fold and
 * the inside of the centre sheet's, at their middle (for the staples' crowns and legs).
 */
function writeFoldGeometry(geo, leaves, book) {
  const SEGS = 32;
  const ROW = SEGS + 1;
  const SHEET = 8 * ROW; // vertices: four strips of two rows each
  const h2 = book.height / 2;
  const n = leaves.length;
  const sheets = Math.floor(n / 2);
  // The mesh is the same every frame but for where the folds are: built once, then only the
  // folds whose roots moved are written again, in place (a page turn moves one; all of them
  // rebuilt every frame were most of a stitched book's frame).
  let fold = geo.userData.fold;
  if (fold?.sheets !== sheets) {
    geo.dispose();
    const index = [];
    for (let k = 0; k < sheets; k++) {
      for (let st = 0; st < 4; st++) {
        const base = k * SHEET + st * 2 * ROW;
        for (let j = 0; j < SEGS; j++) {
          const v = base + 2 * j;
          index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
        }
      }
    }
    foldGroups(geo, geo.userData.pairs, SHEET, SEGS);
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(sheets * SHEET * 3), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(sheets * SHEET * 3), 3));
    geo.setAttribute("fold", new THREE.BufferAttribute(new Float32Array(sheets * SHEET * 3), 3)); // see foldSheetMaterial
    geo.setIndex(index);
    fold = geo.userData.fold = { sheets, roots: new Float64Array(6 * sheets).fill(NaN), box: new Float64Array(4 * sheets), apex: [], xs: new Float64Array(ROW), ys: new Float64Array(ROW), nx: new Float64Array(ROW), ny: new Float64Array(ROW) };
  }
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const fl = geo.attributes.fold;
  const { xs, ys, nx: NX, ny: NY } = fold;
  // Two rows of vertices along the fold at heights za and zb (`side`: 1 the outside surface,
  // -1 the inside), quads between them, wound so their front faces the given normal (`nz`
  // for head and foot, else the surface's own): double-sided materials light by winding.
  // Their place on the pages: `kind` and `us` (see foldSheetMaterial).
  const strip = (base, sa, za, sb, zb, nz, flip, kind, us) => {
    const ax = (j, sd) => xs[j] + NX[j] * sd;
    const ay = (j, sd) => ys[j] + NY[j] * sd;
    const e1 = [ax(0, sb) - ax(0, sa), ay(0, sb) - ay(0, sa), zb - za];
    const e2 = [ax(1, sa) - ax(0, sa), ay(1, sa) - ay(0, sa), 0];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    const n0 = nz ? [0, 0, nz] : [NX[0] * flip, NY[0] * flip, 0];
    const swap = cx * n0[0] + cy * n0[1] + cz * n0[2] < 0;
    for (let j = 0; j <= SEGS; j++) {
      const v = base + 2 * j;
      const [s0, z0, s1, z1] = swap ? [sb, zb, sa, za] : [sa, za, sb, zb];
      pos.setXYZ(v, ax(j, s0), ay(j, s0), z0);
      pos.setXYZ(v + 1, ax(j, s1), ay(j, s1), z1);
      const mx = nz ? 0 : NX[j] * flip;
      const my = nz ? 0 : NY[j] * flip;
      nor.setXYZ(v, mx, my, nz);
      nor.setXYZ(v + 1, mx, my, nz);
      fl.setXYZ(v, foldU(j, SEGS, us), (z0 + h2) / (2 * h2), kind);
      fl.setXYZ(v + 1, foldU(j, SEGS, us), (z1 + h2) / (2 * h2), kind);
    }
  };
  let first = -1;
  let last = -1;
  for (let k = 0; k < sheets; k++) {
    const pa = leaves[k].profile;
    const pb = leaves[n - 1 - k].profile;
    const roots = [pa.x[0], pa.y[0], pa.phi[0], pb.x[0], pb.y[0], pb.phi[0]];
    if (roots.every((v, i) => v === fold.roots[6 * k + i])) continue;
    fold.roots.set(roots, 6 * k);
    if (first < 0) first = k;
    last = k;
    const P = { x: pa.x[0], y: pa.y[0] };
    const Q = { x: pb.x[0], y: pb.y[0] };
    // Each root continues backwards out of its leaf: the cubic's handles.
    const dP = { x: -Math.sin(pa.phi[0]), y: -Math.cos(pa.phi[0]) };
    const dQ = { x: -Math.sin(pb.phi[0]), y: -Math.cos(pb.phi[0]) };
    const L = 0.66 * Math.max(1e-4, Math.hypot(Q.x - P.x, Q.y - P.y));
    const c1 = { x: P.x + dP.x * L, y: P.y + dP.y * L };
    const c2 = { x: Q.x + dQ.x * L, y: Q.y + dQ.y * L };
    const half = book.thickness[k] * LEAF_FILL / 2;
    // The side facing leaf k's front at P: its front normal there.
    const frontP = { x: -Math.cos(pa.phi[0]), y: Math.sin(pa.phi[0]) };
    let sign = 0;
    for (let j = 0; j <= SEGS; j++) {
      const t = j / SEGS;
      const u = 1 - t;
      xs[j] = u * u * u * P.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * Q.x;
      ys[j] = u * u * u * P.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * Q.y;
      let tx = 3 * u * u * (c1.x - P.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (Q.x - c2.x);
      let ty = 3 * u * u * (c1.y - P.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (Q.y - c2.y);
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      if (!sign) sign = -ty * frontP.x + tx * frontP.y >= 0 ? 1 : -1;
      NX[j] = -ty * sign;
      NY[j] = tx * sign;
    }
    // On the paper's surface (the staple sinks in by its own design), with the normal
    // pointing out of the paper: the outside at the cover, the inside at the centre sheet.
    const m = SEGS / 2;
    fold.apex[k] = {
      outer: { x: xs[m] + NX[m] * half, y: ys[m] + NY[m] * half, nx: NX[m], ny: NY[m] },
      inner: { x: xs[m] - NX[m] * half, y: ys[m] - NY[m] * half, nx: -NX[m], ny: -NY[m] },
    };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let j = 0; j <= SEGS; j++) {
      x0 = Math.min(x0, xs[j] - half); x1 = Math.max(x1, xs[j] + half);
      y0 = Math.min(y0, ys[j] - half); y1 = Math.max(y1, ys[j] + half);
    }
    fold.box.set([x0, y0, x1, y1], 4 * k);
    const base = k * SHEET;
    const us = leafShape(book, k).uStart / book.width;
    strip(base, half, -h2, half, h2, 0, 1, 0, us); // outside
    strip(base + 2 * ROW, -half, h2, -half, -h2, 0, -1, 1, us); // inside
    strip(base + 4 * ROW, -half, -h2, half, -h2, -1, 1, 2, us); // head
    strip(base + 6 * ROW, half, h2, -half, h2, 1, 1, 2, us); // foot
  }
  if (first >= 0) {
    const from = first * SHEET * 3;
    const count = (last - first + 1) * SHEET * 3;
    for (const attr of [pos, nor, fl]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(from, count);
      attr.needsUpdate = true;
    }
    // Round every fold's box (three sorts by it each frame, and picks by it).
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < sheets; k++) {
      x0 = Math.min(x0, fold.box[4 * k]); y0 = Math.min(y0, fold.box[4 * k + 1]);
      x1 = Math.max(x1, fold.box[4 * k + 2]); y1 = Math.max(y1, fold.box[4 * k + 3]);
    }
    const sphere = (geo.boundingSphere ??= new THREE.Sphere());
    sphere.center.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
    sphere.radius = Math.hypot(x1 - x0, y1 - y0, 2 * h2) / 2;
  }
  const none = { x: 0, y: book.ground, nx: 0, ny: -1 };
  return { outerApex: fold.apex[0]?.outer ?? none, innerApex: fold.apex[sheets - 1]?.inner ?? none };
}

/**
 * A hardcover's headband (mm): a cord with cloth sewn round it, glued across the block's
 * spine at head and foot. The cord, the bead, lies on the signatures' folds (its centre a
 * radius past them: it touches them, `beadOut`) at the cut edge, its centre `beadDrop`
 * radii inside the edge, so most of it stands proud of the cut as a headband's does. The
 * cloth tail is glued down the spine from there, `tailLength` long, `tailLift` off the
 * folds. The case's hollow leaves the bead room (CASE_HOLLOW). (Until 0.17.83 the bead's
 * centre was half a radius past the folds and a fifth of a radius beyond the cut: it hung in
 * the hollow, clear of the block.)
 */
const HEADBAND = { beadRadius: CASE_HOLLOW / 2 - 0.02, beadDrop: 0.3, beadOut: 1, tailLength: 12, tailLift: 0.06 };

/** The headband's tail: a strip along `path` (the spine's width) from z0 to z1. */
function tailGeometry(path, z0, z1) {
  const pos = [];
  const index = [];
  for (const [k, q] of path.entries()) {
    pos.push(q.x, q.y, z0, q.x, q.y, z1);
    if (k) index.push(2 * k - 2, 2 * k - 1, 2 * k, 2 * k, 2 * k - 1, 2 * k + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/**
 * The folds of a sewn block's signatures (see makeSignatureFolds): for every sheet, a half
 * circle from its first leaf's root to its last's, bulging `out` (away from the pages) by
 * half the distance between them, as thick as the sheet; nested within a signature, since
 * the sheets' roots lie in order along the spine. Written again only for sheets whose roots
 * moved (a page turn moves none; opening and closing move them all).
 * @param {THREE.BufferGeometry} geo
 * @param {{profile: import("./model.js").Profile}[]} leaves
 * @param {import("./model.js").Book} book
 * @param {THREE.Vector2} out
 */
function writeSignatureFolds(geo, leaves, book, out) {
  const SEGS = 12;
  const ROW = SEGS + 1;
  const SHEET = 8 * ROW; // vertices: four strips (outside, inside, head, foot) of two rows
  const h2 = book.height / 2;
  const pairs = signatureSheets(book);
  let folds = geo.userData.folds;
  if (folds?.count !== pairs.length) {
    geo.dispose();
    const index = [];
    for (let s = 0; s < pairs.length; s++) {
      for (let st = 0; st < 4; st++) {
        const base = s * SHEET + st * 2 * ROW;
        for (let j = 0; j < SEGS; j++) {
          const v = base + 2 * j;
          index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
        }
      }
    }
    foldGroups(geo, pairs, SHEET, SEGS);
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs.length * SHEET * 3), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(pairs.length * SHEET * 3), 3));
    geo.setAttribute("fold", new THREE.BufferAttribute(new Float32Array(pairs.length * SHEET * 3), 3)); // see foldSheetMaterial
    geo.setIndex(index);
    folds = geo.userData.folds = { count: pairs.length, roots: new Float64Array(6 * pairs.length).fill(NaN) };
  }
  const pos = /** @type {THREE.BufferAttribute} */ (geo.attributes.position);
  const nor = /** @type {THREE.BufferAttribute} */ (geo.attributes.normal);
  const fl = /** @type {THREE.BufferAttribute} */ (geo.attributes.fold);
  let first = -1;
  let last = -1;
  // Two rows of vertices along a half circle (radius r, centre c, from -e to e through
  // `out`) at offsets sa and sb from it and heights za and zb; quads between them, wound so
  // their front faces `nz` (head and foot) or the surface's own normal, outward (flip 1) or
  // inward (-1): double-sided materials light by winding. Their place on the pages: `kind`
  // and `us` (see foldSheetMaterial).
  const strip = (base, c, e, r, sa, za, sb, zb, nz, flip, kind, us) => {
    const at = (j, sd) => {
      const t = (j / SEGS) * Math.PI;
      const ux = -e.x * Math.cos(t) + out.x * Math.sin(t);
      const uy = -e.y * Math.cos(t) + out.y * Math.sin(t);
      return [c.x + ux * (r + sd), c.y + uy * (r + sd), ux, uy];
    };
    const [p0x, p0y] = at(0, sa);
    const [p1x, p1y] = at(0, sb);
    const [p2x, p2y] = at(1, sa);
    const e1 = [p1x - p0x, p1y - p0y, zb - za];
    const e2 = [p2x - p0x, p2y - p0y, 0];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    const [, , u0x, u0y] = at(0, 0);
    const n0 = nz ? [0, 0, nz] : [u0x * flip, u0y * flip, 0];
    const swap = cx * n0[0] + cy * n0[1] + cz * n0[2] < 0;
    for (let j = 0; j <= SEGS; j++) {
      const v = base + 2 * j;
      const [s0, z0, s1, z1] = swap ? [sb, zb, sa, za] : [sa, za, sb, zb];
      const [ax, ay, ux, uy] = at(j, s0);
      const [bx, by] = at(j, s1);
      pos.setXYZ(v, ax, ay, z0);
      pos.setXYZ(v + 1, bx, by, z1);
      nor.setXYZ(v, nz ? 0 : ux * flip, nz ? 0 : uy * flip, nz);
      nor.setXYZ(v + 1, nz ? 0 : ux * flip, nz ? 0 : uy * flip, nz);
      fl.setXYZ(v, foldU(j, SEGS, us), (z0 + h2) / (2 * h2), kind);
      fl.setXYZ(v + 1, foldU(j, SEGS, us), (z1 + h2) / (2 * h2), kind);
    }
  };
  for (let s = 0; s < pairs.length; s++) {
    const [i, k] = pairs[s];
    const pa = leaves[i].profile;
    const pb = leaves[k].profile;
    const roots = [pa.x[0], pa.y[0], pb.x[0], pb.y[0], out.x, out.y];
    if (roots.every((v, q) => v === folds.roots[6 * s + q])) continue;
    folds.roots.set(roots, 6 * s);
    if (first < 0) first = s;
    last = s;
    const c = { x: (pa.x[0] + pb.x[0]) / 2, y: (pa.y[0] + pb.y[0]) / 2 };
    const dx = pb.x[0] - pa.x[0];
    const dy = pb.y[0] - pa.y[0];
    const d = Math.hypot(dx, dy) || 1e-4;
    const e = { x: dx / d, y: dy / d };
    const r = d / 2;
    const half = Math.min(r, book.thickness[i] * LEAF_FILL / 2);
    const base = s * SHEET;
    const us = leafShape(book, i).uStart / book.width;
    strip(base, c, e, r, half, -h2, half, h2, 0, 1, 0, us); // outside
    strip(base + 2 * ROW, c, e, r, -half, h2, -half, -h2, 0, -1, 1, us); // inside
    strip(base + 4 * ROW, c, e, r, -half, -h2, half, -h2, -1, 1, 2, us); // head
    strip(base + 6 * ROW, c, e, r, half, h2, -half, h2, 1, 1, 2, us); // foot
  }
  if (first >= 0) {
    const from = first * SHEET * 3;
    const count = (last - first + 1) * SHEET * 3;
    for (const attr of [pos, nor, fl]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(from, count);
      attr.needsUpdate = true;
    }
  }
}

/**
 * A hardcover's spine, square back: the covering from the front board's spine edge across
 * the joint (a groove pressed into its outside), round a square corner, flat across the
 * spine board (as wide as the block and both boards), round the other corner, and across
 * the other joint to the back board. As thick as the boards. Outside: the spine artwork,
 * mapped across the flat spine (u from the front cover's side, v from the head); the
 * the joints take the covers' spine-edge colours. pa, pb: the boards; pl, ph: the block's
 * first and last sheets (their roots are the block's spine). Material groups: 0 outside, 1
 * inside (the joints), 2 the cut edges at head and foot, 3 the front joint's outside, 4
 * the back's, 5 the spine panel's inside (kraft lining).
 */
function writeCaseSpine(geo, pa, pb, pl, ph, book, height, closedFraction = 0) {
  const tb = book.thickness[0];
  const tc = CASE_COVER_MM; // the covering over a thin spine board, flush with the boards' outsides;
  // between it and the block's spine, the hollow.
  const n = book.leafCount;
  // The block's spine: along the line of the roots, outward away from the pages.
  const Pl = { x: pl.x[0], y: pl.y[0] };
  const Ph = { x: ph.x[0], y: ph.y[0] };
  let ax = Ph.x - Pl.x;
  let ay = Ph.y - Pl.y;
  const al = Math.hypot(ax, ay) || 1;
  ax /= al;
  ay /= al;
  let ox = -ay;
  let oy = ax;
  if (ox * Math.sin(pl.phi[0]) + oy * Math.cos(pl.phi[0]) > 0) {
    ox = -ox;
    oy = -oy;
  }
  // The spine board's centre line. Across: past the block by the boards' thickness on
  // either side (flush with the boards' outer faces). Behind the block: the signatures'
  // folds, the hollow the headbands sit in, and half the covering, whatever the boards
  // (tied to the boards, 5 mm boards left a 2 mm gap the headband hung in).
  const tl = book.thickness[1] ?? 0;
  const th = book.thickness[n - 2] ?? 0;
  const wide = (t) => t / 2 + tb - tc / 2;
  const back = book.foldDepth + CASE_HOLLOW + tc / 2;
  const C1 = { x: Pl.x - ax * wide(tl) + ox * back, y: Pl.y - ay * wide(tl) + oy * back };
  const C2 = { x: Ph.x + ax * wide(th) + ox * back, y: Ph.y + ay * wide(th) + oy * back };
  // Each end: at the board's spine edge, its outside 0.02 mm below the board's face (some ten
  // times what the depth buffer tells apart up close). (Until 1.1.0 it began 0.6 mm in on the
  // board with its outside in the board's face itself: two surfaces in one plane along every
  // board's spine edge, the cover's artwork serrated where they fought, the author's view
  // report; and with the rolled ends below, that overlap stood out of the board's own roll.)
  const end = (p, outSign) => {
    const at = (tb - tc) / 2 - 0.02;
    return { x: p.x[0] - Math.cos(p.phi[0]) * outSign * at, y: p.y[0] + Math.sin(p.phi[0]) * outSign * at };
  };
  const A = end(pa, 1); // the front board's outside is its front
  const B = end(pb, -1); // the back board's, its back
  // Straight runs with square corners, just rounded (quadratic, radius R on the centre
  // line: a millimetre and a bit on the outside).
  const R = tc / 2 + 0.15;
  const corners = [A, C1, C2, B];
  const pts = [];
  const push = (q, groove) => pts.push({ x: q.x, y: q.y, groove });
  const GROOVE = 0.5; // mm pressed in, at the board's edge
  const joint = (from, to, reverse) => {
    const run = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      run.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, groove: GROOVE * Math.sin(Math.PI * Math.min(1, t / 0.75)) });
    }
    return reverse ? run.reverse() : run;
  };
  const trimmed = (P0, V, P1) => {
    const d0x = V.x - P0.x;
    const d0y = V.y - P0.y;
    const d1x = P1.x - V.x;
    const d1y = P1.y - V.y;
    const l0 = Math.hypot(d0x, d0y) || 1;
    const l1 = Math.hypot(d1x, d1y) || 1;
    const turn = Math.acos(Math.max(-1, Math.min(1, (d0x * d1x + d0y * d1y) / (l0 * l1))));
    const cut = Math.min(R * Math.tan(turn / 2), l0 * 0.45, l1 * 0.45);
    return {
      a: { x: V.x - (d0x / l0) * cut, y: V.y - (d0y / l0) * cut },
      b: { x: V.x + (d1x / l1) * cut, y: V.y + (d1y / l1) * cut },
    };
  };
  const k1 = trimmed(corners[0], C1, C2);
  const k2 = trimmed(C1, C2, corners[3]);
  const bend = (k, V) => {
    for (let j = 1; j < 8; j++) {
      const t = j / 8;
      const u = 1 - t;
      push({ x: u * u * k.a.x + 2 * u * t * V.x + t * t * k.b.x, y: u * u * k.a.y + 2 * u * t * V.y + t * t * k.b.y }, 0);
    }
  };
  for (const q of joint(A, k1.a, false)) push(q, q.groove);
  bend(k1, C1);
  const panelFrom = pts.length;
  // The spine panel: flat across a square back; round a rounded one (closing: the arc the
  // block's spine bulges by, `round`, the hollow kept), bulging outward.
  const bulge = book.round * closedFraction;
  const chord = Math.hypot(k2.a.x - k1.b.x, k2.a.y - k1.b.y) || 1;
  const Rb = bulge ? (chord * chord / 4 + bulge * bulge) / (2 * bulge) : 0;
  for (let j = 0; j <= 16; j++) {
    const t = j / 16;
    const sag = bulge ? Math.sqrt(Math.max(0, Rb * Rb - (chord * (t - 0.5)) ** 2)) - (Rb - bulge) : 0;
    push({ x: k1.b.x + (k2.a.x - k1.b.x) * t + ox * sag, y: k1.b.y + (k2.a.y - k1.b.y) * t + oy * sag }, 0);
  }
  const panelTo = pts.length - 1;
  bend(k2, C2);
  for (const q of joint(B, k2.b, true)) push(q, q.groove);
  for (let j = 0; j < pts.length; j++) {
    const a = pts[Math.max(0, j - 1)];
    const b = pts[Math.min(pts.length - 1, j + 1)];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    pts[j].tx = (b.x - a.x) / l;
    pts[j].ty = (b.y - a.y) / l;
  }
  const SEGS = pts.length - 1;
  // Outward: away from the block.
  const mid = pts[Math.round((panelFrom + panelTo) / 2)];
  const sign = -mid.ty * ox + mid.tx * oy >= 0 ? 1 : -1;
  const len = [0];
  for (let j = 1; j <= SEGS; j++) len.push(len[j - 1] + Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y));
  // Its outside's lengths (mm, along the centre line): each joint's run, and all of it.
  geo.userData.lengths = { front: len[10], back: len[SEGS] - len[SEGS - 10], all: len[SEGS] };
  const h2 = height / 2;
  const pos = [];
  const nor = [];
  const uv = [];
  const groups = [[], [], [], [], [], []];
  // `group`: the material group, or a function of the segment (the outside: joints apart).
  const strip = (group, rowA, rowB, normal, uvs) => {
    const base = pos.length / 3;
    for (let j = 0; j <= SEGS; j++) {
      pos.push(...rowA[j], ...rowB[j]);
      nor.push(...normal[j], ...normal[j]);
      uv.push(...(uvs ? uvs[j][0] : [0, 0]), ...(uvs ? uvs[j][1] : [0, 0]));
    }
    // Wound to face the normals (double-sided materials light by winding).
    const e1 = [rowB[0][0] - rowA[0][0], rowB[0][1] - rowA[0][1], rowB[0][2] - rowA[0][2]];
    const e2 = [rowA[1][0] - rowA[0][0], rowA[1][1] - rowA[0][1], rowA[1][2] - rowA[0][2]];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const flip = cr[0] * normal[0][0] + cr[1] * normal[0][1] + cr[2] * normal[0][2] < 0;
    for (let j = 0; j < SEGS; j++) {
      const v = base + 2 * j;
      groups[typeof group === "function" ? group(j) : group].push(...(flip ? [v, v + 2, v + 1, v + 2, v + 3, v + 1] : [v, v + 1, v + 2, v + 2, v + 1, v + 3]));
    }
  };
  const JOINT_SEGS = 10; // each joint run is 11 points (see joint)
  // From a case wrap (book.caseWrap) the outside is the wrap's middle from board to board, joints
  // included (its artwork, see caseWrapPages in analysis.js); else the joints take the covers'
  // spine-edge colours and the artwork the spine panel.
  const outsideGroup = book.caseWrap ? () => 0 : (j) => (j < JOINT_SEGS ? 3 : j >= SEGS - JOINT_SEGS ? 4 : 0);
  // The inside: kraft across the panel and round its corners, endpaper across the joints.
  const insideGroup = (j) => (j >= panelFrom - 7 && j < panelTo + 7 ? 5 : 1);
  const outer = [];
  const inner = [];
  const nOut = [];
  const nIn = [];
  for (let j = 0; j <= SEGS; j++) {
    const p = pts[j];
    const nx = -p.ty * sign;
    const ny = p.tx * sign;
    // The groove presses the outside in; the inside stays put. Its walls tilt the normal.
    const slope = (pts[Math.min(SEGS, j + 1)].groove - pts[Math.max(0, j - 1)].groove) /
      ((len[Math.min(SEGS, j + 1)] - len[Math.max(0, j - 1)]) || 1);
    outer.push([p.x + nx * (tc / 2 - p.groove), p.y + ny * (tc / 2 - p.groove)]);
    inner.push([p.x - nx * tc / 2, p.y - ny * tc / 2]);
    const gx = nx + p.tx * slope;
    const gy = ny + p.ty * slope;
    const gl = Math.hypot(gx, gy) || 1;
    nOut.push([gx / gl, gy / gl, 0]);
    nIn.push([-nx, -ny, 0]);
  }
  const at = (row, z) => row.map(([x, y]) => [x, y, z]);
  // The covering rolls over at head and foot (the headcap): the flat run stops half its
  // thickness short of each end, and a half round, outside to inside, closes it, as the
  // boards' edges are rolled (cut square until 1.1.0, its end stood out beside the boards'
  // rolled edges: "the edge meets the spine body incorrectly", the author's view report).
  const roll = tc / 2;
  const hs = h2 - roll;
  // v: 0 at the head of the page (the squares beyond repeat the artwork's edge rows); a case
  // wrap's artwork is the boards' height, squares included.
  const vAtZ = (z) => (book.caseWrap ? (z + h2) / height : (z + book.height / 2) / book.height);
  const vHead = vAtZ(-hs);
  const vFoot = vAtZ(hs);
  // u: across the flat spine, measured on its outside (the corners' outsides included); a case
  // wrap's across the whole outside, from the front board's edge to the back's.
  const u0 = book.caseWrap ? 0 : len[panelFrom] - (R + tc / 2) * 0.5;
  const u1 = book.caseWrap ? len[SEGS] : len[panelTo] + (R + tc / 2) * 0.5;
  const uAt = (j) => Math.min(1, Math.max(0, (len[j] - u0) / ((u1 - u0) || 1)));
  const uvOut = len.map((_, j) => [[uAt(j), vHead], [uAt(j), vFoot]]);
  strip(outsideGroup, at(outer, -hs), at(outer, hs), nOut, uvOut);
  strip(insideGroup, at(inner, hs), at(inner, -hs), nIn);
  // Each end's roll: rows from the outside over the end to the inside, round the middle of the
  // covering's thickness (half of it, the groove's press shared on the way round).
  const ROLL_STEPS = 6;
  for (const zs of [-1, 1]) {
    const rows = [];
    const norms = [];
    for (let k = 0; k <= ROLL_STEPS; k++) {
      const a = (Math.PI * k) / ROLL_STEPS; // 0: the outside, pi: the inside
      const c = Math.cos(a);
      const sn = Math.sin(a);
      rows.push(outer.map(([ox2, oy2], j) => {
        const [ix, iy] = inner[j];
        const mx = (ox2 + ix) / 2;
        const my = (oy2 + iy) / 2;
        return [mx + ((ox2 - ix) / 2) * c, my + ((oy2 - iy) / 2) * c, zs * (hs + roll * sn)];
      }));
      norms.push(nOut.map(([nx, ny]) => [nx * c, ny * c, zs * sn]));
    }
    for (let k = 0; k < ROLL_STEPS; k++) {
      const [a, b] = zs < 0 ? [rows[k + 1], rows[k]] : [rows[k], rows[k + 1]];
      const uvs = len.map((_, j) => [[uAt(j), zs < 0 ? vHead : vFoot], [uAt(j), zs < 0 ? vHead : vFoot]]);
      strip(k < ROLL_STEPS / 2 ? outsideGroup : insideGroup, a, b, (k < ROLL_STEPS / 2 ? norms[k] : norms[k + 1]), uvs);
    }
  }
  commitGeometry(geo, { position: [pos, 3], normal: [nor, 3], uv: [uv, 2] }, groups);
}

/**
 * A mesh rebuilt every frame, into its geometry's own buffers, in place: a new attribute
 * each frame got new graphics memory that three never frees (it grew with every frame of a
 * page turn, staple and case binding). New buffers only when the size changes, the old ones
 * freed. `groups`: per material, the triangles' vertex indices.
 */
function commitGeometry(geo, attributes, groups) {
  const index = groups.flat();
  const fits = geo.index?.count === index.length &&
    Object.entries(attributes).every(([name, [values]]) => geo.getAttribute(name)?.array.length === values.length);
  if (fits) {
    for (const [name, [values]] of Object.entries(attributes)) {
      const attribute = geo.getAttribute(name);
      attribute.array.set(values);
      attribute.needsUpdate = true;
    }
    geo.index.array.set(index);
    geo.index.needsUpdate = true;
  } else {
    geo.dispose(); // frees the old buffers; three makes the new ones on the next draw
    for (const [name, [values, size]] of Object.entries(attributes)) geo.setAttribute(name, new THREE.Float32BufferAttribute(values, size));
    geo.setIndex(index);
  }
  geo.clearGroups();
  let start = 0;
  groups.forEach((list, g) => {
    geo.addGroup(start, list.length, g);
    start += list.length;
  });
  geo.computeBoundingSphere();
}

/** A curve given by its point at each t (0 to 1), for a tube along it. */
function curveOf(point) {
  return new PointCurve(point);
}

class PointCurve extends THREE.Curve {
  constructor(point) {
    super();
    this.point = point;
  }

  getPoint(t, target = new THREE.Vector3()) {
    return this.point(t, target);
  }
}

/** Rounded ends for a wire (a tube is open at both ends). */
function wireEnds(curve, radius, material) {
  const cap = new THREE.SphereGeometry(radius, 14, 10);
  return [0, 1].map((t) => {
    const m = new THREE.Mesh(cap, material);
    m.position.copy(curve.getPoint(t));
    m.castShadow = true;
    return m;
  });
}
