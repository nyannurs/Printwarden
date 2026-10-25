// Points from the testing checklist (the designer's feedback, 0.17.50 to 0.17.67) that
// numbers can settle: a hardcover's endpapers and boards, side glue, a stapled booklet's
// staples and creep, and switching bindings on one book.

import { analyse } from "../app/core/analysis.js";
import { Binding } from "../app/core/binding.js";
import { defaultPaper } from "../app/core/paper.js";
import { defaultExportOptions, planSheets } from "../app/core/sheets.js";
import { calculatedSpine, CASE_JOINT_MM, CASE_SQUARE_MM } from "../app/core/spine.js";
import { rect } from "../app/core/units.js";
import { HOLE_OFFSET_MM, leafShape, makeBook, signatureSheets } from "../app/viewer/model.js";
import { BookScene } from "../app/viewer/scene.js";
import { headbandEnds } from "./drawn.js";
import { eq, near, ok, test } from "./harness.js";

const A5 = rect(0, 0, 148, 210);
const singles = (n) => Array.from({ length: n }, (_, index) => ({ index, mediaBox: A5, trimBox: null, bleedBox: null, rotation: 0 }));

const stock = { color: "#ffffff", roughness: 0.85, specular: 0.3, clearcoat: 0, show: 0.1 };
const paper = { ...stock, cover: { ...stock, color: "#d8d0c0" }, thickness: 0.1, coverThickness: 0.3, gsm: 120, finish: "uncoated" };

function makeScene() {
  const box = document.createElement("div");
  box.style.cssText = "position: fixed; left: -2000px; top: 0; width: 320px; height: 200px;";
  document.body.append(box);
  return { scene: new BookScene(box), box };
}

test("hardcover: the endpapers are in the book (E1 to E4) but on no press sheet, and the counts leave them out", () => {
  // 20 pages: the cover's four and 16 between them (one signature).
  const a = analyse({ pages: singles(20) }, { binding: Binding.HARDCOVER });
  eq(a.book.pages.length, 24);
  const fly = a.book.pages.filter((p) => p.endpaper).map((p) => [p.number, p.label]);
  eq(fly, [[3, "E1"], [4, "E2"], [21, "E3"], [22, "E4"]]);
  eq(a.book.pages.filter((p) => ["C1", "C2", "C3", "C4"].includes(p.label)).map((p) => p.number), [1, 2, 23, 24]);
  ok(!a.hasErrors, JSON.stringify(a.findings.filter((f) => f.severity === "error")));
  const onSheets = new Set(a.layout.sides.flatMap((s) => [s.left, s.right]));
  for (const [n] of fly) ok(!onSheets.has(n), `E page ${n} is on a sheet`);
  const plan = planSheets(a, defaultExportOptions());
  eq(plan.errors, []);
  const placed = plan.sides.flatMap((s) => s.placements.map((p) => p.folio));
  for (const [n] of fly) ok(!placed.includes(n), `E page ${n} is placed`);
  // Every printed page once, the numbering past the endpapers.
  eq([...placed].sort((x, y) => x - y), [1, 2, ...Array.from({ length: 16 }, (_, k) => k + 5), 23, 24]);
  eq(plan.sheetCount, 5); // four sheets of the signature, the cover's own
  ok(a.findings.some((f) => f.code === "endpapers"), "preflight says so");
  ok(a.findings.some((f) => f.code === "sheets" && f.message.startsWith("4 sheets") && f.message.includes("the cover on a sheet of its own")));
});

