// Geometry proof: no two sheets of a book pass through each other, in any binding, at rest
// at any opening, closed on either cover, while closing and opening, mid page-turn, and with
// several pages in the air at once (flipping fast, forward, back, and turned back mid-way).
// Each leaf is its cross-section (a ribbon as thick as it is drawn); every pair that could
// meet is tested for crossing outlines.

import { layoutBook, leafProfile, leafShape, makeBook, restingAngle, rowTurn, turnCurl } from "../app/viewer/model.js";
import { crossingPairs } from "./crossings.js";
import { ok, test } from "./harness.js";

const BINDINGS = ["saddle", "perfect", "sewn", "hardcover", "spiral", "wire-o"];
// Outlines exactly as thick as drawn (LEAF_FILL in viewer/scene.js).
const FILL = 0.9;
const easeTurn = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);

/** The outline of a leaf's cross-section: front edge out, back edge in. */
function outline(book, i, p, from = 0) {
  const half = (book.thickness[i] * FILL) / 2;
  const front = [];
  const back = [];
  for (let k = from; k < p.x.length; k++) {
    const nx = -Math.cos(p.phi[k]);
    const ny = Math.sin(p.phi[k]);
    front.push([p.x[k] + nx * half, p.y[k] + ny * half]);
    back.push([p.x[k] - nx * half, p.y[k] - ny * half]);
  }
  return [...front, ...back.reverse()];
}

/**
 * All crossings in one state: thetas[i], curls[i], closed, side, opening; with froms[i] and
 * tos[i] (where turning leaves come from and go to), every row from head to foot too, as
 * turns led by a corner lay them out (rowTurn, and layoutRows in viewer/layout.js: each row
 * lays out only the leaves that twist, over the whole layout's piles and boards).
 */
export function crossings(book, state) {
  const n = book.leafCount;
  const layout = { closed: state.closed, side: state.side ?? 1, opening: state.opening };
  const cache = {};
  const leaves = shaped(book, state);
  layoutBook(book, leaves, layout, { cache, turning: new Set(state.turning ?? []) });
  const found = new Map();
  for (const pair of crossingsAmong(book, state, leaves.map((l) => l.profile))) found.set(pair.join("/"), pair);
  if (!state.froms || book.style.spine === "coil") return [...found.values()];
  // Rigid, not twisting: a hardcover's boards and the pages a board carries, and stacks
  // turning together.
  const g = state.groups ?? [];
  const stack = (i) => !!g[i] && g.filter((x) => x === g[i]).length > 1;
  const rigid = (i) => stack(i) || (book.style.board && (i === 0 || i === n - 1 || (g[i] && (g[i] === g[0] || g[i] === g[n - 1]))));
  const only = new Set((state.turning ?? []).filter((i) => !rigid(i) && state.froms[i] !== state.tos[i]));
  if (!only.size) return [...found.values()];
  const copy = (p) => ({ x: Float64Array.from(p.x), y: Float64Array.from(p.y), phi: Float64Array.from(p.phi) });
  for (const zz of [-1, -0.5, 0.5, 1]) {
    const row = leaves.map((l, i) => {
      if (!only.has(i)) return { theta: l.theta, curl: l.curl, s: l.s, profile: l.profile, group: l.group };
      const t = rowTurn(l.theta, state.froms[i], state.tos[i], l.curl, zz);
      return { theta: t.theta, curl: t.curl, s: l.s, profile: copy(l.profile), group: l.group };
    });
    layoutBook(book, row, layout, { cache, only });
    for (const pair of crossingsAmong(book, state, row.map((l) => l.profile))) found.set(pair.join("/"), pair);
  }
  return [...found.values()];
}

/** The leaves of a state, shaped one by one (for the arrays and a hardcover's boards), as the scene does. */
function shaped(book, state) {
  const split = state.opening === 0 ? 0 : book.cum[state.opening - 1] + book.thickness[state.opening - 1] / 2;
  const leafS = (i) => leafShape(book, i).s; // as the scene shapes them
  return book.thickness.map((_, i) => ({
    theta: state.thetas[i],
    curl: state.curls?.[i] ?? 0,
    s: leafS(i),
    profile: leafProfile(book, i, state.thetas[i], state.closed, split, state.curls?.[i] ?? 0, leafS(i), undefined, state.side ?? 1),
    group: state.groups?.[i] ?? null,
  }));
}

