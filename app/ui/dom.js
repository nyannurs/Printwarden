// Small pieces of the window shared by the rest of the interface: finding an element, a
// message at the bottom (toast), the loading bar, a progress window.

export const $ = (id) => document.getElementById(id);

/**
 * The menus beside the 3D view (the camera's, the Separations'): one open at a time. A menu
 * registers how it closes; opening one closes the others, however it was opened, and a press
 * anywhere outside a menu's own button and list closes it. (Until 1.1.0 each closed on a press
 * outside any menu: the author opened the Separations with the camera menu open, and both stayed.)
 * @type {{root: Element, close: () => void}[]}
 */
const menus = [];
export function addMenu(root, close) {
  menus.push({ root, close });
  if (menus.length === 1) {
    document.addEventListener("pointerdown", (e) => {
      for (const m of menus) if (!m.root.contains(/** @type {Node} */ (e.target))) m.close();
    });
  }
}
/** A menu opening: the others close. */
export function menuOpening(root) {
  for (const m of menus) if (m.root !== root) m.close();
}

// --- whole pixels ------------------------------------------------------------------------
//
// The layout is made of whole pixels (theme.css), but what the browser centres (a dialog, the
// welcome, the progress window, a message) lands on half a pixel when the room round it is odd,
// and an outline there is drawn a pixel off; what is as wide as its words is a fraction wide.
// These are put back on whole pixels in the layout itself (not by moving the drawing: the type
// in it would stay where it was laid out, half a pixel off): a window centred by the browser is
// placed (`centre`), anything else nudged the fraction (`position: relative`), or made a whole
// (even) number of pixels wide, or tall. Again whenever their size, the window's or the type
// changes. In the order given: a box before what is inside it.
/**
 * @typedef {{x: boolean, y: boolean, width: boolean, height: boolean, centre: boolean, shown?: boolean}} Snap
 * @type {Map<HTMLElement, Snap>}
 */
const snapped = new Map();
function snapAll() {
  for (const [el, o] of snapped) {
    if (!el.isConnected) {
      if (o.shown) snapped.delete(el); // gone (not yet placed: kept)
      continue;
    }
    o.shown = true;
    if (!o.centre) Object.assign(el.style, { left: "", top: "" });
    if (o.width) el.style.width = "";
    if (o.height) el.style.height = "";
  }
  for (const [el, o] of snapped) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (o.width) el.style.width = `${Math.ceil(r.width / 2 - 0.001) * 2}px`;
    if (o.height) el.style.height = `${Math.round(r.height)}px`;
  }
  for (const [el, o] of snapped) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (o.centre) {
      // In the middle of the window, on whole pixels (it is fixed: the window is its frame).
      el.style.margin = "0";
      if (o.x) Object.assign(el.style, { right: "auto", left: `${Math.round((innerWidth - r.width) / 2)}px` });
      if (o.y) Object.assign(el.style, { bottom: "auto", top: `${Math.round((innerHeight - r.height) / 2)}px` });
      continue;
    }
    const dx = o.x ? Math.round(r.x) - r.x : 0;
    const dy = o.y ? Math.round(r.y) - r.y : 0;
    if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
      if (getComputedStyle(el).position === "static") el.style.position = "relative";
      Object.assign(el.style, { left: `${dx}px`, top: `${dy}px` });
    }
  }
}
const snapResized = new ResizeObserver(snapAll); // before the frame is drawn
window.addEventListener("resize", snapAll);
document.fonts.addEventListener("loadingdone", snapAll);

/**
 * Keep these elements on whole pixels (see above): nudged (`y: false` for one that moves up and
 * down), or with `centre`, a fixed window placed in the middle; with `width` or `height`, that
 * size made whole.
 * @param {Element[]} elements
 */
export function snapToPixels(elements, { x = true, y = true, width = false, height = false, centre = false } = {}) {
  for (const el of elements) {
    const was = snapped.get(/** @type {HTMLElement} */ (el)); // given again: both asks
    snapped.set(/** @type {HTMLElement} */ (el), was
      ? { x: was.x || x, y: was.y || y, width: was.width || width, height: was.height || height, centre: was.centre || centre }
      : { x, y, width, height, centre });
    snapResized.observe(el);
  }
  snapAll();
}

export function toast(message, kind = "error") {
  let el = /** @type {HTMLElement} */ (document.querySelector(".toast"));
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  snapToPixels([el], { y: false, width: true, centre: true }); // centred across; it slides in from above
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 7000);
}
let toastTimer = null;