test("hardcover: the boards' thickness sets the spine and the 3D block; the headband lies on the block's spine, not in the air", () => {
  const thin = calculatedSpine(36, defaultPaper(), Binding.HARDCOVER, 1);
  const thick = calculatedSpine(36, defaultPaper(), Binding.HARDCOVER, 5);
  near(thick.widthMm - thin.widthMm, 8, 1e-9, "two boards, 4 mm more each");
  for (const boardMm of [1, 2.5, 5]) {
    const book = makeBook({ pageCount: 36, binding: "hardcover", thickness: 0.1, coverThickness: 0.3, width: 148, height: 210, boardMm });
    eq([book.thickness[0], book.thickness[book.leafCount - 1]], [boardMm, boardMm]);
  }
  const { scene, box } = makeScene();
  try {
    for (const boardMm of [1, 2.5, 5]) {
      for (const roundSpine of [false, true]) {
        scene.setBook({ pageCount: 36, pageSize: { width: 148, height: 210 }, binding: "hardcover", paper, boardMm, roundSpine, endpapers: true });
        for (const opening of [0, 9]) {
          scene.goTo(opening, { animate: false });
          scene.debugStep();
          const n = scene.leaves.length;
          const m = scene.model;
          const roots = scene.leaves.slice(1, -1).map((l) => [l.profile.x[0], l.profile.y[0], l.profile.phi[0]]);
          for (const band of scene.extras.headbands) {
            ok(band.visible, "a headband at each end");
            band.geometry.computeBoundingBox();
            const b = band.geometry.boundingBox;
            // Across the whole block's spine (first inner leaf's root to the last's), a bead's width or so to spare.
            const xs = roots.map((r) => r[0]);
            const label = `board ${boardMm} mm, ${roundSpine ? "rounded" : "square"}, opening ${opening}`;
            ok(b.min.x <= Math.min(...xs) + 1 && b.max.x >= Math.max(...xs) - 1, `${label}: the headband spans x ${b.min.x.toFixed(1)}..${b.max.x.toFixed(1)}, the spine ${Math.min(...xs).toFixed(1)}..${Math.max(...xs).toFixed(1)}`);
            // On the spine: every point of the bead within a few millimetres of the sheets' roots
            // (closed, the roots run upright and the bead sits beside them; open, under them).
            const pos = band.geometry.attributes.position;
            let far = 0;
            for (let k = 0; k < pos.count; k += 7) {
              const px = pos.getX(k);
              const py = pos.getY(k);
              let d = Infinity;
              for (const [rx, ry] of roots) d = Math.min(d, Math.hypot(px - rx, py - ry));
              far = Math.max(far, d);
            }
            // Within the hollow (its depth, 1.7 mm) and its reach into the case's walls (the
            // board less the covering past the block's outer sheets, and half the bead on):
            // farther is floating.
            ok(far < m.foldDepth + 2 * 0.83 + m.thickness[0] - 1.2 + 1, `${label}: a point of the headband ${far.toFixed(1)} mm from the nearest root (floating)`);
            // The bead touches the folds: its nearest point to the roots is a fold's depth away, not more.
            let nearest = Infinity;
            for (let k = 0; k < pos.count; k += 3) {
              const px = pos.getX(k);
              const py = pos.getY(k);
              for (const [rx, ry] of roots) nearest = Math.min(nearest, Math.hypot(px - rx, py - ry));
            }
            ok(nearest < m.foldDepth + 0.35, `${label}: the bead's nearest point is ${nearest.toFixed(2)} mm from the roots, the folds reach ${m.foldDepth.toFixed(2)}`);
            // Shut, its ends in the case's walls (it meets the case at the shoulders); open, at
            // the block's sides (it stays with the block); cut flat either way, never hollow,
            // never a pill's round caps (the author, 1.1.0).
            const ends = headbandEnds(scene);
            const wall = m.thickness[0] - 1.2; // the board less the covering: the block's side to the wall
            const want = scene.closed >= 1 ? (e) => e > 0 : (e) => Math.abs(e + wall) < 0.01;
            ok(ends.every(want), `${label}: its ends ${ends.map((e) => e.toFixed(2)).join(", ")} mm past the case's walls (${scene.closed >= 1 ? "shut: into them" : `open: at the block's sides, ${(-wall).toFixed(2)}`})`);
            ok(band.userData.ends.every((e) => e.visible), `${label}: its ends cut flat`);
            ok(n > 4, "leaves");
          }
        }
      }
    }
  } finally {
    box.remove();
  }
});

test("side glue: preflight names it for glued and sewn books, not for others, not when off", () => {
  const glued = analyse({ pages: singles(36) }, { binding: Binding.PERFECT });
  const note = glued.findings.find((f) => f.code === "side-glue");
  ok(note && note.message.includes("6 mm"), "perfect: 6 mm by default");
  ok(analyse({ pages: singles(36) }, { binding: Binding.SEWN, signaturePages: 16 }).findings.some((f) => f.code === "side-glue"));
  ok(!analyse({ pages: singles(36) }, { binding: Binding.PERFECT, glueMm: 0 }).findings.some((f) => f.code === "side-glue"), "off");
  ok(!analyse({ pages: singles(36) }, { binding: Binding.SADDLE }).findings.some((f) => f.code === "side-glue"), "a stapled booklet has none");
  ok(!analyse({ pages: singles(36) }, { binding: Binding.HARDCOVER }).findings.some((f) => f.code === "side-glue"), "a case's endpapers do that job");
});

test("staple: thin booklets get a flatter staple that stays inside the paper; the fold takes paper from the outer sheets (creep)", () => {
  const { scene, box } = makeScene();
  try {
    // 8 pages of 60 gsm: a 0.3 mm block, thinner than the wire.
    scene.setBook({ pageCount: 8, pageSize: { width: 148, height: 210 }, binding: "saddle", paper: { ...paper, thickness: 0.075, coverThickness: 0.075 } });
    ok(scene.extras.stapleSquash < 0.5, `squashed to ${scene.extras.stapleSquash.toFixed(2)}`);
    ok(scene.extras.staples.every((s) => s.outer.scale.y === scene.extras.stapleSquash), "the crown drawn that flat");
    scene.setBook({ pageCount: 44, pageSize: { width: 148, height: 210 }, binding: "saddle", paper });
    eq(scene.extras.stapleSquash, 1, "a block thicker than the wire: a full staple");
  } finally {
    box.remove();
  }
  const book = makeBook({ pageCount: 44, binding: "saddle", thickness: 0.1, coverThickness: 0.3, width: 148, height: 210 });
  const n = book.leafCount;
  const cover = leafShape(book, 0);
  const inner = leafShape(book, n / 2 - 1);
  ok(cover.uStart > 1, `the cover's fold takes ${cover.uStart.toFixed(2)} mm of its inner margin`);
  ok(inner.uStart < 0.2, `the centre sheet's ${inner.uStart.toFixed(2)} mm`);
  near(cover.width, inner.width, 1e-6, "every half the same flat width: the inner pages lose the difference at the fore-edge");
  // Monotonic: each sheet in takes less.
  let last = Infinity;
  for (let i = 0; i < n / 2; i++) {
    const u = leafShape(book, i).uStart;
    ok(u <= last + 1e-9, `sheet ${i} takes more than the one outside it`);
    last = u;
  }
});

test("hardcover: the case's covering doesn't stretch as the boards open and close", () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 36, pageSize: { width: 148, height: 210 }, binding: "hardcover", paper });
    const lengths = () => scene.extras.caseSpine.geometry.userData.lengths;
    scene.clock = 1e6;
    scene.goTo(0, { animate: false });
    scene.setClosed(true, { animate: false });
    scene.debugStep();
    const shut = lengths().all;
    let least = shut, most = shut;
    scene.clock = 1e6 + 500;
    scene.open();
    for (let t = 0; t <= 1200; t += 1000 / 120) {
      scene.clock = 1e6 + 500 + t;
      scene.debugStep();
      least = Math.min(least, lengths().all);
      most = Math.max(most, lengths().all);
    }
    ok(most - least < 1.2, `the outside ${least.toFixed(2)} to ${most.toFixed(2)} mm (shut ${shut.toFixed(2)})`);
  } finally {
    scene.clock = null;
    box.remove();
  }
});

