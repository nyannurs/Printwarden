// The app's dialogs: import, export, screenshot, video, spot finish, book spine, About and
// its licenses, and reports.

import { Binding, BINDING_LABELS } from "../core/binding.js";
import { defaultExportOptions, planSheets, SHEET_PRESETS } from "../core/sheets.js";
import { formatMm } from "../core/units.js";
import { readImposition } from "../pdf/load.js";
import { pickPdf } from "../platform.js";
import { addScrollbar } from "./dom.js";

/**
 * Ask what to import. Resolves to {file, source, binding, signaturePages, coverSheet, cover} or null.
 * coverSheet: false for an imposed file exported before covers had a sheet of their own.
 * cover: a separate cover file, or null (see coverPages in analysis.js).
 * @param {{name: string, bytes: Uint8Array} | null} initialFile  e.g. from drag and drop
 */
export function importDialog(initialFile = null) {
  return new Promise((resolve) => {
    let file = initialFile;
    let cover = null;
    const d = dialog("Import PDF");
    const fileName = el("span", "file-name");
    const choose = button("Choose PDF", async () => {
      const picked = await pickPdf();
      if (picked) setFile(picked);
    });
    const fileRow = row("File", el("div", "file-row", [fileName, choose]));
    // The cover as a file of its own: one spread with the spine, the inside on page 2.
    const coverName = el("span", "file-name");
    const chooseCover = button("Choose PDF", async () => {
      const picked = await pickPdf();
      if (picked) {
        cover = picked;
        sync();
      }
    });
    const removeCover = button("Remove", () => {
      cover = null;
      sync();
    });
    const coverRow = row("Cover", el("div", "file-row", [coverName, chooseCover, removeCover]));
    const coverNote = el("p", "dialog-note");
    coverNote.textContent = "A separate cover file: the outside as one spread with the spine, the inside on a second page.";

    const pages = radio("source", "pages", "Pages", "Single pages or spreads, in reading order");
    const imposed = radio("source", "imposed", "Imposed sheets", "Printer spreads, e.g. from InDesign's Print Booklet");
    const kind = el("fieldset", "choices", [legend("This PDF contains"), pages.wrap, imposed.wrap]);

    const FOLDED = ["saddle", "perfect", "sewn", "hardcover"];
    const binding = select(FOLDED.map((b) => [b, BINDING_LABELS[b]]), "saddle");
    const signature = select([4, 8, 12, 16, 32].map((n) => [String(n), `${n}-page signatures`]), "4");
    const signed = () => binding.value !== "saddle";
    let coverSheet = true;
    const imposedOptions = el("div", "sub-options", [row("Folded as", binding), row("Signatures", signature)]);
    const note = el("p", "dialog-note");

    const importBtn = button("Import", () => finish(true), "btn primary");
    const actions = el("div", "dialog-actions", [button("Cancel", () => finish(false)), importBtn]);
    d.body.append(fileRow, kind, imposedOptions, coverRow, coverNote, note, actions);

    const sync = () => {
      const isImposed = imposed.input.checked;
      imposedOptions.hidden = !isImposed;
      signature.closest(".row").hidden = !signed();
      importBtn.disabled = !file;
      fileName.textContent = file ? file.name : "No file chosen";
      coverRow.hidden = coverNote.hidden = isImposed; // an imposed file has its cover on its sheets
      coverName.textContent = cover ? cover.name : "None";
      removeCover.hidden = !cover;
    };
    for (const c of [pages.input, imposed.input, binding]) c.addEventListener("change", sync);
    binding.addEventListener("change", () => {
      signature.value = binding.value === "perfect" ? "4" : "16";
    });

    async function setFile(f) {
      file = f;
      note.textContent = "";
      const meta = await readImposition(f.bytes).catch(() => null);
      coverSheet = true;
      if (meta) {
        imposed.input.checked = true;
        binding.value = FOLDED.includes(meta.binding) ? meta.binding : "saddle";
        if (meta.signaturePages && signed()) signature.value = String(meta.signaturePages);
        // Before version 2, the cover was folded into the first and last signatures.
        coverSheet = (meta.version ?? 1) >= 2;
        note.textContent = "Settings taken from the file.";
      }
      sync();
    }

    function finish(ok) {
      d.el.close();
      d.el.remove();
      if (!ok || !file) return resolve(null);
      const isImposed = imposed.input.checked;
      resolve({
        file,
        source: isImposed ? "imposed" : "pages",
        binding: isImposed ? binding.value : null,
        signaturePages: isImposed && signed() ? Number(signature.value) : null,
        coverSheet: isImposed ? coverSheet : true,
        cover: isImposed ? null : cover,
      });
    }

    pages.input.checked = true;
    d.el.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    sync();
    if (file) setFile(file);
    d.el.showModal();
  });
}

/**
 * What the press sheets are, plainly. Spreads: every sheet holds one spread a side (2-up),
 * and a signature is sheets inserted into one another; signatures are gathered (stacked)
 * in order. A folding scheme: a sheet of 8 or 16 pages is folded into a signature (two or
 * three right-angle folds, the upper row printed upside down), or into part of one, nested.
 */
