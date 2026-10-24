// The timeline's thumbnails from a page's inks: a small WebGL program turns an ink image (C, M,
// Y, K a byte each, and its spot channels, see pdf/mupdf-render.js) into the colour it prints
// through the ink table (pdf/inklut.js), with the plates switched and the spots mixed in as the
// 3D view has them (INK_GLSL), so a plate left out or a profile chosen shows in the timeline the
// moment it shows in the book (the thumbnails are drawn again from their inks, which are kept:
// no render).

import { LUT_DEPTH, LUT_HEIGHT, LUT_WIDTH } from "../viewer/inklut.js";

const VERTEX = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = vec2( aPos.x, 1.0 - aPos.y ); gl_Position = vec4( aPos * 2.0 - 1.0, 0.0, 1.0 ); }`;
const FRAGMENT = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D uInk; uniform sampler2D uSpots; uniform highp sampler3D uInkLut; uniform vec4 uInkOn; uniform mat4 uSpotInk;
in vec2 vUv; out vec4 outColor;
vec3 inkToRgb( vec4 ink ) {
  ink = clamp( ink, 0.0, 1.0 );
  float k = ink.a * 16.0;
  float k0 = min( floor( k ), 15.0 );
  vec2 cm = ( ink.rg * 16.0 + 0.5 ) / 17.0;
  float ya = ( k0 * 17.0 + ink.b * 16.0 + 0.5 ) / 289.0;
  float yb = ( ( k0 + 1.0 ) * 17.0 + ink.b * 16.0 + 0.5 ) / 289.0;
  return mix( texture( uInkLut, vec3( cm, ya ) ).rgb, texture( uInkLut, vec3( cm, yb ) ).rgb, k - k0 );
}
void main() { outColor = vec4( inkToRgb( texture( uInk, vUv ) * uInkOn + uSpotInk * texture( uSpots, vUv ) ), 1.0 ); }`;

export class InkView {
  constructor() {
    this.canvas = new OffscreenCanvas(1, 1);
    const gl = this.canvas.getContext("webgl2", { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: false });
    this.gl = gl;
    if (!gl) return;
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program");
    gl.useProgram(program);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    this.uInkOn = gl.getUniformLocation(program, "uInkOn");
    this.uSpotInk = gl.getUniformLocation(program, "uSpotInk");
    gl.uniform1i(gl.getUniformLocation(program, "uInk"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "uInkLut"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "uSpots"), 2);
    gl.uniform4f(this.uInkOn, 1, 1, 1, 1);
    const plain = (unit) => {
      const t = gl.createTexture();
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    this.ink = plain(gl.TEXTURE0);
    this.spots = plain(gl.TEXTURE2);
    /** @type {Map<string, number[]>} the spots that print: their looks (setSpotInks) */
    this.spotInks = new Map();
    this.lut = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, k, v);
    this.hasLut = false;
  }

  /** The ink table (pdf/inklut.js: RGBA bytes, lutIndex order). */
  setLut(data) {
    const gl = this.gl;
    if (!gl) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, LUT_WIDTH, LUT_HEIGHT, LUT_DEPTH, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.hasLut = true;
  }

  /** The plates that print: Cyan, Magenta, Yellow, Black. */
  setInksOn(on) {
    this.gl?.uniform4f(this.uInkOn, on[0] ? 1 : 0, on[1] ? 1 : 0, on[2] ? 1 : 0, on[3] ? 1 : 0);
  }

  /** The spots that print, by name: their looks in CMYK, 0..1 (see BookScene.setSpotInks). */
  setSpotInks(inks) {
    this.spotInks = inks;
  }

  /**
   * An ink image ({width, height, data}) as the colour it prints, an ImageBitmap (the caller's).
   * @returns {ImageBitmap | null} null without WebGL or a table
   */
  draw(ink) {
    const gl = this.gl;
    if (!gl || !this.hasLut) return null;
    if (this.canvas.width !== ink.width || this.canvas.height !== ink.height) {
      this.canvas.width = ink.width;
      this.canvas.height = ink.height;
      gl.viewport(0, 0, ink.width, ink.height);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ink);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ink.width, ink.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, ink.data);
    // Its spot channels (none: one texel of no ink), and the matrix that mixes them in.
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.spots);
    if (ink.spots) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ink.width, ink.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, ink.spots);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    const m = new Float32Array(16);
    (ink.spotNames ?? []).forEach((name, i) => {
      const look = this.spotInks.get(name);
      if (look && i < 4) m.set(look, 4 * i);
    });
    gl.uniformMatrix4fv(this.uSpotInk, false, m);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas.transferToImageBitmap();
  }
}
