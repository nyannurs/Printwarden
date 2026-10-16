// The side panel: what was detected, the InDesign-style document setup, binding
// options, and findings with one-click fixes.

import { BINDING_LABELS, hasWire, WIRE_COLORS } from "../core/binding.js";
import { label } from "../core/book.js";
import { SpreadMode } from "../core/detect.js";
import { caliperUm, coverOf, PAPER_COLORS, PAPER_FINISHES } from "../core/paper.js";
import { bookThicknessMm, hasSpine } from "../core/spine.js";
import { formatMm, formatSize, paperName } from "../core/units.js";
import { snapToPixels } from "./dom.js";

const SIDES = ["top", "bottom", "inside", "outside"];

// The control to give the focus back to once the panel is rebuilt (its data-key): one stepped
// with the arrow keys or committed with Enter, or a dropdown just chosen from. (Not one left
// with Tab: the focus is on its way to the next control then.)
let refocus = null;

const BACKGROUNDS = [
  { label: "Studio gray", hex: "#56575b" },
  { label: "Dark", hex: "#232427" },
  { label: "Light gray", hex: "#c4c4c1" },
  { label: "White", hex: "#f2f2f0" },
];

export class Inspector {
  /**
   * @param {HTMLElement} el
   * @param {{onSetup: (patch: object) => void, onGoToFolio: (folio: number) => void,
   *          onPaperPreview: (colors: {color?: string, coverColor?: string}) => void,
   *          onWirePreview: (color: string) => void,
   *          onColourProfile: (id: string) => void, onSpine: () => void, onFinish: () => void,
   *          onBackground: (color: string, commit: boolean) => void, background: () => string,
   *          onAbout: () => void}} deps
   */
  constructor(el, deps) {
    this.el = el;
    this.deps = deps;
    this.linked = { bleed: true, slug: true };
  }

  render(analysis, docName, colour = null) {
    const { setup, book, findings } = analysis;
    const page = setup.page;
    this.lastAnalysis = analysis;
    this.lastDocName = docName;
    this.lastColour = colour;
    for (const key of ["bleed", "slug"]) {
      const s = page[key];
      if (!SIDES.every((k) => s[k] === s.top)) this.linked[key] = false;
    }
    this.el.replaceChildren(
      this.#docSection(analysis, docName),
      this.#setupSection(page),
      this.#bindingSection(setup, analysis.imposed),
      this.#paperSection(setup),
      this.#backgroundSection(),
      ...(colour ? [this.#colourSection(colour)] : []),
      this.#findingsSection(findings, book, colour),
      this.#aboutSection(),
    );
    if (refocus) {
      /** @type {HTMLElement} */ (this.el.querySelector(`[data-key="${CSS.escape(refocus)}"]`))?.focus();
      refocus = null;
    }
  }

  /** Last, under Preflight: About, across the panel. */
  #aboutSection() {
    const s = el("section", "section about");
    s.append(button("About", () => this.deps.onAbout()));
    return s;
  }

  #docSection(a, docName) {
    const size = a.geometry.find(Boolean)?.size;
    const name = size && paperName(size);
    const formats = {
      "all-single": "Single pages",
      "all-spreads": "Spreads",
      "spreads-with-single-covers": "Spreads, single covers",
      mixed: "Mixed – check export",
      imposed: "Imposed sheets",
    };
    const c = a.coverFile;
    return section("Document", null, facts([
      ["File", docName],
      ...(c ? [["Cover", `${c.name}${c.spineMm > 0.05 ? ` • spine ${formatMm(c.spineMm)} mm` : ""}${c.flapMm > 0.5 ? ` • flaps ${formatMm(c.flapMm)} mm` : ""}`]] : []),
      [a.imposed ? "Sheet sides" : "PDF pages", a.document.pages.length],
      ["Book pages", a.book.pages.length],
      ["Page size", size ? formatSize(size) + (name ? ` • ${name}` : "") : "–"],
      ["Format", formats[a.detection.pattern] + (a.detection.mode === SpreadMode.AUTO && !a.imposed ? ", detected" : "")],
      ["Closed", `about ${formatMm(bookThicknessMm(a.setup, a.book.pages.length))} mm thick`],
    ]));
  }