function sheetsNote(rule, layout) {
  const S = layout.signaturePages;
  const P = layout.sheetPages ?? 2;
  const an = (n) => (n === 8 || n === 18 ? "an" : "a");
  const cover = layout.coverSheet ? ", then the cover on its own sheet" : "";
  if (P > 2) {
    const folds = P === 16 ? "three" : "two";
    const per = S / P;
    const sheets = per === 1 ? `one sheet of ${P} pages, folded ${folds} times` : `${per} sheets of ${P} pages, each folded ${folds} times and inserted into one another`;
    if (rule.binding === Binding.SADDLE) return `The booklet is ${sheets}; the upper row is printed upside down.`;
    return `${an(S).replace(/^a/, "A")} ${S}-page signature is ${sheets}; the upper row is printed upside down. The signatures are gathered in order${cover}.`;
  }
  const sheets = S / 4;
  if (rule.binding === Binding.SADDLE) return `Each sheet holds one spread per side, all ${sheets} inserted into one another.`;
  return `Each sheet holds one spread per side. ${an(S).replace(/^a/, "A")} ${S}-page signature is ${sheets} sheet${sheets === 1 ? "" : "s"}` +
    `${sheets === 1 ? "" : " inserted into one another"}; the signatures are gathered in order${cover}.`;
}

/**
 * What to export (the Export button): the imposed PDF for the printer, or the client viewer.
 * Resolves to "imposed", "viewer", or null if cancelled. `canImpose`: false for a file
 * imported as imposed sheets (it is already imposed).
 * @param {boolean} canImpose
 * @returns {Promise<"imposed" | "viewer" | null>}
 */
export function exportChoiceDialog(canImpose) {
  return new Promise((resolve) => {
    const d = dialog("Export");
    const imposed = button("Export imposed PDF", () => finish("imposed"));
    imposed.disabled = !canImpose;
    const viewer = button("Export as HTML file", () => finish("viewer"));
    const actions = el("div", "dialog-actions", [button("Cancel", () => finish(null))]);
    d.body.append(el("div", "export-choices", [imposed, viewer]), actions);
    function finish(choice) {
      d.el.close();
      d.el.remove();
      resolve(choice);
    }
    d.el.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(null);
    });
    d.el.showModal();
    (canImpose ? imposed : viewer).focus();
  });
}

/**
 * The client viewer's settings (see ui/client.js): how tall the page images are. Resolves
 * to {heightPx}, or null if cancelled.
 * @param {ReturnType<typeof import("../core/analysis.js").analyse>} analysis
 * @returns {Promise<{heightPx: number} | null>}
 */
export function clientViewerDialog(analysis) {
  return new Promise((resolve) => {
    const d = dialog("Export as HTML file");
    const n = analysis.book.pages.length;
    const summary = el("p", "dialog-summary", [`${n} pages as images in one HTML file: the book as shown here, to turn and look round in any browser. Nothing else is needed, no PDF goes with it.`]);
    const height = select([["1024", "1024 px tall (sharp on a phone)"], ["1536", "1536 px tall"], ["2048", "2048 px tall (sharp on a large screen)"]], "1536");
    const note = el("p", "dialog-note", ["About 100 to 400 KB a page, with three.js and the viewer (1.7 MB) in the file."]);
    const exportBtn = button("Export", () => finish(true), "btn primary");
    const actions = el("div", "dialog-actions", [button("Cancel", () => finish(false)), exportBtn]);
    d.body.append(summary, row("Page images", height), note, actions);
    function finish(ok) {
      d.el.close();
      d.el.remove();
      resolve(ok ? { heightPx: Number(height.value) } : null);
    }
    d.el.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    d.el.showModal();
  });
}

/**
 * Imposition settings. Resolves to {options, analysis}, or null if cancelled: `analysis` the
 * one the sheets are planned from, as the dialog ends (the sheet layout chosen in it makes a
 * new one; exported from the analysis it opened with, the PDF was imposed in the old layout
 * until the dialog was opened a second time, 1.0.0). `onSheetPages`: the pages a sheet holds
 * is part of the setup (the timeline's press sheets show it): set through it, it gives the
 * analysis made with it.
 * @param {ReturnType<typeof import("../core/analysis.js").analyse>} analysis
 * @param {import("../core/sheets.js").ExportOptions | null} [remembered]
 * @param {((sheetPages: number) => Promise<ReturnType<typeof import("../core/analysis.js").analyse>>) | null} [onSheetPages]
 * @returns {Promise<{options: import("../core/sheets.js").ExportOptions, analysis: ReturnType<typeof import("../core/analysis.js").analyse>} | null>}
 */
