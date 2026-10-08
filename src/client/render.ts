import { FP } from "../sim/fixed.ts";
import { MODE_ATTACK, MODE_PATROL } from "../sim/commands.ts";
import type { Unit, World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import type { Selection } from "./selection.ts";
import { SELECT_ENEMY, SELECT_NEUTRAL, SELECT_OWN, teamColor } from "./style.ts";
import { GLSL_COMMON, attrib, buffer, compile, hexToRgb, uniforms } from "./gl/glutil.ts";
import { type Mat4, compose, identity, lookAt, multiply, ortho, perspective } from "./gl/math.ts";
import { type MeshData, cone, cylinder, quad, sphere, torus, wing } from "./gl/meshes.ts";
import { MODELS, type MeshName, type Part } from "./gl/models.ts";
import { buildTerrain } from "./gl/terrain.ts";

/**
 * WebGL2 renderer: SC2-style perspective camera, heightfield terrain with
 * cliffs, sun + shadow map, instanced 3D units, ground decals for selection.
 * A transparent 2D canvas on top draws click markers, waypoints, the drag box
 * and the cursor.
 *
 * Public surface used by the rest of the client: resize, draw, pick, pickBox,
 * onScreen, markers, unitIcon. Swapping in a different renderer later
 * (e.g. three.js with real glTF models) only needs to keep that surface.
 */

export interface Marker {
  x: number;
  y: number;
  color: string;
  t0: number;
}

export interface FrameState {
  alpha: number;
  now: number;
  selection: Selection;
  hoverId: number;
  dragBox: { x0: number; y0: number; x1: number; y1: number } | null;
  showWaypoints: boolean;
  cursor: { x: number; y: number; targeting: string | null } | null;
}

const MESH_NAMES: MeshName[] = ["sphere", "cone", "cylinder", "torus", "wing"];
const INST_FLOATS = 20; // mat4 + rgb + emissive
const SHADOW_SIZE = 2048;
// Direction toward the sun: high, from the south-west, so the side of units facing
// the camera is lit and shadows fall up and to the right, like SC2.
const LIGHT_DIR = (() => {
  const v = [-0.45, 0.82, 0.36];
  const l = Math.hypot(v[0], v[1], v[2]);
  return v.map((x) => x / l);
})();

// ---------------------------------------------------------------- shaders

const TERRAIN_VS = /* glsl */ `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in vec3 a_col;
uniform mat4 u_vp;
uniform mat4 u_lightVP;
out vec3 v_pos; out vec3 v_nrm; out vec3 v_col; out vec4 v_lc;
void main() {
  v_pos = a_pos; v_nrm = a_nrm; v_col = a_col;
  v_lc = u_lightVP * vec4(a_pos, 1.0);
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

const TERRAIN_FS = /* glsl */ `#version 300 es
precision highp float;
${GLSL_COMMON}
in vec3 v_pos; in vec3 v_nrm; in vec3 v_col; in vec4 v_lc;
uniform vec3 u_lightDir;
uniform vec2 u_mapSize;
out vec4 o;
void main() {
  vec3 n = normalize(v_nrm);
  // Fine procedural detail so the ground doesn't look flat-shaded.
  float d1 = vnoise(v_pos.xz * 5.0);
  float d2 = vnoise(v_pos.xz * 17.0 + 3.0);
  float d3 = vnoise(v_pos.xz * 1.3 + 9.0);
  vec3 albedo = v_col * (0.82 + d1 * 0.22 + d2 * 0.12 + (d3 - 0.5) * 0.12);
  float ndl = max(dot(n, u_lightDir), 0.0);
  float wrap = clamp(dot(n, u_lightDir) * 0.7 + 0.3, 0.0, 1.0); // softer terminator so cliff faces aren't black
  float sh = shadowAt(v_lc, ndl);
  vec3 sky = vec3(0.45, 0.5, 0.58), ground = vec3(0.26, 0.24, 0.21);
  vec3 amb = mix(ground, sky, n.y * 0.5 + 0.5);
  vec3 c = albedo * (amb + vec3(1.0, 0.94, 0.82) * wrap * (0.3 + 0.7 * sh) * 1.05);
  o = vec4(pow(c, vec3(0.95)), 1.0);
}`;

const UNIT_VS = /* glsl */ `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in vec4 a_m0;
layout(location=3) in vec4 a_m1;
layout(location=4) in vec4 a_m2;
layout(location=5) in vec4 a_m3;
layout(location=6) in vec3 a_col;
layout(location=7) in float a_emit;
uniform mat4 u_vp;
uniform mat4 u_lightVP;
out vec3 v_nrm; out vec3 v_col; out float v_emit; out vec4 v_lc; out vec3 v_world;
void main() {
  mat4 m = mat4(a_m0, a_m1, a_m2, a_m3);
  vec4 w = m * vec4(a_pos, 1.0);
  v_world = w.xyz;
  v_nrm = transpose(inverse(mat3(m))) * a_nrm;
  v_col = a_col; v_emit = a_emit;
  v_lc = u_lightVP * w;
  gl_Position = u_vp * w;
}`;

const UNIT_FS = /* glsl */ `#version 300 es
precision highp float;
${GLSL_COMMON}
in vec3 v_nrm; in vec3 v_col; in float v_emit; in vec4 v_lc; in vec3 v_world;
uniform vec3 u_lightDir;
uniform vec3 u_eye;
out vec4 o;
void main() {
  vec3 v = normalize(u_eye - v_world);
  vec3 n = normalize(v_nrm);
  if (dot(n, v) < 0.0) n = -n; // two-sided thin parts (wings) and mirrored meshes
  float ndl = max(dot(n, u_lightDir), 0.0);
  float sh = shadowAt(v_lc, ndl);
  vec3 amb = mix(vec3(0.22, 0.2, 0.2), vec3(0.45, 0.5, 0.6), n.y * 0.5 + 0.5);
  vec3 c = v_col * (amb + vec3(1.0, 0.95, 0.85) * ndl * (0.35 + 0.65 * sh) * 1.15);
  vec3 h = normalize(u_lightDir + v);
  c += pow(max(dot(n, h), 0.0), 40.0) * 0.35 * sh;
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  c += rim * vec3(0.3, 0.36, 0.45) * 0.35;
  c = mix(c, v_col * 1.5 + vec3(0.15, 0.08, 0.0), v_emit);
  o = vec4(c, 1.0);
}`;

const SHADOW_TERRAIN_VS = /* glsl */ `#version 300 es
layout(location=0) in vec3 a_pos;
uniform mat4 u_lightVP;
void main() { gl_Position = u_lightVP * vec4(a_pos, 1.0); }`;

const SHADOW_UNIT_VS = /* glsl */ `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=2) in vec4 a_m0;
layout(location=3) in vec4 a_m1;
layout(location=4) in vec4 a_m2;
layout(location=5) in vec4 a_m3;
layout(location=7) in float a_emit;
uniform mat4 u_lightVP;
void main() {
  mat4 m = mat4(a_m0, a_m1, a_m2, a_m3);
  gl_Position = u_lightVP * m * vec4(a_pos, 1.0);
  if (a_emit > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // flames don't cast shadows
}`;

const SHADOW_FS = /* glsl */ `#version 300 es
precision mediump float;
void main() {}`;

const DECAL_VS = /* glsl */ `#version 300 es
layout(location=0) in vec3 a_pos;
layout(location=2) in vec4 a_center;  // xyz + radius
layout(location=3) in vec4 a_color;
uniform mat4 u_vp;
out vec2 v_uv; out vec4 v_color; out float v_r;
void main() {
  float r = a_center.w;
  v_uv = a_pos.xz * 1.25; v_color = a_color; v_r = r;
  vec3 p = a_center.xyz + vec3(a_pos.x * r * 1.25, 0.0, a_pos.z * r * 1.25);
  gl_Position = u_vp * vec4(p, 1.0);
}`;

const DECAL_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv; in vec4 v_color; in float v_r;
out vec4 o;
void main() {
  float d = length(v_uv);
  float w = clamp(0.07 / v_r, 0.05, 0.16);
  float ring = smoothstep(1.0 - w * 1.6, 1.0 - w * 0.6, d) * (1.0 - smoothstep(1.0 - w * 0.2, 1.0 + w * 0.3, d));
  float fill = (1.0 - smoothstep(0.6, 1.0, d)) * 0.10;
  float a = max(ring, fill) * v_color.a;
  if (a < 0.01) discard;
  o = vec4(v_color.rgb, a);
}`;

// ------------------------------------------------------------- renderer

interface MeshGL {
  vao: WebGLVertexArrayObject;
  count: number;
  inst: WebGLBuffer;
  data: Float32Array;
  n: number;
}

interface PartGL extends Part {
  local: Mat4;
  rgb: [number, number, number] | null;
}

export class Renderer {
  private gl: WebGL2RenderingContext;
  private overlay: CanvasRenderingContext2D;
  private dpr = 1;
  private terrainVao!: WebGLVertexArrayObject;
  private terrainCount = 0;
  private progTerrain!: WebGLProgram;
  private progUnit!: WebGLProgram;
  private progShadowT!: WebGLProgram;
  private progShadowU!: WebGLProgram;
  private progDecal!: WebGLProgram;
  private uT!: Record<string, WebGLUniformLocation>;
  private uU!: Record<string, WebGLUniformLocation>;
  private uST!: Record<string, WebGLUniformLocation>;
  private uSU!: Record<string, WebGLUniformLocation>;
  private uD!: Record<string, WebGLUniformLocation>;
  private meshes = new Map<MeshName, MeshGL>();
  private decal!: { vao: WebGLVertexArrayObject; inst: WebGLBuffer; data: Float32Array; n: number };
  private shadowTex!: WebGLTexture;
  private shadowFbo!: WebGLFramebuffer;
  private lightVP: Mat4 = new Float32Array(16);
  private models: PartGL[][] = [];
  private facing = new Map<number, number>();
  private phase = new Map<number, number>();
  private lastPos = new Map<number, [number, number]>();
  private tmpU: Mat4 = new Float32Array(16);
  private tmpL: Mat4 = new Float32Array(16);
  private tmpW: Mat4 = new Float32Array(16);
  markers: Marker[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private overlayCanvas: HTMLCanvasElement,
    private world: World,
    private cam: Camera,
  ) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;
    this.overlay = overlayCanvas.getContext("2d")!;
    this.initPrograms();
    this.initTerrain();
    this.initMeshes();
    this.initShadow();
    this.initModels();
  }

  // ------------------------------------------------------------ setup

  private initPrograms() {
    const gl = this.gl;
    this.progTerrain = compile(gl, TERRAIN_VS, TERRAIN_FS);
    this.progUnit = compile(gl, UNIT_VS, UNIT_FS);
    this.progShadowT = compile(gl, SHADOW_TERRAIN_VS, SHADOW_FS);
    this.progShadowU = compile(gl, SHADOW_UNIT_VS, SHADOW_FS);
    this.progDecal = compile(gl, DECAL_VS, DECAL_FS);
    this.uT = uniforms(gl, this.progTerrain);
    this.uU = uniforms(gl, this.progUnit);
    this.uST = uniforms(gl, this.progShadowT);
    this.uSU = uniforms(gl, this.progShadowU);
    this.uD = uniforms(gl, this.progDecal);
  }

  private initTerrain() {
    const gl = this.gl;
    const t = buildTerrain(this.world.map);
    this.terrainVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.terrainVao);
    buffer(gl, gl.ARRAY_BUFFER, t.pos);
    attrib(gl, 0, 3);
    buffer(gl, gl.ARRAY_BUFFER, t.nrm);
    attrib(gl, 1, 3);
    buffer(gl, gl.ARRAY_BUFFER, t.col);
    attrib(gl, 2, 3);
    buffer(gl, gl.ELEMENT_ARRAY_BUFFER, t.idx);
    this.terrainCount = t.idx.length;
    gl.bindVertexArray(null);
  }

  private initMeshes() {
    const gl = this.gl;
    const data: Record<MeshName, MeshData> = {
      sphere: sphere(),
      cone: cone(),
      cylinder: cylinder(),
      torus: torus(0.28),
      wing: wing(),
    };
    for (const name of MESH_NAMES) {
      const m = data[name];
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      buffer(gl, gl.ARRAY_BUFFER, m.pos);
      attrib(gl, 0, 3);
      buffer(gl, gl.ARRAY_BUFFER, m.nrm);
      attrib(gl, 1, 3);
      buffer(gl, gl.ELEMENT_ARRAY_BUFFER, m.idx);
      const inst = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      const stride = INST_FLOATS * 4;
      for (let i = 0; i < 4; i++) attrib(gl, 2 + i, 4, stride, i * 16, 1);
      attrib(gl, 6, 3, stride, 64, 1);
      attrib(gl, 7, 1, stride, 76, 1);
      gl.bindVertexArray(null);
      this.meshes.set(name, { vao, count: m.idx.length, inst, data: new Float32Array(INST_FLOATS * 1024), n: 0 });
    }
    // Ground decals (selection circles).
    const q = quad();
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    buffer(gl, gl.ARRAY_BUFFER, q.pos);
    attrib(gl, 0, 3);
    buffer(gl, gl.ELEMENT_ARRAY_BUFFER, q.idx);
    const inst = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    attrib(gl, 2, 4, 32, 0, 1);
    attrib(gl, 3, 4, 32, 16, 1);
    gl.bindVertexArray(null);
    this.decal = { vao, inst, data: new Float32Array(8 * 1024), n: 0 };
  }

  private initShadow() {
    const gl = this.gl;
    this.shadowTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.shadowFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private initModels() {
    this.models = MODELS.map((m) =>
      m.parts.map((p) => {
        const r = p.r ?? [0, 0, 0];
        return {
          ...p,
          local: compose(new Float32Array(16), p.t[0], p.t[1], p.t[2], r[0], r[1], r[2], p.s[0], p.s[1], p.s[2]),
          rgb: p.c === "team" ? null : hexToRgb(p.c),
        };
      }),
    );
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [this.canvas, this.overlayCanvas]) {
      c.width = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
  }

  // ---------------------------------------------------------- per frame

  /** Interpolated ground position in tiles. */
  pos(u: Unit, alpha: number): { x: number; y: number } {
    return { x: (u.px + (u.x - u.px) * alpha) / FP, y: (u.py + (u.y - u.py) * alpha) / FP };
  }

  height(u: Unit): number {
    return MODELS[u.kind].fly ?? 0;
  }

  private pushInstance(mesh: MeshName, m: Mat4, rgb: [number, number, number], emit: number) {
    const g = this.meshes.get(mesh)!;
    if ((g.n + 1) * INST_FLOATS > g.data.length) {
      const bigger = new Float32Array(g.data.length * 2);
      bigger.set(g.data);
      g.data = bigger;
    }
    const o = g.n * INST_FLOATS;
    g.data.set(m, o);
    g.data[o + 16] = rgb[0];
    g.data[o + 17] = rgb[1];
    g.data[o + 18] = rgb[2];
    g.data[o + 19] = emit;
    g.n++;
  }

  private buildUnitInstances(alpha: number, now: number, cull: boolean) {
    for (const g of this.meshes.values()) g.n = 0;
    const t = now / 1000;
    const fp = this.cam.footprint();
    const minX = Math.min(...fp.map((p) => p.x)) - 3;
    const maxX = Math.max(...fp.map((p) => p.x)) + 3;
    const minY = Math.min(...fp.map((p) => p.y)) - 3;
    const maxY = Math.max(...fp.map((p) => p.y)) + 5;
    for (const u of this.world.units) {
      const p = this.pos(u, alpha);
      if (cull && (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY)) continue;
      const model = MODELS[u.kind];
      const parts = this.models[u.kind];
      const face = this.updateFacing(u);
      // Walk cycle driven by distance actually travelled.
      const last = this.lastPos.get(u.id) ?? [p.x, p.y];
      const moved = Math.hypot(p.x - last[0], p.y - last[1]);
      this.lastPos.set(u.id, [p.x, p.y]);
      const ph = (this.phase.get(u.id) ?? u.id * 0.7) + (moved / (u.radius / FP)) * 2.2;
      this.phase.set(u.id, ph);
      const moving = u.vx !== 0 || u.vy !== 0 ? 1 : 0;
      const fly = model.fly ?? 0;
      const bob = fly ? Math.sin(t * 2.2 + u.id) * 0.12 : moving * Math.abs(Math.sin(ph)) * 0.04 * model.height;
      const team = hexToRgb(teamColor(u.owner));
      compose(this.tmpU, p.x, fly + bob, p.y, -face, 0, 0, 1, 1, 1);
      for (const part of parts) {
        let L = part.local;
        if (part.anim) {
          const r = part.r ?? [0, 0, 0];
          let [tx, ty, tz] = part.t;
          let [sx, sy, sz] = part.s;
          let roll = r[2];
          const sw = Math.sin(ph) * moving;
          if (part.anim === "legA" || part.anim === "legB") {
            const s = part.anim === "legA" ? 1 : -1;
            tx += sw * s * 0.07 * model.height;
            ty += Math.max(0, sw * s) * 0.04 * model.height;
          } else if (part.anim === "flame") {
            const f = Math.sin(t * 19 + u.id * 1.7);
            sy *= 1 + 0.22 * f;
            sx *= 1 + 0.1 * Math.sin(t * 27 + u.id);
            sz *= 1 + 0.1 * Math.sin(t * 23 + u.id);
          } else if (part.anim === "wingR" || part.anim === "wingL") {
            const flap = 0.15 + 0.55 * Math.sin(t * 7.5 + u.id * 0.9);
            roll = part.anim === "wingR" ? -flap : flap;
          }
          L = compose(this.tmpL, tx, ty, tz, r[0], r[1], roll, sx, sy, sz);
        }
        multiply(this.tmpW, this.tmpU, L);
        this.pushInstance(part.mesh, this.tmpW, part.rgb ?? team, part.e ?? 0);
      }
    }
  }

  private updateFacing(u: Unit) {
    let f = this.facing.get(u.id);
    if (f === undefined) {
      // New units face the middle of the map.
      const m = this.world.map;
      f = Math.atan2((m.h * FP) / 2 - u.y, (m.w * FP) / 2 - u.x);
    }
    if (u.vx * u.vx + u.vy * u.vy > (FP / 300) ** 2) {
      const target = Math.atan2(u.vy, u.vx);
      let d = target - f;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      f += d * 0.25;
    }
    this.facing.set(u.id, f);
    return f;
  }

  private buildDecals(state: FrameState) {
    const d = this.decal;
    d.n = 0;
    const sel = state.selection;
    const push = (u: Unit, color: string, a: number) => {
      if (d.n * 8 + 8 > d.data.length) return;
      const p = this.pos(u, state.alpha);
      const [r, g, b] = hexToRgb(color);
      const fly = this.height(u);
      d.data.set([p.x, fly > 0 ? fly - 0.35 : 0.04, p.y, u.radius / FP + 0.08, r, g, b, a], d.n * 8);
      d.n++;
    };
    const selected = new Set(sel.ids);
    for (const id of sel.ids) {
      const u = this.world.byId.get(id);
      if (u) push(u, sel.isMine(u) ? SELECT_OWN : u.owner === 7 ? SELECT_NEUTRAL : SELECT_ENEMY, 1);
    }
    const hover = this.world.byId.get(state.hoverId);
    if (hover && !selected.has(hover.id)) push(hover, sel.isMine(hover) ? SELECT_OWN : hover.owner === 7 ? SELECT_NEUTRAL : SELECT_ENEMY, 0.45);
  }

  private updateLight() {
    // Fit an orthographic light frustum around what the camera sees.
    const fp = this.cam.footprint();
    const cx = fp.reduce((s, p) => s + p.x, 0) / 4;
    const cy = fp.reduce((s, p) => s + p.y, 0) / 4;
    const r = Math.max(...fp.map((p) => Math.hypot(p.x - cx, p.y - cy))) + 3;
    const eye = [cx + LIGHT_DIR[0] * 60, LIGHT_DIR[1] * 60, cy + LIGHT_DIR[2] * 60];
    const view = lookAt(new Float32Array(16), eye, [cx, 0, cy], [0, 1, 0]);
    const proj = ortho(new Float32Array(16), -r, r, -r, r, 1, 140);
    multiply(this.lightVP, proj, view);
  }

  private uploadInstances() {
    const gl = this.gl;
    for (const g of this.meshes.values()) {
      if (g.n === 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, g.inst);
      gl.bufferData(gl.ARRAY_BUFFER, g.data.subarray(0, g.n * INST_FLOATS), gl.DYNAMIC_DRAW);
    }
  }

  /** Draw every mesh's instances with the currently bound program (data must already be uploaded). */
  private drawInstances() {
    const gl = this.gl;
    for (const g of this.meshes.values()) {
      if (g.n === 0) continue;
      gl.bindVertexArray(g.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, g.count, gl.UNSIGNED_SHORT, 0, g.n);
    }
    gl.bindVertexArray(null);
  }

  draw(state: FrameState) {
    const gl = this.gl;
    this.cam.update();
    this.buildUnitInstances(state.alpha, state.now, true);
    this.updateLight();

    // Upload instance data once; the shadow pass and the main pass both use it.
    this.uploadInstances();

    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // 1) Shadow map.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2, 4);
    gl.useProgram(this.progShadowT);
    gl.uniformMatrix4fv(this.uST.u_lightVP, false, this.lightVP);
    gl.bindVertexArray(this.terrainVao);
    gl.drawElements(gl.TRIANGLES, this.terrainCount, gl.UNSIGNED_INT, 0);
    gl.useProgram(this.progShadowU);
    gl.uniformMatrix4fv(this.uSU.u_lightVP, false, this.lightVP);
    this.drawInstances();
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // 2) Main pass.
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.02, 0.025, 0.03, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);

    gl.useProgram(this.progTerrain);
    this.setCommon(this.uT);
    gl.uniform2f(this.uT.u_mapSize, this.world.map.w, this.world.map.h);
    gl.bindVertexArray(this.terrainVao);
    gl.drawElements(gl.TRIANGLES, this.terrainCount, gl.UNSIGNED_INT, 0);

    // Selection circles go on the ground before the units so bodies cover them.
    this.buildDecals(state);
    if (this.decal.n > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(this.progDecal);
      gl.uniformMatrix4fv(this.uD.u_vp, false, this.cam.viewProj);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.decal.inst);
      gl.bufferData(gl.ARRAY_BUFFER, this.decal.data.subarray(0, this.decal.n * 8), gl.DYNAMIC_DRAW);
      gl.bindVertexArray(this.decal.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0, this.decal.n);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    gl.useProgram(this.progUnit);
    this.setCommon(this.uU);
    gl.uniform3fv(this.uU.u_eye, this.cam.eye);
    this.drawInstances();

    this.drawOverlay(state);
  }

  private setCommon(u: Record<string, WebGLUniformLocation>) {
    const gl = this.gl;
    gl.uniformMatrix4fv(u.u_vp, false, this.cam.viewProj);
    gl.uniformMatrix4fv(u.u_lightVP, false, this.lightVP);
    gl.uniform3fv(u.u_lightDir, LIGHT_DIR);
    gl.uniform1i(u.u_shadow, 0);
    gl.uniform1f(u.u_shadowOn, 1);
    gl.uniform1f(u.u_shadowTexel, 1 / SHADOW_SIZE);
  }

  // ---------------------------------------------------------- overlay

  private drawOverlay(state: FrameState) {
    const ctx = this.overlay;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cam.w, this.cam.h);
    if (state.showWaypoints) this.drawWaypoints(state);
    this.drawMarkers(state.now);
    if (state.dragBox) {
      const b = state.dragBox;
      const x = Math.min(b.x0, b.x1);
      const y = Math.min(b.y0, b.y1);
      ctx.fillStyle = "rgba(60,255,82,0.06)";
      ctx.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeStyle = SELECT_OWN;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    if (state.cursor) this.drawCursor(state.cursor);
  }

  private drawWaypoints(state: FrameState) {
    const ctx = this.overlay;
    ctx.lineWidth = 1.5;
    for (const u of state.selection.units()) {
      if (!state.selection.isMine(u) || u.orders.length === 0) continue;
      const p = this.pos(u, state.alpha);
      const h = this.height(u);
      let last = this.cam.project(p.x, h + 0.05, p.y);
      for (const o of u.orders) {
        const color = o.mode === MODE_ATTACK ? "rgba(255,70,60,0.8)" : o.mode === MODE_PATROL ? "rgba(255,220,60,0.8)" : "rgba(60,255,90,0.8)";
        const next = this.cam.project(o.x / FP, h + 0.05, o.y / FP);
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(next.x, next.y);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(next.x, next.y, 3, 0, Math.PI * 2);
        ctx.fill();
        last = next;
      }
    }
  }

  /** SC2-style click feedback: four chevrons converging on the target, drawn on the ground in perspective. */
  private drawMarkers(now: number) {
    const ctx = this.overlay;
    const DUR = 450;
    this.markers = this.markers.filter((m) => now - m.t0 < DUR);
    for (const m of this.markers) {
      const t = (now - m.t0) / DUR;
      const d = 0.75 * (1 - t) + 0.22;
      ctx.strokeStyle = m.color;
      ctx.globalAlpha = 1 - t * t;
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const cx = m.x + Math.cos(a) * d;
        const cy = m.y + Math.sin(a) * d;
        const w = 0.22;
        const p1 = this.cam.project(cx + Math.cos(a + 2.4) * w, 0.05, cy + Math.sin(a + 2.4) * w);
        const p2 = this.cam.project(cx, 0.05, cy);
        const p3 = this.cam.project(cx + Math.cos(a - 2.4) * w, 0.05, cy + Math.sin(a - 2.4) * w);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawCursor(c: NonNullable<FrameState["cursor"]>) {
    const ctx = this.overlay;
    if (c.targeting) {
      const color = c.targeting === "attack" ? SELECT_ENEMY : c.targeting === "patrol" ? SELECT_NEUTRAL : SELECT_OWN;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        ctx.moveTo(c.x + dx * 6, c.y + dy * 6);
        ctx.lineTo(c.x + dx * 16, c.y + dy * 16);
      }
      ctx.stroke();
      return;
    }
    ctx.fillStyle = "#c8ffb0";
    ctx.strokeStyle = "#0d2a10";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(c.x + 4, c.y + 18);
    ctx.lineTo(c.x + 8.5, c.y + 12);
    ctx.lineTo(c.x + 16, c.y + 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // ---------------------------------------------------------- picking

  /** Screen-space shape of a unit: centre at mid-height and a radius in px. */
  private screenShape(u: Unit, alpha: number) {
    const p = this.pos(u, alpha);
    const m = MODELS[u.kind];
    const base = this.height(u);
    const r = u.radius / FP;
    const top = this.cam.project(p.x, base + m.height * 0.9, p.y);
    const bottom = this.cam.project(p.x, base, p.y);
    const side = this.cam.project(p.x + r, base, p.y);
    const rpx = Math.abs(side.x - bottom.x);
    return { top, bottom, rpx };
  }

  /** Topmost unit under a screen point (air first, then nearest to the camera). */
  pick(sx: number, sy: number, alpha: number): Unit | null {
    let best: Unit | null = null;
    let bestScore = Infinity;
    for (const u of this.world.units) {
      const { top, bottom, rpx } = this.screenShape(u, alpha);
      // Distance from the point to the segment bottom→top (a capsule around the model).
      const vx = top.x - bottom.x;
      const vy = top.y - bottom.y;
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((sx - bottom.x) * vx + (sy - bottom.y) * vy) / len2));
      const d = Math.hypot(sx - (bottom.x + vx * t), sy - (bottom.y + vy * t));
      if (d > rpx * 1.1 + 2) continue;
      const score = bottom.depth - (u.air ? 1000 : 0);
      if (score < bestScore) {
        best = u;
        bestScore = score;
      }
    }
    return best;
  }

  /** Units whose on-screen body touches a screen rectangle. */
  pickBox(x0: number, y0: number, x1: number, y1: number, alpha: number): Unit[] {
    const ax = Math.min(x0, x1);
    const bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1);
    const by = Math.max(y0, y1);
    return this.world.units.filter((u) => {
      const { top, bottom, rpx } = this.screenShape(u, alpha);
      const cx = (top.x + bottom.x) / 2;
      const cy = (top.y + bottom.y) / 2;
      const pad = rpx * 0.6;
      return cx + pad >= ax && cx - pad <= bx && cy + pad >= ay && cy - pad <= by;
    });
  }

  onScreen(u: Unit, alpha: number) {
    const { bottom } = this.screenShape(u, alpha);
    return bottom.x >= 0 && bottom.x <= this.cam.w && bottom.y >= 0 && bottom.y <= this.cam.h - this.cam.consoleH;
  }

  // ------------------------------------------------------------ icons

  private iconCache = new Map<string, string>();

  /** Render a unit model to a small transparent PNG (portraits and wireframe icons). */
  unitIcon(kind: number, owner: number, size: number): string {
    const key = `${kind}:${owner}:${size}`;
    const hit = this.iconCache.get(key);
    if (hit) return hit;
    const gl = this.gl;
    const px = Math.round(size * this.dpr);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, px, px);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, px, px);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.viewport(0, 0, px, px);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    // One model, three-quarter view, no shadows.
    for (const g of this.meshes.values()) g.n = 0;
    const model = MODELS[kind];
    const team = hexToRgb(teamColor(owner));
    const h = model.height;
    const s = 1 / Math.max(h, (MODEL_EXTENT[kind] ?? 1) * 0.8);
    compose(this.tmpU, 0, -h * 0.5 * s, 0, -0.75, 0, 0, s, s, s);
    for (const part of this.models[kind]) {
      multiply(this.tmpW, this.tmpU, part.local);
      this.pushInstance(part.mesh, this.tmpW, part.rgb ?? team, part.e ?? 0);
    }
    const view = lookAt(new Float32Array(16), [0.4, 0.55, 2.4], [0, 0, 0], [0, 1, 0]);
    const proj = perspective(new Float32Array(16), 0.62, 1, 0.1, 20);
    const vp = multiply(new Float32Array(16), proj, view);
    gl.useProgram(this.progUnit);
    gl.uniformMatrix4fv(this.uU.u_vp, false, vp);
    gl.uniformMatrix4fv(this.uU.u_lightVP, false, identity());
    gl.uniform3fv(this.uU.u_lightDir, [0.3, 0.75, 0.6]);
    gl.uniform1f(this.uU.u_shadowOn, 0);
    gl.uniform3fv(this.uU.u_eye, [0.4, 0.55, 2.4]);
    this.uploadInstances();
    this.drawInstances();

    const pixels = new Uint8Array(px * px * 4);
    gl.readPixels(0, 0, px, px, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    gl.deleteRenderbuffer(depth);

    const c = document.createElement("canvas");
    c.width = px;
    c.height = px;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(px, px);
    for (let y = 0; y < px; y++) img.data.set(pixels.subarray((px - 1 - y) * px * 4, (px - y) * px * 4), y * px * 4);
    ctx.putImageData(img, 0, 0);
    const url = c.toDataURL();
    this.iconCache.set(key, url);
    return url;
  }
}

/** Rough horizontal size of each model (tiles), so icons frame wide models too. */
const MODEL_EXTENT: Record<number, number> = { 0: 0.8, 1: 1.0, 2: 1.2, 3: 2.6, 4: 1.4 };
