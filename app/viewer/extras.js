// What the binding adds round the leaves, built with the book and laid out with it every
// frame: a glued or sewn spine's slab (and sewing threads), a saddle stitch's folds and
// staples, a case's spine, rounded boards and headbands, a coil; and the contact shadow
// under the book and the table it lies on.

import * as THREE from "three";
import { coilCentre, leafShape } from "./model.js";
import { LEAF_FILL, patchShader } from "./shaders.js";

// Booklet stitching wire (mm): crown width, clinched leg length, flattened cross-section.
const STAPLE = { crown: 12.7, leg: 5.2, width: 0.62, thickness: 0.42 };

const lerp = (a, b, t) => a + (b - a) * t;

export function makeExtras(scene) {
  const group = new THREE.Group();
  scene.block.add(group);
  const { style, height: h } = scene.model;
  const extras = { group };

  if (style.spine === "flat") {
    // Box faces: +x (the back cover's side), -x (the front cover's), +y (against the pages),
    // -y (the spine's outside, v running from head to foot, see layoutExtras), +z and -z
    // (foot and head: cut paper edges).
    const c = scene.coverMat;
    extras.slab = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      [scene.backWrapMat, scene.frontWrapMat, c, scene.spineMat, c, c]);
    extras.slab.castShadow = extras.slab.receiveShadow = true;
    group.add(extras.slab);
    if (scene.model.binding === "sewn") {
      extras.threads = makeThreads(scene, group);
      extras.signatureFolds = makeSignatureFolds(scene, group);
    }
  } else if (style.spine === "fold") {
    // Each sheet folds round the ones inside it: nested U's at the spine, cut paper at head
    // and foot. The cover's outside shows the cover wrapping round the fold: drawn from the
    // front and back cover's own page images, the strips of them the fold takes (leafShape).
    extras.foldCover = foldCoverMaterial(scene);
    extras.fold = new THREE.Mesh(new THREE.BufferGeometry(), [extras.foldCover, scene.coverEdgeMat, scene.edgeMat]);
    // Before each draw, not only when the fold is laid out again: the cover's images arrive later.
    extras.fold.onBeforeRender = () => syncFoldCover(extras.foldCover, scene, scene.model);
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
    extras.caseSpine = new THREE.Mesh(new THREE.BufferGeometry(), [scene.spineMat, scene.liningMat, scene.spineMat]);
    extras.caseSpine.castShadow = extras.caseSpine.receiveShadow = true;
    extras.caseSpine.frustumCulled = false;
    group.add(extras.caseSpine);
    extras.signatureFolds = makeSignatureFolds(scene, group);
    // Each board's covering rolls round its head, foot and fore-edge: rounded edges and
    // corners, as a cased book's are (capsules along the edges, as thick as the board).
    const r = scene.model.thickness[0] / 2; // the boards' thickness
    const faceW = leafShape(scene.model, 0).width;
    const faceH = leafShape(scene.model, 0).height;
    // Rounding the fore-edge corners, stopping short of the joint.
    const along = new THREE.CapsuleGeometry(r, faceW - r, 6, 16);
    const down = new THREE.CapsuleGeometry(r, faceH, 6, 16).rotateX(Math.PI / 2);
    extras.boardEdges = [scene.frontWrapMat, scene.backWrapMat].map((mat) => {
      const g = new THREE.Group();
      const head = new THREE.Mesh(along, mat);
      const foot = new THREE.Mesh(along, mat);
      const fore = new THREE.Mesh(down, mat);
      head.position.z = -faceH / 2;
      foot.position.z = faceH / 2;
      for (const m of [head, foot, fore]) {
        m.castShadow = m.receiveShadow = true;
        g.add(m);
      }
      g.userData = { head, foot, fore, faceW };
      group.add(g);
      return g;
    });
    extras.headbands = [-1, 1].map((sgn) => {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), scene.headbandMat);
      m.castShadow = true;
      m.userData.z = sgn * (h / 2 - 0.75);
      group.add(m);
      return m;
    });
  } else if (style.spine === "coil") {
    extras.coil = makeCoil(scene, style);
    group.add(extras.coil);
  }
  return extras;
}