export function exportDialog(analysis, remembered = null, onSheetPages = null) {
  return new Promise((resolve) => {
    const opts = structuredClone(remembered ?? defaultExportOptions());
    const d = dialog("Export imposed PDF");
    const summary = el("p", "dialog-summary");
    const how = el("p", "dialog-note"); // what the sheets are (see sheetsNote)
    // The sheets: spreads, or a folding scheme (see core/folding.js).
    const layoutChoices = [["2", "Spreads: 2 pages a side"], ["8", "8 pages a sheet, 2 folds"], ["16", "16 pages a sheet, 3 folds"]];
    const sheetLayout = select(layoutChoices, String(analysis.setup.sheetPages ?? 2));
    // The analysis for the layout chosen last: Export waits for it (a choice made just before
    // pressing it may still be in the making).
    let pending = Promise.resolve();
    sheetLayout.addEventListener("change", () => {
      if (!onSheetPages) return;
      const chosen = Number(sheetLayout.value);
      pending = pending.then(async () => {
        const next = await onSheetPages(chosen);
        if (Number(sheetLayout.value) === chosen) {
          analysis = next;
          sync();
        }
      });
    });

    const sheetChoices = [["auto", "Automatic (fits pages, bleed and marks)"],
      ...SHEET_PRESETS.map((p) => [p.name, `${p.name} (${formatMm(p.size.width)} × ${formatMm(p.size.height)} mm)`]),
      ["custom", "Custom…"]];
    const initialSheet = opts.sheet === "auto" ? "auto" : SHEET_PRESETS.find((p) => sameSize(p.size, opts.sheet))?.name ?? "custom";
    const sheet = select(sheetChoices, initialSheet);
    const customW = unitField(opts.sheet === "auto" ? 320 : opts.sheet.width, "mm", 50);
    const customH = unitField(opts.sheet === "auto" ? 450 : opts.sheet.height, "mm", 50);
    const custom = el("div", "pair", [labelled("Width", customW), labelled("Height", customH)]);
    const sheetSize = el("p", "dialog-note");

    const bleed = check("Include bleed", "Outer edges only", opts.bleed);
    const crop = check("Crop marks", "", opts.marks.crop);
    const fold = check("Fold marks", "", opts.marks.fold);
    const info = check("Page information", "File name, sheet and side, date", opts.marks.info);
    const offset = unitField(opts.markOffsetMm, "mm", 0);
    const marks = el("fieldset", "choices", [legend("Printer marks"), crop.wrap, fold.wrap, info.wrap, row("Offset from trim", offset)]);

    const creep = check("Creep compensation", "Ask your printer first: most apply it themselves", opts.creep);
    const creepInfo = el("p", "dialog-note");
    const errors = el("ul", "dialog-errors");

    const exportBtn = button("Export", () => finish(true), "btn primary");
    const actions = el("div", "dialog-actions", [button("Cancel", () => finish(false)), exportBtn]);
    d.body.append(summary, how, row("Sheet layout", sheetLayout), row("Sheet size", sheet), custom, sheetSize, bleed.wrap, marks, creep.wrap, creepInfo, errors, actions);

    const read = () => {
      opts.sheet = sheet.value === "auto" ? "auto"
        : sheet.value === "custom" ? { width: customW.number(), height: customH.number() }
        : { ...SHEET_PRESETS.find((p) => p.name === sheet.value).size };
      opts.bleed = bleed.input.checked;
      opts.marks = { crop: crop.input.checked, fold: fold.input.checked, info: info.input.checked };
      opts.markOffsetMm = Math.max(0, offset.number() || 0);
      opts.creep = creep.input.checked;
    };
    const sync = () => {
      read();
      custom.hidden = sheet.value !== "custom";
      const plan = planSheets(analysis, opts);
      const { layout, rule, book } = analysis;
      summary.textContent = layout
        ? `${BINDING_LABELS[rule.binding]} • ${book.pages.length} pages on ${plan.sheetCount} sheet${plan.sheetCount === 1 ? "" : "s"}`
        : "";
      how.textContent = layout ? sheetsNote(rule, layout) : "";
      sheetSize.textContent = `Sheet: ${formatMm(plan.sheetSize.width)} × ${formatMm(plan.sheetSize.height)} mm, landscape`;
      creepInfo.textContent = opts.creep ? `Up to ${plan.maxCreepMm.toFixed(2)} mm toward the spine, on the innermost leaf` : "";
      errors.replaceChildren(...plan.errors.map((m) => el("li", "", [m])));
      exportBtn.disabled = plan.errors.length > 0;
    };
    d.body.addEventListener("input", sync);
    d.body.addEventListener("change", sync);

    async function finish(ok) {
      if (ok) {
        exportBtn.disabled = true;
        await pending;
        read();
      }
      d.el.close();
      d.el.remove();
      resolve(ok ? { options: opts, analysis } : null);
    }
    d.el.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    sync();
    d.el.showModal();
  });
}

/** Output shapes for screenshots and videos (width : height). The book is framed to fit. */
const SHAPES = [
  ["1:1", "1:1", 1],
  ["4:3", "4:3", 4 / 3],
  ["16:9", "16:9", 16 / 9],
  ["9:16", "9:16", 9 / 16],
];
const shapeRatio = (shape) => SHAPES.find(([id]) => id === shape)[2];

