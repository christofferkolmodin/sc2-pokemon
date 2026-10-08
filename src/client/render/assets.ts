import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { KINDS } from "../../sim/units.ts";
import { type Prim, Sdf, mesh } from "./sdf.ts";
import { type Anim, POKEMON } from "./pokemon.ts";

/**
 * Builds and caches renderable geometry for every unit kind, structure,
 * resource and doodad. Geometry carries vertex colours (`color`) and a glow
 * amount (`glow`); parts marked `team` / `faction` are white and get tinted
 * per instance.
 */

export type Tint = "none" | "team" | "faction";

export interface AssetPart {
  name: string;
  geo: THREE.BufferGeometry;
  tint: Tint;
  anim: Anim | "spin" | "bob";
  pivot: THREE.Vector3;
}

export interface Asset {
  parts: AssetPart[];
  flames: { part: string; p: THREE.Vector3; size: number }[];
  muzzle: THREE.Vector3[];
  gait: "biped" | "quad" | "fly" | "static";
  stride: number;
  /** Bounding radius (tiles) for icons and culling. */
  radius: number;
  height: number;
}

const cache = new Map<string, Asset>();

/** sRGB hex -> linear rgb, like three's colour management expects for vertex colours. */
function lin(hex: string): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

function finish(geo: THREE.BufferGeometry, color: string, glow = 0): THREE.BufferGeometry {
  const g = geo.index ? geo : geo;
  g.deleteAttribute("uv");
  const n = g.getAttribute("position").count;
  const col = new Float32Array(n * 3);
  const gl = new Float32Array(n).fill(glow);
  const [r, gg, b] = lin(color);
  for (let i = 0; i < n; i++) col.set([r, gg, b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("glow", new THREE.BufferAttribute(gl, 1));
  return g.index ? g.toNonIndexed() : g;
}

/** Composes primitives with transforms and colours into one geometry. */
class Builder {
  private list: THREE.BufferGeometry[] = [];
  add(geo: THREE.BufferGeometry, color: string, o: { p?: [number, number, number]; r?: [number, number, number]; s?: [number, number, number]; glow?: number } = {}) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...(o.p ?? [0, 0, 0])),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.r ?? [0, 0, 0]))),
      new THREE.Vector3(...(o.s ?? [1, 1, 1])),
    );
    geo.applyMatrix4(m);
    this.list.push(finish(geo, color, o.glow ?? 0));
    return this;
  }
  box(w: number, h: number, d: number, color: string, o: Parameters<Builder["add"]>[2] = {}) {
    return this.add(new THREE.BoxGeometry(w, h, d), color, o);
  }
  cyl(rt: number, rb: number, h: number, color: string, o: Parameters<Builder["add"]>[2] = {}, seg = 16) {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), color, o);
  }
  sphere(r: number, color: string, o: Parameters<Builder["add"]>[2] = {}, phi = Math.PI, start = 0) {
    return this.add(new THREE.SphereGeometry(r, 18, 12, 0, Math.PI * 2, start, phi), color, o);
  }
  torus(R: number, r: number, color: string, o: Parameters<Builder["add"]>[2] = {}) {
    return this.add(new THREE.TorusGeometry(R, r, 8, 24), color, o);
  }
  rock(r: number, color: string, seed: number, o: Parameters<Builder["add"]>[2] = {}, detail = 1) {
    const g = new THREE.IcosahedronGeometry(r, detail);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const n = 0.78 + 0.32 * hash3(Math.round(x * 50) + seed, Math.round(y * 50), Math.round(z * 50));
      p.setXYZ(i, x * n, y * n * 0.85, z * n);
    }
    g.computeVertexNormals();
    return this.add(g, color, o);
  }
  oct(r: number, h: number, color: string, o: Parameters<Builder["add"]>[2] = {}) {
    const g = new THREE.OctahedronGeometry(1, 0);
    g.scale(r, h, r);
    return this.add(g, color, o);
  }
  get empty() {
    return this.list.length === 0;
  }
  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.list, false)!;
    g.computeBoundingSphere();
    return g;
  }
}