function makeCoil(scene, style) {
  const { height: h, coilRadius: R, psiFlat } = scene.model;
  const coil = new THREE.Group();
  const loops = Math.max(1, Math.floor((h - 6) / style.pitch));
  const margin = (h - loops * style.pitch) / 2;
  const holeZ = (k) => -h / 2 + margin + (k + 0.5) * style.pitch;
  const wire = scene.model.wireRadius;
  if (scene.model.binding === "wire-o") {
    // One continuous wire, as Wire-O is made: through each hole a hairpin (two parallel
    // loops joined by a U at one end), and from each hairpin a bend along the spine to
    // the next. The bends sit at the underside of the ring, under the spine.
    const d = 0.85; // half the spacing of a hairpin's two loops
    const gap = (style.pitch - 2 * d) / 2; // half the length of a bend to the next hairpin
    const seam = -Math.PI / 2;
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
    // A coil whose upper half (where the pages hang, from flat right over the top to
    // flat left) stays level with its hole, so all pages line up at head and foot. It
    // climbs to the next hole on the underside of the ring, out of sight.
    const a0 = Math.PI / 2 - psiFlat; // flat right as a standard angle; flat left is a0 + π
    const start = a0 - Math.PI / 2;
    const turns = loops;
    const zAt = (a) => {
      const k = Math.floor((a - a0) / (2 * Math.PI));
      const u = (a - a0) / Math.PI - 2 * k; // 0..2: level in 0..1, climbing in 1..2
      const climb = u <= 1 ? 0 : (1 - Math.cos((u - 1) * Math.PI)) / 2;
      return holeZ(k) + climb * style.pitch;
    };
    const curve = curveOf((t, target) => {
      const a = start + t * turns * 2 * Math.PI;
      return target.set(R * Math.cos(a), R * Math.sin(a), zAt(a));
    });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, turns * 128, wire, 14, false), scene.wireMat);
    tube.castShadow = true;
    coil.add(tube, ...wireEnds(curve, wire, scene.wireMat));
  }
  return coil;
}

/** Sewing threads through the centre fold of each signature. */
/**
 * A sewn block's signatures, folded: each sheet a U round the ones inside it, at the
 * sheets' roots, reaching foldDepth beyond them toward the cover or case. Seen at head and
 * foot (a row of nested folds along the spine, where a glued block shows cut edges) and, open,
 * at the ends of the gutter. Paper throughout: the folds' outsides and their cut ends.
 */