/** Width × height with the given long side (even numbers: video encoders need them). */
function sized(ratio, longSide) {
  const even = (v) => Math.max(2, 2 * Math.round(v / 2));
  return ratio >= 1 ? { width: even(longSide), height: even(longSide / ratio) } : { width: even(longSide * ratio), height: even(longSide) };
}

/** A shape and a resolution menu that follows it; `longSides(ratio)` lists the sizes. */
function shapeAndResolution(initialShape, longSides, initialIndex) {
  const shape = select(SHAPES.map(([id, label]) => [id, label]), initialShape);
  const resolution = select([], "");
  let sizes = [];
  const sync = () => {
    const keep = resolution.selectedIndex;
    sizes = longSides(shapeRatio(shape.value)).map((long) => sized(shapeRatio(shape.value), long));
    resolution.replaceChildren(...sizes.map((s, i) => new Option(`${s.width} × ${s.height}`, String(i))));
    resolution.selectedIndex = keep >= 0 ? keep : initialIndex;
  };
  shape.addEventListener("change", sync);
  sync();
  return { shape, resolution, chosen: () => sizes[resolution.selectedIndex] };
}

// The settings last rendered with, for the rest of the session (the dialogs open with them).
let lastScreenshot = { shape: "16:9", resolution: 1, transparent: false };
let lastVideo = { shape: "9:16", resolution: 0, fps: "30", turn: 1.2, pause: 0.8, transparent: false, quality: "1" };

// An MP4's bits per pixel per frame (its bitrate ceiling: width × height × frames a second ×
// this, 16 to 240 Mbit/s): a master for editing, or smaller files. Dithered images, fine type
// and pixel art are the hardest content for H.264; at 0.4 the encoder visibly softened pages
// mid-turn (measured, 0.17.80).
const VIDEO_QUALITIES = [["1", "Master (1 bit per pixel)"], ["0.5", "High (0.5 bit per pixel)"], ["0.25", "Standard (0.25 bit per pixel)"]];
/** The MP4 encoder's bitrate ceiling (bit/s) for a picture size, frame rate and bits per pixel. */
export const mp4Bitrate = (width, height, fps, bitsPerPixel) => Math.round(Math.min(240e6, Math.max(16e6, width * height * fps * bitsPerPixel)));
// ProRes 4444's data rate on the book's frames (bits per pixel per frame): measured, 4K60 of
// a pixel-art book came to 6.4 GB a minute, about 1.6.
const PRORES_BITS_PER_PIXEL = 1.6;

/** Screenshot shape, resolution and background. Resolves to {width, height, transparent} or null. */
export function screenshotDialog() {
  return new Promise((resolve) => {
    const d = dialog("Render screenshot");
    const last = lastScreenshot;
    // A PNG canvas holds at most ~268 megapixels and 32767 px per side.
    const { shape, resolution, chosen } = shapeAndResolution(last.shape, (r) => {
      const limit = Math.min(32767, Math.sqrt(268e6 * Math.max(r, 1 / r)));
      return [...new Set([1920, 3840, 7680, 16384].map((px) => Math.min(px, Math.floor(limit))))];
    }, last.resolution);
    const transparent = check("Transparent background", "", last.transparent);
    const go = button("Render", () => finish(true), "btn primary");
    d.body.append(row("Shape", shape), row("Resolution", resolution), transparent.wrap,
      el("div", "dialog-actions", [button("Cancel", () => finish(false)), go]));
    function finish(ok) {
      d.el.close();
      d.el.remove();
      if (ok) lastScreenshot = { shape: shape.value, resolution: resolution.selectedIndex, transparent: transparent.input.checked };
      resolve(ok ? { ...chosen(), transparent: transparent.input.checked } : null);
    }
    d.el.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    d.el.showModal();
  });
}

/**
 * Video settings: shape, resolution, frame rate, page-turn speed, pause per spread,
 * transparency. `turns`: page turns from the front cover to the back. `proRes`: whether
 * transparent (ProRes 4444) videos can be made here. Resolves to the settings or null.
 */
