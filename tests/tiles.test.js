// The tile cache's geometry and bookkeeping (viewer/tiles.js), and the mips (pdf/mips.js).

import { halve, mipChain } from "../app/pdf/mips.js";
import {
  TILE, TILE_BORDER, TILE_MAX_LEVEL, TILE_PAYLOAD, tileAt, tileBudget, tileGrid, TileIndex, tileKey, tileLevel, tilePage, tileRect,
} from "../app/viewer/tiles.js";
import { eq, ok, test } from "./harness.js";

const A4 = { width: 210, height: 297 };
const trim = { x0: 10, y0: 10, x1: 220, y1: 307 };

test("TILES: a page's pyramid: level 0 is the base image's density, each level twice as fine", () => {
  const page = tilePage(1400, A4);
  ok(Math.abs(page.scale0 - 1400 / 297) < 1e-9, "texels per mm at level 0");
  ok(Math.abs(page.w0 - (1400 * 210) / 297) < 1e-9, "width in level-0 texels");
  eq(tileGrid(page, 0), { cols: 1, rows: 2 });
  eq(tileGrid(page, 1), { cols: 2, rows: 3 });
  eq(tileGrid(page, TILE_MAX_LEVEL), { cols: Math.ceil((page.w0 * 32) / TILE_PAYLOAD), rows: Math.ceil((44800) / TILE_PAYLOAD) });
  eq([page.cols, page.rows], [Math.ceil((page.w0 * 32) / TILE_PAYLOAD), 45]);
});

test("TILES: the level a density needs: the first with 1.25 texels a pixel, 0 where the base has that", () => {
  const scale0 = 1400 / 297; // 4.71 texels per mm
  eq(tileLevel(2, scale0), 0); // 2 px/mm on screen: the base's 4.7 is plenty
  eq(tileLevel(3.77, scale0), 0); // 3.77 × 1.25 = 4.71: just enough
  eq(tileLevel(3.8, scale0), 1);
  eq(tileLevel(7.5, scale0), 1); // 9.4 needed, level 1 has 9.4
  eq(tileLevel(7.6, scale0), 2);
  eq(tileLevel(59, scale0), 4); // 800 % on a Retina screen: 74 needed, level 4 has 75
  eq(tileLevel(1000, scale0), TILE_MAX_LEVEL, "capped");
  eq(tileLevel(0, scale0), 0);
});

test("TILES: a tile's place and rectangle: square at its level's scale, the border past its payload", () => {
  const page = tilePage(1400, A4);
  eq(tileAt(page, 1, 0, 0), { ix: 0, iy: 0 });
  eq(tileAt(page, 1, 0.999, 0.999), { ix: 1, iy: 2 });
  eq(tileAt(page, 2, 0.5, 0.5), { ix: Math.floor((0.5 * page.w0 * 4) / TILE_PAYLOAD), iy: Math.floor((0.5 * 1400 * 4) / TILE_PAYLOAD) });
  const r = tileRect(page, 2, 1, 2, trim);
  const scale = page.scale0 * 4;
  ok(Math.abs((r.x1 - r.x0) - TILE / scale) < 1e-9 && Math.abs((r.y1 - r.y0) - TILE / scale) < 1e-9, "TILE texels square");
  ok(Math.abs(r.x0 - (trim.x0 + (TILE_PAYLOAD - TILE_BORDER) / scale)) < 1e-9, "starts a border before its payload");
  ok(Math.abs(r.y1 - (trim.y1 - (2 * TILE_PAYLOAD - TILE_BORDER) / scale)) < 1e-9, "the head is PDF's top (y up)");
  const first = tileRect(page, 1, 0, 0, trim);
  ok(first.x0 < trim.x0 && first.y1 > trim.y1, "the first tile's border lies outside the page");
});