/** The loading bar, along the frame's top line: a fraction done, or null (hidden). */
export function showLoad(fraction) {
  const bar = $("loadbar");
  if (fraction == null || fraction >= 1) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $("loadbar-fill").style.width = `${Math.max(2, fraction * 100)}%`;
}

/**
 * A progress window over the app: title, bar, percentage and, with `onCancel`, a Cancel
 * button. `progress(fraction)` moves the bar; `title(text)` renames the step (e.g. saving).
 */
export function showBusy(text, onCancel = null) {
  const el = document.createElement("div");
  el.className = "busy-overlay";
  el.setAttribute("role", "status");
  const box = document.createElement("div");
  box.className = "busy-box";
  const label = document.createElement("p");
  label.className = "busy-title";
  label.textContent = text;
  const bar = document.createElement("div");
  bar.className = "busy-bar";
  const fill = document.createElement("div");
  bar.append(fill);
  const percent = document.createElement("p");
  percent.className = "busy-percent";
  percent.textContent = "0 %";
  box.append(label, bar, percent);
  let cancelling = false;
  if (onCancel) {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      cancel.disabled = cancelling = true;
      label.textContent = "Canceling…";
      onCancel();
    });
    box.append(cancel);
  }
  el.append(box);
  document.body.append(el);
  snapToPixels([box, ...box.children]);
  return {
    progress(fraction) {
      const f = Math.min(1, Math.max(0, fraction));
      fill.style.width = `${f * 100}%`;
      percent.textContent = `${Math.floor(f * 100)} %`;
    },
    title(t) {
      if (!cancelling) label.textContent = t;
    },
    remove: () => el.remove(),
  };
}

/** A pill as wide as its text needs, in whole squares from `min` to `max` (longer: cut with …). */
export function fitPill(el, min, max) {
  const square = el.getBoundingClientRect().height;
  if (!square) return; // hidden
  el.style.width = "max-content";
  const needs = el.getBoundingClientRect().width;
  el.style.width = "";
  el.style.setProperty("--w", String(Math.min(max, Math.max(min, Math.ceil(needs / square - 0.01)))));
}

/**
 * A scrollbar of our own for `scroller` (the system's is hidden, styles.css): an outlined pill
 * along its right edge (`axis` "y") or its lower edge ("x"), the head a circle inside it with a
 * little room all round (styles.css). Drag the head, or press the track to bring the head there; the wheel scrolls as ever.
 * Hidden while nothing overflows. Placed beside the scroller, over it, in its positioned
 * ancestor, and kept there as the scroller or what it holds changes size. `nudge`: px nearer
 * the edge than the usual half its width (a dropdown's list: into the rounded corner).
 * Returns a function that lets go of it (its observers and listeners), for scrollers that go.
 */