export function videoDialog(turns, proRes) {
  return new Promise((resolve) => {
    const d = dialog("Render video");
    const last = lastVideo;
    const { shape, resolution, chosen } = shapeAndResolution(last.shape, () => [1920, 3840], last.resolution);
    const fps = select([["30", "30"], ["60", "60"]], last.fps);
    const turn = unitField(last.turn, "s", 0.3, 0.1);
    const pause = unitField(last.pause, "s", 0, 0.1);
    const transparent = check("Transparent background", "ProRes 4444 (.mov)", last.transparent && proRes);
    transparent.input.disabled = !proRes;
    const quality = select(VIDEO_QUALITIES, last.quality ?? "1");
    const qualityRow = row("Quality", quality);
    const length = el("span", "dialog-value");
    const size = el("span", "dialog-value");
    const seconds = () => videoLength(turns, Math.max(0.3, turn.number() || 1.2), Math.max(0, pause.number() || 0)) / 1000;
    const syncLength = () => {
      const s = seconds();
      length.textContent = `${s.toFixed(1)} s`;
      const { width, height } = chosen();
      const perSecond = width * height * Number(fps.value);
      qualityRow.hidden = transparent.input.checked;
      // ProRes writes what the frames need; the MP4 at most its ceiling (still frames take less).
      size.textContent = transparent.input.checked
        ? `about ${fmt((perSecond * PRORES_BITS_PER_PIXEL * s) / 8 / 1e9, 1)} GB`
        : `up to ${Math.round((mp4Bitrate(width, height, Number(fps.value), Number(quality.value)) * s) / 8 / 1e6)} MB`;
    };
    for (const c of [turn, pause, shape, resolution, fps, quality, transparent.input]) for (const type of ["input", "change"]) c.addEventListener(type, syncLength);
    syncLength();
    const go = button("Render", () => finish(true), "btn primary");
    d.body.append(row("Shape", shape), row("Resolution", resolution), row("Frames per second", fps),
      row("Page turn", turn), row("Pause on each spread", pause), row("Length", length), transparent.wrap, qualityRow, row("File size", size),
      el("div", "dialog-actions", [button("Cancel", () => finish(false)), go]));
    function finish(ok) {
      d.el.close();
      d.el.remove();
      if (!ok) return resolve(null);
      const settings = {
        ...chosen(),
        fps: Number(fps.value),
        turnSeconds: Math.max(0.3, turn.number() || 1.2),
        pauseSeconds: Math.max(0, pause.number() || 0),
        transparent: transparent.input.checked,
        bitsPerPixel: Number(quality.value),
      };
      lastVideo = {
        shape: shape.value, resolution: resolution.selectedIndex, fps: fps.value,
        turn: settings.turnSeconds, pause: settings.pauseSeconds, quality: quality.value,
        // Unticked only where it couldn't be ticked: a computer with ProRes keeps the choice.
        transparent: proRes ? settings.transparent : last.transparent,
      };
      resolve(settings);
    }
    d.el.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(false);
    });
    d.el.showModal();
  });
}

/** Spot finishes: the kinds a finish PDF can be shown as. */
const FINISHES = [
  ["gloss", "Spot UV (gloss)"],
  ["gold", "Gold foil"],
  ["silver", "Silver foil"],
  ["copper", "Copper foil"],
];

/**
 * Spot finish: a PDF of the varnish or foil layer (the separate file printers ask for), and
 * what it is. Changes apply at once. api: {info() -> {name, kind, pages}, importPdf(),
 * setKind(kind), remove()}.
 */
export function finishDialog(api) {
  const d = dialog("Spot finish");
  const kind = select(FINISHES, api.info().kind);
  kind.addEventListener("change", () => api.setKind(kind.value));
  const file = el("p", "spine-file");
  const remove = button("Remove", async () => {
    await api.remove();
    sync();
  }, "btn");
  const load = button("Import finish PDF", async () => {
    await api.importPdf();
    sync();
  }, "btn primary");
  const note = el("p", "dialog-note", ["One page per document page, or 1–2 pages for the covers"]);
  const sync = () => {
    const info = api.info();
    file.textContent = info.name ? `${info.name}, ${info.pages} page${info.pages === 1 ? "" : "s"}` : "None";
    remove.disabled = !info.name;
  };
  sync();
  d.body.append(row("Finish", kind), row("File", file), note,
    el("div", "dialog-actions", [remove, load, button("Done", () => close(), "btn")]));
  const close = () => {
    d.el.close();
    d.el.remove();
  };
  d.el.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  d.el.showModal();
}

/** A video's length (ms): a still second, each turn plus its pause, a still second. */
export function videoLength(turns, turnSeconds, pauseSeconds) {
  return 1000 + turns * (turnSeconds + pauseSeconds) * 1000 + 1000;
}

/**
 * The book spine panel: its width (calculated, or the printer's figure), artwork from a PDF
 * (glued and sewn spines), or a colour. Doesn't block the window: drag it aside by its
 * title to watch the 3D book while changing the spine. `api` supplies the current state
 * (info) and the actions; refresh() re-reads the state.
 */
