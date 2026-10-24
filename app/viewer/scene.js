// The book in 3D. Each leaf is a ribbon with real paper thickness that bends out of the
// spine and curls while it turns (shape in model.js). Paper is lit by a studio
// environment, casts soft shadows, multiplies the page image like ink on stock, and
// lets the other side show through on thin paper. The gutter darkens toward the fold
// the way it does in a real book (computed per binding, noise-free).
//
// World space is millimetres: the book lies on a table, spine along z, head at -z.
//
// Its parts in files of their own, as functions of the scene: where the camera stands and what
// it sees (framing.js), the page images and tiles going to the GPU (uploads.js), screenshots,
// videos and the picture read back (capture.js), input (input.js), the layout (layout.js) and
// the draw order and shadows (draw.js).

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { CAMERA_PRESETS, CameraRig, presetHome } from "./camera.js";
import * as capture from "./capture.js";
import { drawOrder, shadows } from "./draw.js";
import { layoutGround, makeExtras } from "./extras.js";
import { frameCamera, placeCamera, visiblePages } from "./framing.js";
import { bindInput, glideZoom, panBy } from "./input.js";
import { layoutLeaves } from "./layout.js";
import { freeFlap, isCover, makeFlap, makeLeaf, makeSheets, fillerMaterial } from "./leaf.js";
import { HOLE_OFFSET_MM, makeBook, restingAngle, turnCurl } from "./model.js";
import { MAX_DETAIL, sheetShader } from "./shaders.js";
import { naiveLut } from "./inklut.js";
import { disposeTexture, makeContactMap, makeGrain, makeInkLut, makeInkPaper, makeWhite } from "./textures.js";
import { TileCache } from "./tiles.js";
import * as uploads from "./uploads.js";

const TURN_MS = 720;
const FAST_TURN_MS = 360; // for requests in quick succession (rapid clicks, scrubbing)
const CLOSE_MS = 900;
const FAST_SCRUB_MS = 160; // requests closer than this count as quick succession
// A coil book closing from a spread: its closing (the ring turning round the spine, the book
// settling onto it) starts this share of the pages' turn before they land, so pages and book
// move as one; begun only after they landed, the book stopped, then buckled. (Its sheets never
// meet, however much the two overlap: tests/scene.test.js, frame by frame.)
const CLOSE_OVERLAP = 0.5;
const SETTLE_MS = 120; // quiet time before the view counts as settled
// After pages turned: longer, so the at-rest tile requests (the next finer level, the spreads
// either side: ui/tiles.js) aren't made for pages only flipped past as the next click comes.
const TURN_SETTLE_MS = 350;
// All light scaled so white paper peaks just under the screen's white (about 247-250 of
// 255, measured on a white page in the reading and isometric views): it shades instead of
// clipping flat. At 1 (until 0.13.1), about 60 % of a white page sat at 255: overexposed.
// The same factor on every light keeps hues; a tone-mapping curve would shift them.
const LIGHT = 0.92;
const KEY_INTENSITY = 1.57 * LIGHT;
const ENV_INTENSITY = 0.35 * LIGHT;
const RIM_INTENSITY = 0.29 * LIGHT;
const VIEW_FOV = 30; // the live view's lens (vertical, degrees): about 45 mm full-frame

/**
 * The parts of a frame's main-thread time (frameLog.parts): the animations and the camera
 * brought on (update), the sheets laid out (layout: their shapes, to the GPU), page images and
 * tiles to the GPU (uploads), the tiles the view needs found (tiles: rays from the screen),
 * whether the shadow map is drawn again (shadows: three draws it with the frame, so its cost is
 * in draw; the performance check's run without shadows shows it), the sheets sorted (order),
 * the frame's draw calls (draw).
 */
export const FRAME_PARTS = ["update", "layout", "uploads", "tiles", "shadows", "order", "draw"];
const PART = Object.fromEntries(FRAME_PARTS.map((name, i) => [name, i]));

const easeTurn = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t); // gentle, like a hand
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @typedef {{wake: () => void, update: (time: number) => {animating: boolean, moving: boolean}}} SceneSteps
 */

