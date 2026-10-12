// The book's shaders: three.js's own, changed as text where pages, sheets and shadows need
// more (patchShader: a three.js upgrade that changed the text fails at once, see
// tests/scene.test.js), and the GLSL snippets that change them. The sheets are built on the
// GPU from their cross-sections (SHEET_VERTEX); pages are shaded as ink on paper.

import * as THREE from "three";
import { VECTOR_TEXT_GLSL } from "./vectortext.js";

export const MAX_DETAIL = 6; // sharp strips per page

// Leaves are drawn this much of their thickness: neighbours never share a surface (which
// flickers at grazing angles), and the stack's edges show the fine lines of real paper.
export const LEAF_FILL = 0.9;
export const LEAF_ROWS = 9; // vertex rows from head to foot: enough for a page's gentle bow
export const MID_ROW = (LEAF_ROWS - 1) / 2;
// The sheets texture's rows (see packSheet): the rows of a corner-led turn other than the
// middle one, in order.
export const OTHER_ROWS = Array.from({ length: LEAF_ROWS }, (_, r) => r).filter((r) => r !== MID_ROW);

// Soft shadows that harden where things touch (percentage-closer soft shadows), as under a
// large window rather than a point of light: the shadow's blur grows with the distance
// between what casts it and what receives it. Replaces three's fixed-width filter for the
// key light's shadow. Units are the shadow map's own (uv across, 0-1 in depth); both scale
// with the book (see #frameCamera), so one set of numbers fits every page size.
// SPREAD: blur per unit of depth gap (a light about 10 degrees across); SEARCH: the widest
// blur, in uv (about 12 mm on an A5 page).
const PCSS_GLSL = /* glsl */ `
#define PV_PCSS_SPREAD 0.42
#define PV_PCSS_SEARCH 0.02
const vec2 PV_DISK[ 24 ] = vec2[ 24 ](
  vec2( 0.000, 0.000 ), vec2( 0.527, -0.085 ), vec2( -0.040, 0.536 ), vec2( -0.670, -0.179 ),
  vec2( -0.419, -0.616 ), vec2( 0.440, -0.639 ), vec2( -0.757, 0.349 ), vec2( 0.574, 0.685 ),
  vec2( 0.976, 0.122 ), vec2( 0.264, -0.968 ), vec2( -0.249, 0.937 ), vec2( -0.926, -0.301 ),
  vec2( 0.215, 0.271 ), vec2( -0.267, -0.244 ), vec2( 0.312, -0.330 ), vec2( -0.338, 0.253 ),
  vec2( 0.786, -0.483 ), vec2( 0.809, 0.462 ), vec2( -0.103, -0.880 ), vec2( 0.099, 0.840 ),
  vec2( -0.678, 0.682 ), vec2( -0.858, 0.052 ), vec2( -0.648, -0.637 ), vec2( 0.035, -0.459 )
);
// The nearest caster around each block of the shadow map, as far as the search below reaches
// (see nearestCasters); 0 where it isn't current (while shadows change, and in materials
// that don't take it).
uniform highp sampler2D uCasterMap;
uniform float uCasterMapOn;
float pvSoftShadow( sampler2D map, vec2 mapSize, vec4 sc ) {
  // Nothing nearer the light than this point anywhere the search would look: lit, as the
  // search would find, after one lookup instead of 24 (most of a page; at a Retina screen's
  // resolution the search was a quarter of a frame).
  if ( uCasterMapOn > 0.5 && texture2D( uCasterMap, sc.xy ).r >= sc.z + 1e-6 ) return 1.0;
  // How far, on average, are the blockers above this point?
  float sum = 0.0;
  float n = 0.0;
  for ( int i = 0; i < 24; i++ ) {
    float d = unpackRGBAToDepth( texture2D( map, sc.xy + PV_DISK[ i ] * PV_PCSS_SEARCH ) );
    if ( d < sc.z ) { sum += d; n += 1.0; }
  }
  if ( n == 0.0 ) return 1.0;
  float blur = clamp( ( sc.z - sum / n ) * PV_PCSS_SPREAD, 1.5 / mapSize.x, PV_PCSS_SEARCH );
  // The sample pattern turned per pixel: fine grain instead of banding.
  float a = 6.2831853 * fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  mat2 turn = mat2( cos( a ), sin( a ), -sin( a ), cos( a ) );
  float lit = 0.0;
  for ( int i = 0; i < 24; i++ ) lit += texture2DCompare( map, sc.xy + turn * PV_DISK[ i ] * blur, sc.z );
  return lit / 24.0;
}
`;

