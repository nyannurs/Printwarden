// The book in 3D. Each leaf is a ribbon with real paper thickness that bends out of the
// spine and curls while it turns (shape in model.js). Paper is lit by a studio
// environment, casts soft shadows, multiplies the page image like ink on stock, and
// lets the other side show through on thin paper. The gutter darkens toward the fold
// the way it does in a real book (computed per binding, noise-free).
//
// World space is millimetres: the book lies on a table, spine along z, head at -z.

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { CAMERA_PRESETS, CameraRig, presetHome } from "./camera.js";
import * as capture from "./capture.js";
import { drawOrder, shadows } from "./draw.js";
import { layoutGround, makeExtras } from "./extras.js";
import { bindInput, glideZoom } from "./input.js";
import { layoutLeaves } from "./layout.js";
import { firstMaterial, freeFlap, isCover, makeFlap, makeLeaf, makeSheets, pageHit } from "./leaf.js";
import { HOLE_OFFSET_MM, makeBook, restingAngle, turnCurl } from "./model.js";
import { motionReset, motionState, motionStep } from "./motion.js";
import { MAX_DETAIL, sheetShader } from "./shaders.js";
import { disposeTexture, freeImage, makeContactMap, makeGrain, makeWarmer, makeWhite, vectorFloats, vectorInts } from "./textures.js";
import { TEX_W } from "./vectortext.js";

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
// After pages turned: longer, so pages only flipped past aren't sharpened (rendered from the
// PDF and sent to the GPU, four times the pixels on a Retina screen) as the next click comes.
const TURN_SETTLE_MS = 350;
const UPLOADS_PER_FRAME = 2;
// Sharp strips arriving on a page that had none fade in over the base image this long: the
// swap no longer reads as the page's pixels shifting as it comes to rest.
const DETAIL_FADE_MS = 220;
// Page images are filtered as stored (sRGB values) and only then turned into light: type
// keeps its weight, the way browsers and Acrobat antialias it. Filtered as light, the grey
// edge pixels of dark type on white come out too light, and text looks thin and grey.
const PAGE_COLOR_SPACE = THREE.NoColorSpace;
// All light scaled so white paper peaks just under the screen's white (about 247-250 of
// 255, measured on a white page in the reading and isometric views): it shades instead of
// clipping flat. At 1 (until 0.13.1), about 60 % of a white page sat at 255: overexposed.
// The same factor on every light keeps hues; a tone-mapping curve would shift them.
const LIGHT = 0.92;
const KEY_INTENSITY = 1.57 * LIGHT;
const ENV_INTENSITY = 0.35 * LIGHT;
const RIM_INTENSITY = 0.29 * LIGHT;
const VIEW_FOV = 30; // the live view's lens (vertical, degrees): about 45 mm full-frame

const easeTurn = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t); // gentle, like a hand
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @typedef {{wake: () => void, currentTarget: () => THREE.Vector3, frameCamera: () => void,
 *            placeCamera: () => void, update: (time: number) => {animating: boolean, moving: boolean},
 *            flushUploads: () => void}} SceneSteps
 */