function crossingsAmong(book, state, profiles) {
  const n = book.leafCount;
  const moving = new Set(state.turning ?? []);
  const near = (i, j) => j - i <= 2 || i === 0 || j === n - 1 || moving.has(i) || moving.has(j);
  return crossingPairs(profiles.map((p, i) => outline(book, i, p).flat()), near);
}

/** Every state worth checking for a binding: [label, state]. */
export function states(book) {
  const n = book.leafCount;
  const coil = book.style.spine === "coil";
  const rest = (j) => book.thickness.map((_, i) => restingAngle(book, i, j));
  const out = [];
  const openings = [...new Set([0, 1, 2, Math.floor(n / 2), n - 2, n - 1, n])].filter((j) => j >= 0 && j <= n);
  // As the scene has it: a glued, sewn, stitched or cased book with every page on one side
  // is shut by its cover (see #update in viewer/scene.js); a coil book lies open.
  for (const j of openings) {
    const thetas = rest(j);
    const over = thetas.map((t) => Math.min(1, Math.max(0, (90 - t) / 180)));
    const front = 1 - 2 * Math.max(...over);
    const back = 2 * Math.min(...over) - 1;
    const closed = coil ? 0 : Math.min(1, Math.max(0, front, back));
    out.push([`open at ${j}`, { opening: j, thetas, closed, side: front >= back ? 1 : -1 }]);
  }
  // Closing and opening happen at a cover: front up at opening 0, back up at the end.
  for (const [j, side] of [[0, 1], [n, -1]]) {
    for (const c of [0.25, 0.5, 0.75, 1]) out.push([`closing at ${j}, ${c}`, { opening: j, thetas: rest(j), closed: c, side }]);
  }
  // Glued, sewn, stitched and cased books open and close by their covers: the block is as
  // closed as the cover lying on it (see #update in viewer/scene.js), in one motion.
  if (!coil) {
    for (const [cover, side, from, to] of [[0, 1, 0, 1], [n - 1, -1, n, n - 1]]) {
      const a = rest(from);
      const b = rest(to);
      for (const p of [0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8]) {
        const e = easeTurn(p);
        const thetas = a.map((f, i) => f + (b[i] - f) * e);
        const over = Math.min(1, Math.max(0, (90 - thetas[cover]) / 180));
        const closed = Math.min(1, Math.max(0, side > 0 ? 1 - 2 * over : 2 * over - 1));
        const curls = a.map((f, i) => (i === cover ? turnCurl(f, b[i], p) : 0));
        out.push([`opening by the ${side > 0 ? "front" : "back"} cover, ${p}`, { opening: to, thetas, curls, closed, side, turning: [cover], froms: a, tos: b }]);
      }
    }
  }
  // Closing from a spread, and opening a closed book straight at a spread: the pile swings
  // over as one stack (one group, see layoutBook), the block as closed as it allows.
  if (!coil) {
    const mid = Math.floor(n / 2);
    const swings = [];
    for (const j of [...new Set([2, mid, n - 1])].filter((j) => j > 1 && j < n)) {
      swings.push([`closing from ${j} on the front`, j, 0, 1]);
      swings.push([`opening at ${j} from the front`, 0, j, 1]);
      swings.push([`closing from ${n - j} on the back`, n - j, n, -1]);
    }
    for (const [label, from, to, side] of swings) {
      const a = rest(from);
      const b = rest(to);
      for (const p of [0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.95]) {
        const e = easeTurn(p);
        const moving = a.map((f, i) => f !== b[i]);
        const thetas = a.map((f, i) => f + (b[i] - f) * e);
        const curls = a.map((f, i) => (moving[i] ? turnCurl(f, b[i], p) : 0));
        const over = thetas.map((t) => Math.min(1, Math.max(0, (90 - t) / 180)));
        const closed = Math.min(1, Math.max(0, side > 0 ? 1 - 2 * Math.max(...over) : 2 * Math.min(...over) - 1));
        const groups = moving.map((m) => (m ? "swing" : null));
        const turning = moving.flatMap((m, i) => (m ? [i] : []));
        out.push([`${label}, ${p}`, { opening: to, thetas, curls, closed, side, groups, turning, froms: a, tos: b }]);
      }
    }
  }
  // Turning one leaf forward from opening j (the others settle at the same pace).
  // (The covers too, but for a coil's: those turn like any page.)
  for (const j of [...new Set([coil ? 1 : 0, 1, Math.floor(n / 2), n - 2, coil ? n - 2 : n - 1])].filter((j) => j >= 0 && j < n)) {
    const from = rest(j);
    const to = rest(j + 1);
    for (const p of [0.25, 0.5, 0.75]) {
      const e = easeTurn(p);
      const thetas = from.map((f, i) => f + (to[i] - f) * e);
      const curls = from.map((f, i) => (i === j ? turnCurl(f, to[i], p) : 0));
      out.push([`turning leaf ${j}, ${p}`, { opening: j + 1, thetas, curls, closed: 0, turning: [j], froms: from, tos: to }]);
    }
  }
  // Flipping fast, as the scene does on quick clicks: each leaf starts a little after the
  // one before, so several are in the air at different points of their turns; forward,
  // back, and a leaf sent back mid-turn while the next ones still go forward.
  const flick = (j, count, dir, t, stagger = 0.3) => {
    const target = j + dir * count;
    const from = rest(j);
    const to = rest(target);
    const thetas = from.slice();
    const curls = from.map(() => 0);
    const turning = [];
    for (let m = 0; m < count; m++) {
      const i = dir > 0 ? j + m : j - 1 - m;
      const p = Math.min(1, Math.max(0, t - m * stagger));
      thetas[i] = from[i] + (to[i] - from[i]) * easeTurn(p);
      curls[i] = turnCurl(from[i], to[i], p);
      if (p > 0 && p < 1) turning.push(i);
    }
    return { opening: target, thetas, curls, closed: 0, turning, froms: from, tos: to };
  };
  const mid = Math.floor(n / 2);
  // A page close behind its cover (or a hardcover's board) as both come down: corner-led,
  // the page's leading corner gets there first.
  if (!coil) {
    for (const [t, gap] of [[0.6, 0.08], [0.85, 0.08], [0.95, 0.08], [0.8, 0.03], [0.88, 0.03], [0.93, 0.03]]) {
      for (const [j, dir, side] of [[0, 1, 1], [n, -1, -1]]) {
        const st = flick(j, 2, dir, t, gap);
        const over = st.thetas.map((th) => Math.min(1, Math.max(0, (90 - th) / 180)));
        st.closed = Math.min(1, Math.max(0, side > 0 ? 1 - 2 * Math.max(...over) : 2 * Math.min(...over) - 1));
        st.side = side;
        out.push([`a page following the ${side > 0 ? "front" : "back"} cover, ${t} (${gap} behind)`, st]);
      }
    }
  }
  for (const t of [0.35, 0.55, 0.75, 0.95, 1.15]) {
    if (mid + 4 <= n) out.push([`flicking forward from ${mid}, ${t}`, flick(mid, 4, 1, t)]);
    if (mid - 4 >= 0) out.push([`flicking back from ${mid}, ${t}`, flick(mid, 4, -1, t)]);
  }
  // Flicking forward, then back before they land: as the scene does, every leaf still in
  // the air (and the ones already over) turns back from where it is, all at once, its curl
  // fading.
  if (mid + 3 <= n) {
    for (const t of [0.5, 0.9]) {
      const st = flick(mid, 3, 1, t);
      const home = rest(mid);
      for (const q of [0.15, 0.35, 0.6]) {
        const thetas = st.thetas.slice();
        const curls = st.curls.slice();
        const turning = [];
        for (let i = mid; i < mid + 3; i++) {
          if (st.thetas[i] === home[i]) continue;
          thetas[i] = st.thetas[i] + (home[i] - st.thetas[i]) * easeTurn(q);
          curls[i] = turnCurl(st.thetas[i], home[i], q) + st.curls[i] * (1 - q) ** 2;
          turning.push(i);
        }
        out.push([`flicked forward to ${t}, back ${q}`, { opening: mid, thetas, curls, closed: 0, turning, froms: st.thetas, tos: home }]);
      }
    }
  }
  return out;
}