/**
 * Change three.js's shader source: each [find, replacement] pair's text must be there exactly
 * once (a replacement may be a function of it). A three.js upgrade that changed the text
 * stops here, at the first compile (or, for the shadow chunk below, as the app loads),
 * instead of drawing without part of the shading.
 */
export function patchShader(source, pairs) {
  for (const [find, replacement] of pairs) {
    const at = source.indexOf(find);
    if (at < 0 || source.indexOf(find, at + 1) >= 0) {
      throw new Error(`three.js shader changed: "${find.trim().split("\n")[0]}" ${at < 0 ? "is gone" : "is there more than once"}`);
    }
    const text = typeof replacement === "function" ? replacement(find) : replacement;
    source = source.slice(0, at) + text + source.slice(at + find.length);
  }
  return source;
}

THREE.ShaderChunk.shadowmap_pars_fragment = patchShader(THREE.ShaderChunk.shadowmap_pars_fragment, [
  ["\tvec2 texture2DDistribution(", (after) => PCSS_GLSL + after],
  ["\t\t#if defined( SHADOWMAP_TYPE_PCF )\n\t\t\tvec2 texelSize",
    "\t\tshadow = pvSoftShadow( shadowMap, shadowMapSize, shadowCoord );\n\t\t#if 0\n\t\t\tvec2 texelSize"],
  ["\t\t#elif defined( SHADOWMAP_TYPE_PCF_SOFT )", "\t\t#endif\n\t\t#if 0"],
  ["\t\t#elif defined( SHADOWMAP_TYPE_VSM )\n\t\t\tshadow = VSMShadow( shadowMap, shadowCoord.xy, shadowCoord.z );\n\t\t#else\n\t\t\tshadow = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );\n\t\t#endif",
    "\t\t#endif"],
]);

const DETAIL_UNIFORMS = Array.from({ length: MAX_DETAIL }, (_, i) =>
  `uniform sampler2D uDetail${i};\nuniform vec4 uDetailRect${i};`).join("\n");

// The last strip covering the point wins (as if drawn over each other), so they are tried
// from the last: the first that covers it is the one to sample.
const DETAIL_LOOKUPS = Array.from({ length: MAX_DETAIL }, (_, k) => MAX_DETAIL - 1 - k).map((i) => `
    if ( !covered && uDetailCount > ${i}.5 && vMapUv.x >= uDetailRect${i}.x && vMapUv.x <= uDetailRect${i}.z
         && vMapUv.y >= uDetailRect${i}.y && vMapUv.y <= uDetailRect${i}.w ) {
      vec2 size${i} = uDetailRect${i}.zw - uDetailRect${i}.xy;
      sampledDiffuseColor = pageSample( uDetail${i}, ( vMapUv - uDetailRect${i}.xy ) / size${i},
        detailDx / size${i}, detailDy / size${i} );
      covered = true;
    }`).join("");