test("REGRESSION: a thick hardcover's covering doesn't stretch either (244 pages, 23 mm): opening, to its first spread, the board turned back", () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 244, pageSize: { width: 148, height: 210 }, binding: "hardcover", paper, endpapers: true, signaturePages: 16 });
    const lengths = () => scene.extras.caseSpine.geometry.userData.lengths;
    scene.clock = 1e6;
    scene.goTo(0, { animate: false });
    scene.setClosed(true, { animate: false });
    scene.debugStep();
    const shut = lengths().all;
    let least = shut, most = shut, where = "";
    const watch = (label) => {
      const v = lengths().all;
      if (v < least) { least = v; where = label; }
      if (v > most) { most = v; where = label; }
    };
    let clock = 1e6 + 500;
    const run = (ms, label) => { for (let t = 0; t <= ms; t += 1000 / 120) { scene.clock = clock + t; scene.debugStep(); watch(label); } clock += ms + 10; };
    scene.clock = clock; scene.open(); run(1500, "opening");
    scene.clock = clock; scene.goTo(1); run(1500, "to the first spread");
    scene.clock = clock; scene.goTo(0); run(1500, "back to the cover");
    // (Not yet: the whole block flung to the back spread at once, the board riding on the
    // turning first page, stretches the front joint to 17 mm for a tenth of a second.)
    ok(most - least < 1.5, `the outside ${least.toFixed(2)} to ${most.toFixed(2)} mm (shut ${shut.toFixed(2)}; worst ${where})`);
  } finally {
    scene.clock = null;
    box.remove();
  }
});

