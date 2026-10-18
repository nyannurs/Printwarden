// Mouse and keyboard on the view: drag to orbit (the camera springs home on release), space
// and drag to pan, double space to reset, the wheel to zoom (gliding), a click to turn.
// `own`: the scene's own steps (waking its frames, where it aims).

import * as THREE from "three";
import { pageHit } from "./leaf.js";

const CLICK_SLOP_PX = 5;
const DOUBLE_TAP_MS = 320;

// The camera never gets closer to paper than this (mm): close enough to fill the screen
// with a 6 pt letter, never through the page.
const MIN_SURFACE_DISTANCE = 8;

export function bindInput(scene, own) {
  const el = scene.renderer.domElement;
  let down = null;
  scene.space = false;
  let lastSpace = 0;
  // Input wakes the frame loop first (see #wake): what it moves is checked every frame.
  for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) el.addEventListener(type, () => own.wake(), { capture: true, passive: true });
  for (const type of ["keydown", "keyup"]) window.addEventListener(type, () => own.wake(), { capture: true, passive: true });

  // Space pans unless it types; a focused slider (zoom) doesn't type.
  const typing = (e) => e.target.closest?.("input:not([type=range]), select, textarea, [contenteditable], dialog");
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || typing(e)) return;
    e.preventDefault();
    if (e.repeat) return;
    const now = performance.now();
    if (now - lastSpace < DOUBLE_TAP_MS) scene.resetView();
    lastSpace = now;
    scene.space = true;
    el.style.cursor = "grab";
  });
  window.addEventListener("keyup", (e) => {
    if (e.code !== "Space") return;
    scene.space = false;
    el.style.cursor = "";
  });
  window.addEventListener("blur", () => {
    scene.space = false;
    el.style.cursor = "";
    end(); // switching windows mid-drag: the button's release never arrives here
  });

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    down = { x: e.clientX, y: e.clientY, moved: false, pan: scene.space };
    if (!down.pan) scene.rig.beginDrag();
  });
  el.addEventListener("pointermove", (e) => {
    if (!down) return;
    if (!(e.buttons & 1)) {
      end(); // released elsewhere (another window, outside the app)
      return;
    }
    if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_SLOP_PX) return;
    down.moved = true;
    if (down.pan) {
      scene.rig.enterFree();
      pan(scene, own, e.movementX, e.movementY);
    } else {
      orbit(scene, own, e.movementX, e.movementY);
    }
    scene.dirty = true;
  });
  // A drag ends on release, and also whenever the app loses the pointer: otherwise
  // panning or orbiting would stay on until the next click.
  const end = () => {
    if (!down) return;
    const { pan } = down;
    down = null;
    if (!pan) scene.rig.endDrag();
  };
  el.addEventListener("pointerup", (e) => {
    const clicked = down && !down.moved && !down.pan;
    end();
    if (clicked) click(scene, e);
  });
  el.addEventListener("pointercancel", end);
  el.addEventListener("lostpointercapture", end);
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(scene, own, e);
  }, { passive: false });
}