// The sheets, built here from their cross-sections (see packSheet): a vertex's position is
// only its place on its sheet (point along it, row from head to foot, code; see makeLeaf).
// A point of either surface is the cross-section's point out along its normal by half the
// paper, plus the bow (most at the corners, nothing at the spine). Normals as the triangles
// round a vertex face (they are wound so): over the faces from the neighbouring points; head
// and foot lie flat, both wound to face the foot; the fore-edge and spine end from the way
// along the rows and the way through the paper.
const SHEET_VERTEX = /* glsl */ `
#define SHEET_ROWS ${LEAF_ROWS}
#define SHEET_MID ${MID_ROW}
uniform highp sampler2D uSheets;
uniform ivec3 uSheetLayout; // a sheet's block width, sheets per column, first row of the other rows
ivec2 sheetBlock;
int sheetJ;
int sheetN;
bool sheetRowsOn;
float sheetHalf;
float sheetZ0;
float sheetHeight;
float sheetFore;
vec4 sheetBowsA;
vec4 sheetBowsB;
float sheetBow8;
void sheetLoad( int sheet ) {
  int column = sheet / uSheetLayout.y;
  sheetJ = sheet - column * uSheetLayout.y;
  sheetBlock = ivec2( column * uSheetLayout.x, 0 );
  ivec2 at = sheetBlock + ivec2( 0, 2 * sheetJ );
  sheetBowsA = texelFetch( uSheets, at, 0 );
  sheetBowsB = texelFetch( uSheets, at + ivec2( 1, 0 ), 0 );
  vec4 a = texelFetch( uSheets, at + ivec2( 2, 0 ), 0 );
  vec4 b = texelFetch( uSheets, at + ivec2( 3, 0 ), 0 );
  sheetBow8 = a.x;
  sheetHalf = a.y;
  sheetZ0 = a.z;
  sheetHeight = a.w;
  sheetFore = b.x;
  sheetRowsOn = b.y > 0.5;
  sheetN = int( b.z + 0.5 );
}
float sheetBow( int r ) {
  return r < 4 ? sheetBowsA[ r ] : r < 8 ? sheetBowsB[ r - 4 ] : sheetBow8;
}
vec3 sheetPoint( int k, int r, float side ) {
  int y = !sheetRowsOn || r == SHEET_MID ? 2 * sheetJ + 1
    : uSheetLayout.z + ( SHEET_ROWS - 1 ) * sheetJ + ( r < SHEET_MID ? r : r - 1 );
  vec4 t = texelFetch( uSheets, sheetBlock + ivec2( k, y ), 0 );
  float s = sin( t.z );
  float c = cos( t.z );
  float ext = k == sheetN - 1 ? sheetFore : 0.0;
  float zz = 2.0 * float( r ) / float( SHEET_ROWS - 1 ) - 1.0;
  float d = sheetBow( r ) * t.w * t.w * ( 0.4 + 0.6 * zz * zz );
  vec2 p = t.xy + vec2( s, c ) * ext + vec2( - c, s ) * ( side * sheetHalf + d );
  return vec3( p, sheetZ0 + sheetHeight * float( r ) / float( SHEET_ROWS - 1 ) );
}
vec3 sheetPosition() {
  int code = int( position.z + 0.5 );
  sheetLoad( code >> 4 );
  return sheetPoint( int( position.x + 0.5 ), int( position.y + 0.5 ), ( code & 1 ) == 0 ? 1.0 : - 1.0 );
}
vec3 sheetNormal() {
  int code = int( position.z + 0.5 );
  sheetLoad( code >> 4 );
  int k = int( position.x + 0.5 );
  int r = int( position.y + 0.5 );
  float side = ( code & 1 ) == 0 ? 1.0 : - 1.0;
  int part = ( code >> 1 ) & 7;
  if ( part == 1 || part == 2 ) return vec3( 0.0, 0.0, 1.0 );
  vec3 along = sheetPoint( k, min( r + 1, SHEET_ROWS - 1 ), side ) - sheetPoint( k, max( r - 1, 0 ), side );
  if ( part == 0 ) {
    vec3 across = sheetPoint( min( k + 1, sheetN - 1 ), r, side ) - sheetPoint( max( k - 1, 0 ), r, side );
    return normalize( side * cross( along, across ) );
  }
  vec3 through = sheetPoint( k, r, - 1.0 ) - sheetPoint( k, r, 1.0 );
  return normalize( part == 3 ? cross( along, through ) : cross( through, along ) );
}
`;

export const PAGE_FRAGMENT_HEADER = /* glsl */ `
uniform sampler2D uBack;
uniform sampler2D uSmall;
uniform float uSmallOn;
uniform float uShow;
uniform float uSpineAtU0;
uniform vec4 uHoles;      // shape (0 none, 1 round, 2 square), pitch, radius or half-width, offset from spine (mm)
uniform vec2 uPageSize;   // mm
uniform float uDetailCount; // sharp strips over the page, see MAX_DETAIL
${DETAIL_UNIFORMS}
uniform vec2 uGutter;      // shade width (mm), depth at the fold
uniform float uOpenness;
uniform float uOuterCover;
uniform sampler2D uFinish;  // spot finish mask, see FINISH_FRAGMENT
uniform float uFinishKind;  // 0 none, 1 gloss varnish, 2 gold, 3 silver, 4 copper foil
${VECTOR_TEXT_GLSL}
// A page image sampled four times across the pixel's footprint (rotated grid), each from a
// mipmap level twice as fine: supersampling the texture. Sharper than the GPU's trilinear
// filter, and type keeps a steady baseline on a tilted page.
vec4 pageSample( sampler2D t, vec2 uv, vec2 dx, vec2 dy ) {
  vec2 hx = dx * 0.25, hy = dy * 0.25;
  vec2 gx = dx * 0.5, gy = dy * 0.5;
  return 0.25 * ( textureGrad( t, uv - hx * 0.5 - hy * 1.5, gx, gy ) + textureGrad( t, uv + hx * 1.5 - hy * 0.5, gx, gy )
                + textureGrad( t, uv + hx * 0.5 + hy * 1.5, gx, gy ) + textureGrad( t, uv - hx * 1.5 + hy * 0.5, gx, gy ) );
}
`;