/**
 * The coil as drawn against every page as drawn: the wire (the coil's tube, sampled every
 * 0.1 mm or so) never touches paper outside a punched hole, and every hole of every page has the
 * wire through it. Holes as the page shader cuts them (HOLE_DISCARD): round, or Wire-O's
 * squares, `pitch` apart, centred on the height, HOLE_OFFSET_MM from the spine edge.
 * @returns {string[]} what's wrong, at most a few
 */
const wireSamples = new WeakMap(); // a coil's path -> its samples (the coil's shape is the book's)
export function coilFaults(scene, { turningAlongOnly = false } = {}) {
  const m = scene.model;
  const style = m.style;
  const tube = scene.extras.coil.children.find((c) => c.geometry?.parameters?.path);
  const path = tube.geometry.parameters.path;
  const at = scene.extras.coil.position;
  const wire = m.wireRadius;
  const h = m.height;
  const loops = Math.max(1, Math.floor((h - 6) / style.pitch));
  const margin = (h - loops * style.pitch) / 2;
  const square = !!style.squareHoles;
  const room = style.holeRadius - wire; // how far the wire's centre may stray from a hole's centre
  // Evenly in the curve's own parameter, densely (three's arc-length spacing leaves gaps of 1.5 mm
  // on the Wire-O's joined parts), then thinned to no closer than 0.1 mm.
  let local = wireSamples.get(path);
  if (!local) {
    local = [];
    for (const q of path.getPoints(Math.ceil(path.getLength() / 0.03))) {
      const l = local[local.length - 1];
      if (!l || Math.hypot(q.x - l.x, q.y - l.y, q.z - l.z) >= 0.1) local.push({ x: q.x, y: q.y, z: q.z });
    }
    wireSamples.set(path, local);
  }
  const pts = local.map((q) => ({ x: q.x + at.x, y: q.y + at.y, z: q.z }));
  const faults = [];
  const threaded = new Map(); // `${leaf}:${hole}` -> best offset from the hole's centre
  scene.leaves.forEach((leaf, i) => {
    // (turningAlongOnly: a page in mid-turn, its hole only along the spine from the wire. As a
    // thick book's pile lifts off the table, a page in the air leaves the ring across the page
    // by up to 2 mm, a fault of its own, found 2026-10-24 once the turning pages were checked.)
    const along = turningAlongOnly && Math.abs(leaf.theta - leaf.to) > 0.5;
    const p = leaf.profile;
    const s = leaf.s;
    const half = m.thickness[i] / 2;
    // The page near its spine edge: segments up to 12 mm in.
    const segs = [];
    for (let k = 0; k + 1 < s.length && s[k] < 12; k++) segs.push(k);
    let last = null; // the previous sample's side of this page and hole, for crossings
    // Only the wire near this page's spine strip (its first 12 mm) can touch it.
    const k12 = segs.length;
    const cx0 = (p.x[0] + p.x[k12]) / 2, cy0 = (p.y[0] + p.y[k12]) / 2;
    const reach = Math.hypot(p.x[k12] - p.x[0], p.y[k12] - p.y[0]) / 2 + wire + half + 0.5;
    for (const w of pts) {
      if (Math.abs(w.z - leaf.rise) > h / 2 || Math.abs(w.x - cx0) > reach || Math.abs(w.y - cy0) > reach) { last = null; continue; }
      let best = null;
      for (const k of segs) {
        const ax = p.x[k], ay = p.y[k], bx = p.x[k + 1], by = p.y[k + 1];
        const dx = bx - ax, dy = by - ay;
        const L2 = dx * dx + dy * dy || 1;
        const t = Math.min(1, Math.max(0, ((w.x - ax) * dx + (w.y - ay) * dy) / L2));
        const cx = ax + dx * t, cy = ay + dy * t;
        const d = Math.hypot(w.x - cx, w.y - cy);
        if (!best || d < best.d) best = { d, along: s[k] + (s[k + 1] - s[k]) * t, ends: (k === 0 && t === 0), side: Math.sign((w.x - ax) * -dy + (w.y - ay) * dx) };
      }
      if (!best || best.ends || best.d > half + wire + 0.3) { last = null; continue; } // clear of this page
      // The wire is in the paper's plane here: inside a hole?
      const zFromHead = w.z - leaf.rise + h / 2; // (a spiral's page as far up as it hangs on the wire)
      const hole = Math.min(loops - 1, Math.max(0, Math.floor((zFromHead - margin) / style.pitch)));
      const zc = margin + (hole + 0.5) * style.pitch;
      const ds = best.along - HOLE_OFFSET_MM, dz = zFromHead - zc;
      const off = along ? Math.abs(dz) : square ? Math.max(Math.abs(ds), Math.abs(dz)) : Math.hypot(ds, dz);
      // Threaded: the wire crosses the page's plane (between this sample and the last) within the hole.
      if (last && last.hole === hole && last.side !== best.side && Math.max(off, last.off) <= room + 0.05) {
        const key = `${i}:${hole}`;
        threaded.set(key, Math.min(threaded.get(key) ?? Infinity, off));
      }
      last = { side: best.side, hole, off };
      if (best.d > half + wire) continue;
      if (off > room + 0.05) {
        if (faults.length < 6) faults.push(`leaf ${i}: the wire through the paper ${off.toFixed(2)} mm from hole ${hole}'s centre (room ${room.toFixed(2)}), ${best.along.toFixed(1)} mm from the spine edge`);
      }
    }
  });
  for (let i = 0; i < scene.leaves.length && faults.length < 6; i++) {
    for (let k = 0; k < loops; k++) {
      if (!threaded.has(`${i}:${k}`)) { faults.push(`leaf ${i}: no wire through hole ${k}`); break; }
    }
  }
  return faults;
}