  #setupSection(page) {
    const manual = page.mode === "manual";
    const note = el("p", "mode-note");
    if (manual) note.append(button("Use PDF values", () => this.deps.onSetup({ page: null }), "btn link-btn"));

    const edit = (mutate) => {
      const next = structuredClone({ ...page, mode: "manual" });
      delete next.fromBoxes;
      mutate(next);
      this.deps.onSetup({ page: next });
    };

    const dims = el("div", "dims");
    dims.append(
      numberInput("Width", page.width, (v) => edit((p) => { p.width = v; }), { min: 10, key: "width" }),
      numberInput("Height", page.height, (v) => edit((p) => { p.height = v; }), { min: 10, key: "height" }),
    );

    const group = (key, title) => {
      const wrap = el("div", "box-group");
      const head = el("div", "box-group-head");
      const strong = el("strong");
      strong.textContent = title;
      const link = button(this.linked[key] ? "Linked" : "Unlinked", () => {
        this.linked[key] = !this.linked[key];
        const uneven = !SIDES.every((k) => page[key][k] === page[key].top);
        if (this.linked[key] && uneven) edit((p) => { for (const k of SIDES) p[key][k] = p[key].top; });
        else this.render(this.lastAnalysis, this.lastDocName, this.lastColour);
      }, "btn link-btn");
      link.setAttribute("aria-pressed", String(this.linked[key]));
      head.append(strong, link);
      const grid = el("div", "dims");
      for (const side of SIDES) {
        grid.append(numberInput(cap(side), page[key][side], (v) => edit((p) => {
          if (this.linked[key]) for (const k of SIDES) p[key][k] = v;
          else p[key][side] = v;
        }), { min: 0, key: `${key}-${side}` }));
      }
      wrap.append(head, grid);
      return wrap;
    };