export function spinePanel(api) {
  const d = dialog("Book spine");
  d.el.classList.add("floating");
  const title = d.el.querySelector("h2");
  makeDraggable(d.el, title);

  let customPicking = false;
  let refocusWidth = false; // the width stepped with the arrow keys: focused again once redrawn
  function render() {
    const info = api.info();
    const { calc } = info;
    const width = info.widthMm ?? calc.widthMm;
    const parts = [];

    // Size.
    const size = el("section", "panel-section", [el("h3", "", ["Size"])]);
    const coverNote = calc.covers ? ` + ${calc.covers} cover${calc.covers > 1 ? "s" : ""} × ${fmt(calc.coverMm, 3)} mm` : "";
    size.append(el("p", "dialog-note", [
      `Calculated: ${fmt(calc.widthMm, 2)} mm (${calc.inner} leaves × ${fmt(calc.paperMm, 3)} mm${coverNote})`,
    ]));
    const input = unitField(width, "mm", 0.1, 0.1);
    input.addEventListener("change", (e) => {
      const v = input.number();
      if (!(v > 0)) return render();
      refocusWidth = !e.isTrusted; // the arrow keys' change (unitField); typed ones are the browser's
      api.setWidth(Math.abs(v - calc.widthMm) < 0.005 ? null : Math.round(v * 100) / 100);
    });
    const widthRow = el("div", "file-row", [input]);
    if (info.widthMm) widthRow.append(button("Use calculated", () => api.setWidth(null), "btn link-btn"));
    size.append(row("Spine width", widthRow));
    if (!info.widthValid) {
      size.append(el("p", "dialog-errors-line", ["Thinner than the covers: the calculated width is used"]));
    }
    const head = info.bleedMm?.top ?? 0;
    const foot = info.bleedMm?.bottom ?? 0;
    const bleed = !head && !foot ? ""
      : head === foot ? `, plus ${fmt(head, 1)} mm bleed at head and foot`
        : `, plus ${fmt(head, 1)} mm bleed at the head and ${fmt(foot, 1)} mm at the foot`;
    size.append(el("p", "dialog-note spine-artboard", [`Artboard: ${fmt(width, 2)} × ${fmt(info.heightMm, 1)} mm${bleed}`]));
    parts.push(size);

    // Artwork (glued and sewn spines).
    if (info.takesArtwork) {
      const art = el("section", "panel-section", [el("h3", "", ["Artwork"])]);
      if (info.artwork) {
        const { name, sizeMm } = info.artwork;
        art.append(el("p", "spine-file", [`${name} • ${fmt(sizeMm.width, 1)} × ${fmt(sizeMm.height, 1)} mm`]));
        const fits = (w, h) => Math.abs(w - width) < 0.3 && Math.abs(h - info.heightMm) < 0.5;
        if (!fits(sizeMm.width, sizeMm.height) && !fits(sizeMm.height, sizeMm.width)) {
          art.append(el("p", "dialog-note", ["Not the spine's size: stretched to fit"]));
        }
        art.append(el("div", "dialog-actions spine-actions", [
          button("Remove", () => api.removeArtwork()),
          button("Rotate spine", () => api.rotate(), "btn primary"),
        ]));
      } else {
        art.append(el("div", "dialog-actions spine-actions", [button("Import spine PDF", () => api.importArtwork(), "btn primary")]));
      }
      parts.push(art);
    }

    // Colour.
    const colour = el("section", "panel-section", [el("h3", "", ["Color"])]);
    const swatches = el("div", "swatches");
    for (const p of info.presets) {
      const b = button("", () => api.setColour(p.id), "swatch");
      if (p.hex) b.style.background = p.hex;
      else b.classList.add("pending"); // the cover isn't rendered yet
      b.setAttribute("aria-label", p.label);
      b.setAttribute("aria-pressed", String(info.color === p.id));
      swatches.append(b);
    }
    const custom = el("input", "custom-swatch");
    custom.type = "color";
    const isPreset = info.presets.some((p) => p.id === info.color);
    custom.value = isPreset ? (info.presets.find((p) => p.id === info.color)?.hex ?? "#ffffff") : info.color;
    custom.setAttribute("aria-label", "Custom spine color");
    if (!isPreset) custom.classList.add("chosen");
    custom.addEventListener("input", () => {
      customPicking = true;
      api.previewColour(custom.value);
    });
    custom.addEventListener("change", () => {
      customPicking = false;
      api.setColour(custom.value);
    });
    swatches.append(custom);
    colour.append(row("Spine color", swatches));
    parts.push(colour);

    parts.push(el("div", "dialog-actions", [button("Done", () => close(), "btn primary")]));
    d.body.replaceChildren(...parts);
    if (refocusWidth) input.focus();
    refocusWidth = false;
  }

  function close() {
    d.el.close();
    d.el.remove();
    api.onClose();
  }
  d.el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  render();
  d.el.show(); // not modal: the book stays usable
  // Top left of the view: clear of the camera buttons (top right) and the side panel.
  d.el.style.left = "16px";
  d.el.style.top = "60px";
  return {
    refresh: () => {
      if (!customPicking) render(); // don't rebuild the picker while it's open
    },
    focus: () => d.el.querySelector("button, input")?.focus(),
    close,
  };
}

/** Move a floating dialog by dragging its title. */
function makeDraggable(box, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, left: box.offsetLeft, top: box.offsetTop };
    const move = (ev) => {
      const left = Math.round(Math.min(window.innerWidth - 80, Math.max(-box.offsetWidth + 80, start.left + ev.clientX - start.x)));
      const top = Math.round(Math.min(window.innerHeight - 40, Math.max(0, start.top + ev.clientY - start.y)));
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("lostpointercapture", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("lostpointercapture", up);
  });
}