function pan(scene, own, dx, dy) {
  const lowest = scene.float ? -Infinity : (scene.model?.ground ?? -Infinity) + 2;
  const wasAbove = scene.camera.position.y >= lowest - 1e-3;
  const d = scene.camera.position.distanceTo(own.currentTarget());
  const perPx = (2 * d * Math.tan((scene.camera.fov * Math.PI) / 360)) / scene.renderer.domElement.clientHeight;
  const right = new THREE.Vector3().setFromMatrixColumn(scene.camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(scene.camera.matrixWorld, 1);
  const shift = right.multiplyScalar(-dx * perPx).add(up.multiplyScalar(dy * perPx));
  const p = scene.rig.pan;
  p.x += shift.x;
  p.y += shift.y;
  p.z += shift.z;
  pivotOnPaper(scene, own);
  // A pan doesn't take the camera under the table: in low views (Front, Side) a pan
  // downward would otherwise. Lifting the whole view keeps the pivot in front of the
  // paper. Already beneath it (orbited there to see the underside), panning is free:
  // lifting there fought the pivot settling back onto the paper, and the view jumped.
  const cameraY = own.currentTarget().y + scene.fitDistance * scene.rig.zoom * Math.sin(scene.rig.elevation);
  if (wasAbove && cameraY < lowest) p.y += lowest - cameraY;
  scene.cameraChanged = true;
}

/**
 * Keep the camera exactly where it is, but move the point it pivots on onto the paper
 * at the centre of the view. Pages slope, so a pan could otherwise slide the pivot
 * underneath one; the camera would then follow it under the paper and the book would
 * seem to vanish.
 */
function pivotOnPaper(scene, own) {
  const { azimuth, elevation, zoom } = scene.rig;
  const d = scene.fitDistance * zoom;
  const toCamera = new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
  const target = own.currentTarget();
  const camera = target.clone().addScaledVector(toCamera, d);
  const ray = new THREE.Raycaster(camera, toCamera.clone().negate(), 0, d + scene.fitDistance);
  const hit = ray.intersectObjects(scene.leaves.map((l) => l.mesh), false)[0];
  if (!hit) return; // off the book: nothing to stay above
  const onPaper = Math.max(MIN_SURFACE_DISTANCE, hit.distance) / scene.fitDistance;
  // Farther than the zoom range allows (zoomed out over low paper): the pivot stays where
  // it is, in front of the paper, which is harmless.
  if (onPaper > scene.rig.clampZoom(onPaper)) return;
  const p = scene.rig.pan;
  p.x += hit.point.x - target.x;
  p.y += hit.point.y - target.y;
  p.z += hit.point.z - target.z;
  // Where the paper rises toward the camera (pages slope up to the spine), back off: to
  // 8 mm from it, and never closer than the zoom range allows (800 %).
  const was = scene.rig.zoom;
  scene.rig.zoom = scene.rig.clampZoom(onPaper);
  scene.zoomBias *= scene.rig.zoom / was; // the camera hasn't moved: neither does the zoom shown
}

/**
 * Zoom toward the centre of the view: what is in the middle of the screen stays there.
 * Each wheel notch moves a goal; the camera glides to it (see glideZoom), so zooming
 * is smooth rather than a jump per notch. Over a page, the aim point is on the paper
 * itself and the goal stops short of it: the camera bumps into the page instead of
 * passing through.
 */
function zoomAt(scene, own, e) {
  const scale = e.deltaMode === 1 ? 0.05 : 0.0015;
  const now = performance.now();
  const glide = scene.zoomGlide;
  // A new burst of scrolling finds its aim point; notches within a burst share it.
  if (!glide || glide.keepPivot || now - glide.lastInput > 250) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), scene.camera);
    const target = own.currentTarget();
    const onPage = ray.intersectObjects(scene.leaves.map((l) => l.mesh), false)[0];
    let anchor = onPage?.point ?? null;
    if (!anchor) {
      const facing = new THREE.Vector3();
      scene.camera.getWorldDirection(facing);
      anchor = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(facing, target), new THREE.Vector3());
    }
    const zoom = scene.rig.zoom;
    // Closest the camera may get: MIN_SURFACE_DISTANCE from the paper under the aim.
    const floor = onPage ? zoom * Math.min(1, MIN_SURFACE_DISTANCE / onPage.distance) : 0;
    scene.zoomGlide = { anchor, goal: zoom, floor, lastInput: now, lastTime: null };
  }
  const g = scene.zoomGlide;
  g.goal = Math.max(g.floor, scene.rig.clampZoom(g.goal * Math.exp(e.deltaY * scale)));
  g.lastInput = now;
  scene.rig.resetting = null; // a deliberate zoom wins over a running reset
  scene.dirty = true;
}

