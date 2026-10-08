import * as THREE from "three";
import type { WeaponFx } from "../../sim/units.ts";

/**
 * Visual effects: two particle pools (additive for fire/light, alpha-blended
 * for smoke/water/leaves) and a batch of camera-facing beams. Everything is
 * simulated on the CPU in typed arrays and uploaded once per frame.
 */

const VS = /* glsl */ `
attribute float size;
attribute vec4 pcolor;
uniform float scale;
varying vec4 vColor;
void main() {
  vColor = pcolor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = max(1.0, size * scale / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FS = /* glsl */ `
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.35, 1.0, d);
  if (a <= 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

class Pool {
  readonly n: number;
  count = 0;
  pos: Float32Array;
  vel: Float32Array;
  col: Float32Array; // start rgba
  col2: Float32Array; // end rgb
  life: Float32Array;
  max: Float32Array;
  size: Float32Array;
  size2: Float32Array;
  grav: Float32Array;
  drag: Float32Array;
  geo = new THREE.BufferGeometry();
  outPos: Float32Array;
  outCol: Float32Array;
  outSize: Float32Array;
  points: THREE.Points;
  mat: THREE.ShaderMaterial;

  constructor(n: number, additive: boolean) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.col2 = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.size = new Float32Array(n);
    this.size2 = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.outPos = new Float32Array(n * 3);
    this.outCol = new Float32Array(n * 4);
    this.outSize = new Float32Array(n);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.outPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("pcolor", new THREE.BufferAttribute(this.outCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("size", new THREE.BufferAttribute(this.outSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      uniforms: { scale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 20 : 10;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, size2: number, c: number[], c2: number[], grav = 0, drag = 0) {
    if (this.count >= this.n) return;
    const i = this.count++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.col.set([c[0], c[1], c[2], c[3] ?? 1], i * 4);
    this.col2.set([c2[0], c2[1], c2[2]], i * 3);
    this.life[i] = 0;
    this.max[i] = life;
    this.size[i] = size;
    this.size2[i] = size2;
    this.grav[i] = grav;
    this.drag[i] = drag;
  }

  update(dt: number) {
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.max[i]) {
        // Swap-remove.
        n--;
        this.copy(n, i);
        i--;
        continue;
      }
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.count = n;
    for (let i = 0; i < n; i++) {
      const t = this.life[i] / this.max[i];
      this.outPos[i * 3] = this.pos[i * 3];
      this.outPos[i * 3 + 1] = this.pos[i * 3 + 1];
      this.outPos[i * 3 + 2] = this.pos[i * 3 + 2];
      this.outCol[i * 4] = this.col[i * 4] + (this.col2[i * 3] - this.col[i * 4]) * t;
      this.outCol[i * 4 + 1] = this.col[i * 4 + 1] + (this.col2[i * 3 + 1] - this.col[i * 4 + 1]) * t;
      this.outCol[i * 4 + 2] = this.col[i * 4 + 2] + (this.col2[i * 3 + 2] - this.col[i * 4 + 2]) * t;
      // Fade in quickly, fade out slowly.
      this.outCol[i * 4 + 3] = this.col[i * 4 + 3] * Math.min(1, t * 8) * (1 - t * t);
      this.outSize[i] = this.size[i] + (this.size2[i] - this.size[i]) * t;
    }
    this.geo.setDrawRange(0, n);
    for (const a of ["position", "pcolor", "size"]) (this.geo.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
  }

  private copy(from: number, to: number) {
    if (from === to) return;
    this.pos.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.vel.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.col.copyWithin(to * 4, from * 4, from * 4 + 4);
    this.col2.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.life[to] = this.life[from];
    this.max[to] = this.max[from];
    this.size[to] = this.size[from];
    this.size2[to] = this.size2[from];
    this.grav[to] = this.grav[from];
    this.drag[to] = this.drag[from];
  }
}

const BEAM_VS = /* glsl */ `
attribute vec4 bcolor;
attribute float side;
varying vec4 vColor;
varying float vSide;
void main() {
  vColor = bcolor;
  vSide = side;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BEAM_FS = /* glsl */ `
varying vec4 vColor;
varying float vSide;
void main() {
  float a = 1.0 - abs(vSide);
  a = a * a * (3.0 - 2.0 * a);
  vec3 core = mix(vColor.rgb, vec3(1.0), smoothstep(0.6, 1.0, a) * 0.6);
  gl_FragColor = vec4(core, vColor.a * a);
}`;

interface Beam {
  a: THREE.Vector3;
  b: THREE.Vector3;
  width: number;
  color: number[];
  t: number;
  life: number;
  jag: number; // lightning zig-zag amount
}

class Beams {
  private list: Beam[] = [];
  private max = 512;
  private pos: Float32Array;
  private col: Float32Array;
  private side: Float32Array;
  geo = new THREE.BufferGeometry();
  mesh: THREE.Mesh;
  constructor() {
    const v = this.max * 8 * 4; // up to 8 segments per beam, 4 verts each
    this.pos = new Float32Array(v * 3);
    this.col = new Float32Array(v * 4);
    this.side = new Float32Array(v);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("bcolor", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("side", new THREE.BufferAttribute(this.side, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(this.max * 8 * 6);
    for (let q = 0; q < this.max * 8; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.ShaderMaterial({ vertexShader: BEAM_VS, fragmentShader: BEAM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 25;
  }
  add(a: THREE.Vector3, b: THREE.Vector3, width: number, color: number[], life: number, jag = 0) {
    if (this.list.length < this.max) this.list.push({ a: a.clone(), b: b.clone(), width, color, t: 0, life, jag });
  }
  update(dt: number, eye: THREE.Vector3) {
    this.list = this.list.filter((bm) => (bm.t += dt) < bm.life);
    let q = 0;
    const dir = new THREE.Vector3();
    const view = new THREE.Vector3();
    const sideV = new THREE.Vector3();
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    for (const bm of this.list) {
      const fade = 1 - bm.t / bm.life;
      const segs = bm.jag > 0 ? 6 : 1;
      let prev = bm.a.clone();
      for (let s = 1; s <= segs; s++) {
        const t = s / segs;
        p1.lerpVectors(bm.a, bm.b, t);
        if (bm.jag > 0 && s < segs) p1.add(new THREE.Vector3((Math.random() - 0.5) * bm.jag, (Math.random() - 0.5) * bm.jag, (Math.random() - 0.5) * bm.jag));
        p0.copy(prev);
        dir.subVectors(p1, p0);
        view.subVectors(eye, p0);
        sideV.crossVectors(dir, view).normalize().multiplyScalar(bm.width * (0.6 + 0.4 * fade));
        const base = q * 4;
        this.pos.set([p0.x - sideV.x, p0.y - sideV.y, p0.z - sideV.z, p0.x + sideV.x, p0.y + sideV.y, p0.z + sideV.z, p1.x - sideV.x, p1.y - sideV.y, p1.z - sideV.z, p1.x + sideV.x, p1.y + sideV.y, p1.z + sideV.z], base * 3);
        for (let k = 0; k < 4; k++) {
          this.col.set([bm.color[0], bm.color[1], bm.color[2], (bm.color[3] ?? 1) * fade], (base + k) * 4);
          this.side[base + k] = k % 2 === 0 ? -1 : 1;
        }
        q++;
        prev = p1.clone();
      }
    }
    this.geo.setDrawRange(0, q * 6);
    for (const a of ["position", "bcolor", "side"]) (this.geo.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
  }
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

const FIRE = [1.0, 0.62, 0.18, 1];
const FIRE_END = [0.6, 0.1, 0.02];
const WATER = [0.45, 0.72, 1.0, 0.9];
const LEAF = [0.35, 0.8, 0.3, 1];
const SPARK = [1.0, 0.95, 0.45, 1];

export class Effects {
  readonly glow = new Pool(9000, true);
  readonly soft = new Pool(7000, false);
  readonly beams = new Beams();
  readonly group = new THREE.Group();

  constructor() {
    this.group.add(this.soft.points, this.glow.points, this.beams.mesh);
  }

  setScale(px: number) {
    this.glow.mat.uniforms.scale.value = px;
    this.soft.mat.uniforms.scale.value = px;
  }

  update(dt: number, eye: THREE.Vector3) {
    this.glow.update(dt);
    this.soft.update(dt);
    this.beams.update(dt, eye);
  }

  // ------------------------------------------------------------ emitters

  /** A living tail flame (call every frame). */
  flame(p: THREE.Vector3, size: number, dt: number) {
    const n = Math.random() < dt * 40 ? 1 : 0;
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, size * 1.6, size * 1.6, [1, 0.55, 0.15, 0.55], [1, 0.4, 0.1]);
    for (let i = 0; i < n + (Math.random() < dt * 25 ? 1 : 0); i++)
      this.glow.emit(p.x + rnd(-0.03, 0.03), p.y, p.z + rnd(-0.03, 0.03), rnd(-0.1, 0.1), rnd(0.5, 0.9), rnd(-0.1, 0.1), rnd(0.25, 0.4), size * 0.9, size * 0.2, FIRE, FIRE_END, -0.5, 1);
  }

  /** Short-lived sprite (one frame): carried minerals, construction lights, etc. */
  sprite(p: THREE.Vector3, size: number, c: number[], additive = true) {
    (additive ? this.glow : this.soft).emit(p.x, p.y, p.z, 0, 0, 0, 0.034, size, size, c, c);
  }

  /** Trail behind a projectile, by move type. */
  trail(fx: WeaponFx, p: THREE.Vector3, dt: number) {
    switch (fx) {
      case "ember":
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.35, 0.35, [1, 0.6, 0.2, 0.9], [1, 0.4, 0.1]);
        if (Math.random() < dt * 60) this.glow.emit(p.x, p.y, p.z, rnd(-0.3, 0.3), rnd(0, 0.4), rnd(-0.3, 0.3), 0.25, 0.22, 0.05, FIRE, FIRE_END);
        break;
      case "flame":
        for (let i = 0; i < 3; i++) this.glow.emit(p.x + rnd(-0.1, 0.1), p.y + rnd(-0.1, 0.1), p.z + rnd(-0.1, 0.1), rnd(-0.5, 0.5), rnd(0, 0.6), rnd(-0.5, 0.5), rnd(0.25, 0.45), rnd(0.35, 0.6), 0.1, FIRE, FIRE_END);
        break;
      case "water":
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.24, 0.24, [0.6, 0.85, 1, 0.8], [0.6, 0.85, 1]);
        if (Math.random() < dt * 50) this.soft.emit(p.x, p.y, p.z, rnd(-0.2, 0.2), 0, rnd(-0.2, 0.2), 0.3, 0.12, 0.04, WATER, [0.8, 0.9, 1], 4);
        break;
      case "bubble":
        this.soft.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.3, 0.3, [0.75, 0.9, 1, 0.55], [0.75, 0.9, 1]);
        if (Math.random() < dt * 30) this.soft.emit(p.x, p.y, p.z, rnd(-0.3, 0.3), rnd(0, 0.3), rnd(-0.3, 0.3), 0.5, 0.14, 0.2, [0.8, 0.92, 1, 0.5], [0.9, 0.95, 1]);
        break;
      case "hydro":
        for (let i = 0; i < 2; i++) this.soft.emit(p.x, p.y, p.z, rnd(-0.4, 0.4), rnd(-0.2, 0.3), rnd(-0.4, 0.4), 0.35, 0.45, 0.15, [0.5, 0.75, 1, 0.85], [0.85, 0.95, 1], 5);
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.6, 0.6, [0.4, 0.7, 1, 0.6], [0.4, 0.7, 1]);
        break;
      case "leaf":
        this.soft.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.22, 0.22, LEAF, LEAF);
        if (Math.random() < dt * 30) this.soft.emit(p.x, p.y, p.z, rnd(-0.4, 0.4), rnd(-0.1, 0.3), rnd(-0.4, 0.4), 0.4, 0.1, 0.06, [0.5, 0.9, 0.4, 1], [0.3, 0.6, 0.2], 1.5);
        break;
      case "bolt":
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.45, 0.45, [1, 1, 0.6, 1], SPARK);
        if (Math.random() < dt * 60) this.glow.emit(p.x, p.y, p.z, rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), 0.15, 0.12, 0.02, SPARK, [1, 0.9, 0.3]);
        break;
      default:
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.25, 0.25, SPARK, SPARK);
    }
  }

  /** Impact at a point, scaled by splash radius (tiles). */
  impact(fx: WeaponFx, p: THREE.Vector3, splash: number) {
    const s = Math.max(1, splash * 2);
    switch (fx) {
      case "ember":
      case "flame":
      case "bite":
        this.burst(p, fx === "bite" ? 6 : Math.round(10 * s), FIRE, FIRE_END, 1.4 * Math.sqrt(s), 0.32, fx === "bite" ? 0.25 : 0.35);
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.18, 0.9 * s, 1.4 * s, [1, 0.6, 0.25, 0.7], [1, 0.3, 0.1]);
        if (fx === "flame") this.smoke(p, 3, 0.6);
        break;
      case "water":
      case "bubble":
      case "hydro": {
        const n = fx === "hydro" ? 30 : 9;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const v = rnd(0.5, 1.6) * Math.sqrt(s);
          this.soft.emit(p.x, p.y, p.z, Math.cos(a) * v, rnd(1, 2.6), Math.sin(a) * v, rnd(0.35, 0.6), rnd(0.1, 0.22), 0.05, [0.55, 0.8, 1, 0.9], [0.85, 0.95, 1], 7);
        }
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.2, 0.5 * s, 1.2 * s, [0.5, 0.75, 1, 0.5], [0.6, 0.85, 1]);
        break;
      }
      case "leaf":
      case "vine":
        for (let i = 0; i < 8; i++) this.soft.emit(p.x, p.y, p.z, rnd(-1.2, 1.2), rnd(0.2, 1.4), rnd(-1.2, 1.2), rnd(0.4, 0.7), rnd(0.08, 0.14), 0.05, [0.45, 0.85, 0.35, 1], [0.25, 0.55, 0.2], 2.5, 1.5);
        break;
      case "solar":
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.3, 1.0 * s, 2.2 * s, [1, 1, 0.7, 0.9], [0.6, 1, 0.4]);
        this.burst(p, 14, [1, 1, 0.6, 1], [0.5, 1, 0.3], 2.2, 0.25, 0.45);
        break;
      case "spark":
      case "bolt":
        this.burst(p, 10, SPARK, [1, 0.85, 0.2], 2.8, 0.12, 0.25);
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.12, 0.6, 0.9, [1, 1, 0.7, 0.8], [1, 0.9, 0.4]);
        break;
    }
  }

  burst(p: THREE.Vector3, n: number, c: number[], c2: number[], speed: number, size: number, life: number) {
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const v = speed * rnd(0.4, 1);
      this.glow.emit(p.x, p.y, p.z, Math.cos(a) * r * v, Math.abs(u) * v, Math.sin(a) * r * v, life * rnd(0.6, 1.2), size, size * 0.2, c, c2, 1.5, 2);
    }
  }

  smoke(p: THREE.Vector3, n: number, size: number) {
    for (let i = 0; i < n; i++)
      this.soft.emit(p.x + rnd(-0.3, 0.3), p.y, p.z + rnd(-0.3, 0.3), rnd(-0.2, 0.2), rnd(0.3, 0.8), rnd(-0.2, 0.2), rnd(0.8, 1.6), size * 0.6, size * 1.8, [0.35, 0.33, 0.3, 0.55], [0.5, 0.5, 0.5], -0.1, 0.8);
  }

  /** Muzzle beam for instant moves (Solar Beam, Vine Whip, Thunderbolt…). */
  beam(fx: WeaponFx, a: THREE.Vector3, b: THREE.Vector3) {
    if (fx === "solar") {
      this.beams.add(a, b, 0.32, [0.9, 1, 0.5, 1], 0.35);
      this.beams.add(a, b, 0.12, [1, 1, 1, 1], 0.3);
    } else if (fx === "vine") this.beams.add(a, b, 0.06, [0.35, 0.8, 0.3, 1], 0.18);
    else if (fx === "spark" || fx === "bolt") this.beams.add(a, b, 0.07, [1, 0.95, 0.5, 1], 0.12, 0.35);
  }

  /** Pokémon fainting: red recall beam, white sparkles. */
  faint(p: THREE.Vector3, size: number) {
    this.beams.add(p, new THREE.Vector3(p.x, p.y + 6, p.z), 0.18 * size + 0.1, [1, 0.25, 0.2, 0.9], 0.45);
    this.burst(p, 12, [1, 1, 1, 1], [1, 0.4, 0.4], 1.6, 0.18, 0.5);
    this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.3, size * 1.4, size * 2.4, [1, 0.5, 0.45, 0.8], [1, 0.2, 0.2]);
  }

  /** Structure destroyed: fireball, smoke column, debris. */
  explode(p: THREE.Vector3, size: number) {
    this.burst(p, Math.round(18 * size), FIRE, FIRE_END, 3 * Math.sqrt(size), 0.6, 0.7);
    this.glow.emit(p.x, p.y + 0.5, p.z, 0, 0, 0, 0.5, size * 2, size * 4, [1, 0.7, 0.3, 0.9], [1, 0.3, 0.05]);
    this.smoke(p, Math.round(8 * size), 1.2 * Math.sqrt(size));
    for (let i = 0; i < 10 * size; i++)
      this.soft.emit(p.x, p.y + 0.5, p.z, rnd(-3, 3), rnd(2, 5), rnd(-3, 3), rnd(0.8, 1.4), 0.18, 0.18, [0.25, 0.23, 0.2, 1], [0.2, 0.2, 0.2], 9);
  }

  /** Evolution: rising sparkles while morphing (per frame) and a white flash when done. */
  evolving(p: THREE.Vector3, height: number, dt: number) {
    if (Math.random() < dt * 12)
      this.glow.emit(p.x + rnd(-0.5, 0.5), p.y + rnd(0, height), p.z + rnd(-0.5, 0.5), 0, rnd(0.6, 1.2), 0, rnd(0.5, 0.9), 0.15, 0.02, [1, 1, 1, 1], [0.6, 0.85, 1]);
  }

  evolved(p: THREE.Vector3, height: number) {
    this.glow.emit(p.x, p.y + height * 0.5, p.z, 0, 0, 0, 0.45, height * 1.2, height * 2.6, [1, 1, 1, 0.6], [0.7, 0.9, 1]);
    this.burst(new THREE.Vector3(p.x, p.y + height * 0.5, p.z), 16, [1, 1, 1, 0.9], [0.6, 0.85, 1], 2.4, 0.16, 0.7);
  }

  dust(p: THREE.Vector3, size: number) {
    this.soft.emit(p.x + rnd(-size, size), p.y + 0.1, p.z + rnd(-size, size), rnd(-0.2, 0.2), rnd(0.2, 0.5), rnd(-0.2, 0.2), rnd(0.8, 1.3), 0.35, 0.8, [0.55, 0.5, 0.42, 0.22], [0.6, 0.56, 0.48], 0, 0.5);
  }

  /** Warp-in sparkle when a structure finishes or a unit is trained. */
  sparkle(p: THREE.Vector3, size: number, c = [0.6, 0.9, 1, 1]) {
    this.burst(p, Math.round(10 * size), c, [1, 1, 1], 1.5 * size, 0.18, 0.5);
  }
}