/** About the app, laid out like macOS's About windows: icon, name and version, credits. */
export function aboutDialog({ name, version }) {
  const d = el("dialog", "dialog about");
  d.setAttribute("aria-label", `About ${name}`);
  const icon = el("img", "about-icon");
  icon.src = new URL("../icon.svg", import.meta.url).href; // the app icon (also the builds')
  icon.alt = "";
  d.append(
    icon,
    el("p", "about-name", [`${name} ver. ${version}`]),
    el("p", "about-line", ["Designed by Ramin Strauss", el("br"), "Built with Claude"]),
    el("p", "about-line", ["Powered by Electron, three.js, pdf.js, pdf-lib, Slug, mp4-muxer and FFmpeg"]),
    el("div", "dialog-actions about-actions", [button("Licenses", licensesDialog, "btn"), button("Close", () => d.close(), "btn")]),
  );
  d.addEventListener("close", () => d.remove());
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close(); // a click on the backdrop
  });
  document.body.append(d);
  d.showModal();
}

// The software from others inside the app, each with its license as shipped with it: name,
// license, the license text (a file in the app, from its root), or where it is instead.
// CREDITS.md says what each is used for.
const LICENSES = [
  ["Printwarden", "Apache License 2.0", ["NOTICE", "LICENSE"]], // its own, then the others'
  ["Electron", "MIT", "vendor/licenses/electron.txt"],
  ["Chromium", "BSD 3-Clause and others", null, "Chromium's licenses, and those of the projects it includes, ship with the app: LICENSES.chromium.html (Windows: next to Printwarden.exe; macOS: in Printwarden.app/Contents/Resources/licenses)."],
  ["three.js", "MIT", "vendor/LICENSE.three.txt"],
  ["pdf.js", "Apache License 2.0", "vendor/LICENSE.pdfjs.txt"],
  ["jpeg-decoder", "MIT", "vendor/licenses/jpeg-decoder.txt"],
  ["qcms", "MIT", "vendor/pdf-wasm/LICENSE_QCMS"],
  ["OpenJPEG", "BSD 2-Clause", "vendor/pdf-wasm/LICENSE_OPENJPEG"],
  ["PDFium JBIG2 decoder", "BSD 3-Clause", "vendor/pdf-wasm/LICENSE_JBIG2"],
  ["pdf.js WebAssembly builds", "Apache License 2.0, MIT", ["vendor/pdf-wasm/LICENSE_PDFJS_JBIG2", "vendor/pdf-wasm/LICENSE_PDFJS_OPENJPEG", "vendor/pdf-wasm/LICENSE_PDFJS_QCMS"]],
  ["Foxit fonts", "BSD 3-Clause", "vendor/pdf-standard-fonts/LICENSE_FOXIT"],
  ["Liberation Sans", "GPL 2 with font exception", "vendor/pdf-standard-fonts/LICENSE_LIBERATION"],
  ["Adobe CMaps", "BSD 3-Clause", "vendor/pdf-cmaps/LICENSE"],
  ["CGATS001Compat profile", "CC0 1.0", "vendor/pdf-iccs/LICENSE"],
  ["pdf-lib, standard-fonts, UPNG.js, pako", "MIT", "vendor/licenses/pdf-lib.txt"],
  ["mp4-muxer", "MIT", "vendor/mp4-muxer/LICENSE.txt"],
  ["Slug", "MIT", "vendor/licenses/slug.txt"],
  ["Space Grotesk", "SIL Open Font License 1.1", "vendor/fonts/OFL-SpaceGrotesk.txt"],
  ["Space Mono", "SIL Open Font License 1.1", "vendor/fonts/OFL-SpaceMono.txt"],
  ["FFmpeg", "LGPL 2.1 or later", "vendor/licenses/ffmpeg.txt"],
  ["ISO Coated v2 (ECI)", "European Color Initiative", "vendor/icc/README.txt"],
];

/** The licenses of the software from others inside the app (from the About window). */
function licensesDialog() {
  const { el: d, body } = dialog("Licenses");
  d.classList.add("licenses");
  const list = el("div", "license-list");
  for (const [name, license, files, text] of LICENSES) {
    const item = el("details", "license", [el("summary", "", [el("strong", "", [name]), `  ${license}`])]);
    const pre = el("pre", "license-text", text ? [text] : []);
    item.append(pre);
    item.addEventListener("toggle", () => {
      if (item.open && !pre.dataset.bar) addScrollbar(pre, "y"); // once shown: it can measure
      pre.dataset.bar = "1";
    });
    if (files) {
      // Read when first opened.
      item.addEventListener("toggle", () => {
        if (!item.open || pre.textContent) return;
        Promise.all([files].flat().map((f) => fetch(new URL(`../../${f}`, import.meta.url)).then((r) => r.text())))
          .then((texts) => { pre.textContent = texts.join("\n\n"); }, () => { pre.textContent = [files].flat().join("\n"); });
      });
    }
    list.append(item);
  }
  body.append(list, el("div", "dialog-actions", [button("Close", () => d.close(), "btn")]));
  d.addEventListener("close", () => d.remove());
  d.showModal();
  addScrollbar(list);
}

