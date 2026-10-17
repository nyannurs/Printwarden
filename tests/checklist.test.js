// Points from the testing checklist (the designer's feedback, 0.17.50 to 0.17.67) that
// numbers can settle: a hardcover's endpapers and boards, side glue, a stapled booklet's
// staples and creep, and switching bindings on one book.

import { analyse } from "../app/core/analysis.js";
import { Binding } from "../app/core/binding.js";
import { defaultPaper } from "../app/core/paper.js";
import { defaultExportOptions, planSheets } from "../app/core/sheets.js";
import { calculatedSpine } from "../app/core/spine.js";
import { rect } from "../app/core/units.js";
import { leafShape, makeBook } from "../app/viewer/model.js";
import { BookScene } from "../app/viewer/scene.js";
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
            ok(far < m.foldDepth + 2.4, `${label}: a point of the headband ${far.toFixed(1)} mm from the nearest root (floating)`);
            // The bead touches the folds: its nearest point to the roots is a fold's depth away, not more.
            let nearest = Infinity;
            for (let k = 0; k < pos.count; k += 3) {
              const px = pos.getX(k);
              const py = pos.getY(k);
              for (const [rx, ry] of roots) nearest = Math.min(nearest, Math.hypot(px - rx, py - ry));
            }
            ok(nearest < m.foldDepth + 0.35, `${label}: the bead's nearest point is ${nearest.toFixed(2)} mm from the roots, the folds reach ${m.foldDepth.toFixed(2)}`);
            ok(band.userData.caps.every((c) => c.visible && c.geometry.attributes.position.count > 20), "closed at both ends");
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
