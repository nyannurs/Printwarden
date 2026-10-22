// The timeline under the viewport, in two views:
//  - Reading order: facing pairs. The first and last cells are single (front and back
//    cover); a single cell mid-strip would mean the pairing broke.
//  - Press sheets: sheet sides as printed, e.g. 44 | 1 then 2 | 43. For an imposed file
//    this is the file itself; for a normal file it is how it will be imposed.

import { hasWire } from "../core/binding.js";
import { addScrollbar } from "./dom.js";
import { label } from "../core/book.js";
import { openingOf } from "../core/pairing.js";

export class Filmstrip {
  /**
   * @param {HTMLElement} el
   * @param {{onSelect: (opening: number) => void,
   *          thumbnail: (folio: number) => Promise<{width: number, height: number, data: Uint8Array} | null>,
   *          ink: import("./inkview.js").InkView,
   *          toggleHost: HTMLElement}} deps `thumbnail`: a page's inks, small; `ink`: draws them
   *   as the colour they print; `toggleHost`: where Reading order / Press sheets go
   */
  constructor(el, deps) {
    this.el = el;
    this.deps = deps;
    this.mode = "reading";
    this.cells = [];
    /** @type {Map<HTMLElement, {width: number, height: number, data: Uint8Array}>} a page's cell -> its inks, for drawing again */
    this.thumbs = new Map();

    this.toggle = document.createElement("div");
    this.toggle.className = "pill-row";
    this.toggle.setAttribute("role", "tablist");
    for (const [mode, text] of [["reading", "Reading order"], ["sheets", "Press sheets"]]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill";
      b.textContent = text;
      b.dataset.mode = mode;
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => this.setMode(mode));
      this.toggle.append(b);
    }
    deps.toggleHost.append(this.toggle);
    this.note = document.createElement("span");
    this.note.className = "strip-note";

    this.strip = document.createElement("div");
    this.strip.className = "strip";
    el.append(this.strip, this.note);
    addScrollbar(this.strip, "x");

    this.observer = new IntersectionObserver((entries) => this.#onVisible(entries), {
      root: this.strip,
      rootMargin: "0px 600px",
    });
    this.strip.addEventListener("wheel", (e) => {
      // A vertical wheel scrolls the strip sideways.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        this.strip.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }, { passive: false });
    this.#syncToggle();
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.#syncToggle();
    if (this.analysis) {
      this.render(this.analysis, this.pageSize);
      this.setActive(this.opening ?? 0);
    }
  }

  /** @param {ReturnType<typeof import("../core/analysis.js").analyse>} analysis */
  render(analysis, pageSize) {
    // A hardcover's flyleaves in the timeline: the endpaper stock's colour.
    const paper = analysis.setup.paper;
    this.el.style.setProperty("--endpaper", paper.endpaperColor ?? paper.color);
    this.analysis = analysis;
    this.pageSize = pageSize;
    this.observer.disconnect();
    this.strip.replaceChildren();
    this.thumbs.clear();
    const { book, pairs, layout, findings, imposed } = analysis;
    const flagged = new Set(findings.filter((f) => f.severity === "error").flatMap((f) => f.folios));

    let items;
    if (this.mode === "reading") {
      items = pairs.map((pair, i) => ({
        pages: [pair.left, pair.right].filter(Boolean),
        caption: [pair.left, pair.right].filter(Boolean).map((p) => label(book, p.number)).join(" • "),
        opening: i,
      }));
      this.note.textContent = "";
    } else if (layout && !(imposed && analysis.hasErrors)) {
      // A scheme sheet's cells in their rows (the upper row upside down), else the spread.
      items = layout.sides.map((side) => {
        const cells = side.cells?.flat() ?? [{ page: side.left, turned: false }, { page: side.right, turned: false }];
        return {
          pages: cells.map((c) => book.pages[c.page - 1]),
          turned: cells.map((c) => c.turned),
          cols: side.cols ?? 2,
          caption: cells.map((c) => label(book, c.page)).join(" • "),
          sub: side.cover ? `Cover ${side.side}` : `Sheet ${side.sheet} ${side.side}`,
          opening: openingOf(Math.min(side.left, side.right)),
        };
      });
      this.note.textContent = "";
    } else {
      items = [];
      // A coil book is loose leaves: nothing folds, so nothing is imposed (and nothing is wrong).
      this.note.textContent = hasWire(analysis.rule.binding) ? "Loose leaves: nothing to fold or impose." : "No press sheets: see Preflight.";
    }

    this.cells = items.map((item) => {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.folios = item.pages.map((p) => p.number).join(",");
      const pages = document.createElement("div");
      pages.className = "pages";
      if (item.cols > 2) {
        pages.classList.add("grid");
        pages.style.setProperty("--cols", String(item.cols));
      }
      for (const [k, page] of item.pages.entries()) {
        const div = document.createElement("div");
        div.className = "page" + (page.source ? "" : page.endpaper ? " endpaper" : " blank") + (item.turned?.[k] ? " turned" : "");
        div.style.aspectRatio = `${pageSize.width} / ${pageSize.height}`; // as tall as the timeline lets it
        div.dataset.folio = String(page.number);
        pages.append(div);
        if (flagged.has(page.number)) cell.classList.add("flagged");
      }
      const caption = document.createElement("div");
      caption.className = "caption";
      caption.textContent = item.caption;
      cell.append(pages, caption);
      if (item.sub) {
        const sub = document.createElement("div");
        sub.className = "sub";
        sub.textContent = item.sub;
        cell.append(sub);
      }
      cell.addEventListener("click", () => this.deps.onSelect(item.opening));
      this.strip.append(cell);
      this.observer.observe(cell);
      return { cell, opening: item.opening, folios: item.pages.map((p) => p.number) };
    });
  }

  /** Highlight what is open in the book. */
  setActive(opening) {
    this.opening = opening;
    const visible = new Set([2 * opening, 2 * opening + 1]);
    let first = null;
    for (const c of this.cells) {
      const on = this.mode === "reading" ? c.opening === opening : c.folios.some((f) => visible.has(f));
      c.cell.classList.toggle("active", on);
      if (on && !first) first = c.cell;
    }
    first?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }

  #syncToggle() {
    for (const b of this.toggle.querySelectorAll("button")) {
      const on = b.dataset.mode === this.mode;
      b.setAttribute("aria-selected", String(on));
      b.classList.toggle("on", on);
    }
  }

  #onVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      this.observer.unobserve(entry.target);
      for (const div of entry.target.querySelectorAll(".page:not(.blank)")) {
        this.deps.thumbnail(Number(div.dataset.folio)).then((ink) => {
          if (!ink || !div.isConnected) return; // a page that rendered blank, or gone
          this.thumbs.set(div, ink);
          this.#draw(div, ink);
        }).catch(() => {});
      }
    }
  }

  /** A thumbnail from its inks, through the converter (the profile and the plates as now). */
  #draw(div, ink) {
    const bitmap = this.deps.ink.draw(ink);
    if (!bitmap) return; // no table yet: drawn when it comes (refreshInk)
    let c = div.firstChild;
    if (!(c instanceof HTMLCanvasElement)) {
      c = document.createElement("canvas");
      div.replaceChildren(c);
    }
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext("bitmaprenderer").transferFromImageBitmap(bitmap);
  }

  /** Every thumbnail drawn again from its inks: the profile or the plates changed. */
  refreshInk() {
    for (const [div, ink] of this.thumbs) {
      if (div.isConnected) this.#draw(div, ink);
      else this.thumbs.delete(div);
    }
  }
}