function makeSignatureFolds(scene, group) {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), scene.edgeMat);
  m.castShadow = m.receiveShadow = true;
  m.frustumCulled = false;
  group.add(m);
  return m;
}

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
    // line), or against a sewn block's folds.
    const mid = P.clone().add(Q).multiplyScalar(0.5).addScaledVector(out, tc / 2 + m.foldDepth);
    const along = Q.clone().sub(P);
    ex.slab.position.set(mid.x, mid.y, 0);
    ex.slab.rotation.z = Math.atan2(along.y, along.x);
    ex.slab.scale.set(along.length() + tc, tc, m.height);
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
      const span = Math.hypot(dx, dy) || 1;
      for (const e of [g.userData.head, g.userData.foot]) {
        e.position.x = (p.x[0] + p.x[last]) / 2 + (dx / span) * (m.thickness[0] / 4);
        e.position.y = (p.y[0] + p.y[last]) / 2 + (dy / span) * (m.thickness[0] / 4);
        e.rotation.z = turn;
      }
      g.userData.fore.position.set(p.x[last], p.y[last], 0);
    }
    // Headbands: along the block's spine at head and foot, on the spine board.
    const inner = scene.leaves.slice(1, -1);
    const sink = m.thickness[1] / 2 + 0.76 + m.foldDepth; // into the hollow: from the sheets' roots, past the folds, to the band's centre
    const stepBy = Math.max(1, Math.ceil(inner.length / 24));
    const path = [];
    for (let k = 0; k < inner.length; k += stepBy) {
      const p = inner[k].profile;
      path.push(new THREE.Vector2(p.x[0] - Math.sin(p.phi[0]) * sink, p.y[0] - Math.cos(p.phi[0]) * sink));
    }
    const lastP = inner[inner.length - 1]?.profile;
    if (lastP && (inner.length - 1) % stepBy !== 0) path.push(new THREE.Vector2(lastP.x[0] - Math.sin(lastP.phi[0]) * sink, lastP.y[0] - Math.cos(lastP.phi[0]) * sink));
    // Rebuilt only when the spine moved (a page turning over the block leaves it as it is).
    const along = path.flatMap((q) => [q.x, q.y]);
    for (const band of ex.headbands) {
      band.visible = path.length >= 2;
      if (!band.visible) continue;
      const was = band.userData.along;
      if (was && was.length === along.length && was.every((v, k) => v === along[k])) continue;
      band.userData.along = along;
      const z = band.userData.z;
      const curve = new THREE.CatmullRomCurve3(path.map((q) => new THREE.Vector3(q.x, q.y, z)));
      band.geometry.dispose();
      band.geometry = new THREE.TubeGeometry(curve, Math.max(4, path.length * 2), 0.75, 8, false);
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
 * Saddle stitch: each sheet is one piece of paper folded round the ones inside it. Its two
 * halves are leaves k and n - 1 - k; between their roots it bends in a U, leaving each
 * root in the direction that leaf starts in, so the paper runs on without a kink. Built as
 * one mesh: outside, inside and the cut edges at head and foot of every sheet's fold.
 * Material groups: 0 the cover's outside (the spine colour), 1 the rest of the cover's
 * fold, 2 the pages'. Returns the outside of the cover's fold and the inside of the centre
 * sheet's, at their middle (for the staples' crowns and legs).
 */
/**
 * The outside of the cover's fold: the front cover's page image from its root back to the
 * fold's apex, then the back cover's from the apex to its root (the strips of them the fold
 * takes: `uFoldStart` of each, as leafShape sets their uStart). The mesh's uv is the way
 * along the fold (0 at the front cover's root, 1 at the back's) and down it (head 0). Page
 * images are stored as sRGB (see PAGE_COLOR_SPACE in scene.js): decoded here as the pages do.
 */
function foldCoverMaterial(scene) {
  const m = new THREE.MeshPhysicalMaterial({ roughness: 0.8, side: THREE.DoubleSide });
  m.defines = { USE_UV: "" };
  m.userData.uniforms = { uFoldFront: { value: scene.white }, uFoldBack: { value: scene.white }, uFoldStart: { value: 0 } };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, m.userData.uniforms);
    shader.fragmentShader = patchShader(shader.fragmentShader, [
      ["void main() {", "uniform sampler2D uFoldFront;\nuniform sampler2D uFoldBack;\nuniform float uFoldStart;\nvoid main() {"],
      ["#include <map_fragment>", `{
  float t = vUv.x;
  vec4 ink = t < 0.5 ? texture2D( uFoldFront, vec2( uFoldStart * ( 1.0 - 2.0 * t ), vUv.y ) )
                     : texture2D( uFoldBack, vec2( 1.0 - uFoldStart * ( 2.0 * t - 1.0 ), vUv.y ) );
  diffuseColor *= sRGBTransferEOTF( ink );
}`],
    ]);
  };
  m.customProgramCacheKey = () => "bookview-fold-cover";
  return m;
}