// A hardcover with a rounded back and its endpaper leaves, as the app makes one, as well.
const VARIANTS = [...BINDINGS.map((binding) => [binding, {}]), ["hardcover, rounded", { binding: "hardcover", roundSpine: true, endpapers: true }]];
for (const [name, variant] of VARIANTS) {
  for (const pageCount of [16, 44, 120]) {
    test(`geometry: ${name}, ${pageCount} pages: no sheet passes through another`, () => {
      const book = makeBook({ pageCount, binding: name, thickness: 0.1, coverThickness: 0.3, width: 148, height: 210, ...variant });
      const bad = [];
      for (const [label, state] of states(book)) {
        const found = crossings(book, state);
        if (found.length) bad.push(`${label}: leaves ${found.slice(0, 4).map((p) => p.join("/")).join(", ")}${found.length > 4 ? ` (+${found.length - 4})` : ""}`);
      }
      ok(!bad.length, bad.slice(0, 8).join("\n"));
    });
  }
}

// Not only apart, but together: a hardcover's board swung over with the pages it covers
// stays with them (it once kept clear by staying behind on the other side).
test("geometry: a hardcover's board carries the pages it covers when the book closes", () => {
  for (const pageCount of [16, 44, 120]) {
    const book = makeBook({ pageCount, binding: "hardcover", thickness: 0.1, coverThickness: 0.3, width: 148, height: 210 });
    const n = book.leafCount;
    const from = Math.floor(n / 2);
    const s = leafShape(book, 1).s;
    const sb = leafShape(book, 0).s;
    const a = book.thickness.map((_, i) => restingAngle(book, i, from));
    const b = book.thickness.map((_, i) => restingAngle(book, i, 0));
    for (const p of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const e = easeTurn(p);
      const thetas = a.map((f, i) => f + (b[i] - f) * e);
      const curls = a.map((f, i) => (f !== b[i] ? turnCurl(f, b[i], p) : 0));
      const over = thetas.map((t) => Math.min(1, Math.max(0, (90 - t) / 180)));
      const closed = Math.max(0, 1 - 2 * Math.max(...over));
      const leaves = book.thickness.map((_, i) => {
        const ss = i === 0 || i === n - 1 ? sb : s;
        return { theta: thetas[i], curl: curls[i], s: ss, profile: leafProfile(book, i, thetas[i], closed, 0, curls[i], ss), group: a[i] !== b[i] ? "swing" : null };
      });
      layoutBook(book, leaves, { closed, side: 1, opening: 0 });
      // The page's direction half way out against the board's.
      const page = leaves[1].profile;
      const k = Math.floor(page.phi.length * 0.7);
      const diff = Math.abs(page.phi[k] - leaves[0].profile.phi[0]) * 180 / Math.PI;
      ok(diff < 25, `${pageCount} pages, ${p} of the way: the board is ${diff.toFixed(0)}° from the first page`);
    }
  }
});