/**
 * A report to read and pass on (the performance check): its text, and Copy (selects it and
 * copies it; the app is allowed no clipboard permission of its own).
 */
export function reportDialog(title, text) {
  const { el: d, body } = dialog(title);
  const pre = el("pre", "license-text report-text", [text]);
  const copy = button("Copy", () => {
    getSelection().selectAllChildren(pre);
    document.execCommand("copy");
  }, "btn");
  body.append(pre, el("div", "dialog-actions", [copy, button("Close", () => d.close(), "btn")]));
  d.classList.add("licenses");
  d.addEventListener("close", () => d.remove());
  d.showModal();
  addScrollbar(pre);
}

const fmt = (v, digits) => Number(v).toFixed(digits).replace(/\.?0+$/, "") || "0";

// --- helpers -----------------------------------------------------------------------

const sameSize = (a, b) => Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
  || Math.abs(a.width - b.height) < 0.5 && Math.abs(a.height - b.width) < 0.5;

function el(tag, className = "", children = []) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  e.append(...children);
  return e;
}

function dialog(title) {
  const d = el("dialog", "dialog");
  const h = el("h2", "", [title]);
  const body = el("div", "dialog-body");
  d.append(h, body);
  document.body.append(d);
  return { el: d, body };
}

function button(text, onClick, className = "btn") {
  const b = el("button", className, [text]);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

let uid = 0;
function row(label, control) {
  const id = control.id || `d${++uid}`;
  control.id = id;
  const l = el("label", "", [label]);
  l.htmlFor = id;
  return el("div", "row", [l, control]);
}

function labelled(text, control) {
  const l = el("label", "stack", [el("span", "", [text]), control]);
  return l;
}

function legend(text) {
  return el("legend", "", [text]);
}

function radio(name, value, label, hint) {
  const input = el("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  const wrap = el("label", "choice", [input, el("span", "choice-text", [el("strong", "", [label]), el("span", "hint", [hint])])]);
  return { input, wrap };
}

function check(label, hint, checked) {
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  const text = el("span", "choice-text", [el("strong", "", [label])]);
  if (hint) text.append(el("span", "hint", [hint]));
  return { input, wrap: el("label", "choice", [input, text]) };
}

function select(options, value) {
  const s = el("select");
  for (const [v, text] of options) s.append(new Option(text, v, false, v === value));
  // Scrolled over: the choice above (scrolled up) or below, as the list runs (not past either
  // end, nor to one disabled).
  onWheelSteps(s, (n) => {
    let i = s.selectedIndex;
    for (let left = Math.abs(n); left > 0; left--) {
      let j = i - Math.sign(n);
      while (s.options[j]?.disabled) j -= Math.sign(n);
      if (!s.options[j]) break;
      i = j;
    }
    if (i === s.selectedIndex) return;
    s.selectedIndex = i;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return s;
}

/**
 * Scrolling over `control` steps it: `onSteps(n)`, n steps up (scrolled up) or down. A mouse
 * wheel's notch is a step; a touchpad's small, frequent movements add up to steps as it
 * glides (every 30 px). The dialog doesn't scroll meanwhile.
 */
function onWheelSteps(control, onSteps) {
  let pending = 0;
  control.addEventListener("wheel", (e) => {
    if (control.disabled) return;
    e.preventDefault();
    const pixels = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (Math.abs(pixels) >= 50) {
      pending = 0;
      onSteps(-Math.sign(pixels)); // a notch: one step, however far the system scrolls for it
      return;
    }
    pending -= pixels;
    const n = Math.trunc(pending / 30);
    if (!n) return;
    pending -= n * 30;
    onSteps(n);
  }, { passive: false });
}

/**
 * A number shown with its unit ("3 mm"), typed with or without it; arrow keys step it.
 * `number()` reads it.
 */
function unitField(value, unit, min, step = 0.5) {
  const i = el("input", "unit-number");
  i.type = "text";
  i.inputMode = "decimal";
  let last = value;
  const show = (v) => { i.value = `${fmt(v, 2)} ${unit}`; };
  i.number = () => Number.parseFloat(i.value.replace(",", "."));
  const commit = (v) => {
    if (Number.isFinite(v) && v >= min) last = v;
    show(last);
  };
  i.addEventListener("change", () => commit(i.number()));
  const stepBy = (n) => {
    commit(Math.max(min, Math.round(((i.number() || last) + n * step) * 100) / 100));
    i.dispatchEvent(new Event("change", { bubbles: true }));
  };
  i.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    stepBy(e.key === "ArrowUp" ? 1 : -1);
  });
  onWheelSteps(i, stepBy); // scrolled over: steps as the arrow keys do
  show(value);
  return i;
}