test("COIL: the wire goes through every punched hole of every page and touches paper nowhere else (spiral, Wire-O; 44 and 240 pages; at rest, closed, and while pages turn, the turning ones along the spine)", () => {
  const { scene, box } = makeScene();
  try {
    for (const binding of ["spiral", "wire-o"]) {
      for (const pageCount of [44, 240]) {
        scene.setBook({ pageCount, pageSize: { width: 148, height: 210 }, binding, paper: { ...paper, thickness: 0.15, coverThickness: 0.15 } });
        const N = scene.model.leafCount;
        const check = (label, turningAlongOnly = false) => {
          const f = coilFaults(scene, { turningAlongOnly });
          ok(!f.length, `${binding}, ${pageCount} pages, ${label}: ${f.join("; ")}`);
          return f.length;
        };
        scene.clock = 1e6;
        for (const opening of [0, 1, Math.round(N / 4), Math.round(N / 2), N - 1, N]) {
          scene.setClosed(false, { animate: false });
          scene.goTo(opening, { animate: false });
          scene.debugStep();
          check(`open at ${opening}`);
        }
        scene.goTo(0, { animate: false }); scene.setClosed(true, { animate: false }); scene.debugStep();
        check("closed, front up");
        // Opening, then turning to the middle: a frame checked every 100 ms (stop at the first fault).
        let clock = 1e6 + 500;
        let prev = null;
        // Every frame: no page at rest and not the coil jumps (they "spazzed", the author: the coil
        // turned round by up to 177° in a frame, 2026-10-23). A frame checked every 100 ms.
        const run = (label, ms) => {
          for (let t = 0; t <= ms; t += 1000 / 120) {
            scene.clock = clock + t;
            scene.debugStep();
            const c = scene.extras.coil;
            const cur = { coil: [c.position.x, c.position.y, c.rotation.z], leaves: scene.leaves.map((l) => [l.profile.x[0], l.profile.y[0]]) };
            if (prev) {
              const jump = Math.max(...cur.leaves.map((q, i) => (Math.abs(scene.leaves[i].theta - scene.leaves[i].to) > 0.5 ? 0 : Math.hypot(q[0] - prev.leaves[i][0], q[1] - prev.leaves[i][1]))));
              const coil = Math.hypot(cur.coil[0] - prev.coil[0], cur.coil[1] - prev.coil[1]) + 10 * Math.abs(cur.coil[2] - prev.coil[2]);
              ok(jump < 0.8 && coil < 1.5, `${binding}, ${pageCount} pages, ${label}, ${Math.round(t)} ms: a page at rest moved ${jump.toFixed(2)} mm in a frame, the coil ${coil.toFixed(2)}`);
            }
            prev = cur;
            if (Math.round(t) % 100 < 9 && check(`${label}, ${Math.round(t)} ms`, true)) return;
          }
          clock += ms + 10;
          prev = null;
        };
        scene.clock = clock; scene.open(); run("opening", 1200);
        scene.clock = clock; scene.goTo(Math.round(N / 2)); run("turning to the middle", 1500);
        scene.clock = clock; scene.goTo(N); scene.close?.(); run("to the back", 2000);
      }
    }
  } finally {
    scene.clock = null;
    box.remove();
  }
});

