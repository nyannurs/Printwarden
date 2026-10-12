// Camera state. Two modes:
//  - default: rotation is completely free while dragging and springs back to the home
//    view on release (critically damped: no overshoot, a wobble reads as a bug);
//    zoom persists.
//  - free: entered by panning (space + drag). Nothing springs back; the camera stays
//    where you put it until you return to default (double-tap space).

const DEG = Math.PI / 180;
const HOME_OPEN = { azimuth: 0, elevation: 40 * DEG };
const HOME_CLOSED = { azimuth: -28 * DEG, elevation: 42 * DEG };

/** Camera presets: angles to look from. "reading" differs for the open and closed book. */
export const CAMERA_PRESETS = {
  reading: { label: "Reading view" },
  isometric: { label: "Isometric", azimuth: -45 * DEG, elevation: 35.264 * DEG },
  top: { label: "Top down", azimuth: 0, elevation: 88.9 * DEG },
  front: { label: "Front", azimuth: 0, elevation: 12 * DEG },
  side: { label: "Side", azimuth: -90 * DEG, elevation: 16 * DEG },
  // The book hangs in space, tilted as if caught mid-fall, cover toward the camera; no
  // table. Fixed, not animated: it opens and turns as anywhere else. `float`: the book's
  // tilt (radians) about x (head toward the camera) and z (one side down).
  floating: { label: "Floating", azimuth: -14 * DEG, elevation: 58 * DEG, float: { x: 0.3, z: -0.24 } },
};

export function presetHome(name, closed) {
  const p = CAMERA_PRESETS[name];
  if (!p || p.azimuth === undefined) return closed ? HOME_CLOSED : HOME_OPEN;
  return { azimuth: p.azimuth, elevation: p.elevation };
}
const ELEVATION_LIMIT = 89 * DEG; // straight up/down would flip the view
// Camera distance relative to the preset's framing: 800 % to 50 % (the zoom slider's range).
const ZOOM_LIMITS = [1 / 8, 2];
const OMEGA = 10; // spring stiffness; settles in ~0.5 s
const DRAG_SPEED = 0.0065; // radians per pixel

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a)); // to [-π, π]

export class CameraRig {
  constructor() {
    this.home = HOME_OPEN;
    this.azimuth = this.home.azimuth;
    this.elevation = this.home.elevation;
    this.vel = { azimuth: 0, elevation: 0 };
    this.zoom = 1;
    this.pan = { x: 0, y: 0, z: 0 };
    this.dragging = false;
    this.springing = false;
    this.free = false;
    this.resetting = null; // {from, start} while pan/zoom animate home
  }

  /** Panning leaves the default mode. */
  enterFree() {
    this.free = true;
    this.resetting = null;
    this.springing = false;
  }

  setHome(home) {
    this.home = home;
    if (!this.dragging && !this.free) this.#spring();
  }

  beginDrag() {
    this.dragging = true;
    this.springing = false;
  }

  drag(dx, dy) {
    this.azimuth -= dx * DRAG_SPEED;
    this.elevation = Math.max(-ELEVATION_LIMIT, Math.min(ELEVATION_LIMIT, this.elevation + dy * DRAG_SPEED));
  }

  endDrag() {
    this.dragging = false;
    if (!this.free) this.#spring();
  }

  clampZoom(zoom) {
    return Math.min(ZOOM_LIMITS[1], Math.max(ZOOM_LIMITS[0], zoom));
  }

  /** Back to the default mode: animate pan, zoom and rotation home. */
  resetView() {
    this.free = false;
    this.resetting = { from: { zoom: this.zoom, pan: { ...this.pan } }, start: null };
    this.#spring();
  }

  #spring() {
    // Take the short way round after a free spin.
    this.azimuth = this.home.azimuth + wrap(this.azimuth - this.home.azimuth);
    this.vel = { azimuth: 0, elevation: 0 };
    this.springing = true;
    this.lastTime = null;
  }

  /** Advance animations. Returns true while anything is moving. */
  update(time) {
    let moving = this.dragging;
    if (this.resetting) {
      this.resetting.start ??= time;
      const p = Math.min(1, (time - this.resetting.start) / 450);
      const e = 1 - (1 - p) ** 3;
      const { from } = this.resetting;
      this.zoom = from.zoom + (1 - from.zoom) * e;
      for (const k of ["x", "y", "z"]) this.pan[k] = from.pan[k] * (1 - e);
      if (p >= 1) this.resetting = null;
      moving = true;
    }
    if (!this.springing || this.dragging) {
      this.lastTime = null;
      return moving;
    }
    const dt = this.lastTime == null ? 1 / 60 : Math.min(0.05, (time - this.lastTime) / 1000);
    this.lastTime = time;
    let still = true;
    for (const key of ["azimuth", "elevation"]) {
      // x'' = -ω²(x - home) - 2ω x'   (critically damped)
      const x = this[key] - this.home[key];
      const v = this.vel[key];
      this.vel[key] = v + (-OMEGA * OMEGA * x - 2 * OMEGA * v) * dt;
      this[key] += this.vel[key] * dt;
      if (Math.abs(this[key] - this.home[key]) > 1e-4 || Math.abs(this.vel[key]) > 1e-3) still = false;
    }
    if (still) {
      this.azimuth = this.home.azimuth;
      this.elevation = this.home.elevation;
      this.springing = false;
    }
    return true;
  }
}