/** The fold's cover material takes the cover pages' images and the cover stock's look, as drawn now. */
function syncFoldCover(m, scene, book) {
  const front = scene.leaves[0]?.front;
  const back = scene.leaves[scene.leaves.length - 1]?.back;
  if (!front || !back) return;
  const u = m.userData.uniforms;
  u.uFoldFront.value = front.map ?? scene.white;
  u.uFoldBack.value = back.map ?? scene.white;
  u.uFoldStart.value = leafShape(book, 0).uStart / book.width;
  m.color.copy(front.color);
  m.roughness = front.roughness;
  m.specularIntensity = front.specularIntensity;
  m.clearcoat = front.clearcoat;
  m.clearcoatRoughness = front.clearcoatRoughness;
}

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
    const groups = [[], [], []];
    for (let k = 0; k < sheets; k++) {
      for (let st = 0; st < 4; st++) {
        const group = k > 0 ? 2 : st === 0 ? 0 : 1;
        const base = k * SHEET + st * 2 * ROW;
        for (let j = 0; j < SEGS; j++) {
          const v = base + 2 * j;
          groups[group].push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
        }
      }
    }
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(sheets * SHEET * 3), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(sheets * SHEET * 3), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(sheets * SHEET * 2), 2)); // the cover's outside (see foldCoverMaterial)
    geo.setIndex(groups.flat());
    geo.clearGroups();
    let at = 0;
    groups.forEach((list, g) => {
      geo.addGroup(at, list.length, g);
      at += list.length;
    });
    fold = geo.userData.fold = { sheets, roots: new Float64Array(6 * sheets).fill(NaN), box: new Float64Array(4 * sheets), apex: [], xs: new Float64Array(ROW), ys: new Float64Array(ROW), nx: new Float64Array(ROW), ny: new Float64Array(ROW) };
  }
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const { xs, ys, nx: NX, ny: NY } = fold;
  // Two rows of vertices along the fold at heights za and zb (`side`: 1 the outside surface,
  // -1 the inside), quads between them, wound so their front faces the given normal (`nz`
  // for head and foot, else the surface's own): double-sided materials light by winding.
  const strip = (base, sa, za, sb, zb, nz, flip) => {
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
    strip(base, half, -h2, half, h2, 0, 1); // outside
    if (k === 0) {
      // Along the fold (0 at the front cover's root, 1 at the back's) and down it (0 at the head).
      const uv = geo.attributes.uv;
      for (let j = 0; j <= SEGS; j++) {
        const v = base + 2 * j;
        uv.setXY(v, j / SEGS, (pos.getZ(v) + h2) / (2 * h2));
        uv.setXY(v + 1, j / SEGS, (pos.getZ(v + 1) + h2) / (2 * h2));
      }
      uv.needsUpdate = true;
    }
    strip(base + 2 * ROW, -half, h2, -half, -h2, 0, -1); // inside
    strip(base + 4 * ROW, -half, -h2, half, -h2, -1, 1); // head
    strip(base + 6 * ROW, half, h2, -half, h2, 1, 1); // foot
  }
  if (first >= 0) {
    const from = first * SHEET * 3;
    const count = (last - first + 1) * SHEET * 3;
    pos.clearUpdateRanges();
    nor.clearUpdateRanges();
    pos.addUpdateRange(from, count);
    nor.addUpdateRange(from, count);
    pos.needsUpdate = true;
    nor.needsUpdate = true;
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
  const n = leaves.length;
  const sig = book.signatureLeaves;
  // The sheets: within each signature of the block (the covers or boards, and a hardcover's
  // flyleaves, apart), the k-th leaf from its front with the k-th from its back.
  const pairs = [];
  const blockFirst = book.firstBlockLeaf;
  for (let a = blockFirst; a < n - blockFirst; a += sig) {
    const b = Math.min(n - 1 - blockFirst, a + sig - 1);
    for (let k = 0; a + k < b - k; k++) pairs.push([a + k, b - k]);
  }
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
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pairs.length * SHEET * 3), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(pairs.length * SHEET * 3), 3));
    geo.setIndex(index);
    folds = geo.userData.folds = { count: pairs.length, roots: new Float64Array(6 * pairs.length).fill(NaN) };
  }
  const pos = /** @type {THREE.BufferAttribute} */ (geo.attributes.position);
  const nor = /** @type {THREE.BufferAttribute} */ (geo.attributes.normal);
  let first = -1;
  let last = -1;
  // Two rows of vertices along a half circle (radius r, centre c, from -e to e through
  // `out`) at offsets sa and sb from it and heights za and zb; quads between them, wound so
  // their front faces `nz` (head and foot) or the surface's own normal, outward (flip 1) or
  // inward (-1): double-sided materials light by winding.
  const strip = (base, c, e, r, sa, za, sb, zb, nz, flip) => {
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
    strip(base, c, e, r, half, -h2, half, h2, 0, 1); // outside
    strip(base + 2 * ROW, c, e, r, -half, h2, -half, -h2, 0, -1); // inside
    strip(base + 4 * ROW, c, e, r, -half, -h2, half, -h2, -1, 1); // head
    strip(base + 6 * ROW, c, e, r, half, h2, -half, h2, 1, 1); // foot
  }
  if (first >= 0) {
    const from = first * SHEET * 3;
    const count = (last - first + 1) * SHEET * 3;
    pos.clearUpdateRanges();
    nor.clearUpdateRanges();
    pos.addUpdateRange(from, count);
    nor.addUpdateRange(from, count);
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }
}