    return section("Document setup", manual ? "Manual" : null, ...(manual ? [note] : []), dims, group("bleed", "Bleed"), group("slug", "Slug"));
  }

  #bindingSection(setup, imposed) {
    const rows = [];
    if (!imposed) rows.push(field("Pages are", select(
      [[SpreadMode.AUTO, "Detect automatically"], [SpreadMode.SINGLE, "Single pages"], [SpreadMode.SPREADS, "Spreads"]],
      setup.spreadMode, (v) => this.deps.onSetup({ spreadMode: v }),
    )));
    rows.push(field("Binding", select(
      Object.entries(BINDING_LABELS), setup.binding,
      (v) => this.deps.onSetup({ binding: v, signaturePages: null }),
    )));
    if (setup.binding === "perfect" || setup.binding === "sewn" || setup.binding === "hardcover") {
      const current = setup.signaturePages ?? (setup.binding === "perfect" ? 4 : 16);
      rows.push(field("Signature", select(
        [4, 8, 12, 16, 32].map((n) => [String(n), `${n} pages`]), String(current),
        (v) => this.deps.onSetup({ signaturePages: Number(v) }),
      )));
    }
    if (hasWire(setup.binding)) {
      rows.push(field("Wire", colourSwatches(WIRE_COLORS, setup.wire, "wire", {
        pick: (hex) => this.deps.onSetup({ wire: hex }),
        preview: (hex) => this.deps.onWirePreview(hex),
      })));
    }
    if (hasSpine(setup.binding)) rows.push(field("Book spine", button("Select", () => this.deps.onSpine(), "btn")));
    return section("Binding", null, ...rows);
  }

  #paperSection(setup) {
    const paper = setup.paper;
    const cover = coverOf(paper);
    const set = (patch) => this.deps.onSetup({ paper: { ...paper, ...patch } });
    const finishes = Object.entries(PAPER_FINISHES).map(([k, v]) => [k, v.label]);
    const gsm = (v, max) => Math.max(40, Math.min(max, v));
    const volume = (um, weight) => Math.max(0.5, Math.min(3, um / weight));

    const rows = [
      field("Paper color", colourSwatches(PAPER_COLORS, paper.color, "paper", {
        pick: (hex) => set({ color: hex }),
        preview: (hex) => this.deps.onPaperPreview({ color: hex }),
      })),
      field("Cover color", colourSwatches(PAPER_COLORS, cover.color, "cover", {
        pick: (hex) => set({ coverColor: hex }),
        preview: (hex) => this.deps.onPaperPreview({ coverColor: hex }),
      })),
      // Another finish is another paper: its thickness goes back to the finish's typical.
      field("Paper finish", select(finishes, paper.finish, (v) => set({ finish: v, volume: null }))),
      field("Cover finish", select(finishes, cover.finish, (v) => set({ coverFinish: v, coverVolume: null }))),
      field("Paper weight", unitNumber(paper.gsm, "gsm", (v) => set({ gsm: gsm(v, 400) }), { min: 40, step: 5 })),
      field("Cover weight", unitNumber(cover.gsm, "gsm", (v) => set({ coverGsm: gsm(v, 450) }), { min: 40, step: 5 })),
      // The caliper, as a printer quotes it: kept as the paper's volume (see paper.js), so it
      // follows the weight. Half to three times the weight in µm: the papers there are.
      field("Paper thickness", unitNumber(caliperUm(paper), "µm", (v) => set({ volume: volume(v, paper.gsm) }), { min: 20, step: 5, key: "paper-caliper" })),
      field("Cover thickness", unitNumber(caliperUm(cover), "µm", (v) => set({ coverVolume: volume(v, cover.gsm) }), { min: 20, step: 5, key: "cover-caliper" })),
      field("Spot finish", button("Select", () => this.deps.onFinish(), "btn")),
    ];
    return section("Paper", null, ...rows);
  }

  #backgroundSection() {
    const swatches = colourSwatches(BACKGROUNDS, this.deps.background(), "background", {
      pick: (hex) => this.deps.onBackground(hex, true),
      preview: (hex) => this.deps.onBackground(hex, false),
    });
    return section("Background", null, field("Color", swatches));
  }

  #colourSection(colour) {
    const profile = select(colour.options.map((o) => [o.id, o.name]), colour.choice, (id) => this.deps.onColourProfile(id));
    const row = field("CMYK profile", profile);
    row.classList.add("wide"); // profile names run long: the panel's whole width
    return section("Color", null, row);
  }

  #findingsSection(findings, book, colour) {
    const list = el("ul", "findings");
    // The file names its own CMYK profile, and another was chosen (it sticks): said, so colours
    // shown otherwise than the file asks are never a surprise.
    const intent = colour?.options.find((o) => o.id === "intent");
    if (intent && colour.choice !== "intent") {
      const shown = colour.options.find((o) => o.id === colour.choice)?.name ?? colour.choice;
      findings = [...findings, { severity: "info", code: "profile-chosen", folios: [],
        message: `The PDF names its own CMYK profile, ${intent.name.replace(/^From PDF: /, "")}. It is shown with ${shown}, as chosen under Color.` }];
    } else if (colour) {
      // Which profile the colours follow, and what it reaches: plain CMYK only. (A print
      // designer compared two FOGRA39 profiles and saw no change: there is almost none.)
      const shown = colour.options.find((o) => o.id === colour.choice)?.name.replace(/^(Included|From PDF): /, "") ?? colour.choice;
      findings = [...findings, { severity: "info", code: "profile", folios: [],
        message: `Plain CMYK is shown with ${shown}. Images with their own profile and RGB keep their colors, whatever is chosen.` }];
    }
    if (!findings.length) list.append(Object.assign(el("li", "muted"), { textContent: "Nothing to report." }));
    for (const f of findings) {
      const li = el("li", `finding ${f.severity}`);
      const sev = el("div", "sev");
      sev.textContent = f.severity;
      const p = el("p");
      p.textContent = f.message;
      li.append(sev, p);
      if (f.folios.length) {
        li.append(button(`Show page ${label(book, f.folios[0])}`, () => this.deps.onGoToFolio(f.folios[0]), "btn goto"));
      }
      list.append(li);
    }
    const errors = findings.filter((f) => f.severity === "error").length;
    return section("Preflight", errors ? `${errors} error${errors > 1 ? "s" : ""}` : null, list);
  }
}