// The page image, with the sharp strips where they cover. Unrolled per strip: arrays of
// samplers can't be indexed by a loop counter on every GPU. Gradients are taken once,
// outside the branches, so mipmap selection stays correct. Each point samples only what it
// shows: the strip covering it, else the page image (sampling the image everywhere and
// drawing strips over it cost four lookups a pixel for nothing).
export const PAGE_MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  vec2 detailDx = dFdx( vMapUv );
  vec2 detailDy = dFdy( vMapUv );
  // Small on screen (a page under about 400 px tall, all of it under 200), the page comes
  // from its small image, which has the text and is mipmapped like any image: drawn from
  // outlines, strokes thinner than a pixel flicker as the view moves.
  float smallShare = 0.0;
  if ( uSmallOn > 0.5 ) {
    vec2 texels = vec2( textureSize( uSmall, 0 ) );
    smallShare = smoothstep( 1.0, 2.0, max( length( detailDx * texels ), length( detailDy * texels ) ) );
  }
  vec4 sampledDiffuseColor = vec4( 1.0 );
  if ( smallShare < 1.0 ) {
    bool covered = false;
    ${DETAIL_LOOKUPS}
    if ( !covered ) sampledDiffuseColor = pageSample( map, vMapUv, detailDx, detailDy );
    // Text from its outlines, over the image (which leaves it out), blended as stored, as
    // a canvas blends: see vectortext.js.
    sampledDiffuseColor.rgb = pvVectorText( sampledDiffuseColor.rgb, vMapUv, detailDx, detailDy );
  }
  if ( smallShare > 0.0 ) sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, pageSample( uSmall, vMapUv, detailDx, detailDy ).rgb, smallShare );
  sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor ); // filtered as stored, see PAGE_COLOR_SPACE
  diffuseColor *= sampledDiffuseColor;
#endif
  if ( uOuterCover < 0.5 ) {
    // Gutter shade: less light reaches the paper deep in the fold. Soft falloff, strongest
    // right at the spine, gone a few centimetres out; none once the book is closed.
    float fromSpine = (uSpineAtU0 > 0.5 ? vMapUv.x : 1.0 - vMapUv.x) * uPageSize.x;
    float shade = exp( -fromSpine / ( uGutter.x * 0.35 ) );
    diffuseColor.rgb *= 1.0 - uGutter.y * uOpenness * shade;
  }
`;

// Spot finishes: where the finish PDF has any ink (its mask), gloss varnish is a smooth,
// clear coat over the print; foil is metal instead of the ink. Foil reflects the room more
// (metal shows what it mirrors), varnish a little.
export const FINISH_FRAGMENT = /* glsl */ `
  float pvGloss = 0.0;
  float pvFoil = 0.0;
  if ( uFinishKind > 0.5 ) {
    vec3 ink = texture2D( uFinish, vMapUv ).rgb;
    float m = 1.0 - min( min( ink.r, ink.g ), ink.b );
    if ( uFinishKind < 1.5 ) {
      pvGloss = m;
      material.roughness = mix( material.roughness, 0.07, m );
      material.specularColor = mix( material.specularColor, vec3( 0.045 ), m );
      material.specularF90 = mix( material.specularF90, 1.0, m );
    } else {
      pvFoil = m;
      vec3 foil = uFinishKind < 2.5 ? vec3( 1.0, 0.76, 0.33 ) : uFinishKind < 3.5 ? vec3( 0.93, 0.93, 0.94 ) : vec3( 0.95, 0.58, 0.45 );
      material.diffuseColor = mix( material.diffuseColor, vec3( 0.0 ), m );
      material.specularColor = mix( material.specularColor, foil, m );
      material.specularF90 = mix( material.specularF90, 1.0, m );
      material.roughness = mix( material.roughness, 0.32, m );
    }
  }