/**
 * A hardcover's spine, square back: the covering from the front board's spine edge across
 * the joint (a groove pressed into its outside), round a square corner, flat across the
 * spine board (as wide as the block and both boards), round the other corner, and across
 * the other joint to the back board. As thick as the boards. Outside: the spine artwork,
 * mapped across the flat spine (u from the front cover's side, v from the head); the
 * joints repeat its edges. pa, pb: the boards; pl, ph: the block's first and last sheets
 * (their roots are the block's spine). Material groups: 0 outside, 1 inside, 2 the cut
 * edges at head and foot.
 */
function writeCaseSpine(geo, pa, pb, pl, ph, book, height, closedFraction = 0) {
  const tb = book.thickness[0];
  const tc = 1.2; // the covering over a thin spine board, flush with the boards' outsides;
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
  // The spine board's centre line: clear of the sheets' spine edges, reaching past the
  // block by the boards' thickness on either side (flush with the boards' outer faces).
  const tl = book.thickness[1] ?? 0;
  const th = book.thickness[n - 2] ?? 0;
  const deep = Math.max(tb - tc / 2, book.foldDepth + 0.4 + tc / 2); // past the signatures' folds too
  const C1 = { x: Pl.x - ax * (tl / 2 + deep) + ox * (tl + deep), y: Pl.y - ay * (tl / 2 + deep) + oy * (tl + deep) };
  const C2 = { x: Ph.x + ax * (th / 2 + deep) + ox * (th + deep), y: Ph.y + ay * (th / 2 + deep) + oy * (th + deep) };
  // Each end: just under the board's outer face at its spine edge, a little inside the
  // board (no seam opens).
  const end = (p, outSign) => {
    const dx = Math.sin(p.phi[0]);
    const dy = Math.cos(p.phi[0]);
    const at = (tb - tc) / 2;
    return { x: p.x[0] + dx * 0.6 - Math.cos(p.phi[0]) * outSign * at, y: p.y[0] + dy * 0.6 + Math.sin(p.phi[0]) * outSign * at };
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
  const h2 = height / 2;
  const pos = [];
  const nor = [];
  const uv = [];
  const groups = [[], [], []];
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
      groups[group].push(...(flip ? [v, v + 2, v + 1, v + 2, v + 3, v + 1] : [v, v + 1, v + 2, v + 2, v + 1, v + 3]));
    }
  };
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
  // v: 0 at the head of the page (the squares beyond repeat the artwork's edge rows).
  const vHead = (h2 - book.height / 2) / -book.height;
  const vFoot = 1 + (h2 - book.height / 2) / book.height;
  // u: across the flat spine, measured on its outside (the corners' outsides included).
  const u0 = len[panelFrom] - (R + tc / 2) * 0.5;
  const u1 = len[panelTo] + (R + tc / 2) * 0.5;
  const uAt = (j) => Math.min(1, Math.max(0, (len[j] - u0) / ((u1 - u0) || 1)));
  const uvOut = len.map((_, j) => [[uAt(j), vHead], [uAt(j), vFoot]]);
  strip(0, at(outer, -h2), at(outer, h2), nOut, uvOut);
  strip(1, at(inner, h2), at(inner, -h2), nIn);
  strip(2, at(inner, -h2), at(outer, -h2), outer.map(() => [0, 0, -1]));
  strip(2, at(outer, h2), at(inner, h2), outer.map(() => [0, 0, 1]));
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