test("sewn and hardcover: each signature folds as a booklet does, printed from its fold, trimmed together", () => {
  for (const binding of ["sewn", "hardcover"]) {
    const book = makeBook({ pageCount: 64, binding, thickness: 0.1, coverThickness: 0.3, width: 148, height: 210, signaturePages: 16 });
    const sheets = signatureSheets(book);
    eq(sheets.length, (book.leafCount - 2 * book.firstBlockLeaf) / 2, `${binding}: every block leaf in one sheet`);
    const [a, b] = sheets[0]; // the first signature's outermost sheet
    const [c] = sheets[book.signatureLeaves / 2 - 1]; // and its centre
    const outer = leafShape(book, a);
    ok(outer.uStart > 0.4, `${binding}: the outer fold takes ${outer.uStart.toFixed(2)} mm of the page`);
    ok(leafShape(book, c).uStart < outer.uStart / 3, `${binding}: the centre fold less`);
    near(leafShape(book, b).uStart, outer.uStart, 1e-9, `${binding}: both halves of a sheet alike`);
    near(outer.uStart + outer.width, 148, 1e-6, `${binding}: the outermost pages reach the trim`);
    near(leafShape(book, c).width, outer.width, 1e-9, `${binding}: every page as wide (the creep cut off)`);
    if (binding === "sewn") near(leafShape(book, 0).width, outer.width, 1e-9, "the cover trimmed with the block");
  }
  const cased = makeBook({ pageCount: 64, binding: "hardcover", thickness: 0.1, coverThickness: 0.3, width: 148, height: 210 });
  eq([cased.style.square, cased.style.joint], [CASE_SQUARE_MM, CASE_JOINT_MM], "the case's squares and joints as a case wrap is read");
  eq(signatureSheets(makeBook({ pageCount: 64, binding: "perfect", thickness: 0.1, coverThickness: 0.3, width: 148, height: 210 })).length, 0, "a glued block has no folds");
});