export class BookScene {
  /**
   * The scene's own steps that the parts in other files call (input.js, capture.js): asking
   * for frames again, and the animations brought to a time.
   * @type {SceneSteps}
   */
  #own = {
    wake: () => this.#wake(),
    update: (time) => this.#update(time),
  };

  /**
   * @param {HTMLElement} container
   * @param {{onTurnRequest?: (delta: number) => void, onOpenRequest?: () => void,
   *          onChange?: () => void, onViewSettled?: (time: number) => void, onViewMoving?: () => void,
   *          onViewFrame?: (time: number) => void,
   *          onZoom?: (percent: number) => void, onCamera?: (camera: THREE.PerspectiveCamera) => void}} callbacks
   *   onCamera: after the camera is placed for a frame drawn (the compass); onViewFrame: every
   *   frame the view moves (the tiles it needs, ui/tiles.js), onViewSettled once it stops
   */
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;

    // No depth buffer of its own: the scene is drawn into the composer's targets, the canvas
    // only gets their result (see OutputPass).
    const r = new THREE.WebGLRenderer({ antialias: false, depth: false, powerPreference: "high-performance" });
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    // No tone-mapping curve: a page lit head-on shows exactly the colours it was rendered
    // with (the ICC-converted CMYK), like a flat proof; light only ever darkens it.
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.shadowMap.autoUpdate = false; // drawn only when what casts shadows changed: see shadows
    // three numbers a program's textures across its vertex and fragment stages together but
    // checks them against one stage's limit: the page shader's 16 (the most a stage has on
    // many GPUs) plus the sheets in the vertex stage drew a warning for every page, every
    // frame (10,000 a second while dragging). Their limit together is the one that counts;
    // a stage past its own fails to compile, loudly.
    const gl = r.getContext();
    r.capabilities.maxTextures = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
    this.layoutVersion = 0; // counts the book's layouts (the leaves', and the parts around them)
    container.appendChild(r.domElement);
    this.renderer = r;
    this.tiles = new TileCache(r); // the pages' tiles on the GPU (see tiles.js); bound to the pages by uploads.js

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#56575b");
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = ENV_INTENSITY;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(VIEW_FOV, 1, 1, 10000);
    this.key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(4096, 4096);
    this.key.shadow.bias = -0.0003;
    this.key.shadow.normalBias = 0.1;
    this.key.shadow.radius = 3;
    this.rim = new THREE.DirectionalLight(0xffffff, RIM_INTENSITY); // back light: edges read
    this.scene.add(this.key, this.key.target, this.rim, this.rim.target);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    );
    this.ground.receiveShadow = true;
    this.ground.material.onBeforeCompile = (shader) => {
      shader.uniforms.uCasterMap = this.shared.uCasterMap; // see nearestCasters
      shader.uniforms.uCasterMapOn = this.shared.uCasterMapOn;
    };
    this.ground.material.customProgramCacheKey = () => "bookview-table";
    this.scene.add(this.ground);
    // Where the book rests on the table, less light reaches it from anywhere: a soft dark
    // footprint (ambient occlusion from the book's known shape, not from the screen).
    this.contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: makeContactMap(), transparent: true, opacity: 0.38, depthWrite: false }),
    );
    this.contact.renderOrder = 1;
    this.scene.add(this.contact);

    // Rendered through a multisampled target, then converted for the screen. (Screen-space
    // ambient occlusion was tried and dropped: it left noise in the deep gutter.) The target
    // keeps 8-bit sRGB, as the screen does: the same pixels as half floats (checked: no pixel
    // off by more than 2 of 255), at half the memory traffic. 8× multisampling where
    // available: thousands of sub-pixel leaf edges shimmer at 4×. On a high-density screen (a
    // Retina display: four device pixels to a point) 4× is as fine; 2× there turned the block's
    // fine edge lines into a stipple. Screenshots and videos take 8× regardless.
    const samples = Math.min(r.getPixelRatio() >= 2 ? 4 : 8, r.capabilities.maxSamples);
    // Only its colour is resolved: nothing reads the depth after (copying it cost a full-screen
    // pass a frame).
    const target = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, colorSpace: THREE.SRGBColorSpace, samples, resolveDepthBuffer: false });
    // The output pass reads what the render pass drew and swaps nothing: else the composer's
    // two targets take turns, frame by frame, and both are kept (twice the memory: 280 MB more
    // at 3472 × 2014 px).
    const output = () => Object.assign(new OutputPass(), { needsSwap: false });
    this.composer = new EffectComposer(r, target());
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(output());
    // Every frame is drawn at full size, in motion too. (Until 2026-10-24 motion was drawn
    // smaller when frames came late, through a second composer: the pages went soft the moment
    // a turn or a drag began, and the late frames were mostly a document loading or tiles going
    // up, not a slow graphics card; the author's M4 Pro holds 120 fps at full size.)
    // How long the graphics card takes to draw a frame, where it can be timed (the frame counter).
    this.gpuTime = { timer: r.getContext().getExtension("EXT_disjoint_timer_query_webgl2"), queries: [], ms: 0, at: -Infinity };
    // Drawn frames (frameStats): when, the main thread's time, and that time by part (the
    // performance check's breakdown, see FRAME_PARTS).
    this.frameLog = { time: new Float64Array(256), cpu: new Float64Array(256), parts: FRAME_PARTS.map(() => new Float64Array(256)), n: 0 };
    this.partTimes = new Float64Array(FRAME_PARTS.length); // this frame's, as they are measured
    this.casters = { current: false }; // see nearestCasters

    this.root = new THREE.Group();
    this.scene.add(this.root);
    // The book itself, inside root: tilted when a closed coil book rests on its coil.
    this.block = new THREE.Group();
    this.root.add(this.block);

    this.white = makeWhite();
    this.none = makeWhite(); // a finish mask without ink
    // The pages' placeholder, by their kind (setPageKind): as inks, none (paper); as sRGB
    // images, white. And the ink table the shaders read the inks through (setInkLut).
    this.noInk = makeInkPaper();
    this.blank = this.white;
    // The spots: a page image's spot channels where it has none (no ink), the look in CMYK of
    // each spot that prints, by name (setSpotInks), and which spot each page's channels hold.
    this.noSpots = makeInkPaper();
    /** @type {Map<string, number[]>} */
    this.spotInks = new Map();
    /** @type {Map<number, string[]>} folio -> its spot channels' names (see uploads.js showPage) */
    this.spotNames = new Map();
    this.inkLut = makeInkLut(naiveLut());
    /** @type {Map<number, THREE.Mesh>} folio -> a flap lying on that page (see setPageFlap) */
    this.flaps = new Map();
    // folio -> the page's image, on the GPU only (see setPageTexture); kept through rebuilds.
    this.pageTextures = new Map();
    this.overrides = new Map(); // folio -> an image shown instead for now (see showPageImage)
    this.finish = { kind: 0, images: new Map(), textures: new Map() };
    this.grain = makeGrain();
    this.shared = {
      uHoles: { value: new THREE.Vector4(0, 8, 2.5, HOLE_OFFSET_MM) },
      uPageSize: { value: new THREE.Vector2(148, 210) },
      uGutter: { value: new THREE.Vector2(14, 0.2) }, // shade width (mm), depth at the fold
      uOpenness: { value: 1 }, // the gutter shade fades as the book closes
      // Every sheet's cross-sections, for the GPU to build the sheets from (see SHEET_VERTEX).
      uSheets: { value: null },
      uSheetLayout: { value: new THREE.Vector3(1, 1, 2) },
      // Where no shadow caster comes near (see nearestCasters).
      uCasterMap: { value: null },
      uCasterMapOn: { value: 0 },
      // The tile cache's texture array (TILE_GLSL; each page's table is its own uniform).
      uTiles: { value: this.tiles.texture },
      // The pages' inks to colour (INK_GLSL): the table, the plates that print, whether the
      // pages are inks at all (see setPageKind).
      uInkLut: { value: this.inkLut },
      uInkOn: { value: new THREE.Vector4(1, 1, 1, 1) },
      uInkPages: { value: 0 },
    };
    this.edgeMat = new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide });
    this.coverEdgeMat = new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide }); // the covers' cut edges
    this.kraftMat = new THREE.MeshStandardMaterial({ color: 0x5c4b3a, roughness: 1, side: THREE.DoubleSide }); // a case's spine lining, inside the hollow
    this.coverMat = new THREE.MeshPhysicalMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    // The outside of the spine: a colour, or imported artwork (see setSpine). Its two narrow
    // sides are the covers wrapping onto it: each shows its cover's colour at the spine edge.
    this.spineMat = new THREE.MeshPhysicalMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    this.frontWrapMat = new THREE.MeshPhysicalMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    this.backWrapMat = new THREE.MeshPhysicalMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    // A glued or sewn spine block's narrow sides, where the cover folds round the spine's
    // corner: the spine's own tone there (its colour, or its artwork's colour along that
    // edge), as the fold carries the spine's printing round the corner. (The cover's edge
    // colour until 0.17.84: a white cover on a black spine drew a white line along the corner.)
    this.spineSideFrontMat = new THREE.MeshPhysicalMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    this.spineSideBackMat = new THREE.MeshPhysicalMaterial({ roughness: 0.8, side: THREE.DoubleSide });
    // The same for the sheets' own edges, built on the GPU (the others are used elsewhere
    // too), kept alike by #syncSheetEdges; and the sheets' shape for their shadows.
    this.sheetEdges = new Map([this.edgeMat, this.coverEdgeMat, this.frontWrapMat, this.backWrapMat].map((base) => {
      const m = base.clone();
      m.onBeforeCompile = (shader) => sheetShader(shader, this.shared);
      m.customProgramCacheKey = () => "bookview-sheet";
      return [base, m];
    }));
    this.sheetDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.sheetDepth.onBeforeCompile = (shader) => sheetShader(shader, this.shared);
    this.sheetDepth.customProgramCacheKey = () => "bookview-sheet";
    this.sheetFiller = fillerMaterial(this); // the faces between a flying stack's sheets (see layoutLeaves)
    // Cotton headbands: the bead and its cloth tail (a single sheet: seen from either side).
    this.headbandMat = new THREE.MeshStandardMaterial({ color: 0xece4d2, roughness: 0.85, side: THREE.DoubleSide });
    // A hardcover's case spine inside: what shows of it is the joint, which the endpaper
    // covers (it runs from the board into the first leaf), so it is paper (see setPaper).
    this.liningMat = new THREE.MeshStandardMaterial({ color: 0xf2efe8, roughness: 0.9, side: THREE.DoubleSide });
    this.stapleMat = new THREE.MeshStandardMaterial({ color: 0xc3c6ca, metalness: 1, roughness: 0.38 }); // galvanised stitching wire
    this.wireMat = new THREE.MeshStandardMaterial({ color: 0xc9cbd0, metalness: 1, roughness: 0.22 }); // coils
    this.threadMat = new THREE.MeshStandardMaterial({ color: 0xe9e3d3, roughness: 0.9 });

    this.rig = new CameraRig();
    this.turnMs = TURN_MS; // how long a page turn takes (a video may set its own)
    this.closeMs = CLOSE_MS;
    this.clock = null; // a video's time while it renders; otherwise the real time
    this.preset = "reading";
    this.float = null; // the floating preset's tilt of the book, if chosen
    this.model = null;
    this.leaves = [];
    this.extras = null;
    this.opening = 0;
    this.closed = 0; // 0 open … 1 closed, animated
    this.closedSide = 1; // closed front cover up (1) or back cover up (-1)
    // Open at a cover with every page on one side (a coil book lying flat): 1 right, -1 left.
    // The camera aims at that side, not at the spine; animated (see #frame). Also the page
    // asked for (focus), on an open spread.
    this.coverShift = 0;
    // How much the view is framed as one page (0 the spread … 1 a page), gliding on its own:
    // from one page to the other the aim crosses the spine, the framing stays a page's.
    this.pageFrame = 0;
    // Of that page framing, how much is a cover's (all pages on one side, a coil book open at
    // its cover: framed as the closed book, so closing it moves the camera no further) rather
    // than a page asked for (never farther than the spread). Glides on its own too.
    this.coverFrame = 0;
    this.focus = 0; // the page the camera centers on, open: -1 left, 0 the spread, 1 right (setFocus)
    this.closeAnim = null;
    this.lastRequest = 0;
    this.capturing = false; // a screenshot or video owns the renderer (capture.js)
    this.pixelBudget = Infinity; // see setPixelBudget
    this.warmer = null; // see uploads.js warm
    this.space = false; // space held: a drag pans (input.js)
    this.shadowState = null; // what the shadow map was last drawn for (draw.js)
    this.uploads = new Map(); // folio -> image waiting for GPU upload
    this.detailQueue = new Map(); // folio -> detail strips being prepared
    this.under = { request: null, busy: false, buffer: null, size: 0 }; // the picture read back (see sampleUnder)
    // The zoom shown is the camera's distance to its pivot against the preset's framing; the
    // pivot moves onto the paper under the view's middle when panning (input.js
    // pivotOnPaper) without the camera moving, which changes that distance: this factor takes
    // such changes out, so only deliberate zooming moves the number (it wandered 95 to 105 %
    // while panning, 0.17.93).
    this.zoomBias = 1;
    this.shownPercent = null;
    this.debugInnerFaces = false; // see layoutLeaves: diagnosis switches, off
    this.debugStackFill = null;
    this.debugFillerInk = true;
    this.debugNoPivot = false; // the performance check's "no re-pivot" run (input.js)
    this.dirty = true;
    this.geometryDirty = false;
    this.lastMotion = 0;
    this.settled = true;
    this.paper = { color: "#ffffff", roughness: 0.92, specular: 0.2, clearcoat: 0, show: 0.01, endpaperColor: null };
    this.paper.cover = { ...this.paper };
    this.target = new THREE.Vector3();
    this.fitDistance = 800;

    bindInput(this, this.#own);
    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    // Drawing stops when nothing moves or waits (see #frame). Any call from outside starts it
    // again, as do input on the view (see bindInput) and anything asking for a redraw (dirty).
    for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(BookScene.prototype))) {
      if (name === "constructor") continue;
      if (typeof d.value === "function") {
        this[name] = (...args) => {
          this.#wake();
          return d.value.apply(this, args);
        };
      } else if (d.set) {
        Object.defineProperty(this, name, { get: d.get, set: (v) => { this.#wake(); d.set.call(this, v); } });
      }
    }
    this.#wake();
  }

  /** Something to draw (dirty), or to check every frame: an animation, input. */
  get dirty() {
    return this.redraw;
  }

  set dirty(on) {
    this.redraw = on;
    if (on) this.#wake();
  }

  /**
   * Ask for frames again, if they stopped (see #frame). Our own loop, one request at a time:
   * three's, stopped from inside a frame, still asked for the next, and started again it ran
   * twice (every frame drawn twice: 480 fps on a 240 Hz screen, more with every rest).
   */
  #wake() {
    this.idleFrames = 0;
    this.frameRequest ??= requestAnimationFrame((t) => this.#tick(t));
  }

  /** A frame, and the next unless the view is at rest (see #frame). */
  #tick(time) {
    this.frameRequest = null;
    this.#frame(time);
    if (this.idleFrames <= 3) this.frameRequest ??= requestAnimationFrame((t) => this.#tick(t));
  }

  /**
   * What the pages' textures hold: "ink" (C, M, Y, K a byte each, shown through the ink table:
   * the app, see pdf/mupdf-render.js) or "rgb" (sRGB images: the client viewer, the tests).
   * Before the book is built: the placeholders are chosen by it.
   */
  setPageKind(kind) {
    this.shared.uInkPages.value = kind === "ink" ? 1 : 0;
    this.blank = kind === "ink" ? this.noInk : this.white;
    this.dirty = true;
  }

  /** The ink table (viewer/inklut.js: the chosen profile): every page changes with it, at once. */
  setInkLut(data) {
    const old = this.inkLut;
    this.inkLut = makeInkLut(data);
    this.shared.uInkLut.value = this.inkLut;
    old?.dispose();
    this.dirty = true;
  }

  /** The plates that print (Cyan, Magenta, Yellow, Black): a plate left out is gone from every page at once. */
  setInksOn(on) {
    this.shared.uInkOn.value.set(on[0] ? 1 : 0, on[1] ? 1 : 0, on[2] ? 1 : 0, on[3] ? 1 : 0);
    this.dirty = true;
  }

  /**
   * The spots that print, by name, each with its look in CMYK (0..1, in the profile: what MuPDF
   * composites it as); a spot left out is not in the map. Every page's spot channels are mixed
   * in by it from the next frame, as the process plates are switched (uploads.js refreshSpots).
   * @param {Map<string, number[]>} inks
   */
  setSpotInks(inks) {
    this.spotInks = inks;
    uploads.refreshSpots(this);
  }

  /**
   * Everything the frame on screen is made from, as plain data (a view report, ui/report.js):
   * the book as built (setBook's spec) and its paper, the camera, and every sheet's motion
   * at this moment, its times relative to now. tests/drawn.js restoreView builds the same
   * frame from it, on a scene of its own: the geometry needs no PDF.
   */
  snapshot() {
    const now = this.#now();
    const rel = (t) => (t == null ? null : t - now);
    const rig = this.rig;
    return {
      book: this.bookSpec,
      paper: this.paper,
      preset: this.preset,
      opening: this.opening,
      closed: this.closed,
      closedSide: this.closedSide,
      closeAnim: this.closeAnim ? { ...this.closeAnim, start: rel(this.closeAnim.start) } : null,
      coverShift: this.coverShift,
      pageFrame: this.pageFrame,
      coverFrame: this.coverFrame,
      focus: this.focus,
      turnMs: this.turnMs,
      closeMs: this.closeMs,
      leaves: this.leaves.map((l) => ({
        theta: l.theta, from: l.from, to: l.to, start: rel(l.start), duration: l.duration,
        curl: l.curl, curlFrom: l.curlFrom, settle: l.settle,
      })),
      rig: { azimuth: rig.azimuth, elevation: rig.elevation, zoom: rig.zoom, pan: { ...rig.pan }, free: rig.free },
      zoomBias: this.zoomBias,
      canvas: { width: this.renderer.domElement.width, height: this.renderer.domElement.height, pixelRatio: this.renderer.getPixelRatio() },
    };
  }

  /** See uploads.js queueTile. */
  queueTile(folio, level, ix, iy, page, tile, stamp) {
    uploads.queueTile(this, folio, level, ix, iy, page, tile, stamp);
  }

  /**
   * Build the book.
   * @param {{pageCount: number, pageSize: {width: number, height: number}, binding: string,
   *          signaturePages?: number | null, boardMm?: number | null, endpapers?: boolean, roundSpine?: boolean, glueMm?: number, caseWrap?: boolean,
   *          paper: {color: string, roughness: number, clearcoat: number, show: number,
   *                  thickness: number, coverThickness: number, specular?: number, gsm?: number,
   *                  finish?: string, cover?: object}}} spec
   */
  setBook(spec) {
    this.#disposeBook();
    this.bookSpec = spec; // as given: a view report rebuilds the book from it (snapshot)
    const { width, height } = spec.pageSize;
    this.model = makeBook({
      pageCount: spec.pageCount,
      binding: spec.binding,
      thickness: spec.paper.thickness,
      coverThickness: spec.paper.coverThickness,
      gsm: spec.paper.gsm,
      finish: spec.paper.finish,
      width,
      height,
      signaturePages: spec.signaturePages,
      boardMm: spec.boardMm ?? null,
      endpapers: !!spec.endpapers,
      roundSpine: !!spec.roundSpine,
      glueMm: spec.glueMm ?? 0,
      caseWrap: !!spec.caseWrap,
    });
    this.pageCount = spec.pageCount;
    this.signatureLeaves = Math.max(1, (spec.signaturePages ?? 16) / 2);
    this.shared.uPageSize.value.set(width, height);
    const style = this.model.style;
    this.shared.uHoles.value.set(style.spine === "coil" ? (style.squareHoles ? 2 : 1) : 0, style.pitch ?? 8, style.holeRadius ?? 2.5, HOLE_OFFSET_MM);
    this.shared.uGutter.value.set(style.gutter[0], style.gutter[1]);
    this.grain.repeat.set(width / 30, height / 30);

    this.opening = Math.min(this.opening, this.model.leafCount);
    this.leaves = Array.from({ length: this.model.leafCount }, (_, i) => makeLeaf(this, i));
    this.leaves[0].front.userData.uniforms.uOuterCover.value = 1;
    if (spec.pageCount % 2 === 0) this.leaves[this.leaves.length - 1].back.userData.uniforms.uOuterCover.value = 1;
    for (const [i, leaf] of this.leaves.entries()) {
      leaf.theta = leaf.to = leaf.from = restingAngle(this.model, i, this.opening);
    }
    makeSheets(this);
    this.extras = makeExtras(this);
    this.#applyFinish();
    uploads.showAllPages(this);
    this.setPaper(spec.paper);
    layoutGround(this);
    this.geometryDirty = true;
    this.coverShift = this.#shiftGoal();
    this.pageFrame = Math.abs(this.coverShift);
    this.coverFrame = this.#coverSide() ? 1 : 0;
    frameCamera(this);
  }

  /**
   * Paper look: instant, no rebuild. (Thickness changes need setBook.) `paper` holds the
   * pages' stock, `paper.cover` the cover's, `paper.endpaperColor` a hardcover's endpapers
   * (null: the pages' colour); any may be given in part.
   */
  setPaper(paper) {
    const { cover = {}, ...pages } = paper;
    this.paper = { ...this.paper, ...pages, cover: { ...this.paper.cover, ...cover } };
    // A hardcover's endpapers: the pastedowns inside the boards (the pages' stock in the
    // endpaper's colour, printed or not) and the lining across the joints.
    const cased = this.model?.style.spine === "case" && this.leaves.length > 1;
    const endpaper = { ...this.paper, color: this.paper.endpaperColor ?? this.paper.color };
    const apply = (m, stock) => {
      m.color.set(stock.color);
      m.roughness = stock.roughness;
      m.specularIntensity = stock.specular ?? 0.2;
      // Never exactly 0: toggling clearcoat on/off would recompile every shader.
      m.clearcoat = Math.max(0.001, stock.clearcoat);
      m.userData.uniforms.uShow.value = stock.show;
    };
    const n = this.leaves.length;
    for (const leaf of this.leaves) {
      const cover = isCover(this.model, leaf.i);
      const stock = cover ? this.paper.cover : this.paper;
      const inside = cased && cover; // a board's inside is its pastedown
      const flyleaf = cased && this.model.firstBlockLeaf === 2 && (leaf.i === 1 || leaf.i === n - 2);
      apply(leaf.front, flyleaf || (inside && leaf.i > 0) ? endpaper : stock);
      apply(leaf.back, flyleaf || (inside && leaf.i === 0) ? endpaper : stock);
      if (inside) {
        // A board is greyboard: nothing printed on one side shows on the other (the cover's
        // print showed faintly on the endpaper inside, the designer's hardcover).
        leaf.front.userData.uniforms.uShow.value = 0;
        leaf.back.userData.uniforms.uShow.value = 0;
      }
    }
    this.#syncTurnIns();
    this.edgeMat.color.set(this.paper.color).multiplyScalar(0.9);
    this.sheetFiller.color.set(this.paper.color);
    for (const leaf of this.leaves ?? []) for (const f of leaf.fillers ?? []) f.color.copy(this.sheetFiller.color).multiplyScalar(0.9);
    this.coverEdgeMat.color.set(this.paper.cover.color).multiplyScalar(0.9);
    this.coverMat.color.set(this.paper.cover.color).multiplyScalar(0.96); // the spine's cut ends
    this.liningMat.color.set(endpaper.color).multiplyScalar(0.95); // the endpaper across a hardcover's joint, in its shade
    this.liningMat.roughness = this.paper.roughness;
    this.#syncSheetEdges();
    this.#syncSpineStock(); // artwork on the spine is printed on the cover stock
    this.dirty = true;
  }

  #syncSheetEdges() {
    for (const [base, m] of this.sheetEdges) m.color.copy(base.color);
  }

  /**
   * Spot finish (gloss varnish or foil) from a finish PDF: `kind` 0 none, 1 gloss, 2 gold,
   * 3 silver, 4 copper; `images`: folio -> its page of the finish PDF (ImageBitmap; any ink
   * marks the finished areas). Kept through rebuilds of the book.
   */
  setFinish({ kind, images }) {
    for (const [folio, tex] of this.finish.textures) {
      if (images.get(folio) !== tex.image) {
        tex.dispose();
        this.finish.textures.delete(folio);
      }
    }
    for (const [folio, image] of images) {
      if (this.finish.textures.has(folio)) continue;
      const tex = new THREE.Texture(image);
      tex.flipY = false;
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;
      this.finish.textures.set(folio, tex);
    }
    this.finish.kind = kind;
    this.finish.images = images;
    this.#applyFinish();
    this.dirty = true;
  }

  /** Forget every page's image and tiles (a new file). */
  clearPages() {
    uploads.clearPages(this);
  }

  /** A page's tiles let go (its image changed: ui/pages.js). */
  forgetTiles(folio) {
    uploads.forgetTiles(this, folio);
  }

  #applyFinish() {
    for (const leaf of this.leaves ?? []) {
      for (const [mat, folio] of [[leaf.front, 2 * leaf.i + 1], [leaf.back, 2 * leaf.i + 2]]) {
        const tex = this.finish.textures.get(folio);
        mat.userData.uniforms.uFinish.value = tex ?? this.none;
        mat.userData.uniforms.uFinishKind.value = tex ? this.finish.kind : 0;
      }
    }
  }

  /** Wire colour of spiral and wire-o bindings: bare metal, or coated (see WIRE_COLORS). */
  setWire(hex, { metal = false } = {}) {
    this.wireMat.color.set(hex);
    this.wireMat.metalness = metal ? 1 : 0.25;
    this.wireMat.roughness = metal ? 0.22 : 0.38;
    this.dirty = true;
  }

  /** A hardcover's headbands: their colour (hex). */
  setHeadband(hex) {
    this.headbandMat.color.set(hex);
    this.dirty = true;
  }

  /**
   * The spine's look: a colour, or artwork (a canvas, already turned and laid out for the
   * spine face, see spineFace()). Glued and sewn spines show either; a stitched fold
   * takes the colour.
   */
  setSpine({ color, artwork = null, frontEdge = color, backEdge = color }) {
    this.frontWrapMat.color.set(frontEdge);
    this.backWrapMat.color.set(backEdge);
    this.#syncSheetEdges();
    const old = this.spineMat.map;
    if (artwork) {
      // The same artwork as shown (spineFace draws it once per artwork and turn): kept on the GPU.
      if (old?.image !== artwork) {
        const tex = new THREE.CanvasTexture(artwork);
        tex.flipY = false; // row 0 at the head, like the page images
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        this.spineMat.map = tex;
      }
    } else {
      this.spineMat.map = null;
    }
    this.spineColor = color;
    // The spine's corners, where the cover folds round onto it: the artwork's own edge there,
    // row by row (the slab's side faces take its edge columns, see makeExtras), or the colour.
    // One averaged tone (to 1.0) drew a spine teal at the head and olive at the foot as a
    // green line the length of the corner (the designer's book).
    for (const m of [this.spineSideFrontMat, this.spineSideBackMat]) {
      const had = m.map;
      m.map = this.spineMat.map;
      if (!had !== !m.map) m.needsUpdate = true;
    }
    this.#syncSpineStock();
    this.#syncTurnIns();
    if (old !== this.spineMat.map) {
      old?.dispose();
      this.spineMat.needsUpdate = true; // with or without a map: a different shader
    }
    this.dirty = true;
  }

  /**
   * A hardcover board's inside: the endpaper pasted down, the page's size; round it on the
   * squares, the cover's turn-in, in the cover's colour at its spine edge (the wrap colours).
   * Without it the board's inside was endpaper to its edges: "naked" (the designer).
   */
  #syncTurnIns() {
    const cased = this.model?.style.spine === "case" && this.leaves.length > 1;
    const n = this.leaves.length;
    for (const leaf of this.leaves ?? []) {
      for (const [m, wrap] of [[leaf.front, cased && leaf.i === n - 1 ? this.backWrapMat : null], [leaf.back, cased && leaf.i === 0 ? this.frontWrapMat : null]]) {
        const t = m.userData.uniforms.uTurnIn?.value;
        if (!t) continue;
        if (wrap) t.set(wrap.color.r, wrap.color.g, wrap.color.b, 1);
        else t.set(0, 0, 0, 0);
      }
    }
  }

  /**
   * Spine artwork is printed on the cover's stock: its paper shows the cover colour (a pink
   * cover's unprinted spine is pink, as the cover's own pages are). A spine colour is as set.
   */
  #syncSpineStock() {
    const stock = this.spineMat.map ? this.paper.cover.color : this.spineColor ?? this.paper.cover.color;
    for (const m of [this.spineMat, this.spineSideFrontMat, this.spineSideBackMat]) m.color.set(stock);
  }

  /** Closed, or closing (including via opening first, to close on the other cover). */
  get isClosed() {
    if (this.#coverShuts()) return this.opening === 0 || this.opening === this.model.leafCount;
    const a = this.closeAnim;
    return a ? a.then != null || a.to === 1 : this.closed === 1;
  }

  /**
   * Glued, sewn, stitched and cased books are shut by their covers: how closed the book is
   * follows the covers' angles (see #update), so opening it is lifting the cover, in one
   * motion. A coil-bound book closes as a separate move (its ring turns round the spine).
   */
  #coverShuts() {
    const m = this.model;
    return !!m && m.style.spine !== "coil" && m.leafCount > 1;
  }

  /**
   * Point the camera's home at the closed-book view whenever the book lies flat: closed, or
   * (a coil book) open at a cover with every page on one side. All bindings then look alike.
   */
  #updateHome(closed = this.isClosed) {
    const flat = closed || this.#coverSide() !== 0;
    const home = presetHome(this.preset, flat);
    const now = this.rig.home;
    if (home.azimuth !== now.azimuth || home.elevation !== now.elevation) this.rig.setHome(home);
  }

  /**
   * Center the camera on the left page (-1), the spread (0) or the right page (1), framed on
   * that page as a book open at a cover is; it glides there (#update). Kept through page turns;
   * closed or at a cover, the side the pages lie on rules (see #shiftGoal), and it comes back
   * once the book opens.
   */
  setFocus(side) {
    this.focus = Math.sign(side);
    this.callbacks.onChange?.();
  }

  /** Where the camera aims, across: the side all the pages lie on (at a cover), or the focus. */
  #shiftGoal() {
    return this.#coverSide() || this.focus;
  }

  /** Where the open book's pages lie: all right (1, front cover), all left (-1, back), or both (0). */
  #coverSide() {
    const m = this.model;
    if (!m || m.leafCount <= 1) return 0;
    return this.opening === 0 ? 1 : this.opening === m.leafCount ? -1 : 0;
  }

  /** Show opening `j` (0 = front cover, j = pages 2j | 2j+1). Opens a closed book. */
  goTo(j, { animate = true } = {}) {
    if (!this.model) return;
    j = Math.max(0, Math.min(this.model.leafCount, j));
    const now = this.#now();
    const fast = now - this.lastRequest < FAST_SCRUB_MS;
    this.lastRequest = now;
    const turnMs = fast ? Math.min(FAST_TURN_MS, this.turnMs) : this.turnMs;
    // Opening and closing are part of the turn: glued, sewn, stitched and cased books are
    // as closed as their covers lie (#update); a closed coil book opens as its cover turns.
    if (!this.#coverShuts() && this.isClosed) this.setClosed(false, { animate });
    if (j === this.opening) return;
    this.opening = j;
    this.leaves.forEach((leaf, i) => {
      const to = restingAngle(this.model, i, j);
      if (!animate) {
        leaf.theta = leaf.from = leaf.to = to;
        leaf.start = null;
        leaf.curl = leaf.curlFrom = 0;
        leaf.settle = false;
      } else if (to !== leaf.to) {
        // A coil book's pages lie at an angle set by how thick their side is: a turn moves
        // every page staying on its pile a fraction of a degree. That is the pile settling,
        // not a page turning: no bend, no lift (they had both, so the whole pile fanned out
        // and lifted its corners, then snapped shut as it landed).
        leaf.settle = this.model.style.spine === "coil" && Math.sign(to) === Math.sign(leaf.theta) && (leaf.start == null || !!leaf.settle);
        // Always from where the leaf is now, never a jump: a leaf redirected mid-turn
        // keeps its bend and lets it fade (a sudden change reads as a glitch).
        leaf.from = leaf.theta;
        leaf.to = to;
        leaf.start = now;
        leaf.duration = turnMs;
        leaf.curlFrom = leaf.curl;
      }
    });
    if (animate && this.#coverShuts()) this.#pace();
    if (animate) this.#inOrder();
    if (!animate) {
      this.coverShift = this.#shiftGoal();
      this.pageFrame = Math.abs(this.coverShift);
      this.coverFrame = this.#coverSide() ? 1 : 0;
      frameCamera(this);
    }
    this.#updateHome();
    this.geometryDirty = true;
    this.callbacks.onChange?.();
  }

  /**
   * Time a cover's turn against the pages already in the air, so the book is only ever
   * partly shut with nothing else moving (see #update): a cover on its way to shutting runs
   * slower, passing upright just as the last of them lands; a page sent off a cover that is
   * still lifting waits under it until it is past upright. Planned when the turn is asked
   * for, so nothing stops in mid-air (a fast double-click had the cover stand upright until
   * the page before it landed).
   */
  #pace() {
    const n = this.leaves.length;
    const together = (a, b) => a.from === b.from && a.to === b.to && a.start === b.start && a.duration === b.duration && a.curlFrom === b.curlFrom;
    // How far through its turn a leaf passes upright (easeTurn(p) = the share of the way
    // to angle 0), or null if it doesn't cross.
    const upright = (l) => {
      if (l.start == null || !(l.from * l.to < 0)) return null;
      const r = l.from / (l.from - l.to);
      return Math.acos(1 - 2 * r) / Math.PI;
    };
    for (const ci of [0, n - 1]) {
      const cover = this.leaves[ci];
      const p = upright(cover);
      if (p == null) continue;
      const mates = this.leaves.filter((l) => l.start != null && together(l, cover));
      const others = this.leaves.filter((l) => l.start != null && !together(l, cover));
      const crosses = cover.start + p * cover.duration;
      const shutting = ci === 0 ? cover.to > 0 : cover.to < 0;
      if (shutting) {
        const lands = Math.max(-Infinity, ...others.map((l) => l.start + l.duration));
        if (lands > crosses) {
          const duration = (lands - cover.start) / p;
          for (const l of mates) l.duration = duration;
        }
      } else {
        for (const l of others) {
          // Still lying under the lifting cover, sent the same way: it goes once the cover
          // is past upright.
          if (l.theta === l.from && l.to * cover.to > 0 && l.start < crosses) l.start = crosses;
        }
      }
    }
  }

  /**
   * No page lifts before the one lying on it, nor lands before the one it comes down on: of
   * the leaves sent the same way and still on their pile, each starts no earlier than the one
   * above it (going left, the right pile's top is the lowest leaf; going right, the left
   * pile's top is the highest), and lands no earlier than it. Started no earlier and landing
   * no earlier, on the same easing, a leaf is never further over than the one before it at
   * any moment, so the layout (which keeps them in order, see layoutBook) never has to hold
   * one back. Until 0.17.82 a quick second click sent its page at the fast pace (half the
   * time) after one going at the normal pace: it caught up, was held on the first, and when
   * its own time ran out, a quarter second early, it was laid on its pile and the first page,
   * still in the air above, with it: both snapped down from mid-air (115 mm in one frame).
   */
  #inOrder() {
    for (const dir of [-1, 1]) {
      const order = dir < 0 ? this.leaves : [...this.leaves].reverse();
      let earliest = -Infinity;
      let lands = -Infinity;
      for (const l of order) {
        if (l.start == null || Math.sign(l.to - l.from) !== dir) continue;
        if (l.theta === l.from) {
          if (l.start < earliest) l.start = earliest;
          if (l.start + l.duration < lands) l.duration = lands - l.start;
        }
        earliest = Math.max(earliest, l.start);
        lands = Math.max(lands, l.start + l.duration);
      }
    }
  }

  /**
   * Close or open the book. Closed, it lies front cover up (side 1) or, flipped through to
   * the end, back cover up (side -1); by default the side follows the opening. Closing on
   * the other cover than the one it lies on opens it on the way, then closes it again.
   */
  setClosed(closed, { animate = true, side = null, delay = 0 } = {}) {
    if (!this.model) return;
    if (this.#coverShuts()) {
      // Shut by the covers: closing is turning to one, opening is turning away from it.
      const n = this.model.leafCount;
      if (closed) this.goTo(side === -1 || (side == null && this.opening === n) ? n : 0, { animate });
      else if (this.atCover) this.goTo(this.opening === 0 ? 1 : n - 1, { animate });
      return;
    }
    // A coil book: flipped through to the end, it closes back cover up (it used to close
    // front up whatever its pages did, so the whole block swung over on the next turn).
    const atEnd = this.opening === this.model.leafCount && this.model.leafCount > 1;
    const nextSide = closed ? side ?? (atEnd ? -1 : 1) : 1;
    const heading = this.closeAnim?.then ?? this.closedSide;
    if (this.isClosed === closed && (!closed || nextSide === heading)) return;
    const now = this.#now();
    if (!animate) {
      this.closeAnim = null;
      this.closed = closed ? 1 : 0;
      if (closed) this.closedSide = nextSide;
      this.geometryDirty = true;
      frameCamera(this);
    } else if (closed && this.closed > 0 && nextSide !== this.closedSide) {
      // Lying on (or closing onto) the other cover: open, then close the other way.
      this.closeAnim = { from: this.closed, to: 0, start: now, duration: this.closeMs / 2, then: nextSide };
    } else {
      // A coil book's closing runs with its cover's turn, as one move (same length).
      if (closed) this.closedSide = nextSide;
      this.closeAnim = { from: this.closed, to: closed ? 1 : 0, start: now + delay, duration: this.turnMs };
    }
    this.#updateHome(closed);
    this.callbacks.onChange?.();
  }

  /** The pages facing up: a spread, or the cover on top of a closed book. */
  get shownFolios() {
    if (!this.isClosed) return [2 * this.opening, 2 * this.opening + 1];
    if (this.#coverShuts()) return [this.opening === 0 ? 1 : this.pageCount];
    return [(this.closeAnim?.then ?? this.closedSide) > 0 ? 1 : this.pageCount];
  }

  /** At the front or back cover the book is shut in all but name. */
  get atCover() {
    return this.#coverSide() !== 0;
  }

  /**
   * Close the book: from a spread, turn back to the front cover first (the pages turn back and
   * it closes as they do), so it closes on the first page.
   */
  close() {
    if (!this.model || this.isClosed) return;
    this.goTo(0); // glued, sewn and stitched books close by themselves at the cover
    if (this.model.style.spine !== "coil") return;
    // A coil book closes as its pages turn back, one move: the closing starts while they are
    // still coming down (CLOSE_OVERLAP) and ends a little after they land.
    const now = this.#now();
    const pages = this.leaves.filter((l) => l.i > 0 && l.start != null);
    const lands = pages.length ? Math.max(...pages.map((l) => l.start + l.duration)) : now;
    const last = pages.length ? Math.max(...pages.map((l) => l.duration)) : 0;
    this.setClosed(true, { delay: Math.max(0, lands - now - CLOSE_OVERLAP * last) });
  }

  /** Open a closed book, or one flipped all the way to a cover, at its first or last spread. */
  open() {
    // goTo opens a closed book first, then turns.
    if (this.atCover) this.goTo(this.opening === 0 ? 1 : this.model.leafCount - 1);
    else if (this.isClosed) this.setClosed(false);
  }

  /** See uploads.js setPageTexture. */
  setPageTexture(folio, image) {
    uploads.setPageTexture(this, folio, image);
  }

  /** The page's material (its face of its leaf), or null. */
  #pageMaterial(folio) {
    const leaf = this.leaves[Math.ceil(folio / 2) - 1];
    if (!leaf) return null;
    return folio % 2 ? leaf.front : leaf.back;
  }

  /** Side glue on this page: glued to the cover `mm` from the spine (0: none). See the page shader. */
  setPageGlue(folio, mm) {
    const m = this.#pageMaterial(folio);
    if (!m) return;
    m.userData.uniforms.uGlue.value = mm;
    this.dirty = true;
  }

  /** The cover's hinge score on this (outside) page, `mm` from the spine (0: none). */
  setCoverScore(folio, mm) {
    const m = this.#pageMaterial(folio);
    if (!m) return;
    m.userData.uniforms.uScore.value = mm;
    this.dirty = true;
  }

  /**
   * A flap lying on this page (the inside of a cover) from the fore-edge in: a sheet of its
   * own (makeFlap) with its image (taken: freed when replaced or the book is rebuilt),
   * reaching `reachMm` in, `flip` for the back cover's. Null: none.
   */
  setPageFlap(folio, image, reachMm = 0, flip = false) {
    const leaf = this.leaves[Math.ceil(folio / 2) - 1];
    const old = this.flaps.get(folio);
    if (old) {
      freeFlap(this, old);
      this.flaps.delete(folio);
    }
    if (!leaf || !image) {
      image?.close?.();
    } else {
      this.flaps.set(folio, makeFlap(this, leaf, folio % 2 ? 0 : 1, Math.min(reachMm, leaf.s[leaf.s.length - 1]), image, flip));
    }
    this.dirty = true;
  }

  /** See uploads.js showPageImage. */
  showPageImage(folio, image) {
    uploads.showPageImage(this, folio, image);
  }

  /** See framing.js visiblePages. */
  visiblePages(size) {
    return visiblePages(this, size);
  }

  /** See uploads.js setPageDetails. */
  setPageDetails(folio, strips, options) {
    uploads.setPageDetails(this, folio, strips, options);
  }

  /** The current view as a large PNG, tile by tile (see capture.js). */
  captureImage(options) {
    return capture.captureImage(this, options);
  }

  /** An animation, rendered offline frame by frame on the scene's own clock (see capture.js). */
  recordVideo(options) {
    return capture.recordVideo(this, this.#own, options);
  }

  /**
   * How light the picture is under a few places on screen (the frame counter and the zoom
   * value over the view, see view.js): each rect's mean luminance, 0 to 1, linear. `rects` in
   * the canvas's pixels from its top left. Read back without stalling: copied into a buffer
   * on the GPU right after the next frame drawn, collected once the GPU is through with it
   * (a fence, polled). `done(luminances)`; a newer request replaces one not yet copied.
   * @param {{x: number, y: number, w: number, h: number}[]} rects
   * @param {(luminances: number[]) => void} done
   */
  sampleUnder(rects, done) {
    this.under.request = { rects, done };
  }

  /** For the performance check: a pan by (dx, dy) screen pixels, as the space bar and a drag make it. */
  debugPan(dx, dy) {
    panBy(this, dx, dy);
  }

  /** For tests: advance the animations to the set clock and lay the book out, without drawing. */
  debugStep() {
    this.#update(this.clock ?? performance.now());
  }

  /** Render now and read one pixel (sRGB, 0-255) at a fraction of the canvas. For calibration. */
  debugSample(fx, fy) {
    this.dirty = true;
    this.#frame(performance.now()); // lays out pending changes and renders
    placeCamera(this);
    shadows(this);
    drawOrder(this);
    this.composer.render();
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(fx * gl.drawingBufferWidth), Math.round((1 - fy) * gl.drawingBufferHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2]];
  }

  get maxTextureSize() {
    return this.renderer.capabilities.maxTextureSize;
  }

  resetView() {
    this.zoomGlide = null;
    this.zoomBias = 1;
    this.rig.resetView();
  }

  /** Put the camera at its home angles at once, without the spring (e.g. a video's start). */
  settleCamera() {
    if (this.rig.free) return;
    this.rig.azimuth = this.rig.home.azimuth;
    this.rig.elevation = this.rig.home.elevation;
    this.rig.springing = false;
    this.dirty = true;
  }

  /** Zoom as a percentage of the camera preset's framing (100 = as framed). */
  get zoomPercent() {
    return (100 * this.zoomBias) / this.rig.zoom;
  }

  /**
   * Glide to `percent` about the view's pivot, without moving the pivot: a camera preset
   * plus a zoom step always frames the book the same way (for mockups).
   */
  setZoomPercent(percent) {
    this.zoomBias = 1;
    const goal = this.rig.clampZoom(100 / percent);
    this.zoomGlide = { anchor: null, goal, floor: 0, lastInput: performance.now(), lastTime: null, keepPivot: true };
    this.rig.resetting = null;
    this.dirty = true;
  }

  /** Backdrop colour behind the book: flat, exactly as chosen (no halo, no vignette). */
  setBackground(hex) {
    this.scene.background = new THREE.Color(hex);
    this.dirty = true;
  }

  /**
   * Choose a camera preset: the camera moves there, and double-tapping space returns there.
   * A floating preset also lifts the book off the table and tilts it in space.
   */
  setPreset(name) {
    this.preset = name;
    this.float = CAMERA_PRESETS[name]?.float ?? null;
    this.ground.visible = this.contact.visible = !this.float; // the table (its shadow) only under a resting book
    frameCamera(this);
    this.zoomGlide = null;
    this.zoomBias = 1;
    this.#updateHome();
    this.rig.resetView();
    this.dirty = true;
  }

  // --- construction ----------------------------------------------------------------

  #disposeBook() {
    for (const leaf of this.leaves) {
      this.block.remove(leaf.mesh);
      leaf.geo.dispose();
      leaf.pick.geometry.dispose();
      for (const m of [leaf.front, leaf.back]) { // (their page images are kept: see setPageTexture)
        for (let i = 0; i < MAX_DETAIL; i++) disposeTexture(m.userData.uniforms[`uDetail${i}`].value, this.blank);
        m.dispose();
      }
      for (const m of leaf.mesh.material.slice(3)) m.dispose(); // a coil page's twins (their textures are the page's)
      if (leaf.mesh.material[2].userData.edgeOf) leaf.mesh.material[2].dispose(); // its edges' (the same)
    }
    this.leaves = [];
    for (const flap of this.flaps.values()) freeFlap(this, flap); // the flaps lay on them
    this.flaps.clear();
    uploads.dropDetails(this); // sharp strips on their way: for the old book's leaves
    this.sheets?.tex.dispose();
    this.sheets = null;
    if (this.extras) {
      this.block.remove(this.extras.group);
      this.extras.group.traverse((o) => {
        const mesh = /** @type {THREE.Mesh} */ (o);
        mesh.geometry?.dispose();
        for (const m of [mesh.material ?? []].flat()) if (m.userData.disposable) m.dispose(); // a fold's (see foldSheetMaterial)
      });
      this.extras = null;
    }
  }

  // --- per-frame layout --------------------------------------------------------------

  /**
   * Draw at most this many device pixels (the client viewer, which fills the window: the
   * app's 3D view, beside its panel and timeline, has about 3.5 million on a Retina laptop).
   * Infinity, as the app has it: the screen's resolution, up to twice the CSS pixels.
   */
  setPixelBudget(pixels) {
    this.pixelBudget = pixels;
    this.#resize();
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const ratio = Math.min(window.devicePixelRatio, 2, Math.sqrt((this.pixelBudget ?? Infinity) / (w * h)));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    frameCamera(this);
    this.dirty = true;
  }

  #now() {
    return this.clock ?? performance.now();
  }

  #frame(time) {
    if (this.capturing) return; // a capture owns the renderer
    const started = performance.now();
    const parts = this.partTimes;
    parts.fill(0);
    // A set clock (a video, or a test stepping through frames) is the only time: the screen's
    // own frames mustn't advance animations under it.
    const { animating, moving } = this.#update(this.clock ?? time);
    parts[PART.update] = performance.now() - started - parts[PART.layout] - parts[PART.uploads];
    const inMotion = animating || moving;
    const draw = inMotion || this.dirty;
    this.#readGpuTime();
    if (!draw) {
      // At rest, settled, nothing waiting to go to the GPU: no more frames until something
      // changes (asking for them every refresh kept a CPU core 7 % busy for nothing).
      if (this.settled && !this.uploads.size && !this.detailQueue.size && !this.tiles.pending) this.idleFrames++;
      return;
    }
    this.idleFrames = 0;
    this.dirty = false;
    placeCamera(this);
    this.callbacks.onCamera?.(this.camera);
    // The view as this frame draws it (the camera just placed): what it needs (ui/tiles.js).
    let t = performance.now();
    if (inMotion) this.callbacks.onViewFrame?.(time);
    parts[PART.tiles] = -t + (t = performance.now());
    shadows(this);
    parts[PART.shadows] = -t + (t = performance.now());
    drawOrder(this);
    parts[PART.order] = -t + (t = performance.now());
    const g = this.gpuTime;
    const gl = /** @type {WebGL2RenderingContext} */ (this.renderer.getContext());
    const query = g.timer && inMotion && g.queries.length < 4 ? gl.createQuery() : null;
    if (query) gl.beginQuery(g.timer.TIME_ELAPSED_EXT, query);
    this.composer.render();
    if (query) {
      gl.endQuery(g.timer.TIME_ELAPSED_EXT);
      g.queries.push(query);
    }
    capture.copyUnder(this, gl);
    parts[PART.draw] = performance.now() - t;
    const log = this.frameLog;
    const at = log.n % log.time.length;
    log.time[at] = started;
    log.cpu[at] = performance.now() - started;
    parts.forEach((ms, i) => { log.parts[i][at] = ms; });
    log.n++;
  }

  /**
   * How drawing went over the last second, for the frame counter: frames a second while
   * things move (null at rest, where nothing is drawn; a lone redraw, a page image arriving,
   * doesn't count), the main thread's time a frame and the graphics card's (where it can be
   * timed, else null; see #readGpuTime).
   */
  get frameStats() {
    const { time, cpu, n } = this.frameLog;
    const now = performance.now();
    const recent = [];
    for (let k = Math.max(0, n - time.length); k < n; k++) {
      const i = k % time.length;
      if (now - time[i] <= 1000) recent.push(i);
    }
    let gaps = 0;
    let span = 0;
    for (let k = 1; k < recent.length; k++) {
      const gap = time[recent[k]] - time[recent[k - 1]];
      if (gap < 100) {
        gaps++;
        span += gap;
      }
    }
    const moving = gaps > 0 && now - time[recent[recent.length - 1]] < 250;
    const g = this.gpuTime;
    return {
      fps: moving ? (1000 * gaps) / span : null,
      cpu: recent.length ? recent.reduce((sum, i) => sum + cpu[i], 0) / recent.length : 0,
      gpu: g.timer && now - g.at < 1000 ? g.ms : null,
    };
  }

  /** The graphics card's time for the frames timed, as their results come in (a few frames later). */
  #readGpuTime() {
    const g = this.gpuTime;
    if (!g.timer) return;
    const gl = /** @type {WebGL2RenderingContext} */ (this.renderer.getContext());
    while (g.queries.length && gl.getQueryParameter(g.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = g.queries.shift();
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
      if (!gl.getParameter(g.timer.GPU_DISJOINT_EXT) && this.clock == null) {
        g.ms = ms;
        g.at = performance.now();
      }
    }
  }

  /** Advance every animation to `time` and lay the book out; drawing is up to the caller. */
  #update(time) {
    let animating = false;
    // Leaves sent turning together (same start, length, path: closing from a spread swings
    // the whole left pile over) are one group, laid out as one stack (layoutBook). While a
    // book is partly shut only its cover's group moves (separate sheets in the air over a
    // half-closed block can't be kept apart): a cover on its way to shutting holds at
    // upright, with its group, until every page moving on its own has landed; such a page
    // waits to lift until the cover is past upright. Unseen at a normal pace; only clicks
    // faster than pages land meet it.
    const shut = this.#coverShuts();
    const dt = Math.max(0, time - (this.lastFrameTime ?? time));
    const n = this.leaves.length;
    const keyOf = (l) => (l.start == null ? null : `${l.from}|${l.to}|${l.start}|${l.duration}|${l.curlFrom}`);
    const keys = this.leaves.map(keyOf);
    const coverKeys = new Set([keys[0], keys[n - 1]].filter(Boolean));
    const hold = new Set();
    if (shut && dt > 0) {
      for (const [ci, dir] of [[0, 1], [n - 1, -1]]) {
        const cover = this.leaves[ci];
        if (!keys[ci]) continue;
        const p = Math.max(0, Math.min(1, (time - cover.start) / cover.duration));
        const theta = lerp(cover.from, cover.to, easeTurn(p));
        const shutting = dir > 0 ? cover.to > cover.theta : cover.to < cover.theta;
        const crossing = dir > 0 ? theta > 0 && cover.theta <= 0 : theta < 0 && cover.theta >= 0;
        const others = keys.some((k) => k && k !== keys[ci]);
        if (shutting && crossing && others) hold.add(keys[ci]);
      }
      if (this.closed > 0) {
        this.leaves.forEach((l, i) => {
          if (keys[i] && !coverKeys.has(keys[i]) && l.theta === l.from) hold.add(keys[i]);
        });
      }
    }
    this.leaves.forEach((leaf, i) => {
      if (leaf.start == null) return;
      // Held: a leaf in the air stops where it is; one still waiting to go waits no longer
      // than until now (pushing its start on by every frame's time made it go after pages
      // sent later, which then lifted from under it).
      if (hold.has(keys[i])) leaf.start = leaf.theta === leaf.from ? Math.max(leaf.start, time) : leaf.start + dt;
      const p = Math.max(0, Math.min(1, (time - leaf.start) / leaf.duration)); // may wait to start
      leaf.theta = lerp(leaf.from, leaf.to, easeTurn(p));
      leaf.curl = (leaf.settle ? 0 : turnCurl(leaf.from, leaf.to, p)) + leaf.curlFrom * (1 - p) ** 2;
      if (p >= 1) {
        leaf.start = null;
        leaf.settle = false;
        leaf.curl = leaf.curlFrom = 0;
      }
      animating = true;
    });
    for (const leaf of this.leaves) leaf.group = keyOf(leaf);
    if (this.#coverShuts()) {
      // Shut by the covers: closed while a cover lies on the block, opening as it lifts (the
      // block relaxes while the cover rises through its first half turn), open once it is
      // over. One motion: nothing to fall out of step, however fast the clicks.
      this.closeAnim = null;
      // As closed as every page allows, not just the cover: a page still in the air keeps
      // the book open under it (pages kept in order, see layoutBook, so the cover leads).
      const over = (leaf) => Math.min(1, Math.max(0, (90 - leaf.theta) / 180)); // 0 right … 1 left
      const front = 1 - 2 * Math.max(...this.leaves.map(over));
      const back = 2 * Math.min(...this.leaves.map(over)) - 1;
      const closed = Math.min(1, Math.max(0, front, back));
      const side = front >= back ? 1 : -1;
      if (closed !== this.closed || (closed > 0 && side !== this.closedSide)) {
        this.closed = closed;
        if (closed > 0) this.closedSide = side;
        frameCamera(this);
        this.geometryDirty = true;
      }
    } else if (this.closeAnim) {
      const a = this.closeAnim;
      const p = Math.max(0, Math.min(1, (time - a.start) / a.duration));
      this.closed = lerp(a.from, a.to, ease(p));
      if (p >= 1) {
        // Opened on the way to the other cover: now close onto it.
        if (a.then != null) {
          this.closedSide = a.then;
          this.closeAnim = { from: 0, to: 1, start: time, duration: this.closeMs / 2 };
        } else {
          this.closeAnim = null;
        }
      }
      frameCamera(this);
      animating = true;
    }
    // Turning to or from a cover, or another page asked for: the camera glides there, its
    // aim and its framing each on its own (a page to the other page: the framing stays).
    const coverGoal = this.#shiftGoal();
    const frameGoal = Math.abs(coverGoal);
    const coverFrameGoal = this.#coverSide() ? 1 : 0;
    if (this.coverShift !== coverGoal || this.pageFrame !== frameGoal || this.coverFrame !== coverFrameGoal) {
      const dt = Math.min(0.05, (time - (this.lastFrameTime ?? time)) / 1000) || 1 / 60;
      const glide = (now, goal) => (Math.abs(goal - now) < 0.002 ? goal : now + (goal - now) * (1 - Math.exp(-dt / 0.2)));
      this.coverShift = glide(this.coverShift, coverGoal);
      this.pageFrame = glide(this.pageFrame, frameGoal);
      this.coverFrame = glide(this.coverFrame, coverFrameGoal);
      frameCamera(this);
      this.cameraChanged = true;
    }
    this.lastFrameTime = time;
    if (this.model && (animating || this.geometryDirty)) {
      const t0 = performance.now();
      this.shared.uOpenness.value = 1 - this.closed;
      layoutLeaves(this);
      this.geometryDirty = false;
      this.dirty = true;
      this.partTimes[PART.layout] = performance.now() - t0;
    }
    // A capture's strips are laid at once (setPageDetails, immediate); one queued otherwise (a
    // clearing) goes at rest.
    const t1 = performance.now();
    if (this.uploads.size) uploads.flushUploads(this);
    else if (this.detailQueue.size && this.settled) uploads.prepareDetails(this);
    if (uploads.flushTiles(this, time)) this.dirty = true;
    this.partTimes[PART.uploads] = performance.now() - t1;
    // Wheel zoom and pan change the camera outside the rig's own animations: count them
    // as motion too (the tiles the view needs are asked for as it moves, see ui/tiles.js).
    glideZoom(this, time);
    const moving = this.rig.update(time) || this.cameraChanged;
    this.cameraChanged = false;
    if (this.zoomPercent !== this.shownPercent) {
      this.shownPercent = this.zoomPercent;
      this.callbacks.onZoom?.(this.zoomPercent);
    }
    if (animating || moving) {
      this.lastMotion = time;
      this.lastTurned = animating;
      if (this.settled) this.callbacks.onViewMoving?.(); // once, as it starts
      this.settled = false;
    } else if (!this.settled && time - this.lastMotion > (this.lastTurned ? TURN_SETTLE_MS : SETTLE_MS)) {
      this.settled = true;
      this.callbacks.onViewSettled?.(time);
    }
    return { animating, moving };
  }

}

