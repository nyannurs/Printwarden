// The 3D view's compass, above the zoom: the world's X, Y and Z as the camera sees them (X across
// the book, Y up from the table, Z along the spine), so turning the view stays easy to follow.
// A round pill a square wide; the axes pointing away from the camera drawn first and fainter.

const SVG = "http://www.w3.org/2000/svg";
/** @type {[string, [number, number, number]][]} */
const AXES = [["X", [1, 0, 0]], ["Y", [0, 1, 0]], ["Z", [0, 0, 1]]];
const REACH = 0.56; // an axis's length, of the circle's radius
const LABEL = 0.78; // where its letter sits

/** Build the compass in `el`; returns update(camera), to call whenever the camera moved. */
export function makeCompass(el) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "-1 -1 2 2");
  svg.setAttribute("aria-hidden", "true");
  const parts = AXES.map(([name]) => {
    const g = document.createElementNS(SVG, "g");
    const line = document.createElementNS(SVG, "line");
    line.setAttribute("x1", "0");
    line.setAttribute("y1", "0");
    const text = document.createElementNS(SVG, "text");
    text.textContent = name;
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    g.append(line, text);
    svg.append(g);
    return { g, line, text };
  });
  el.append(svg);
  let last = "";
  return (camera) => {
    // World directions in the camera's own space: x right, y up, z toward the viewer.
    const e = camera.matrixWorldInverse.elements;
    const key = [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]].map((v) => v.toFixed(3)).join();
    if (key === last) return;
    last = key;
    const seen = AXES.map(([, [x, y, z]], i) => ({
      i,
      sx: e[0] * x + e[4] * y + e[8] * z,
      sy: e[1] * x + e[5] * y + e[9] * z,
      sz: e[2] * x + e[6] * y + e[10] * z,
    }));
    // Back to front: an axis pointing at the viewer is drawn over the others.
    seen.sort((a, b) => a.sz - b.sz);
    for (const { i, sx, sy, sz } of seen) {
      const { g, line, text } = parts[i];
      svg.append(g); // drawing order
      line.setAttribute("x2", String(sx * REACH));
      line.setAttribute("y2", String(-sy * REACH));
      text.setAttribute("x", String(sx * LABEL));
      text.setAttribute("y", String(-sy * LABEL));
      g.style.opacity = sz < -0.05 ? "0.45" : "1"; // pointing away from the viewer
    }
  };
}
