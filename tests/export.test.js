// The imposed export's dialog (ui/dialogs.js exportDialog): the sheet layout chosen in it makes
// a new analysis, and the export must be planned from that one. To 1.0.0 the export kept the
// analysis it opened with: 16 pages a sheet chosen, the PDF came out in the old layout, until
// the dialog was opened again (the author's report).

import { analyse } from "../app/core/analysis.js";
import { Binding } from "../app/core/binding.js";
import { planSheets } from "../app/core/sheets.js";
import { rect } from "../app/core/units.js";
import { exportDialog } from "../app/ui/dialogs.js";
import { eq, ok, test } from "./harness.js";

const A5 = rect(0, 0, 148, 210);
const singles = (n) => Array.from({ length: n }, (_, index) => ({ index, mediaBox: A5, trimBox: null, bleedBox: null, rotation: 0 }));
const doc = { pages: singles(32) };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** The open export dialog's sheet layout menu and its Export button. */
function controls() {
  const d = [...document.querySelectorAll("dialog")].pop();
  const layout = [...d.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "16"));
  const go = [...d.querySelectorAll("button")].find((b) => b.textContent === "Export");
  return { layout, go };
}

/** Open the dialog on a booklet in spreads; each layout's analysis arrives after `delay(pages)` ms. */
function open(delay = () => 30) {
  const start = analyse(doc, { binding: Binding.SADDLE, sheetPages: 2 });
  const result = exportDialog(start, null, async (sheetPages) => {
    await pause(delay(sheetPages));
    return analyse(doc, { binding: Binding.SADDLE, sheetPages });
  });
  return { result, ...controls() };
}

const choose = (layout, value) => {
  layout.value = value;
  layout.dispatchEvent(new Event("change", { bubbles: true }));
};

test("imposed export: a sheet layout chosen in the dialog is the one exported, even with Export pressed at once", async () => {
  const { result, layout, go } = open();
  choose(layout, "16");
  go.click(); // before the new analysis has arrived
  const chosen = await result;
  ok(chosen, "the dialog resolved");
  eq(chosen.analysis.setup.sheetPages, 16);
  const plan = planSheets(chosen.analysis, chosen.options);
  eq(plan.sides[0].placements.length, 8, "8 pages a side on a 16-page sheet");
  eq(plan.sheetCount, 2, "32 pages on two 16-page sheets");
});

test("imposed export: the last layout chosen wins, whichever analysis arrives first", async () => {
  // 16 chosen, then 8; the 16-page analysis takes longer to arrive than the 8-page one.
  const { result, layout, go } = open((pages) => (pages === 16 ? 60 : 10));
  choose(layout, "16");
  choose(layout, "8");
  go.click();
  const chosen = await result;
  eq(chosen.analysis.setup.sheetPages, 8);
  eq(planSheets(chosen.analysis, chosen.options).sides[0].placements.length, 4);
});

test("imposed export: unchanged, the dialog exports the analysis it opened with; cancelled, nothing", async () => {
  const first = open();
  first.go.click();
  eq((await first.result).analysis.setup.sheetPages, 2);
  const second = open();
  choose(second.layout, "16");
  const d = [...document.querySelectorAll("dialog")].pop();
  [...d.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click();
  eq(await second.result, null);
  await pause(60); // the change's analysis still arriving after a cancel breaks nothing
});