/** Ease the camera toward the zoom goal, keeping the aim point fixed on screen. */
export function glideZoom(scene, own, time) {
  const g = scene.zoomGlide;
  if (!g) return false;
  const dt = g.lastTime == null ? 1 / 60 : Math.min(0.05, (time - g.lastTime) / 1000);
  g.lastTime = time;
  const from = scene.rig.zoom;
  const gap = Math.log(g.goal / from);
  const done = Math.abs(gap) < 0.002;
  const next = done ? g.goal : from * Math.exp(gap * (1 - Math.exp(-dt / 0.075)));
  const ratio = next / from;
  scene.rig.zoom = next;
  if (g.anchor) {
    const target = own.currentTarget();
    const moved = g.anchor.clone().add(target.clone().sub(g.anchor).multiplyScalar(ratio)).sub(target);
    const p = scene.rig.pan;
    p.x += moved.x;
    p.y += moved.y;
    p.z += moved.z;
  }
  scene.cameraChanged = true;
  if (done) {
    scene.zoomGlide = null;
    if (!g.keepPivot) pivotOnPaper(scene, own);
  }
  return true;
}

/**
 * Is a page between the pivot and where the camera would be? Close up only: from afar the
 * pivot floats above the book and nothing can come between.
 */
function pageInTheWay(scene, own) {
  const { azimuth, elevation, zoom } = scene.rig;
  const d = scene.fitDistance * zoom;
  if (!scene.leaves.length || d > scene.fitDistance * 0.5) return false;
  const toCamera = new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
  const world = new THREE.Ray(own.currentTarget(), toCamera);
  const local = new THREE.Ray();
  const toLeaf = new THREE.Matrix4();
  return scene.leaves.some((leaf) => {
    leaf.mesh.updateWorldMatrix(true, false);
    local.copy(world).applyMatrix4(toLeaf.copy(leaf.mesh.matrixWorld).invert());
    return pageHit(scene.model, leaf, local, null, 0.05, d) !== null;
  });
}

/**
 * Orbit by a drag, stopping at pages like at a wall: a movement that would put a page
 * between the pivot and the camera is refused (sliding along it where one direction is
 * free). Only your own dragging is checked: book animations (opening, closing, turning)
 * never move the camera, their pages may pass through the view. (Pushing the camera in
 * front of pages every frame made it jump as they swept past.)
 */
function orbit(scene, own, dx, dy) {
  const rig = scene.rig;
  // Already behind a page (one swung there while you looked): move freely to get out.
  if (pageInTheWay(scene, own)) {
    rig.drag(dx, dy);
    return;
  }
  const before = { azimuth: rig.azimuth, elevation: rig.elevation };
  for (const [mx, my] of [[dx, dy], [dx, 0], [0, dy]]) {
    rig.azimuth = before.azimuth;
    rig.elevation = before.elevation;
    rig.drag(mx, my);
    if (!pageInTheWay(scene, own)) return;
  }
  rig.azimuth = before.azimuth;
  rig.elevation = before.elevation;
}

/** Click right of the spine to turn forward, left to turn back; a closed book opens. Only
 * on the book itself: a click beside it does nothing. */
function click(scene, e) {
  const r0 = scene.renderer.domElement.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r0.left) / r0.width) * 2 - 1, -((e.clientY - r0.top) / r0.height) * 2 + 1), scene.camera);
  if (!ray.intersectObject(scene.block, true).length) return;
  if (scene.isClosed) {
    scene.callbacks.onOpenRequest?.();
    return;
  }
  const spine = scene.block.localToWorld(new THREE.Vector3(0, scene.model?.ground ?? 0, 0)).project(scene.camera);
  const spineX = r0.left + ((spine.x + 1) / 2) * r0.width;
  scene.callbacks.onTurnRequest?.(e.clientX >= spineX ? 1 : -1);
}