export function addScrollbar(scroller, axis = "y", { nudge = 0 } = {}) {
  const y = axis === "y";
  const track = document.createElement("div");
  track.className = `scrollbar ${y ? "vertical" : "horizontal"}`;
  const head = document.createElement("div");
  head.className = "scrollbar-head";
  track.append(head);
  scroller.classList.add(y ? "scrolls-y" : "scrolls-x");
  scroller.after(track);

  const room = () => (y ? scroller.scrollHeight - scroller.clientHeight : scroller.scrollWidth - scroller.clientWidth);
  // The head's room from the track's outer edge (`start`), its size, and how far it travels:
  // from one end to the other, as far from the ends as from the sides. In exact (fractional)
  // pixels: whole ones (offsetTop, clientHeight) lost it more than a pixel of room at the far end.
  const metrics = () => {
    const cs = getComputedStyle(head);
    const border = y ? track.clientTop : track.clientLeft;
    const gap = parseFloat(y ? cs.top : cs.left);
    const size = parseFloat(y ? cs.height : cs.width);
    const length = y ? track.getBoundingClientRect().height : track.getBoundingClientRect().width;
    return { start: border + gap, size, travel: length - 2 * (border + gap) - size };
  };
  let pending = 0;
  const place = () => {
    pending = 0;
    if (!scroller.isConnected && !track.isConnected) { // gone with what held it (a closed list)
      window.removeEventListener("resize", schedule);
      return;
    }
    track.hidden = room() <= 1 || !scroller.offsetParent;
    scroller.classList.toggle(y ? "overflows-y" : "overflows-x", !track.hidden); // room kept for it only then (a dropdown's list)
    if (track.hidden) return;
    const box = track.offsetParent?.getBoundingClientRect();
    if (!box) return;
    const s = scroller.getBoundingClientRect();
    const thick = y ? track.offsetWidth : track.offsetHeight;
    const inset = thick / 2 - nudge;
    const left = s.left - box.left - track.offsetParent.clientLeft;
    const top = s.top - box.top - track.offsetParent.clientTop;
    // On whole pixels: the track's outline and its head then fall on the same pixel grid,
    // and the head sits exactly in the middle.
    const px = (v) => `${Math.round(v)}px`;
    if (y) Object.assign(track.style, { left: px(left + s.width - thick - inset), top: px(top + inset), height: px(s.height - 2 * inset) });
    else Object.assign(track.style, { left: px(left + inset), top: px(top + s.height - thick - inset), width: px(s.width - 2 * inset) });
    const at = (metrics().travel * (y ? scroller.scrollTop : scroller.scrollLeft)) / room();
    head.style.transform = y ? `translateY(${Math.round(at)}px)` : `translateX(${Math.round(at)}px)`;
  };
  const schedule = () => { pending ||= requestAnimationFrame(place); };
  scroller.addEventListener("scroll", schedule, { passive: true });
  const resized = new ResizeObserver(schedule);
  resized.observe(scroller);
  const changed = new MutationObserver(schedule);
  changed.observe(scroller, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open", "hidden"] });
  window.addEventListener("resize", schedule);

  // Dragging: the head follows the pointer; pressing the track brings the head there first.
  const scrollTo = (v) => { if (y) scroller.scrollTop = v; else scroller.scrollLeft = v; };
  track.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = track.getBoundingClientRect();
    const along = (ev) => (y ? ev.clientY - r.top : ev.clientX - r.left);
    const { start, size, travel } = metrics();
    // Where on the head it was taken: on the track, its middle comes to the pointer.
    const grab = e.target === head ? along(e) - start - new DOMMatrix(getComputedStyle(head).transform)[y ? "f" : "e"] : size / 2;
    const move = (ev) => scrollTo(((along(ev) - start - grab) / travel) * room());
    move(e);
    track.setPointerCapture(e.pointerId);
    track.classList.add("dragging");
    track.addEventListener("pointermove", move);
    track.addEventListener("lostpointercapture", () => {
      track.removeEventListener("pointermove", move);
      track.classList.remove("dragging");
    }, { once: true });
  });
  // At once when it is on the page: whoever measures the scroller next sees the room kept
  // for the track, or none. Not yet on the page: once it is.
  if (scroller.isConnected) place();
  else schedule();
  return () => {
    resized.disconnect();
    changed.disconnect();
    window.removeEventListener("resize", schedule);
    cancelAnimationFrame(pending);
  };
}

// A pill or button just clicked shows its new state, not its hover look, until the pointer
// leaves it (styles.css, `.pressed`): a click that inverts it (Camera opening its menu) shows
// the inversion at once.
document.addEventListener("click", (e) => {
  const b = /** @type {Element} */ (e.target).closest?.(".pill, .btn");
  if (!b) return;
  b.classList.add("pressed");
  b.addEventListener("pointerleave", () => b.classList.remove("pressed"), { once: true });
});

// ---------- dropdowns ----------
// A dropdown's open list is the system's, drawn outside the page and beyond styling. Every
// <select> keeps its closed state (a pill, styles.css) but opens ours: a rounded, outlined
// list in the pills' manner (the chosen item inverted; the others hover a lighter black),
// with our scrollbar when long. Choosing sets the select's value and fires its change, so the
// code using it is as before. Keys: Space, Enter or Alt+Down open; Up and Down move, Enter
// picks, Escape closes, a letter jumps to the next item starting with it.
let openList = null;

function closeList(refocus = true) {
  if (!openList) return;
  const { popup, select, cleanup } = openList;
  openList = null;
  cleanup();
  popup.remove();
  select.classList.remove("open");
  if (refocus) select.focus();
}