function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function sdfGeometry(prims: Prim[], cell: number): THREE.BufferGeometry {
  const m = mesh(new Sdf(prims), cell);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(m.nrm, 3));
  const n = m.pos.length / 3;
  const col = new Float32Array(n * 3);
  const glow = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    col[i * 3] = m.col[i * 4];
    col[i * 3 + 1] = m.col[i * 4 + 1];
    col[i * 3 + 2] = m.col[i * 4 + 2];
    glow[i] = m.col[i * 4 + 3];
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("glow", new THREE.BufferAttribute(glow, 1));
  g.setIndex(new THREE.BufferAttribute(m.idx, 1));
  g.computeBoundingSphere();
  return g;
}

// --------------------------------------------------------------- Pokémon

function pokemonAsset(key: string): Asset {
  const def = POKEMON[key];
  const parts: AssetPart[] = def.parts.map((p) => ({
    name: p.name,
    geo: sdfGeometry(p.prims, p.cell ?? def.cell),
    tint: p.team ? "team" : "none",
    anim: p.anim,
    pivot: new THREE.Vector3(...p.pivot),
  }));
  let radius = 0;
  let height = 0;
  for (const p of parts) {
    const bs = p.geo.boundingSphere!;
    radius = Math.max(radius, bs.center.length() + bs.radius);
    p.geo.computeBoundingBox();
    height = Math.max(height, p.geo.boundingBox!.max.y);
  }
  return {
    parts,
    flames: def.flames.map((f) => ({ part: f.part, p: new THREE.Vector3(...f.p), size: f.size })),
    muzzle: def.muzzle.map((m) => new THREE.Vector3(...m)),
    gait: def.gait,
    stride: def.stride,
    radius,
    height,
  };
}

// ------------------------------------------------------------ structures

const POKEBALL_RED = "#e2353a";

function pokeball(b: Builder, r: number, p: [number, number, number], rot: [number, number, number] = [0, 0, 0]) {
  b.sphere(r, POKEBALL_RED, { p, r: rot }, Math.PI / 2, 0);
  b.sphere(r, "#f4f4f4", { p, r: rot }, Math.PI / 2, Math.PI / 2);
  b.torus(r * 0.99, r * 0.08, "#222222", { p, r: [Math.PI / 2 + rot[0], rot[1], rot[2]] });
  const fx = Math.sin(rot[1]);
  const fz = Math.cos(rot[1]);
  b.cyl(r * 0.28, r * 0.28, r * 0.14, "#f8f8f8", { p: [p[0] + fx * r * 0.95, p[1], p[2] + fz * r * 0.95], r: [Math.PI / 2, 0, -rot[1]] }, 16);
}

interface StructParts {
  base: Builder;
  team: Builder;
  faction: Builder;
  spin?: Builder;
}

