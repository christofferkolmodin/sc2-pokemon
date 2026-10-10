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
  /** Seconds alive; starts negative for a delayed beam. */
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
  add(a: THREE.Vector3, b: THREE.Vector3, width: number, color: number[], life: number, jag = 0, delay = 0) {
    if (this.list.length < this.max) this.list.push({ a: a.clone(), b: b.clone(), width, color, t: -delay, life, jag });
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
      if (bm.t < 0) continue;
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


const WHIP_FS = /* glsl */ `
varying vec4 vColor;
varying float vSide;
void main() {
  // Shaded like a round stem: lit centre, dark edges, a thin highlight.
  float e = abs(vSide);
  if (e > 0.98) discard;
  float shade = sqrt(1.0 - e * e);
  vec3 c = vColor.rgb * (0.35 + 0.75 * shade) + vec3(0.25, 0.35, 0.2) * smoothstep(0.85, 1.0, shade) * 0.5;
  gl_FragColor = vec4(c, 1.0);
}`;

interface Whip {
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** Sideways direction the vine curls toward. */
  curl: THREE.Vector3;
  width: number;
  color: number[];
  t: number;
  life: number;
}

/**
 * Vine Whip: a solid, tapered vine that lashes out from the muzzle in a curve,
 * snaps straight onto the target and pulls back. Normal blending, so it reads
 * as a plant rather than a laser.
 */
class Whips {
  private list: Whip[] = [];
  private max = 128;
  private segs = 14;
  private pos: Float32Array;
  private col: Float32Array;
  private side: Float32Array;
  geo = new THREE.BufferGeometry();
  mesh: THREE.Mesh;
  constructor() {
    const v = this.max * this.segs * 4;
    this.pos = new Float32Array(v * 3);
    this.col = new Float32Array(v * 4);
    this.side = new Float32Array(v);
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("bcolor", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("side", new THREE.BufferAttribute(this.side, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(this.max * this.segs * 6);
    for (let q = 0; q < this.max * this.segs; q++) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(this.geo, new THREE.ShaderMaterial({ vertexShader: BEAM_VS, fragmentShader: WHIP_FS, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 24;
  }
  add(a: THREE.Vector3, b: THREE.Vector3, width: number, color: number[], life: number) {
    if (this.list.length >= this.max) return;
    const dir = new THREE.Vector3().subVectors(b, a);
    const curl = new THREE.Vector3(-dir.z, 0, dir.x).normalize().multiplyScalar(Math.random() < 0.5 ? -1 : 1);
    this.list.push({ a: a.clone(), b: b.clone(), curl, width, color, t: 0, life });
  }
  /** Point on the vine at u (0 = root, 1 = tip) for animation phase `ph`. */
  private point(w: Whip, u: number, ph: number, out: THREE.Vector3) {
    // Reach out (0-0.35), crack (0.35-0.5), pull back (0.5-1).
    const reach = ph < 0.35 ? 1 - Math.pow(1 - ph / 0.35, 3) : ph < 0.5 ? 1 : 1 - (ph - 0.5) / 0.5;
    const len = w.a.distanceTo(w.b);
    // The curl is strongest while extending and relaxes into a straight snap.
    const bend = (ph < 0.35 ? 1 - ph / 0.35 : 0) * 0.35 + 0.08;
    const s = u * reach;
    out.lerpVectors(w.a, w.b, s);
    const arc = Math.sin(s * Math.PI);
    out.addScaledVector(w.curl, arc * len * bend * Math.sin(u * Math.PI * 1.5 + ph * 6));
    out.y += arc * len * (0.18 + bend * 0.4);
  }
  update(dt: number, eye: THREE.Vector3) {
    this.list = this.list.filter((w) => (w.t += dt) < w.life);
    let q = 0;
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const view = new THREE.Vector3();
    const sideV = new THREE.Vector3();
    for (const w of this.list) {
      const ph = w.t / w.life;
      this.point(w, 0, ph, p0);
      for (let i = 1; i <= this.segs; i++) {
        const u = i / this.segs;
        this.point(w, u, ph, p1);
        dir.subVectors(p1, p0);
        view.subVectors(eye, p0);
        const taper0 = w.width * (1 - ((i - 1) / this.segs) * 0.7);
        const taper1 = w.width * (1 - u * 0.7);
        sideV.crossVectors(dir, view).normalize();
        const base = q * 4;
        this.pos.set(
          [
            p0.x - sideV.x * taper0, p0.y - sideV.y * taper0, p0.z - sideV.z * taper0,
            p0.x + sideV.x * taper0, p0.y + sideV.y * taper0, p0.z + sideV.z * taper0,
            p1.x - sideV.x * taper1, p1.y - sideV.y * taper1, p1.z - sideV.z * taper1,
            p1.x + sideV.x * taper1, p1.y + sideV.y * taper1, p1.z + sideV.z * taper1,
          ],
          base * 3,
        );
        // Slight colour banding along the stem.
        const band = i % 3 === 0 ? 0.82 : 1;
        for (let k = 0; k < 4; k++) {
          this.col.set([w.color[0] * band, w.color[1] * band, w.color[2] * band, 1], (base + k) * 4);
          this.side[base + k] = k % 2 === 0 ? -1 : 1;
        }
        q++;
        p0.copy(p1);
      }
    }
    this.geo.setDrawRange(0, q * 6);
    for (const a of ["position", "bcolor", "side"]) (this.geo.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
  }
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** A stream from a mouth or cannon to the target: Flamethrower, Water Gun, Hydro Pump, Bubble Beam. */
interface Jet {
  fx: WeaponFx;
  a: THREE.Vector3;
  b: THREE.Vector3;
  t: number;
  /** How long the stream keeps pouring. */
  life: number;
  /** Seconds for a particle to reach the target. */
  travel: number;
}

const FIRE = [1.0, 0.62, 0.18, 1];
const FIRE_END = [0.6, 0.1, 0.02];
const WATER = [0.45, 0.72, 1.0, 0.9];
const LEAF = [0.35, 0.8, 0.3, 1];
const SPARK = [1.0, 0.95, 0.45, 1];

export class Effects {
  readonly glow = new Pool(9000, true);
  readonly soft = new Pool(7000, false);
  readonly beams = new Beams();
  readonly whips = new Whips();
  readonly group = new THREE.Group();
  private jets: Jet[] = [];

  constructor() {
    this.group.add(this.soft.points, this.glow.points, this.beams.mesh, this.whips.mesh);
  }

  setScale(px: number) {
    this.glow.mat.uniforms.scale.value = px;
    this.soft.mat.uniforms.scale.value = px;
  }

  update(dt: number, eye: THREE.Vector3) {
    this.glow.update(dt);
    this.soft.update(dt);
    this.beams.update(dt, eye);
    this.whips.update(dt, eye);
    this.jets = this.jets.filter((j) => (j.t += dt) < j.life);
    for (const j of this.jets) this.pour(j, dt);
  }

  /** Start a stream from `a` to `b`; particles take `travel` seconds to arrive. */
  jet(fx: WeaponFx, a: THREE.Vector3, b: THREE.Vector3, travel: number) {
    if (this.jets.length > 200) return;
    const life = fx === "flame" ? 0.42 : fx === "hydro" ? 0.38 : fx === "bubble" ? 0.3 : 0.16;
    this.jets.push({ fx, a: a.clone(), b: b.clone(), t: 0, life, travel: Math.max(0.12, Math.min(0.6, travel)) });
  }

  private pour(j: Jet, dt: number) {
    const dx = (j.b.x - j.a.x) / j.travel;
    const dy = (j.b.y - j.a.y) / j.travel;
    const dz = (j.b.z - j.a.z) / j.travel;
    const speed = Math.hypot(dx, dy, dz);
    // Each particle starts a random fraction of a frame along, so the stream is smooth instead of beaded.
    const a = new THREE.Vector3();
    const from = () => a.set(j.a.x, j.a.y, j.a.z).addScaledVector(new THREE.Vector3(dx, dy, dz), Math.random() * dt);
    switch (j.fx) {
      case "flame": {
        // Fire that widens as it goes: small and yellow-white at the mouth, big and red at the far end.
        const n = Math.round(dt * 260) || 1;
        for (let i = 0; i < n; i++) {
          const s = speed * 0.11;
          from();
          this.glow.emit(a.x, a.y, a.z, dx + rnd(-s, s), dy + rnd(-s, s) * 0.6 + 0.4, dz + rnd(-s, s), j.travel * rnd(0.9, 1.2), 0.14, rnd(0.7, 1.05), [1, 0.85, 0.45, 0.85], [0.9, 0.18, 0.02]);
        }
        this.glow.emit(j.a.x, j.a.y, j.a.z, 0, 0, 0, 0.05, 0.35, 0.35, [1, 0.9, 0.6, 0.8], [1, 0.6, 0.2]);
        if (Math.random() < dt * 20) this.soft.emit(j.b.x, j.b.y, j.b.z, rnd(-0.3, 0.3), rnd(0.5, 1), rnd(-0.3, 0.3), rnd(0.6, 1), 0.3, 0.8, [0.3, 0.28, 0.26, 0.4], [0.5, 0.5, 0.5], -0.2, 0.8);
        break;
      }
      case "water":
      case "hydro": {
        // A tight, bright core with spray peeling off it; Hydro Pump is thick and sprays at the target.
        const big = j.fx === "hydro";
        const n = Math.round(dt * (big ? 280 : 160)) || 1;
        for (let i = 0; i < n; i++) {
          const s = speed * (big ? 0.035 : 0.015);
          from();
          this.soft.emit(a.x, a.y, a.z, dx + rnd(-s, s), dy + rnd(-s, s), dz + rnd(-s, s), j.travel, big ? 0.3 : 0.14, big ? 0.5 : 0.2, [0.55, 0.8, 1, 0.95], [0.8, 0.92, 1]);
          if (Math.random() < 0.3) this.glow.emit(a.x, a.y, a.z, dx, dy, dz, j.travel, big ? 0.16 : 0.07, big ? 0.24 : 0.1, [0.6, 0.85, 1, 0.5], [0.8, 0.95, 1]);
        }
        const spray = big ? 6 : 2;
        for (let i = 0; i < spray; i++)
          if (Math.random() < dt * 40) this.soft.emit(j.b.x, j.b.y, j.b.z, rnd(-1.5, 1.5), rnd(0.8, 2.4), rnd(-1.5, 1.5), rnd(0.3, 0.6), rnd(0.08, 0.18), 0.04, [0.6, 0.85, 1, 0.9], [0.9, 0.95, 1], 7);
        break;
      }
      case "bubble": {
        // A spray of wobbling bubbles that drift a little slower than the shot.
        if (Math.random() < dt * 55) {
          const s = speed * 0.1;
          const slow = rnd(0.75, 1);
          from();
          const vx = dx * slow + rnd(-s, s);
          const vy = dy * slow + rnd(-s, s) * 0.5 + 0.3;
          const vz = dz * slow + rnd(-s, s);
          const size = rnd(0.2, 0.36);
          this.soft.emit(a.x, a.y, a.z, vx, vy, vz, j.travel / slow, size * 0.6, size, [0.7, 0.9, 1, 0.6], [0.88, 0.96, 1]);
          // A white glint on each bubble.
          this.glow.emit(a.x, a.y, a.z, vx, vy, vz, j.travel / slow, size * 0.25, size * 0.35, [1, 1, 1, 0.7], [0.85, 0.95, 1]);
        }
        break;
      }
    }
  }

  /** Wind-up at the attacker's mouth, from the start of the swing until the attack lands. */
  charge(fx: WeaponFx, p: THREE.Vector3, secs: number) {
    switch (fx) {
      case "solar":
        // Sunlight streams in from all around and gathers into a growing orb.
        for (let i = 0; i < 26; i++) {
          const u = Math.random() * 2 - 1;
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(1 - u * u);
          const d = rnd(0.8, 1.4);
          const ox = Math.cos(a) * r * d;
          const oy = Math.abs(u) * d;
          const oz = Math.sin(a) * r * d;
          const life = secs * rnd(0.7, 1);
          this.glow.emit(p.x + ox, p.y + oy, p.z + oz, -ox / life, -oy / life, -oz / life, life, 0.24, 0.1, [1, 1, 0.65, 0.9], [0.7, 1, 0.4]);
        }
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, secs, 0.15, 1.3, [1, 1, 0.7, 0.9], [0.8, 1, 0.5]);
        break;
      case "spark":
      case "bolt":
      case "thunder":
        // Cheeks crackle before the discharge.
        this.burst(p, fx === "thunder" ? 14 : 6, [1, 1, 0.6, 1], [1, 0.85, 0.2], 1.4, 0.08, secs + 0.1);
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, secs + 0.05, 0.3, fx === "thunder" ? 1.1 : 0.55, [1, 0.95, 0.5, 0.8], [1, 0.9, 0.3]);
        break;
      case "ember":
      case "flame":
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, Math.max(0.1, secs), 0.15, fx === "flame" ? 0.6 : 0.35, [1, 0.75, 0.3, 0.9], [1, 0.4, 0.1]);
        this.smoke(p, 1, 0.25);
        break;
      case "hydro":
      case "water":
      case "bubble":
        for (let i = 0; i < 5; i++) this.soft.emit(p.x, p.y, p.z, rnd(-0.4, 0.4), rnd(0.2, 0.8), rnd(-0.4, 0.4), 0.35, 0.07, 0.03, [0.6, 0.85, 1, 0.9], [0.85, 0.95, 1], 5);
        break;
      case "leaf":
        // Leaves whirl up around the attacker.
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          this.soft.emit(p.x + Math.cos(a) * 0.3, p.y - 0.2, p.z + Math.sin(a) * 0.3, -Math.sin(a) * 1.4, rnd(0.6, 1.2), Math.cos(a) * 1.4, secs + 0.15, 0.1, 0.08, [0.45, 0.85, 0.35, 1], [0.3, 0.65, 0.25], 0, 1);
        }
        break;
    }
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

  /** Trail behind a projectile, by move type. `t` is the projectile's age (seconds). */
  trail(fx: WeaponFx, p: THREE.Vector3, dt: number, t = 0) {
    switch (fx) {
      case "ember":
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.35, 0.35, [1, 0.6, 0.2, 0.9], [1, 0.4, 0.1]);
        if (Math.random() < dt * 60) this.glow.emit(p.x, p.y, p.z, rnd(-0.3, 0.3), rnd(0, 0.4), rnd(-0.3, 0.3), 0.25, 0.22, 0.05, FIRE, FIRE_END);
        break;
      case "flame":
        // The head of the Flamethrower stream.
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.05, 0.6, 0.6, [1, 0.6, 0.2, 0.8], [1, 0.4, 0.1]);
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
        // Three spinning leaves whirling around each other, shedding bits of green.
        for (let k = 0; k < 3; k++) {
          const a = t * 22 + (k * Math.PI * 2) / 3;
          const flat = 0.6 + 0.4 * Math.abs(Math.sin(t * 30 + k));
          this.soft.emit(p.x + Math.cos(a) * 0.28, p.y + Math.sin(a) * 0.16, p.z + Math.sin(a) * 0.28, 0, 0, 0, 0.04, 0.3 * flat, 0.3 * flat, k === 1 ? [0.55, 0.9, 0.4, 1] : LEAF, LEAF);
        }
        if (Math.random() < dt * 30) this.soft.emit(p.x, p.y, p.z, rnd(-0.4, 0.4), rnd(-0.1, 0.3), rnd(-0.4, 0.4), 0.4, 0.08, 0.05, [0.5, 0.9, 0.4, 1], [0.3, 0.6, 0.2], 1.5);
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
      case "fang":
        this.burst(p, fx === "fang" ? 8 : Math.round(10 * s), FIRE, FIRE_END, 1.4 * Math.sqrt(s), 0.32, 0.35);
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.18, 0.9 * s, 1.4 * s, [1, 0.6, 0.25, 0.7], [1, 0.3, 0.1]);
        if (fx === "flame") this.smoke(p, 3, 0.6);
        break;
      case "bite":
      case "scratch":
        this.burst(p, 5, [1, 1, 1, 0.9], [0.8, 0.8, 0.8], 1.2, 0.12, 0.2);
        break;
      case "absorb":
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.25, 0.3, 0.7, [0.55, 1, 0.45, 0.6], [0.3, 0.8, 0.3]);
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
        for (let i = 0; i < 8; i++) this.soft.emit(p.x, p.y, p.z, rnd(-1.2, 1.2), rnd(0.2, 1.4), rnd(-1.2, 1.2), rnd(0.4, 0.7), rnd(0.08, 0.14), 0.05, [0.45, 0.85, 0.35, 1], [0.25, 0.55, 0.2], 2.5, 1.5);
        break;
      case "solar":
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.35, 1.0 * s, 2.6 * s, [1, 1, 0.75, 0.95], [0.6, 1, 0.4]);
        this.burst(p, 22, [1, 1, 0.6, 1], [0.5, 1, 0.3], 2.8, 0.25, 0.5);
        this.smoke(p, 2, 0.6);
        break;
      case "thunder": {
        this.burst(p, Math.round(14 * s), [0.7, 0.97, 1, 1], [0.3, 0.7, 1], 3.2, 0.14, 0.3);
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.2, 0.8 * s, 2.0 * s, [0.75, 0.97, 1, 0.9], [0.3, 0.7, 1]);
        // A ring of sparks racing out along the ground.
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2;
          this.glow.emit(p.x, p.y - 0.3, p.z, Math.cos(a) * 3.5, 0.2, Math.sin(a) * 3.5, 0.22, 0.16, 0.04, [0.8, 0.97, 1, 1], [0.4, 0.75, 1], 0, 6);
        }
        this.smoke(p, 3, 0.5);
        break;
      }
      case "vine":
        // The crack: a few torn leaves and a small white snap.
        for (let i = 0; i < 6; i++) this.soft.emit(p.x, p.y, p.z, rnd(-1.4, 1.4), rnd(0.4, 1.6), rnd(-1.4, 1.4), rnd(0.5, 0.8), rnd(0.08, 0.13), 0.05, [0.45, 0.85, 0.35, 1], [0.25, 0.55, 0.2], 2.5, 1.5);
        this.glow.emit(p.x, p.y, p.z, 0, 0, 0, 0.08, 0.25, 0.55, [1, 1, 0.9, 0.7], [0.8, 1, 0.7]);
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

  /** Lightning from a to b with a few forks splitting off it. */
  private lightning(a: THREE.Vector3, b: THREE.Vector3, width: number, color: number[], life: number, jag: number, forks: number, delay = 0) {
    this.beams.add(a, b, width, color, life, jag, delay);
    this.beams.add(a, b, width * 0.35, [1, 1, 1, 1], life * 0.8, jag * 0.8, delay);
    const len = a.distanceTo(b);
    for (let i = 0; i < forks; i++) {
      const m = new THREE.Vector3().lerpVectors(a, b, rnd(0.25, 0.7));
      const end = m.clone().add(new THREE.Vector3(rnd(-1, 1), rnd(-0.6, 0.6), rnd(-1, 1)).multiplyScalar(len * 0.3 + 0.3));
      this.beams.add(m, end, width * 0.45, color, life * 0.7, jag * 0.6, delay);
    }
  }

  /** Effects for instant moves (Solar Beam, Vine Whip, Thunderbolt, bites and claws…), muzzle a to target b. */
  beam(fx: WeaponFx, a: THREE.Vector3, target: THREE.Vector3) {
    // Bites and claws land on the side facing the attacker, not inside the target.
    const melee = fx === "fang" || fx === "bite" || fx === "scratch";
    const b = melee ? target.clone().add(new THREE.Vector3(a.x - target.x, 0, a.z - target.z).normalize().multiplyScalar(0.4)) : target;
    switch (fx) {
      case "solar":
        // A wide sunlit beam with a white-hot core, flickering particles along it.
        this.beams.add(a, b, 0.55, [0.6, 1, 0.35, 0.5], 0.5);
        this.beams.add(a, b, 0.3, [0.95, 1, 0.55, 1], 0.45);
        this.beams.add(a, b, 0.11, [1, 1, 1, 1], 0.4);
        for (let i = 0; i < 16; i++) {
          const m = new THREE.Vector3().lerpVectors(a, b, Math.random());
          this.glow.emit(m.x, m.y, m.z, rnd(-0.6, 0.6), rnd(-0.6, 0.6), rnd(-0.6, 0.6), rnd(0.3, 0.5), 0.12, 0.02, [1, 1, 0.7, 1], [0.6, 1, 0.4]);
        }
        break;
      case "vine":
        this.whips.add(a, b, 0.055, [0.28, 0.62, 0.22, 1], 0.42);
        if (Math.random() < 0.6) this.whips.add(a, b, 0.04, [0.33, 0.7, 0.26, 1], 0.36);
        break;
      case "spark":
        this.lightning(a, b, 0.06, [1, 0.95, 0.5, 1], 0.14, 0.3, 1);
        break;
      case "bolt":
        // Thunderbolt: a thick forked bolt that flickers twice.
        this.lightning(a, b, 0.11, [1, 0.93, 0.4, 1], 0.18, 0.45, 3);
        this.lightning(a, b, 0.08, [1, 0.95, 0.55, 1], 0.12, 0.45, 1, 0.09);
        break;
      case "thunder": {
        // A bolt from the sky onto the target, a second strike right after, and an arc from the attacker.
        const sky = new THREE.Vector3(b.x + rnd(-0.6, 0.6), b.y + 9, b.z + rnd(-0.6, 0.6));
        this.lightning(sky, b, 0.24, [0.55, 0.95, 1, 1], 0.24, 1.4, 4);
        this.lightning(new THREE.Vector3(sky.x + rnd(-0.8, 0.8), sky.y, sky.z + rnd(-0.8, 0.8)), b, 0.16, [0.65, 0.95, 1, 1], 0.18, 1.2, 2, 0.12);
        this.lightning(a, b, 0.08, [0.6, 0.95, 1, 1], 0.14, 0.5, 1);
        break;
      }
      case "fang":
      case "bite": {
        // Upper and lower fangs snapping shut on the target.
        const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
        const side = new THREE.Vector3(-dir.z, 0, dir.x);
        const up = fx === "fang" ? 0.45 : 0.35;
        // Two curved fangs per jaw, closing from above and below.
        for (const k of [-1, 1])
          for (const w of [-0.14, 0.14]) {
            const from = new THREE.Vector3(b.x + side.x * w, b.y + up * k, b.z + side.z * w);
            this.beams.add(from, new THREE.Vector3(b.x + side.x * w * 0.6, b.y + up * k * 0.12, b.z + side.z * w * 0.6), 0.07, [1, 1, 1, 1], 0.16);
          }
        if (fx === "fang") this.glow.emit(b.x, b.y, b.z, 0, 0, 0, 0.25, 0.5, 1.1, [1, 0.6, 0.2, 0.8], [1, 0.3, 0.05]);
        break;
      }
      case "scratch": {
        // Three claw marks raking across the target.
        const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
        const side = new THREE.Vector3(-dir.z, 0, dir.x);
        for (let i = -1; i <= 1; i++) {
          const off = side.clone().multiplyScalar(i * 0.12);
          const top = new THREE.Vector3(b.x + off.x - side.x * 0.2, b.y + 0.35, b.z + off.z - side.z * 0.2);
          const bot = new THREE.Vector3(b.x + off.x + side.x * 0.2, b.y - 0.28, b.z + off.z + side.z * 0.2);
          this.beams.add(top, bot, 0.05, [1, 0.95, 0.85, 1], 0.2);
        }
        break;
      }
      case "absorb":
        // Green orbs of energy drift from the target back into Oddish.
        for (let i = 0; i < 12; i++) {
          const life = rnd(0.45, 0.65);
          const ox = rnd(-0.2, 0.2);
          const oy = rnd(-0.1, 0.3);
          const oz = rnd(-0.2, 0.2);
          this.glow.emit(b.x + ox, b.y + oy, b.z + oz, (a.x - b.x - ox) / life, (a.y - b.y - oy) / life + 0.4, (a.z - b.z - oz) / life, life, 0.22, 0.1, [0.6, 1, 0.45, 1], [0.3, 0.9, 0.35]);
        }
        break;
    }
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