// --- tiny DOM helpers ------------------------------------------------------------

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

/**
 * A row of colour presets and a custom colour: a round swatch with a rainbow ring (it opens
 * the system colour picker). `preview` runs live while picking, `pick` once chosen.
 */
function colourSwatches(presets, current, what, { pick, preview }) {
  const now = current.toLowerCase();
  const row = el("div", "swatches");
  for (const c of presets) {
    const b = button("", () => pick(c.hex), "swatch");
    b.style.background = c.hex;
    b.setAttribute("aria-label", c.label);
    b.setAttribute("aria-pressed", String(now === c.hex));
    row.append(b);
  }
  const custom = el("input", "custom-swatch");
  custom.type = "color";
  custom.value = now;
  custom.setAttribute("aria-label", `Custom ${what} color`);
  if (!presets.some((c) => c.hex === now)) custom.classList.add("chosen");
  custom.addEventListener("input", () => preview(custom.value));
  custom.addEventListener("change", () => pick(custom.value));
  row.append(custom);
  // Spread across the column, the room between them comes in fractions: each on a whole pixel
  // (dom.js), again when the row's width changes (a scrollbar appearing).
  snapToPixels([row], { x: false, y: false });
  snapToPixels([...row.children], { y: false });
  return row;
}

function section(title, badge, ...children) {
  const s = el("section", "section");
  const h = el("h2");
  h.textContent = title;
  if (badge) {
    const b = el("span", "badge");
    b.textContent = badge;
    h.append(b);
  }
  s.append(h, ...children);
  return s;
}

function facts(rows) {
  const dl = el("dl", "facts");
  for (const [k, v] of rows) {
    const dt = el("dt");
    dt.textContent = k;
    const dd = el("dd");
    dd.textContent = String(v);
    dl.append(dt, dd);
  }
  return dl;
}

function button(text, onClick, className = "btn") {
  const b = el("button", className);
  b.type = "button";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}

function field(labelText, control) {
  const row = el("div", "field");
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  const l = el("label");
  l.textContent = labelText;
  l.htmlFor = id;
  control.id = id;
  control.dataset.key ??= labelText; // see refocus
  row.append(l, control);
  return row;
}

function select(options, value, onChange) {
  const s = el("select");
  for (const [v, text] of options) s.append(new Option(text, v, false, v === value));
  s.addEventListener("change", () => {
    refocus = s.dataset.key ?? null;
    onChange(s.value);
  });
  return s;
}

/** A number shown with its unit ("80 gsm"); typed with or without it; arrow keys step it. */
function unitNumber(value, unit, onChange, { min = 0, step = 1, key = null } = {}) {
  const input = el("input");
  input.type = "text";
  input.inputMode = "decimal";
  input.className = "unit-number";
  if (key) input.dataset.key = key;
  const show = (v) => { input.value = `${formatMm(v)} ${unit}`; };
  show(value);
  const commit = (v) => {
    if (Number.isFinite(v) && v >= min) {
      show(v);
      onChange(v);
    } else show(value);
  };
  input.addEventListener("change", () => commit(Number.parseFloat(input.value.replace(",", "."))));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") refocus = input.dataset.key ?? null; // its change follows
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    refocus = input.dataset.key ?? null;
    const v = Number.parseFloat(input.value.replace(",", ".")) || value;
    commit(Math.max(min, v + (e.key === "ArrowUp" ? step : -step)));
  });
  return input;
}

function numberInput(labelText, value, onChange, { min = 0, key = null } = {}) {
  const wrap = el("label", "num");
  const span = el("span");
  span.textContent = labelText;
  wrap.append(span, unitNumber(value, "mm", onChange, { min, step: 0.5, key }));
  return wrap;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