function structureAsset(key: string): Asset {
  const k = KINDS.find((x) => x.key === key)!;
  const P: StructParts = { base: new Builder(), team: new Builder(), faction: new Builder() };
  const { base: b, team: t, faction: f } = P;
  const W = k.w;
  const H = k.h;
  switch (key) {
    case "center": {
      b.box(4.9, 0.25, 4.9, "#9aa3ab", { p: [0, 0.125, 0] });
      b.box(4.2, 1.6, 3.6, "#f2eee4", { p: [0, 1.05, -0.1] });
      b.box(4.4, 0.42, 3.8, POKEBALL_RED, { p: [0, 2.05, -0.1] });
      b.box(3.6, 0.5, 2.9, POKEBALL_RED, { p: [0, 2.5, -0.25] });
      b.box(2.4, 0.3, 1.8, "#c92f33", { p: [0, 2.88, -0.35] });
      b.box(1.5, 1.1, 0.1, "#86d0ee", { p: [0, 0.8, 1.72], glow: 0.35 });
      b.box(1.9, 0.12, 0.7, POKEBALL_RED, { p: [0, 1.45, 1.95] });
      for (const x of [-1.5, 1.5]) b.box(0.9, 0.6, 0.08, "#9fd8f0", { p: [x, 1.15, 1.71], glow: 0.2 });
      for (const zz of [-1.2, 0, 1.0]) for (const s of [-1, 1]) b.box(0.08, 0.55, 0.7, "#9fd8f0", { p: [s * 2.11, 1.15, zz], glow: 0.15 });
      pokeball(b, 0.42, [0, 2.48, 1.32]);
      t.box(4.46, 0.14, 3.86, "#ffffff", { p: [0, 1.82, -0.1] });
      for (const x of [-2.15, 2.15]) {
        b.cyl(0.05, 0.05, 1.6, "#d8d8d8", { p: [x, 0.95, 2.1] });
        t.box(0.5, 0.32, 0.03, "#ffffff", { p: [x + (x < 0 ? 0.27 : -0.27), 1.55, 2.1] });
      }
      break;
    }
    case "mart": {
      b.box(1.95, 0.15, 1.95, "#9aa3ab", { p: [0, 0.075, 0] });
      b.box(1.6, 1.0, 1.5, "#f2eee4", { p: [0, 0.65, -0.05] });
      b.box(1.78, 0.32, 1.68, "#2f62c9", { p: [0, 1.31, -0.05] });
      b.box(1.3, 0.2, 1.2, "#2a56b0", { p: [0, 1.56, -0.1] });
      b.box(0.6, 0.75, 0.06, "#86d0ee", { p: [0, 0.55, 0.72], glow: 0.3 });
      t.box(1.64, 0.1, 1.54, "#ffffff", { p: [0, 1.12, -0.05] });
      b.box(0.5, 0.3, 0.05, "#ffffff", { p: [0, 1.3, 0.8], glow: 0.2 });
      break;
    }
    case "gym": {
      b.cyl(1.38, 1.45, 0.9, "#a9a49a", { p: [0, 0.45, 0] }, 8);
      f.cyl(1.25, 1.3, 0.45, "#ffffff", { p: [0, 1.12, 0] }, 8);
      f.sphere(1.12, "#ffffff", { p: [0, 1.32, 0], s: [1, 0.62, 1] }, Math.PI / 2);
      b.box(0.8, 0.8, 0.2, "#4c4740", { p: [0, 0.45, 1.33] });
      b.box(1.0, 0.16, 0.35, "#d8d2c4", { p: [0, 0.93, 1.35] });
      for (const x of [-0.75, 0.75]) {
        b.cyl(0.04, 0.04, 2.0, "#d0d0d0", { p: [x, 1.0, 1.42] });
        t.box(0.3, 0.55, 0.03, "#ffffff", { p: [x, 1.6, 1.43] });
      }
      f.sphere(0.22, "#ffffff", { p: [0, 2.1, 0], glow: 0.6 });
      break;
    }
    case "shrine": {
      b.box(2.8, 0.3, 2.8, "#b9b1a2", { p: [0, 0.15, 0] });
      b.box(2.2, 0.2, 2.2, "#cfc7b6", { p: [0, 0.4, 0] });
      for (const x of [-1.0, 1.0])
        for (const zz of [-1.0, 1.0]) {
          b.cyl(0.16, 0.19, 1.7, "#ddd5c4", { p: [x, 1.35, zz] });
          b.box(0.42, 0.14, 0.42, "#c9c0ad", { p: [x, 2.25, zz] });
          t.box(0.06, 0.6, 0.3, "#ffffff", { p: [x + (x < 0 ? 0.17 : -0.17), 1.55, zz] });
        }
      b.box(2.45, 0.16, 0.3, "#c9c0ad", { p: [0, 2.38, 1.0] });
      b.box(2.45, 0.16, 0.3, "#c9c0ad", { p: [0, 2.38, -1.0] });
      b.cyl(0.5, 0.6, 0.25, "#a99f8c", { p: [0, 0.62, 0] }, 12);
      const s = new Builder();
      s.oct(0.36, 0.55, "#ffffff", { glow: 0.85 });
      P.spin = s;
      break;
    }
    case "elite": {
      b.box(2.9, 0.3, 2.9, "#b7b3ab", { p: [0, 0.15, 0] });
      b.cyl(1.0, 1.15, 2.0, "#f1efe9", { p: [0, 1.3, 0] }, 16);
      b.sphere(1.02, "#e8c55a", { p: [0, 2.3, 0] }, Math.PI / 2);
      b.cyl(0.02, 0.12, 0.8, "#e8c55a", { p: [0, 3.55, 0] });
      b.box(0.7, 1.0, 0.12, "#7a5c2e", { p: [0, 0.8, 1.05] });
      t.torus(1.06, 0.07, "#ffffff", { p: [0, 1.0, 0], r: [Math.PI / 2, 0, 0] });
      t.torus(1.03, 0.06, "#ffffff", { p: [0, 2.0, 0], r: [Math.PI / 2, 0, 0] });
      for (const a of [0.6, 2.2, 3.8, 5.4]) b.cyl(0.1, 0.12, 2.2, "#e2ded4", { p: [Math.cos(a) * 1.25, 1.25, Math.sin(a) * 1.25] });
      break;
    }
    case "turret": {
      b.box(1.7, 0.3, 1.7, "#8f979e", { p: [0, 0.15, 0] });
      b.cyl(0.32, 0.45, 1.3, "#a3abb3", { p: [0, 0.95, 0] }, 12);
      t.torus(0.36, 0.06, "#ffffff", { p: [0, 1.2, 0], r: [Math.PI / 2, 0, 0] });
      pokeball(b, 0.5, [0, 1.95, 0]);
      b.cyl(0.03, 0.06, 0.6, "#f6cf37", { p: [0, 2.7, 0], glow: 0.5 });
      b.sphere(0.08, "#fff27a", { p: [0, 3.02, 0], glow: 1 });
      break;
    }
    case "extractor": {
      b.cyl(1.35, 1.45, 0.55, "#7f8891", { p: [0, 0.28, 0] }, 12);
      b.torus(1.0, 0.08, "#5bff7a", { p: [0, 0.58, 0], r: [Math.PI / 2, 0, 0], glow: 0.9 });
      b.cyl(0.55, 0.65, 1.3, "#9aa3ab", { p: [0, 1.1, 0] }, 12);
      b.sphere(0.5, "#b8c0c8", { p: [0.75, 1.0, -0.6] });
      b.cyl(0.08, 0.08, 1.2, "#6d757c", { p: [0.5, 1.4, 0.1], r: [0, 0, 1.2] });
      t.box(1.12, 0.14, 1.12, "#ffffff", { p: [0, 1.5, 0] });
      b.cyl(0.25, 0.25, 0.3, "#5bff7a", { p: [0, 1.9, 0], glow: 0.7 });
      break;
    }
    case "mineral":
    case "mineralRich": {
      const rich = key === "mineralRich";
      const col = rich ? "#ffc845" : "#57c8ff";
      const shards: [number, number, number, number, number][] = [
        [-0.55, 0.0, 0.42, 0.75, 0.2],
        [-0.15, 0.12, 0.38, 0.95, -0.15],
        [0.3, -0.1, 0.4, 0.8, 0.25],
        [0.62, 0.1, 0.33, 0.6, -0.2],
        [0.05, -0.22, 0.3, 0.55, 0.1],
      ];
      for (const [x, zz, r, h, tilt] of shards) b.oct(r * 0.55, h * 0.75, col, { p: [x, h * 0.55, zz], r: [tilt, x, tilt * 0.6], glow: 0.35 });
      b.rock(0.5, "#5b5148", 3, { p: [0, 0.05, 0], s: [1.8, 0.35, 1.0] }, 0);
      break;
    }
    case "geyser": {
      b.rock(1.0, "#6f6658", 7, { p: [0, 0.15, 0], s: [1.45, 0.55, 1.45] });
      b.torus(0.62, 0.18, "#5d554a", { p: [0, 0.6, 0], r: [Math.PI / 2, 0, 0] });
      b.cyl(0.5, 0.5, 0.1, "#4dff6b", { p: [0, 0.62, 0], glow: 0.9 });
      break;
    }
    case "rock": {
      const rs: [number, number, number, number][] = [
        [-1.2, -0.8, 1.5, 1],
        [1.0, -1.1, 1.3, 2],
        [0.2, 1.0, 1.6, 3],
        [-1.5, 1.4, 1.0, 4],
        [1.6, 1.2, 1.1, 5],
        [0.0, -0.1, 1.2, 6],
      ];
      for (const [x, zz, r, s] of rs) b.rock(r, "#8a7f6e", s, { p: [x, r * 0.55, zz] });
      break;
    }
    case "rock2": {
      b.rock(0.85, "#8a7f6e", 11, { p: [-0.3, 0.45, 0] });
      b.rock(0.6, "#7d7262", 12, { p: [0.45, 0.3, 0.3] });
      break;
    }
    case "tower": {
      b.box(1.8, 0.3, 1.8, "#7d786f", { p: [0, 0.15, 0] });
      b.cyl(0.35, 0.6, 2.6, "#a29c90", { p: [0, 1.6, 0] }, 6);
      b.oct(0.35, 0.55, "#7ff4ff", { p: [0, 3.4, 0], glow: 0.9 });
      break;
    }
    default:
      b.box(W * 0.9, 1, H * 0.9, "#888888", { p: [0, 0.5, 0] });
  }
  const parts: AssetPart[] = [];
  const add = (name: string, bld: Builder, tint: Tint, anim: AssetPart["anim"] = "body", pivot = new THREE.Vector3()) => {
    if (!bld.empty) parts.push({ name, geo: bld.build(), tint, anim, pivot });
  };
  add("base", P.base, "none");
  add("team", P.team, "team");
  add("faction", P.faction, "faction");
  if (P.spin) add("spin", P.spin, "faction", "spin", new THREE.Vector3(0, 2.0, 0));
  const height = k.height / 1000;
  return { parts, flames: [], muzzle: [new THREE.Vector3(0, height * 0.8, 0)], gait: "static", stride: 1, radius: Math.max(W, H) * 0.7, height };
}