test("one book through every binding, deep in it: no error, the opening kept, the shape right", () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 60, pageSize: { width: 148, height: 210 }, binding: "perfect", paper });
    scene.goTo(25, { animate: false });
    for (const binding of ["saddle", "sewn", "hardcover", "spiral", "wire-o", "perfect"]) {
      scene.setBook({ pageCount: 60, pageSize: { width: 148, height: 210 }, binding, paper, endpapers: binding === "hardcover", roundSpine: binding === "hardcover" });
      eq(scene.leaves.length, 30, binding);
      eq(scene.opening, 25, `${binding}: the opening is kept`);
      scene.debugSample(0.5, 0.5);
      const left = scene.leaves.filter((l) => l.theta < 0).length;
      eq(left, 25, `${binding}: 25 leaves turned`);
      ok(scene.leaves.every((l) => Number.isFinite(l.profile.x[0]) && Number.isFinite(l.profile.y[0])), `${binding}: every leaf laid out`);
    }
  } finally {
    box.remove();
  }
});

test("sewn and glued: the spine block reaches the covers' roots (no slit over the folds); a case's spine is lined with kraft across its panel", () => {
  const { scene, box } = makeScene();
  try {
    scene.setBook({ pageCount: 36, pageSize: { width: 148, height: 210 }, binding: "sewn", signaturePages: 16, paper });
    scene.goTo(0, { animate: false });
    scene.debugStep();
    const m = scene.model;
    ok(m.foldDepth > 0.3, `the signatures fold ${m.foldDepth.toFixed(2)} mm past the roots`);
    near(scene.extras.slab.scale.y, m.coverThickness + m.foldDepth, 1e-6, "the slab takes the folds in, as deep as folds and cover together");
    // Its inner face at the roots: across the spine (the slab's own y), its centre is half
    // its depth from the first leaf's root.
    const root = scene.leaves[0].profile;
    const th = scene.extras.slab.rotation.z;
    const d = Math.abs(-(scene.extras.slab.position.x - root.x[0]) * Math.sin(th) + (scene.extras.slab.position.y - root.y[0]) * Math.cos(th));
    ok(Math.abs(d - scene.extras.slab.scale.y / 2) < 0.05, `the slab's centre ${d.toFixed(2)} mm behind the cover's root, half its depth ${(scene.extras.slab.scale.y / 2).toFixed(2)}`);
    // Its narrow sides in the spine's tone, not the cover's.
    eq(scene.extras.slab.material[1], scene.spineSideFrontMat);
    scene.setBook({ pageCount: 36, pageSize: { width: 148, height: 210 }, binding: "perfect", paper });
    scene.debugStep();
    near(scene.extras.slab.scale.y, scene.model.coverThickness, 1e-6, "a glued block has no folds: the cover's thickness");
    scene.setBook({ pageCount: 36, pageSize: { width: 148, height: 210 }, binding: "hardcover", signaturePages: 16, paper, boardMm: 2.5, roundSpine: true, endpapers: true });
    scene.debugStep();
    const groups = new Set(scene.extras.caseSpine.geometry.groups.map((g) => g.materialIndex));
    ok(groups.has(5) && groups.has(3) && groups.has(4), `the case spine's groups: ${[...groups].join(", ")}`);
    eq(scene.extras.caseSpine.material[5], scene.kraftMat);
  } finally {
    box.remove();
  }
});