function openSelect(select) {
  closeList(false);
  const popup = document.createElement("div");
  popup.className = "select-popup";
  const list = document.createElement("div");
  list.className = "select-list";
  list.setAttribute("role", "listbox");
  popup.append(list);
  const items = [...select.options].map((o, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "select-item";
    b.textContent = o.textContent;
    b.disabled = o.disabled;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(i === select.selectedIndex));
    b.addEventListener("click", () => choose(i));
    b.addEventListener("pointermove", () => mark(i));
    list.append(b);
    return b;
  });
  (select.closest("dialog") ?? document.body).append(popup); // in a modal dialog's layer, or the page's
  select.classList.add("open"); // raised while its list is open (styles.css)
  let active = Math.max(0, select.selectedIndex);
  const mark = (i) => {
    items[active]?.classList.remove("active");
    active = i;
    items[active]?.classList.add("active");
  };
  const choose = (i) => {
    if (items[i].disabled) return;
    const changed = select.selectedIndex !== i;
    select.selectedIndex = i;
    closeList();
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  // Under the pill, or above it if there is more room there; inside the window. Its left edge
  // on the pill's, in line with what is round it (the panel's column); wider to the right
  // only, as far as the window allows (longer names end in an ellipsis there).
  const r = select.getBoundingClientRect();
  const margin = 8;
  popup.style.minWidth = `${r.width}px`;
  popup.style.maxWidth = `${Math.max(r.width, Math.min(480, innerWidth - margin - Math.max(margin, r.left)))}px`;
  const below = innerHeight - r.bottom - margin;
  const above = r.top - margin;
  const room = Math.max(below, above) - 4;
  // Whole pixels: a fractional height left the list a fraction short of its end, the last item cut.
  list.style.maxHeight = `${Math.floor(Math.min(room, innerHeight * 0.6))}px`;
  // First: a long list makes room for it, and is measured with that room. 1 px out from the
  // list's edge (the popup's inside, its padding the list's): as it was 3 px into the padding.
  const dropBar = addScrollbar(list, "y", { nudge: -1 });
  const w = popup.offsetWidth;
  const h = popup.offsetHeight;
  const left = Math.round(Math.min(Math.max(margin, r.left), innerWidth - margin - w));
  const top = Math.round(below >= h || below >= above ? r.bottom + 4 : r.top - 4 - h);
  Object.assign(popup.style, { left: `${left}px`, top: `${top}px` });
  items[active]?.scrollIntoView({ block: "nearest" }); // marked only once pointed at or keyed to

  const onKey = (e) => {
    if (e.key === "Escape") closeList();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      let i = active;
      do i = (i + step + items.length) % items.length; while (items[i].disabled && i !== active);
      mark(i);
      items[i].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" || e.key === " ") choose(active);
    else if (e.key === "Tab") closeList(false);
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase();
      const order = [...items.keys()].map((n) => (active + 1 + n) % items.length);
      const hit = order.find((n) => !items[n].disabled && items[n].textContent.trim().toLowerCase().startsWith(k));
      if (hit === undefined) return;
      mark(hit);
      items[hit].scrollIntoView({ block: "nearest" });
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = (e) => {
    if (!popup.contains(e.target) && e.target !== select) closeList(false);
  };
  const onAway = (e) => {
    if (e.type === "scroll" && popup.contains(e.target)) return; // its own list scrolling
    closeList(false);
  };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("resize", onAway);
  window.addEventListener("blur", onAway);
  document.addEventListener("scroll", onAway, true);
  openList = {
    popup,
    select,
    cleanup: () => {
      dropBar(); // its list goes with it
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onAway);
      window.removeEventListener("blur", onAway);
      document.removeEventListener("scroll", onAway, true);
    },
  };
}

document.addEventListener("mousedown", (e) => {
  const select = /** @type {Element} */ (e.target).closest?.("select");
  if (!(select instanceof HTMLSelectElement) || select.disabled || e.button !== 0) return;
  e.preventDefault(); // not the system's list
  // Its look after the click: not raised by the hover until the pointer leaves, nor as if
  // reached by keyboard until a key is pressed (styles.css).
  select.classList.add("pressed");
  select.addEventListener("pointerleave", () => select.classList.remove("pressed"), { once: true });
  select.dataset.pointer = "";
  if (openList?.select === select) closeList();
  else {
    select.focus();
    openSelect(select);
  }
});
for (const type of ["keydown", "focusout"]) {
  document.addEventListener(type, (e) => {
    if (e.target instanceof HTMLSelectElement) delete e.target.dataset.pointer;
  }, true);
}
document.addEventListener("keydown", (e) => {
  const select = e.target;
  if (!(select instanceof HTMLSelectElement) || openList) return;
  // (Not Space: that is the 3D view's, see viewer/input.js.)
  if (e.key === "Enter" || (e.altKey && e.key === "ArrowDown") || e.key === "F4") {
    e.preventDefault();
    openSelect(select);
  }
});