// --------------------------------------------------------------- doodads

export type DoodadPart = { geo: THREE.BufferGeometry; tinted: boolean };

const doodadCache = new Map<string, DoodadPart[]>();

/** Geometry for a doodad category; `tinted` parts take the per-instance colour (foliage). */
export function doodadAsset(t: string, variant: number): DoodadPart[] {
  const key = `${t}:${variant}`;
  const hit = doodadCache.get(key);
  if (hit) return hit;
  const plain = new Builder();
  const tinted = new Builder();
  const v = variant;
  switch (t) {
    case "tree": {
      const h = 0.9 + (v % 3) * 0.25;
      plain.cyl(0.08, 0.14, h, "#6b4a2e", { p: [0, h / 2, 0] }, 7);
      tinted.rock(0.62, "#ffffff", v * 7 + 1, { p: [0, h + 0.25, 0], s: [1, 0.9, 1] });
      tinted.rock(0.48, "#f2f2f2", v * 7 + 2, { p: [0.22, h + 0.65, 0.1] });
      tinted.rock(0.4, "#e8e8e8", v * 7 + 3, { p: [-0.2, h + 0.55, -0.18] });
      break;
    }
    case "bush": {
      tinted.rock(0.36, "#ffffff", v * 5 + 1, { p: [0, 0.18, 0], s: [1, 0.7, 1] });
      tinted.rock(0.28, "#eeeeee", v * 5 + 2, { p: [0.25, 0.14, 0.12], s: [1, 0.7, 1] });
      tinted.rock(0.24, "#f6f6f6", v * 5 + 3, { p: [-0.2, 0.12, -0.15], s: [1, 0.7, 1] });
      break;
    }
    case "rock": {
      tinted.rock(0.6, "#ffffff", v * 3 + 9, { p: [0, 0.25, 0], s: [1.1, 0.8, 0.95] }, 1);
      if (v % 2) tinted.rock(0.35, "#eeeeee", v * 3 + 10, { p: [0.55, 0.12, 0.2] }, 0);
      break;
    }
    case "crystal": {
      plain.oct(0.18, 0.6, "#b58cff", { p: [0, 0.45, 0], r: [0.15, 0, 0.1], glow: 0.55 });
      plain.oct(0.13, 0.42, "#8fb8ff", { p: [0.22, 0.3, 0.1], r: [0.4, 0.3, -0.3], glow: 0.55 });
      plain.oct(0.12, 0.38, "#c6a6ff", { p: [-0.18, 0.28, -0.12], r: [-0.4, 0, 0.35], glow: 0.55 });
      break;
    }
    case "pillar": {
      plain.cyl(0.28, 0.32, 2.0, "#b6ad9c", { p: [0, 1.0, 0] }, 10);
      plain.box(0.8, 0.2, 0.8, "#a59c8b", { p: [0, 2.1, 0] });
      plain.box(0.75, 0.18, 0.75, "#a59c8b", { p: [0, 0.09, 0] });
      break;
    }
    default: {
      plain.box(0.6, 0.6, 0.6, "#8d6a43", { p: [0, 0.3, 0] });
      plain.box(0.64, 0.08, 0.64, "#6e5032", { p: [0, 0.6, 0] });
    }
  }
  const out: DoodadPart[] = [];
  if (!plain.empty) out.push({ geo: plain.build(), tinted: false });
  if (!tinted.empty) out.push({ geo: tinted.build(), tinted: true });
  doodadCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------ API

/** Asset for a unit kind (Pokémon or structure); `rich` picks the gold mineral variant. */
export function assetFor(kind: number, rich = false): Asset {
  const k = KINDS[kind];
  const key = k.key === "mineral" && rich ? "mineralRich" : k.key;
  let a = cache.get(key);
  if (!a) {
    a = POKEMON[key] ? pokemonAsset(key) : structureAsset(key);
    cache.set(key, a);
  }
  return a;
}

const carryCache = new Map<string, THREE.BufferGeometry>();

/**
 * What a worker holds while bringing resources home: a cluster of blue
 * mineral crystals, or a glowing green gas canister. Centred on the origin,
 * about a fifth of a tile across.
 */
export function carryGeometry(gas: boolean): THREE.BufferGeometry {
  const key = gas ? "gas" : "mineral";
  const hit = carryCache.get(key);
  if (hit) return hit;
  const b = new Builder();
  if (gas) {
    b.cyl(0.07, 0.07, 0.13, "#3c4248", { p: [0, 0, 0] }, 10);
    b.cyl(0.058, 0.058, 0.1, "#5bff7a", { p: [0, 0.005, 0], glow: 0.9 }, 10);
    b.cyl(0.075, 0.075, 0.02, "#7d8791", { p: [0, 0.07, 0] }, 10);
    b.cyl(0.075, 0.075, 0.02, "#7d8791", { p: [0, -0.06, 0] }, 10);
  } else {
    b.oct(0.05, 0.1, "#57c8ff", { p: [0, 0.02, 0], r: [0.25, 0, 0.15], glow: 0.45 });
    b.oct(0.04, 0.075, "#7fdcff", { p: [0.05, -0.005, 0.03], r: [-0.4, 0.3, -0.5], glow: 0.45 });
    b.oct(0.035, 0.065, "#3fb4f0", { p: [-0.045, -0.01, -0.03], r: [0.5, 0, 0.6], glow: 0.45 });
  }
  const g = b.build();
  carryCache.set(key, g);
  return g;
}

/** Build every Pokémon now (a few hundred ms), e.g. behind the loading screen. */
export function preloadAll() {
  for (const k of KINDS) assetFor(k.id);
}