test("TILES: the index keeps tiles, evicts the least recently drawn that this view didn't use, and writes the tables", () => {
  const page = tilePage(1400, A4);
  const index = new TileIndex(3);
  index.nextFrame();
  eq(index.place(5, 1, 0, 0, page, 1000)?.layer, 0);
  eq(index.place(5, 1, 1, 0, page, 1000)?.layer, 1);
  eq(index.place(6, 2, 3, 4, page, 1000)?.layer, 2);
  ok(index.has(tileKey(5, 1, 0, 0)) && index.has(tileKey(6, 2, 3, 4)), "listed");
  const t = index.tables.get(5);
  eq([t.width, t.height], [2 * page.cols, page.rows * (TILE_MAX_LEVEL + 1)], "two entries a tile position");
  const at = (level, ix, iy) => ((level * page.rows + iy) * t.width + 2 * ix) * 4;
  eq([...t.data.subarray(at(1, 0, 0), at(1, 0, 0) + 4)], [0, 0, 255, 0], "layer 0, there, not faded in");
  eq([...t.data.subarray(at(1, 1, 0), at(1, 1, 0) + 4)], [1, 0, 255, 0]);
  eq([...t.data.subarray(at(1, 0, 1), at(1, 0, 1) + 4)], [0, 0, 0, 0], "no tile: not there");
  // Full, all used this view: no room.
  eq(index.place(7, 1, 0, 0, page, 1000), null);
  // A new view uses two of them: the third goes.
  index.nextFrame();
  index.touch(tileKey(5, 1, 0, 0));
  index.touch(tileKey(6, 2, 3, 4));
  eq(index.place(7, 1, 0, 0, page, 1200)?.layer, 1, "took the layer of the tile not drawn by this view");
  ok(!index.has(tileKey(5, 1, 1, 0)), "evicted");
  eq([...t.data.subarray(at(1, 1, 0), at(1, 1, 0) + 4)], [0, 0, 0, 0], "its entry cleared");
  // Fading in: alpha climbs to 255 and then stays.
  ok(index.fade(1200 + 80), "still fading");
  const t7 = index.tables.get(7);
  const a7 = t7.data[at(1, 0, 0) + 3];
  ok(a7 > 100 && a7 < 160, `half way: ${a7}`);
  ok(!index.fade(1200 + 1000), "faded");
  eq(t7.data[at(1, 0, 0) + 3], 255);
  index.forgetPage(5);
  ok(!index.has(tileKey(5, 1, 0, 0)) && !index.tables.has(5), "page forgotten");
  eq(index.free, 1);
});

test("TILES: pages numbered anew (a hardcover's endpapers move every page two on) keep their tiles, layers and tables; a page left out is let go", () => {
  const page = tilePage(1400, A4);
  const index = new TileIndex(4);
  index.nextFrame();
  index.place(3, 1, 0, 0, page, 1000, "inks");
  index.place(3, 2, 1, 1, page, 1000, "inks");
  index.place(4, 1, 0, 0, page, 1000, "inks");
  index.place(9, 1, 0, 0, page, 1000, "inks");
  const table3 = index.tables.get(3);
  const layers = [tileKey(3, 1, 0, 0), tileKey(3, 2, 1, 1), tileKey(4, 1, 0, 0)].map((k) => index.byKey.get(k)?.layer);
  index.renumber(new Map([[3, 5], [4, 6]])); // 9 shown nowhere now
  eq([tileKey(5, 1, 0, 0), tileKey(5, 2, 1, 1), tileKey(6, 1, 0, 0)].map((k) => index.byKey.get(k)?.layer), layers, "the same layers, under the new folios");
  ok(index.has(tileKey(5, 1, 0, 0), "inks"), "with their stamps");
  ok(!index.has(tileKey(3, 1, 0, 0)) && !index.tables.has(3) && !index.tables.has(4), "nothing left under the old folios");
  eq(index.tables.get(5), table3, "the table goes with its page");
  ok(!index.has(tileKey(9, 1, 0, 0)) && !index.tables.has(9), "a page shown nowhere let go");
  eq(index.free, 1, "its layer freed");
  eq(index.byKey.get(tileKey(6, 1, 0, 0))?.folio, 6);
});