export class BookScene {
  /**
   * The scene's own steps that the parts in other files call (input.js, capture.js).
   * @type {SceneSteps}
   */
  #own = {
    wake: () => this.#wake(),
    currentTarget: () => this.#currentTarget(),
    frameCamera: () => this.#frameCamera(),
    placeCamera: () => this.#placeCamera(),
    update: (time) => this.#update(time),
    flushUploads: () => this.#flushUploads(),
  };

  /**
   * @param {HTMLElement} container
   * @param {{onTurnRequest?: (delta: number) => void, onOpenRequest?: () => void,
   *          onChange?: () => void, onViewSettled?: () => void, onViewMoving?: () => void,
   *          onZoom?: (percent: number) => void, onCamera?: (camera: THREE.PerspectiveCamera) => void}} callbacks
   *   onCamera: after the camera is placed for a frame drawn (the compass)
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
    // The same, at a lower resolution, for motion on a graphics card too slow for the screen
    // (see #adaptResolution); scaled up to the window as it is drawn.
    this.motionComposer = new EffectComposer(r, target());
    this.motionComposer.addPass(new RenderPass(this.scene, this.camera));
    this.motionComposer.addPass(output());
    this.motion = {
      scale: 1, step: motionState(), refresh: [], frames: [], lastFrame: 0, rendered: false, low: false,
      // How long the graphics card takes to draw a frame, where it can be timed.
      timer: r.getContext().getExtension("EXT_disjoint_timer_query_webgl2"), queries: [], gpu: 0, gpuAt: -Infinity,
    };
    this.frameLog = { time: new Float64Array(256), cpu: new Float64Array(256), n: 0 }; // drawn frames (frameStats)
    this.casters = { current: false }; // see nearestCasters

    this.root = new THREE.Group();
    this.scene.add(this.root);
    // The book itself, inside root: tilted when a closed coil book rests on its coil.
    this.block = new THREE.Group();
    this.root.add(this.block);

    this.white = makeWhite();
    this.none = makeWhite(); // a finish mask without ink
    // Vector text (see #setVector): per page, two data textures; pages without any use
    // these placeholders (a sampler needs a texture of its own kind bound).
    this.vector = { pages: new Map(), noF: vectorFloats(new Float32Array(4), 1, 1), noU: vectorInts(new Uint32Array(2), 1, 1) };
    this.small = new Map(); // folio -> small texture of the page with its text (see #setSmall)
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
    };
    this.edgeMat = new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide });
    this.coverEdgeMat = new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide }); // the covers' cut edges
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
    this.noDraw = new THREE.MeshBasicMaterial({ visible: false });
    this.depthPass = isAppleMetal(r); // the sheets' depth drawn first (see makeLeaf)
    this.holesFirst = [firstMaterial(this, true, true), firstMaterial(this, false, true)]; // a coil's (see makeLeaf)
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
    this.warmer = null; // see #warm
    this.space = false; // space held: a drag pans (input.js)
    this.shadowState = null; // what the shadow map was last drawn for (draw.js)
    this.uploads = new Map(); // folio -> image waiting for GPU upload
    this.detailQueue = new Map(); // folio -> detail strips being prepared
    this.fading = new Set(); // page uniforms whose strips are fading in (uDetailFade < 1)
    this.lastFadeTime = null;
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
   * Build the book.
   * @param {{pageCount: number, pageSize: {width: number, height: number}, binding: string,
   *          signaturePages?: number | null, boardMm?: number | null, endpapers?: boolean, roundSpine?: boolean,
   *          paper: {color: string, roughness: number, clearcoat: number, show: number,
   *                  thickness: number, coverThickness: number, specular?: number, gsm?: number,
   *                  finish?: string, cover?: object}}} spec
   */
  setBook(spec) {
    this.#disposeBook();
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
    this.#applyVector();
    for (let folio = 1; folio <= 2 * this.leaves.length; folio++) this.#showPage(folio);
    this.setPaper(spec.paper);
    layoutGround(this);
    this.geometryDirty = true;
    this.coverShift = this.#shiftGoal();
    this.pageFrame = Math.abs(this.coverShift);
    this.coverFrame = this.#coverSide() ? 1 : 0;
    this.#frameCamera();
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
    }
    this.edgeMat.color.set(this.paper.color).multiplyScalar(0.9);
    this.coverEdgeMat.color.set(this.paper.cover.color).multiplyScalar(0.9);
    this.coverMat.color.set(this.paper.cover.color).multiplyScalar(0.96); // the spine's cut ends
    this.liningMat.color.set(endpaper.color).multiplyScalar(0.95); // the endpaper across a hardcover's joint, in its shade
    this.liningMat.roughness = this.paper.roughness;
    this.#syncSheetEdges();
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

  /** Forget every page's image, vector text and small image (a new file). */
  clearPages() {
    for (const folio of [...this.vector.pages.keys()]) this.#setVector(folio, null);
    for (const folio of [...this.small.keys()]) this.#setSmall(folio, null);
    this.#applyVector();
    for (const { image } of this.uploads.values()) image?.close();
    this.uploads.clear();
    for (const tex of [...this.pageTextures.values(), ...this.overrides.values()]) tex.dispose();
    this.pageTextures.clear();
    this.overrides.clear();
    for (let folio = 1; folio <= 2 * this.leaves.length; folio++) this.#showPage(folio);
  }

  /**
   * A page's vector text (packed by packVectorText in vectortext.js), or null for none: its
   * glyphs are drawn from their outlines over the page image, which then leaves them out.
   * Kept through rebuilds of the book.
   */
  #setVector(folio, packed) {
    const old = this.vector.pages.get(folio);
    if (old) {
      old.f.dispose();
      old.u.dispose();
      this.vector.pages.delete(folio);
    }
    if (packed) {
      const page = {
        f: vectorFloats(packed.floats, TEX_W, packed.rowsF),
        u: vectorInts(packed.ints, TEX_W, packed.rowsU),
        info: packed.info,
      };
      this.#warm(page.f, page.u); // on the GPU now, not mid-turn (see #warm)
      this.vector.pages.set(folio, page);
    }
  }

  /**
   * A small image of a page with its text (its own image leaves vector text out), or null:
   * what shows through onto the other side of its leaf, and the page itself where it is
   * small on screen (see PAGE_MAP_FRAGMENT).
   */
  #setSmall(folio, image) {
    const old = this.small.get(folio);
    if (old?.image === image) return;
    old?.dispose();
    this.small.delete(folio);
    if (!image) return;
    const tex = new THREE.Texture(image);
    tex.flipY = false;
    tex.colorSpace = PAGE_COLOR_SPACE;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true; // not owned: the timeline's thumbnail is scaled from it
    this.#warm(tex); // see #warm
    this.small.set(folio, tex);
  }

  /**
   * Put textures on the GPU now, as they arrive, and draw from each once (into a single
   * pixel nobody sees): graphics drivers finish taking a texture in only when it is first
   * drawn from, and pages first shown mid-turn (flipping through a document just opened)
   * cost 30-70 ms frames.
   */
  #warm(...textures) {
    const w = (this.warmer ??= makeWarmer());
    const r = this.renderer;
    const before = r.getRenderTarget();
    r.setRenderTarget(w.target);
    for (const t of textures) {
      r.initTexture(t);
      const m = t.type === THREE.UnsignedIntType ? w.uint : w.float;
      m.uniforms.uTex.value = t;
      w.quad.material = m;
      r.render(w.scene, w.camera);
    }
    r.setRenderTarget(before);
  }

  #applyVector() {
    for (const leaf of this.leaves ?? []) {
      for (const [mat, folio] of [[leaf.front, 2 * leaf.i + 1], [leaf.back, 2 * leaf.i + 2]]) {
        const v = this.vector.pages.get(folio);
        const small = this.small.get(folio);
        const u = mat.userData.uniforms;
        u.uVecF.value = v?.f ?? this.vector.noF;
        u.uVecU.value = v?.u ?? this.vector.noU;
        u.uVecInfo.value = v?.info ?? [0, 1, 1, 0];
        u.uVecOn.value = v ? 1 : 0;
        u.uSmall.value = small ?? this.white;
        u.uSmallOn.value = v && small ? 1 : 0;
      }
    }
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
    const [frontTone, backTone] = artwork ? edgeTones(artwork) : [color, color];
    this.spineSideFrontMat.color.set(frontTone);
    this.spineSideBackMat.color.set(backTone);
    if (artwork) {
      // The same artwork as shown (spineFace draws it once per artwork and turn): kept on the GPU.
      if (old?.image !== artwork) {
        const tex = new THREE.CanvasTexture(artwork);
        tex.flipY = false; // row 0 at the head, like the page images
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        this.spineMat.map = tex;
      }
      this.spineMat.color.set(0xffffff);
    } else {
      this.spineMat.map = null;
      this.spineMat.color.set(color);
    }
    if (old !== this.spineMat.map) {
      old?.dispose();
      this.spineMat.needsUpdate = true; // with or without a map: a different shader
    }
    this.dirty = true;
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
      this.#frameCamera();
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
      this.#frameCamera();
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

  /**
   * A page's image (an ImageBitmap, or null for plain paper), with its {vector, small} (see
   * #setVector, #setSmall), which change with it in the same frame (left out, the page keeps
   * its own). Uploads are spread over frames, so a burst of finished renders never stutters.
   * The scene takes the image: once it is on the GPU it is freed from memory, and the texture
   * is kept through rebuilds of the book.
   */
  setPageTexture(folio, image, text) {
    const waiting = this.uploads.get(folio);
    if (waiting?.image && waiting.image !== image) waiting.image.close(); // replaced before it went up
    this.uploads.set(folio, { image, text: text ?? waiting?.text });
    this.dirty = true;
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

  /**
   * Show `image` on a page for now instead of its own (a video's sharper pages), or its own
   * again (null). Not taken: the caller frees it, after.
   */
  showPageImage(folio, image) {
    disposeTexture(this.overrides.get(folio), this.white);
    if (image) this.overrides.set(folio, this.#pageTexture(image));
    else this.overrides.delete(folio);
    this.#showPage(folio);
    this.dirty = true;
  }

  #pageTexture(image) {
    const tex = new THREE.Texture(image);
    tex.flipY = false;
    tex.colorSpace = PAGE_COLOR_SPACE;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    return tex;
  }

  /** A page's image on its leaf (one shown for now, else its own, else white), and through it. */
  #showPage(folio) {
    const leaf = this.leaves[Math.ceil(folio / 2) - 1];
    if (!leaf) return;
    const [mat, other] = folio % 2 ? [leaf.front, leaf.back] : [leaf.back, leaf.front];
    mat.map = this.overrides.get(folio) ?? this.pageTextures.get(folio) ?? this.white;
    other.userData.uniforms.uBack.value = this.small.get(folio) ?? mat.map; // show-through from this side
  }

  /**
   * The pages in view: which part of each page image is on screen (texture uv, v = 0 at
   * the head), and the screen density measured across it.
   *
   * Found by casting rays from a grid of screen points onto the page: exact at any zoom
   * and angle, including a page seen steeply, where near parts need far more detail than
   * distant ones (the densest part decides). Rays meet the page's cross-section curve, not
   * its triangles (see pageHit): zoomed in, every ray reaches the page's bounds, and
   * testing thousands of triangles each took about 50 ms a call while moving.
   * @returns {{folio: number, region: {u0: number, v0: number, u1: number, v1: number},
   *            samples: {u: number, v: number, pxPerMm: number}[]}[]}
   * @param {{width?: number, height?: number, folios?: number[]}} [size] a capture tile's, in
   *   device pixels (else the canvas's); `folios`: the pages to look for (else the open spread's)
   */
  visiblePages({ width, height, folios = this.shownFolios } = {}) {
    if (!this.model) return [];
    // In device pixels of the canvas, or of a capture tile when given.
    const W = width ?? this.renderer.domElement.width;
    const H = height ?? this.renderer.domElement.height;
    const { width: pw, height: ph } = this.model;
    const cols = 16;
    const rows = 12;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const out = [];
    const toLeaf = new THREE.Matrix4();
    const local = new THREE.Ray();
    for (const folio of folios) {
      const leaf = this.leaves[Math.ceil(folio / 2) - 1];
      if (!leaf || folio < 1 || folio > this.pageCount) continue;
      const front = folio % 2 === 1; // odd pages on the leaf's front
      leaf.mesh.updateWorldMatrix(true, false);
      toLeaf.copy(leaf.mesh.matrixWorld).invert();
      const grid = [];
      for (let j = 0; j <= rows; j++) {
        const row = [];
        for (let i = 0; i <= cols; i++) {
          ndc.set((i / cols) * 2 - 1, 1 - (j / rows) * 2);
          ray.setFromCamera(ndc, this.camera);
          local.copy(ray.ray).applyMatrix4(toLeaf);
          row.push(pageHit(this.model, leaf, local, front));
        }
        grid.push(row);
      }
      let u0 = 1;
      let u1 = 0;
      let v0 = 1;
      let v1 = 0;
      const samples = [];
      const stepX = W / cols;
      const stepY = H / rows;
      for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) {
          const q = grid[j][i];
          if (!q) continue;
          u0 = Math.min(u0, q.x);
          u1 = Math.max(u1, q.x);
          v0 = Math.min(v0, q.y);
          v1 = Math.max(v1, q.y);
          // Screen pixels per mm of paper here: from the neighbouring rays.
          let here = 0;
          for (const [n, step] of [[grid[j][i + 1], stepX], [grid[j + 1]?.[i], stepY], [grid[j][i - 1], stepX], [grid[j - 1]?.[i], stepY]]) {
            if (!n) continue;
            const mm = Math.hypot((n.x - q.x) * pw, (n.y - q.y) * ph);
            if (mm > 1e-6) here = Math.max(here, step / mm);
          }
          if (here) samples.push({ u: q.x, v: q.y, pxPerMm: here });
        }
      }
      if (u1 < u0 || v1 < v0) continue; // not on screen
      // Grow by one ray spacing, as measured on the page (the widest step between neighbouring
      // rays): its edge, or the screen's, can lie up to that far past the last ray that met
      // it. (Until 0.17.79 by a sixteenth of the part met, a ninth of the true spacing on a
      // page filling six of the sixteen columns: the strips stopped 12 % short of the spine,
      // and the page showed a seam there between its strip and its base image.)
      let du = 0.01;
      let dv = 0.01;
      for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) {
          const q = grid[j][i];
          if (!q) continue;
          for (const n of [grid[j][i + 1], grid[j + 1]?.[i]]) {
            if (!n) continue;
            du = Math.max(du, Math.min(0.5, Math.abs(n.x - q.x)));
            dv = Math.max(dv, Math.min(0.5, Math.abs(n.y - q.y)));
          }
        }
      }
      // Within a further spacing of the page's own edge: to the edge. Where the page curves
      // away into the spine its steps on screen are shorter than the widest measured, and the
      // last millimetres there fell between rays.
      const lo = (a, d) => (a - 2 * d <= 0 ? 0 : a - d);
      const hi = (a, d) => (a + 2 * d >= 1 ? 1 : a + d);
      out.push({ folio, region: { u0: lo(u0, du), v0: lo(v0, dv), u1: hi(u1, du), v1: hi(v1, dv) }, samples });
    }
    return out;
  }

  /**
   * Sharp strips of a page (each: an ImageBitmap and its region in texture uv), drawn
   * over its base image. Replaces the page's previous strips; pass [] to clear. The
   * images are owned: closed when replaced.
   */
  setPageDetails(folio, strips, { immediate = false } = {}) {
    // Replaces any set still being prepared for this page.
    const pending = this.detailQueue.get(folio);
    if (pending) {
      for (const tex of pending.textures) disposeTexture(tex, this.white);
      for (const s of pending.strips.slice(pending.textures.length)) s.image.close?.();
    }
    this.detailQueue.set(folio, { strips: strips.slice(0, MAX_DETAIL), textures: [] });
    if (immediate) while (this.detailQueue.has(folio)) this.#prepareDetails(folio);
    this.dirty = true;
  }

  /**
   * Prepare queued detail strips one per frame (upload plus mipmaps is the costly part),
   * then swap a page's whole set in at once: no frame carries the full load.
   */
  #prepareDetails(only = null) {
    for (const [folio, job] of this.detailQueue) {
      if (only !== null && folio !== only) continue;
      const leaf = this.leaves[Math.ceil(folio / 2) - 1];
      if (!leaf) {
        for (const s of job.strips) s.image.close?.();
        this.detailQueue.delete(folio);
        continue;
      }
      if (job.textures.length < job.strips.length) {
        // Exactly as a page's base image goes up (see #flushUploads): the same texture, drawn
        // from once before its pixels are let go. (Until 0.17.79 strips had a way of their
        // own, without that first draw.)
        const tex = this.#pageTexture(job.strips[job.textures.length].image);
        tex.userData.owned = true;
        this.#warm(tex);
        freeImage(tex);
        job.textures.push(tex);
        this.dirty = true;
        return; // one per frame
      }
      const u = (folio % 2 ? leaf.front : leaf.back).userData.uniforms;
      const had = u.uDetailCount.value > 0;
      for (let i = 0; i < MAX_DETAIL; i++) {
        disposeTexture(u[`uDetail${i}`].value, this.white);
        u[`uDetail${i}`].value = job.textures[i] ?? this.white;
        const r = job.strips[i]?.region;
        if (r) u[`uDetailRect${i}`].value.set(r.u0, r.v0, r.u1, r.v1);
      }
      u.uDetailCount.value = job.textures.length;
      // New strips over the base image fade in (see DETAIL_FADE_MS); sharper strips replacing
      // strips, or strips going, change at once (fading to or from the base would soften).
      if (job.textures.length && !had) {
        u.uDetailFade.value = 0;
        this.fading.add(u);
      } else {
        u.uDetailFade.value = 1;
        this.fading.delete(u);
      }
      this.detailQueue.delete(folio);
      this.dirty = true;
      return;
    }
  }

  /** The current view as a large PNG, tile by tile (see capture.js). */
  captureImage(options) {
    return capture.captureImage(this, this.#own, options);
  }

  /** An animation, rendered offline frame by frame on the scene's own clock (see capture.js). */
  recordVideo(options) {
    return capture.recordVideo(this, this.#own, options);
  }

  /** Whether the sheets' depth is drawn first (see makeLeaf). */
  get depthFirst() {
    return this.depthPass;
  }

  set depthFirst(on) {
    this.depthPass = on;
    for (const leaf of this.leaves) {
      leaf.first.visible = on;
      for (const m of leaf.mesh.material) if (m.userData.uniforms) m.depthWrite = !on; // the faces'
    }
    this.dirty = true;
  }

  /** For tests: advance the animations to the set clock and lay the book out, without drawing. */
  debugStep() {
    this.#update(this.clock ?? performance.now());
  }

  /** Render now and read one pixel (sRGB, 0-255) at a fraction of the canvas. For calibration. */
  debugSample(fx, fy) {
    this.dirty = true;
    this.#frame(performance.now()); // lays out pending changes and renders
    this.#placeCamera();
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
    return 100 / this.rig.zoom;
  }

  /**
   * Glide to `percent` about the view's pivot, without moving the pivot: a camera preset
   * plus a zoom step always frames the book the same way (for mockups).
   */
  setZoomPercent(percent) {
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
    this.#frameCamera();
    this.zoomGlide = null;
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
        for (let i = 0; i < MAX_DETAIL; i++) disposeTexture(m.userData.uniforms[`uDetail${i}`].value, this.white);
        m.dispose();
      }
      for (const m of leaf.mesh.material.slice(3)) m.dispose(); // a coil page's twins (their textures are the page's)
      if (leaf.mesh.material[2].userData.edgeOf) leaf.mesh.material[2].dispose(); // its edges' (the same)
      leaf.first.material[0].dispose();
      leaf.first.material[1].dispose();
    }
    this.leaves = [];
    this.fading.clear();
    for (const flap of this.flaps.values()) freeFlap(this, flap); // the flaps lay on them
    this.flaps.clear();
    // Sharp strips still on their way to the GPU were for the old book's leaves.
    for (const job of this.detailQueue.values()) {
      for (const tex of job.textures) disposeTexture(tex, this.white);
      for (const s of job.strips.slice(job.textures.length)) s.image.close?.();
    }
    this.detailQueue.clear();
    this.sheets?.tex.dispose();
    this.sheets = null;
    if (this.extras) {
      this.block.remove(this.extras.group);
      this.extras.group.traverse((o) => /** @type {THREE.Mesh} */ (o).geometry?.dispose());
      this.extras = null;
    }
  }

  // --- textures ------------------------------------------------------------------------

  #flushUploads() {
    let n = 0;
    for (const [folio, { image, text }] of this.uploads) {
      if (n >= UPLOADS_PER_FRAME) break;
      this.uploads.delete(folio);
      if (text) { // with its image, in the same frame: the image leaves the vector text out
        this.#setVector(folio, text.vector);
        this.#setSmall(folio, text.small);
        this.#applyVector();
        this.dirty = true;
      }
      this.pageTextures.get(folio)?.dispose();
      this.pageTextures.delete(folio);
      if (image) {
        const tex = this.#pageTexture(image);
        this.#warm(tex);
        freeImage(tex); // on the GPU now: the image in memory goes
        this.pageTextures.set(folio, tex);
        n++;
      }
      this.#showPage(folio);
      this.dirty = true;
    }
  }

  // --- per-frame layout --------------------------------------------------------------

  #frameCamera() {
    if (!this.model) return;
    const { width: w, height: h, ground, total } = this.model;
    const c = ease(this.closed);
    const aspect = this.camera.aspect;
    const vfov = (this.camera.fov * Math.PI) / 360;
    const hfov = Math.atan(Math.tan(vfov) * aspect);
    const spreadFit = Math.max((w * 1.15) / Math.tan(hfov), (h * 0.62) / Math.tan(vfov));
    const closedFit = Math.max((w * 0.75) / Math.tan(hfov), (h * 0.66) / Math.tan(vfov));
    // Open at a cover, the pages lie on one side: framed like a single page, centred on it.
    // So is the one page asked for (focus).
    const s = this.coverShift;
    const p = this.pageFrame;
    // A page asked for: never farther than the spread (in a wide view both fill its height, and
    // a page framed with the closed book's room above and below drew back as it was asked for).
    // At a cover: as the closed book, which it is about to be (a coil book closing from there
    // stepped back as it tilted onto its coil, 0.17.24 to 0.17.38).
    const openFit = lerp(spreadFit, lerp(Math.min(closedFit, spreadFit), closedFit, this.coverFrame), p);
    this.fitDistance = 1.08 * lerp(openFit, closedFit, c);
    const openY = lerp(w * 0.2, total / 2, p);
    this.target.set(lerp((s * w) / 2, (this.closedSide * w) / 2, c), ground + lerp(openY, total / 2, c), h * 0.03);
    // Floating: the book is tilted about the point the camera aims at, which stays put.
    const tilt = this.float;
    this.root.rotation.set(tilt?.x ?? 0, 0, tilt?.z ?? 0);
    this.root.position.copy(this.target).sub(this.target.clone().applyEuler(this.root.rotation));
    this.root.updateMatrixWorld();
    // Key light upper left in front; rim light behind. Fixed to the book, not to where the
    // camera aims: as the view re-frames (closing, opening at a cover) a light following it
    // moved the shadow map a fraction of a texel each frame, and shadows crawled. Floating,
    // they turn with the book: lit as it would be lying on a table, however it hangs.
    const d = Math.max(w, h) * 3;
    const anchor = new THREE.Vector3(0, ground, 0); // the spine on the table, in the book's frame
    const around = (x, y, z) => this.root.localToWorld(new THREE.Vector3(x, y, z).add(anchor));
    this.key.position.copy(around(-d * 0.35, d, d * 0.5));
    this.key.target.position.copy(around(0, 0, 0));
    this.rim.position.copy(around(d * 0.6, d * 0.5, -d));
    this.rim.target.position.copy(around(0, 0, 0));
    const cam = this.key.shadow.camera;
    const span = Math.max(w, h) * 1.4;
    Object.assign(cam, { left: -span, right: span, top: span, bottom: -span, near: d * 0.2, far: d * 2.5 });
    cam.updateProjectionMatrix();
  }

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
    this.motionComposer.setPixelRatio(ratio * this.motion.scale);
    this.motionComposer.setSize(w, h);
    motionReset(this.motion.step); // a new size: smaller may help again
    this.camera.aspect = w / h;
    this.#frameCamera();
    this.dirty = true;
  }

  #now() {
    return this.clock ?? performance.now();
  }

  #frame(time) {
    if (this.capturing) return; // a capture owns the renderer
    const started = performance.now();
    // A set clock (a video, or a test stepping through frames) is the only time: the screen's
    // own frames mustn't advance animations under it.
    const { animating, moving } = this.#update(this.clock ?? time);
    const inMotion = animating || moving;
    // Back at rest after frames drawn smaller: once more, at full resolution.
    if (!inMotion && this.motion.low) this.dirty = true;
    if (this.fading.size) {
      const dt = this.lastFadeTime == null ? 1000 / 60 : Math.min(100, time - this.lastFadeTime);
      for (const u of this.fading) {
        u.uDetailFade.value = Math.min(1, u.uDetailFade.value + dt / DETAIL_FADE_MS);
        if (u.uDetailFade.value >= 1) this.fading.delete(u);
      }
      this.dirty = true;
    }
    this.lastFadeTime = time;
    const draw = inMotion || this.dirty;
    this.#adaptResolution(time, inMotion && draw);
    if (!draw) {
      // At rest, settled, nothing waiting to go to the GPU: no more frames until something
      // changes (asking for them every refresh kept a CPU core 7 % busy for nothing).
      if (this.settled && !this.uploads.size && !this.detailQueue.size) this.idleFrames++;
      return;
    }
    this.idleFrames = 0;
    this.dirty = false;
    this.#placeCamera();
    this.callbacks.onCamera?.(this.camera);
    shadows(this);
    drawOrder(this);
    const low = inMotion && this.motion.scale < 1 && this.clock == null;
    const m = this.motion;
    const gl = /** @type {WebGL2RenderingContext} */ (this.renderer.getContext());
    const query = m.timer && inMotion && m.queries.length < 4 ? gl.createQuery() : null;
    if (query) gl.beginQuery(m.timer.TIME_ELAPSED_EXT, query);
    (low ? this.motionComposer : this.composer).render();
    if (query) {
      gl.endQuery(m.timer.TIME_ELAPSED_EXT);
      m.queries.push(query);
    }
    m.low = low;
    const log = this.frameLog;
    log.time[log.n % log.time.length] = started;
    log.cpu[log.n % log.time.length] = performance.now() - started;
    log.n++;
  }

  /**
   * How drawing went over the last second, for the frame counter: frames a second while
   * things move (null at rest, where nothing is drawn; a lone redraw, a page image arriving,
   * doesn't count), the main thread's time a frame, the graphics card's (where it can be
   * timed, else null) and the scale motion is drawn at (see #adaptResolution).
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
    const m = this.motion;
    return {
      fps: moving ? (1000 * gaps) / span : null,
      cpu: recent.length ? recent.reduce((sum, i) => sum + cpu[i], 0) / recent.length : 0,
      gpu: m.timer && now - m.gpuAt < 1000 ? m.gpu : null,
      scale: m.scale,
    };
  }

  /**
   * Keep motion as smooth as the screen (see motion.js for the steps). The screen's refresh
   * is the shortest time between two animation frames with nothing drawn (frames cost
   * nothing then). In motion, what a frame costs: the graphics card's own time to draw it
   * where it can be timed (a frame's pace alone misleads where the system doesn't hold
   * drawing to the screen's), else the time between frames drawn, over 30 frames. Videos
   * and tests (a set clock) are always drawn at full size.
   */
  #adaptResolution(time, drawingInMotion) {
    const m = this.motion;
    const dt = m.lastFrame ? time - m.lastFrame : 0;
    m.lastFrame = time;
    const wasDrawing = m.rendered;
    m.rendered = drawingInMotion;
    const gl = /** @type {WebGL2RenderingContext} */ (this.renderer.getContext());
    // Timed frames, as their results come in (a few frames later).
    while (m.queries.length && gl.getQueryParameter(m.queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = m.queries.shift();
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
      if (!gl.getParameter(m.timer.GPU_DISJOINT_EXT) && this.clock == null) {
        m.frames.push(ms);
        m.gpu = ms; // for the frame counter (frameStats)
        m.gpuAt = performance.now();
      }
    }
    if (this.clock != null || m.frozen || !(dt > 0 && dt < 200)) return; // frozen: see probe.js
    if (!drawingInMotion && !wasDrawing) {
      m.refresh.push(dt);
      if (m.refresh.length > 120) m.refresh.shift();
      return;
    }
    if (!m.timer && drawingInMotion && wasDrawing) m.frames.push(dt);
    if (m.frames.length < 30 || m.refresh.length < 10) return;
    const mean = m.frames.reduce((x, y) => x + y, 0) / m.frames.length;
    m.frames.length = 0;
    const scale = motionStep(m.step, mean, Math.min(...m.refresh), !!m.timer);
    if (scale === m.scale) return;
    m.scale = scale;
    this.motionComposer.setPixelRatio(this.renderer.getPixelRatio() * m.scale);
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
        this.#frameCamera();
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
      this.#frameCamera();
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
      this.#frameCamera();
      this.cameraChanged = true;
    }
    this.lastFrameTime = time;
    if (this.model && (animating || this.geometryDirty)) {
      this.shared.uOpenness.value = 1 - this.closed;
      layoutLeaves(this);
      this.geometryDirty = false;
      this.dirty = true;
    }
    // Sharp strips go to the GPU only at rest: uploaded mid-motion they stalled frames (four
    // times the pixels on a Retina screen); they are for a view that has stopped anyway.
    if (this.uploads.size) this.#flushUploads();
    else if (this.detailQueue.size && this.settled) this.#prepareDetails();
    // Wheel zoom and pan change the camera outside the rig's own animations: count them
    // as motion too, or the pages would never re-sharpen after a zoom.
    glideZoom(this, this.#own, time);
    const moving = this.rig.update(time) || this.cameraChanged;
    this.cameraChanged = false;
    if (this.rig.zoom !== this.shownZoom) {
      this.shownZoom = this.rig.zoom;
      this.callbacks.onZoom?.(this.zoomPercent);
    }
    if (animating || moving) {
      this.lastMotion = time;
      this.lastTurned = animating;
      if (this.settled) this.callbacks.onViewMoving?.(); // once, as it starts
      this.settled = false;
    } else if (!this.settled && time - this.lastMotion > (this.lastTurned ? TURN_SETTLE_MS : SETTLE_MS)) {
      this.settled = true;
      this.callbacks.onViewSettled?.();
    }
    return { animating, moving };
  }

  #currentTarget() {
    const p = this.rig.pan;
    return this.target.clone().add(new THREE.Vector3(p.x, p.y, p.z));
  }

  #placeCamera() {
    const { azimuth, elevation, zoom } = this.rig;
    const d = this.fitDistance * zoom;
    const t = this.#currentTarget();
    this.camera.position.set(
      t.x + d * Math.sin(azimuth) * Math.cos(elevation),
      t.y + d * Math.sin(elevation),
      t.z + d * Math.cos(azimuth) * Math.cos(elevation),
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(t);
    // Depth range follows the distance: precise enough for 0.1 mm paper at any zoom.
    this.camera.near = Math.max(0.2, d * 0.02);
    this.camera.far = d * 40 + 5000;
    this.camera.updateProjectionMatrix();
    // From beneath the table (orbited there to see the book's underside), the table and
    // its shadows aren't there to see.
    const above = !this.model || this.float || this.camera.position.y > this.model.ground;
    this.ground.visible = this.contact.visible = above && !this.float;
  }
}

/** Whether the renderer draws through Metal on an Apple GPU (see makeLeaf). */
function isAppleMetal(renderer) {
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  return /Apple/.test(name) && /Metal/.test(name);
}

/**
 * The mean colour of an artwork's first and last columns (u 0: the front cover's side of a
 * spine, u 1: the back's), as CSS colours: the spine's tone where it folds round each corner.
 */
function edgeTones(artwork) {
  const c = new OffscreenCanvas(2, 1);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(artwork, 0, 0, 1, artwork.height, 0, 0, 1, 1);
  ctx.drawImage(artwork, artwork.width - 1, 0, 1, artwork.height, 1, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 2, 1).data;
  return [0, 4].map((k) => `rgb(${d[k]}, ${d[k + 1]}, ${d[k + 2]})`);
}