`;

export const FINISH_REFLECTION = /* glsl */ `
  radiance *= 1.0 + 0.6 * pvGloss + 0.7 * pvFoil;
`;

// Foil's highlights keep their colour: brighter than the screen shows, each channel would
// clip on its own and gold turn white. Scaled down as a whole instead, on foil only.
export const FINISH_HIGHLIGHT = /* glsl */ `
  if ( pvFoil > 0.0 ) {
    float peak = max( max( outgoingLight.r, outgoingLight.g ), max( outgoingLight.b, 1e-4 ) );
    outgoingLight = mix( outgoingLight, outgoingLight * min( 1.0, 0.92 / peak ), pvFoil );
  }
`;

// Paper is never lit brighter than white paper lying flat in the studio light (about 250 of
// 255, see LIGHT). Where a page faces the key light more squarely (the floating preset tilts
// the whole book toward it; 50-90 % of its paper clipped to the screen's white, the print's
// light tints washed out with it), the extra light rolls off into the few levels left. Its
// sheen is left as it is: gloss stock does glare.
export const PAPER_ROLLOFF = /* glsl */ `
  {
    // Linear: about 250 and 253 of 255 for white paper.
    const float knee = 0.96;
    const float room = 0.025;
    float lit = dot( totalDiffuse, vec3( 1.0 ) ) / max( dot( material.diffuseColor, vec3( 1.0 ) ), 1e-4 );
    if ( lit > knee ) totalDiffuse *= ( knee + room * ( 1.0 - exp( ( knee - lit ) / room ) ) ) / lit;
  }
`;

// Punched holes for spiral and wire-o bindings. v runs from the head (0) to the foot.
export const HOLE_DISCARD = /* glsl */ `
  if (uHoles.x > 0.5) {
    float s = (uSpineAtU0 > 0.5 ? vMapUv.x : 1.0 - vMapUv.x) * uPageSize.x;
    float z = vMapUv.y * uPageSize.y;
    float pitch = uHoles.y;
    float loops = floor((uPageSize.y - 6.0) / pitch);
    float margin = (uPageSize.y - loops * pitch) * 0.5;
    float k = clamp(floor((z - margin) / pitch), 0.0, loops - 1.0);
    float zc = margin + (k + 0.5) * pitch;
    vec2 p = vec2(s - uHoles.w, z - zc);
    if (uHoles.x > 1.5) {
      // Wire-O: square holes with slightly rounded corners.
      vec2 q = abs(p) - vec2(uHoles.z - 0.4);
      if (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) < 0.4) discard;
    } else if (length(p) < uHoles.z) discard;
  }
`;

// The other side of the leaf, faintly, mirrored and softened: ink showing through paper.
export const SHOW_THROUGH = /* glsl */ `
  {
    vec3 behind = texture(uBack, vec2(1.0 - vMapUv.x, vMapUv.y), 2.5).rgb;
    behind = sRGBTransferEOTF( vec4( behind, 1.0 ) ).rgb;
    diffuseColor.rgb *= mix(vec3(1.0), behind, uShow);
  }
`;

/** Build a sheet's vertices on the GPU from the sheets texture (see SHEET_VERTEX). */
export function sheetShader(shader, uniforms) {
  shader.uniforms.uSheets = uniforms.uSheets;
  shader.uniforms.uSheetLayout = uniforms.uSheetLayout;
  shader.uniforms.uCasterMap = uniforms.uCasterMap;
  shader.uniforms.uCasterMapOn = uniforms.uCasterMapOn;
  // The same point from every program that draws a sheet, to the last bit: its faces' depth,
  // drawn first, must match their shading (see makeLeaf).
  shader.vertexShader = "invariant gl_Position;\n" + patchShader(shader.vertexShader, [
    ["void main() {", SHEET_VERTEX + "void main() {"],
    ["#include <beginnormal_vertex>", "vec3 objectNormal = sheetNormal();"],
    ["#include <begin_vertex>", "vec3 transformed = sheetPosition();"],
  ]);
}