test("TILES: a tile with an outdated stamp (the profile, a spot plate) is drawn till its new one takes its layer, without a fade", () => {
  const page = tilePage(1400, A4);
  const index = new TileIndex(4);
  index.nextFrame();
  const key = tileKey(3, 1, 0, 0);
  eq(index.place(3, 1, 0, 0, page, 1000, "eci|")?.layer, 0);
  index.fade(5000); // faded in
  ok(index.has(key) && index.has(key, "eci|"), "kept, as drawn");
  ok(!index.has(key, "swop|"), "not as the new profile wants it: asked for again");
  const t = index.tables.get(3);
  const at = ((1 * page.rows + 0) * t.width + 0) * 4; // (tile 0, 0: its first entry)
  eq([...t.data.subarray(at, at + 4)], [0, 0, 255, 255], "still drawn meanwhile");
  eq(index.place(3, 1, 0, 0, page, 6000, "swop|")?.layer, 0, "the new one in the same layer");
  ok(index.has(key, "swop|"), "now as wanted");
  eq(index.free, 3, "no second layer taken");
  eq(t.data[at + 3], 255, "no fade: the page never shows less in between");
  ok(!index.fade(6000), "nothing fading");
});

test("TILES: a tile with spot channels takes a second layer, named in its second entry; letting it go frees both", () => {
  const page = tilePage(1400, A4);
  const index = new TileIndex(3);
  index.nextFrame();
  const r = index.place(2, 1, 0, 0, page, 1000, "", true);
  eq([r?.layer, r?.spotLayer], [0, 1]);
  eq(index.free, 1);
  const t = index.tables.get(2);
  const o = (1 * page.rows + 0) * t.width * 4; // level 1, tile 0, 0: its two entries
  eq([...t.data.subarray(o, o + 8)], [0, 0, 255, 0, 1, 0, 255, 255], "its layer, then its spot layer");
  // Another with spots needs two layers: one is free, the other is the first tile's (not drawn by this view).
  index.nextFrame();
  const q = index.place(2, 1, 1, 0, page, 1100, "", true);
  ok(q && q.spotLayer >= 0, "placed, the first let go");
  ok(!index.has(tileKey(2, 1, 0, 0)), "the first tile let go");
  eq([...t.data.subarray(o, o + 8)], [0, 0, 0, 0, 0, 0, 0, 0], "both its entries cleared");
  eq(index.free, 1, "of the first's two layers, one taken");
  // A pair needs two: one is free, the other in use by this view. None taken, nothing changed.
  eq(index.place(4, 1, 0, 0, page, 1200, "", true), null);
  eq(index.free, 1);
  ok(index.has(tileKey(2, 1, 1, 0)), "the one this view uses kept");
  index.forgetPage(2);
  eq(index.free, 3, "a page let go frees its tiles' layers, spot layers too");
});

test("TILES: the budget: a 24th of memory, 256 MB to 1 GB", () => {
  eq(tileBudget(4 * 2 ** 30), 256 * 2 ** 20);
  eq(tileBudget(16 * 2 ** 30), Math.floor((16 * 2 ** 30) / 24));
  eq(tileBudget(64 * 2 ** 30), 2 ** 30);
});

test("MIPS: half size is the mean of 2 × 2, odd edges take what's there", () => {
  const w = 3, h = 2;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i * 10, 100, 0, 255], i * 4);
  const m = halve(data, w, h);
  eq([m.width, m.height], [1, 1]);
  eq([...m.data], [Math.round((0 + 10 + 30 + 40) / 4), 100, 0, 255]);
  const chain = mipChain(new Uint8Array(8 * 8 * 4).fill(200), 8, 8, 2);
  eq(chain.map((c) => c.length), [4 * 4 * 4, 2 * 2 * 4]);
  ok(chain[1].every((v) => v === 200), "flat stays flat");
});