// A board turning on its own (opening and closing a hardcover by its cover) turns smoothly
// with its own angle, every step of the way (it once jumped about, searching for a clear
// place).
test("geometry: a hardcover's board follows its own turn when opening and closing", () => {
  for (const pageCount of [16, 44, 120]) {
    const book = makeBook({ pageCount, binding: "hardcover", thickness: 0.1, coverThickness: 0.3, width: 148, height: 210 });
    const n = book.leafCount;
    const s = leafShape(book, 1).s;
    const sb = leafShape(book, 0).s;
    for (const [label, bi, from, to, side] of [["front open", 0, 0, 1, 1], ["front close", 0, 1, 0, 1], ["back open", n - 1, n, n - 1, -1], ["back close", n - 1, n - 1, n, -1]]) {
      const a = book.thickness.map((_, i) => restingAngle(book, i, from));
      const b = book.thickness.map((_, i) => restingAngle(book, i, to));
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const e = easeTurn(p);
        const thetas = a.map((f, i) => f + (b[i] - f) * e);
        const curls = a.map((f, i) => (f !== b[i] ? turnCurl(f, b[i], p) : 0));
        const over = thetas.map((t) => Math.min(1, Math.max(0, (90 - t) / 180)));
        const closed = Math.min(1, Math.max(0, side > 0 ? 1 - 2 * Math.max(...over) : 2 * Math.min(...over) - 1));
        const leaves = book.thickness.map((_, i) => {
          const ss = i === 0 || i === n - 1 ? sb : s;
          return { theta: thetas[i], curl: curls[i], s: ss, profile: leafProfile(book, i, thetas[i], closed, 0, curls[i], ss), group: null };
        });
        layoutBook(book, leaves, { closed, side, opening: to });
        const diff = Math.abs(leaves[bi].profile.phi[0] * 180 / Math.PI - thetas[bi]);
        ok(diff < 8, `${pageCount} pages, ${label}, ${p.toFixed(2)}: the board is ${diff.toFixed(0)}° off its turn`);
      }
    }
  }
});
