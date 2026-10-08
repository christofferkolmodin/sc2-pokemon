import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { FP } from "../../sim/fixed.ts";
import { MODE_ATTACK, MODE_ATTACK_UNIT, MODE_BUILD, MODE_GATHER, MODE_PATROL, MODE_RETURN } from "../../sim/commands.ts";
import { KINDS, K_EXTRACTOR, K_GEYSER, K_MINERAL, type WeaponFx } from "../../sim/units.ts";
import type { SimEvent, Unit, World } from "../../sim/world.ts";
import type { Doodad, RenderData } from "../../maps/load.ts";
import type { Camera } from "../camera.ts";
import type { Selection } from "../selection.ts";
import { FACTION_COLORS, SELECT_ENEMY, SELECT_NEUTRAL, SELECT_OWN, teamColor } from "../style.ts";
import { Batch } from "./batch.ts";
import { type Asset, assetFor, doodadAsset } from "./assets.ts";
import { type AnimState, bodyOffset, partMatrix } from "./animate.ts";
import { Effects } from "./effects.ts";
import { type GltfModels, GltfUnits } from "./gltf.ts";
import { patch, propMaterial, shared, unitMaterial } from "./materials.ts";
import { Heights, builtinHeights, detailTexture, fbm, importedHeights, paintAlbedo, terrainGeometry } from "./terrain.ts";

/**
 * three.js renderer: SC2 camera, heightfield terrain with cliffs, instanced
 * sculpted Pokémon and buildings, doodads, fog of war, shadows, particles.
 * A transparent 2D canvas on top draws health bars, click markers,
 * waypoints, the drag box and the cursor.
 *
 * Public surface used by the game: resize, draw, onEvents, pick, pickBox,
 * onScreen, markers, unitIcon, heightAt.
 */

export interface Marker {
  x: number;
  y: number;
  color: string;
  t0: number;
}

export interface Placement {
  kind: number;
  tx: number;
  ty: number;
  /** Per footprint tile: 1 = can build here. */
  tiles: Uint8Array;
  ok: boolean;
}

export interface FrameState {
  alpha: number;
  now: number;
  dt: number;
  selection: Selection;
  hoverId: number;
  dragBox: { x0: number; y0: number; x1: number; y1: number } | null;
  showWaypoints: boolean;
  cursor: { x: number; y: number; targeting: string | null } | null;
  /** Local player (-1 = spectator: no fog, see everything). */
  me: number;
  placement: Placement | null;
  fog: boolean;
  bars: "always" | "damaged";
}

interface Vis {
  face: number;
  phase: number;
  lx: number;
  ly: number;
  moving: number;
  seed: number;
  atkTick: number;
  atkT: number;
}

interface Snapshot {
  kind: number;
  owner: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  progress: number;
}

interface Corpse {
  kind: number;
  owner: number;
  x: number;
  y: number;
  h: number;
  face: number;
  t0: number;
}

interface ProjVis {
  sx: number;
  sy: number;
  sh: number;
  d0: number;
  fx: WeaponFx;
}

const LIGHT_DIR = new THREE.Vector3(-0.45, 0.82, 0.36).normalize();
const tmpM = new THREE.Matrix4();
const tmpL = new THREE.Matrix4();
const tmpW = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

function linColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera();
  readonly heights: Heights;
  readonly effects = new Effects();
  markers: Marker[] = [];
  private overlay: CanvasRenderingContext2D;
  private dpr = 1;
  private sun: THREE.DirectionalLight;
  private matUnit = unitMaterial(false);
  private matStruct = unitMaterial(true);
  private batches = new Map<string, Batch>();
  private ringBatch: Batch;
  private tileBatch: Batch;
  private ghost = new THREE.Group();
  private ghostKind = -1;
  private ghostMat = new THREE.MeshStandardMaterial({ color: "#7fe0ff", transparent: true, opacity: 0.5, roughness: 0.4, emissive: "#3070a0", depthWrite: false });
  private vis = new Map<number, Vis>();
  private snapshots = new Map<number, Snapshot>();
  private corpses: Corpse[] = [];
  private proj = new Map<number, ProjVis>();
  private fogData: Uint8Array<ArrayBuffer>;
  private fogTex: THREE.DataTexture;
  private lastFogTick = -1;
  private me = -1;
  private fogOn = false;
  private mapGroup = new THREE.Group();
  private unitGroup = new THREE.Group();
  private minimapImg: HTMLImageElement | null;
  private gltfUnits: GltfUnits | null = null;
  private composer: EffectComposer | null = null;
  quality: "high" | "low" = "high";

  constructor(
    private canvas: HTMLCanvasElement,
    private overlayCanvas: HTMLCanvasElement,
    private world: World,
    private cam: Camera,
    render: RenderData,
    minimap: HTMLImageElement | null,
    readonly gltf: GltfModels | null = null,
  ) {
    this.three = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.three.shadowMap.enabled = true;
    this.three.shadowMap.type = THREE.PCFSoftShadowMap;
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.toneMappingExposure = 1.05;
    this.overlay = overlayCanvas.getContext("2d")!;
    this.minimapImg = minimap;

    const m = world.map;
    if (render.heights) {
      const res = m.w * m.h > 26000 ? 1 : 2;
      this.heights = new Heights(importedHeights(render.heights, res), res);
    } else {
      this.heights = new Heights(builtinHeights(m, 2), 2);
    }
    cam.ground = (x, y) => this.heights.at(x, y);

    this.scene.background = new THREE.Color("#0b0e10");
    this.scene.add(this.mapGroup, this.unitGroup, this.effects.group, this.ghost);
    if (gltf) {
      this.gltfUnits = new GltfUnits(gltf);
      this.scene.add(this.gltfUnits.group);
    }
    const hemi = new THREE.HemisphereLight("#c9dcf2", "#4b3f30", 1.15);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight("#fff1dc", 2.7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.fogData = new Uint8Array(m.w * m.h);
    this.fogTex = new THREE.DataTexture(this.fogData, m.w, m.h, THREE.RedFormat, THREE.UnsignedByteType);
    this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.flipY = false;
    shared.fogTex.value = this.fogTex;
    shared.mapSize.value.set(m.w, m.h);

    this.buildTerrain();
    this.buildDoodads(render.doodads, !render.heights);

    const ring = new THREE.RingGeometry(0.86, 1, 48);
    ring.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, opacity: 0.95, toneMapped: false });
    this.ringBatch = new Batch(ring, ringMat, this.scene, 64, false);
    this.ringBatch.mesh.renderOrder = 5;
    const tile = new THREE.PlaneGeometry(0.9, 0.9);
    tile.rotateX(-Math.PI / 2);
    this.tileBatch = new Batch(tile, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false }), this.scene, 32, false);
    this.tileBatch.mesh.renderOrder = 6;
    this.ghost.renderOrder = 7;
  }

  heightAt(x: number, y: number): number {
    return this.heights.at(x, y);
  }

  // ------------------------------------------------------------- setup

  private buildTerrain() {
    const m = this.world.map;
    const geo = terrainGeometry(this.heights);
    const albedo = paintAlbedo(this.heights, m, this.minimapImg);
    const detail = detailTexture();
    const mat = new THREE.MeshStandardMaterial({ map: albedo, roughness: 0.93, metalness: 0 });
    patch(mat, {
      fog: true,
      extraUniforms: { detailTex: { value: detail } },
      extraFragHead: /* glsl */ `
        uniform sampler2D detailTex;
        vec3 triDetail(vec3 p, vec3 n) {
          vec3 w = pow(abs(n), vec3(4.0));
          w /= (w.x + w.y + w.z);
          float x = texture2D(detailTex, p.zy * 0.35).r;
          float y = texture2D(detailTex, p.xz * 0.35).r;
          float z = texture2D(detailTex, p.xy * 0.35).r;
          return vec3(x * w.x + y * w.y + z * w.z);
        }`,
      extraFragColor: /* glsl */ `
        {
          float steep = 1.0 - clamp(vWNrm.y, 0.0, 1.0);
          float d1 = texture2D(detailTex, vWPos.xz * 0.5).r;
          float d2 = texture2D(detailTex, vWPos.xz * 2.1 + 0.37).g;
          diffuseColor.rgb *= 0.78 + d1 * 0.32 + (d2 - 0.5) * 0.18;
          // Cliff faces: layered rock, triplanar so it doesn't stretch.
          float rockAmt = smoothstep(0.3, 0.62, steep);
          float t1 = triDetail(vWPos * vec3(0.6, 1.1, 0.6), vWNrm).r;
          float t2 = triDetail(vWPos * 2.2 + 1.7, vWNrm).r;
          vec3 rock = mix(vec3(0.27, 0.25, 0.22), vec3(0.55, 0.5, 0.44), smoothstep(0.32, 0.72, t1)) * (0.78 + 0.44 * t2);
          // Soft, broken layering instead of regular stripes.
          rock *= 0.9 + 0.1 * sin(vWPos.y * 4.0 + t1 * 9.0 + t2 * 3.0);
          // Borrow the ground's hue so cliffs match the tileset.
          vec3 hue = diffuseColor.rgb / max(0.15, dot(diffuseColor.rgb, vec3(0.333)));
          rock *= mix(vec3(1.0), clamp(hue, 0.6, 1.5), 0.45);
          diffuseColor.rgb = mix(diffuseColor.rgb, rock, rockAmt * 0.9);
          // Cliff edges catch a lighter rim, like SC2's cliff lips.
          diffuseColor.rgb *= 1.0 + smoothstep(0.15, 0.3, steep) * (1.0 - rockAmt) * 0.15;
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    this.mapGroup.add(mesh);
  }

  /** Imported maps list their doodads; built-in maps get trees and rocks on blocked, non-cliff ground. */
  private buildDoodads(list: Doodad[], procedural: boolean) {
    const m = this.world.map;
    const items: Doodad[] = procedural ? this.proceduralDoodads() : list;
    const groups = new Map<string, Doodad[]>();
    for (const d of items) {
      const key = `${d.t}:${d.v % 3}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(d);
    }
    const mat = propMaterial();
    const mm = this.minimapImg ? this.sampleImage(this.minimapImg) : null;
    const m4 = new THREE.Matrix4();
    for (const [key, ds] of groups) {
      const [t, v] = key.split(":");
      for (const part of doodadAsset(t, Number(v))) {
        const b = new Batch(part.geo, mat, this.mapGroup, ds.length, t === "tree" || t === "rock" || t === "pillar");
        for (const d of ds) {
          const h = this.heights.at(d.x, d.y);
          const s = Math.max(0.3, Math.min(3, d.s));
          m4.compose(tmpV.set(d.x, h - 0.05, d.y), tmpQ.setFromAxisAngle(UP, d.r), new THREE.Vector3(s, s, s));
          let r = 1;
          let g = 1;
          let bl = 1;
          if (part.tinted) {
            const c = this.foliage(t, d, mm);
            r = c[0];
            g = c[1];
            bl = c[2];
          }
          b.push(m4, r, g, bl);
        }
        b.end();
      }
    }
    void m;
  }

  private sampleImage(img: HTMLImageElement) {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext("2d")!;
    x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, c.width, c.height);
  }

  /** Foliage/rock tint: from the minimap colour under the doodad when we have one. */
  private foliage(t: string, d: Doodad, mm: ImageData | null): [number, number, number] {
    const m = this.world.map;
    const j = fbm(d.x * 0.7, d.y * 0.7) * 0.3 + 0.85;
    let base: [number, number, number] = t === "rock" ? [0.42, 0.38, 0.33] : t === "bush" ? [0.22, 0.42, 0.14] : [0.16, 0.36, 0.13];
    if (mm) {
      const sx = Math.max(0, Math.min(mm.width - 1, Math.floor((d.x / m.w) * mm.width)));
      const sy = Math.max(0, Math.min(mm.height - 1, Math.floor((d.y / m.h) * mm.height)));
      const o = (sy * mm.width + sx) * 4;
      const c = new THREE.Color().setRGB(mm.data[o] / 255, mm.data[o + 1] / 255, mm.data[o + 2] / 255, THREE.SRGBColorSpace);
      const k = t === "rock" ? 0.5 : 0.6;
      base = [base[0] * (1 - k) + c.r * k * 1.3, base[1] * (1 - k) + c.g * k * 1.3, base[2] * (1 - k) + c.b * k * 1.3];
    }
    return [base[0] * j, base[1] * j, base[2] * j];
  }

  private proceduralDoodads(): Doodad[] {
    const m = this.world.map;
    const out: Doodad[] = [];
    const MARGIN = 9;
    const h = (x: number, y: number, s: number) => {
      let v = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
      v = Math.imul(v ^ (v >>> 13), 1274126177);
      return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
    };
    for (let y = -MARGIN; y < m.h + MARGIN; y++)
      for (let x = -MARGIN; x < m.w + MARGIN; x++) {
        const inside = x >= 0 && y >= 0 && x < m.w && y < m.h;
        const blocked = !inside || m.terrain[y * m.w + x];
        if (!blocked) {
          // Sparse decoration on open ground, away from where armies walk.
          if (inside && m.nobuild[y * m.w + x] === 0 && h(x, y, 9) < 0.006) out.push({ t: "bush", x: x + 0.5, y: y + 0.5, r: h(x, y, 2) * 6.28, s: 0.6, v: 0 });
          continue;
        }
        // Skip cliff faces (they're steep rock already): only rock formations and the outer scenery.
        if (inside) {
          let cliff = false;
          for (let dy = -1; dy <= 1 && !cliff; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < m.w && ny < m.h && Math.abs(m.level[ny * m.w + nx] - m.level[y * m.w + x]) > 8) cliff = true;
            }
          if (cliff) continue;
        }
        const r = h(x, y, 1);
        const n = fbm(x * 0.12, y * 0.12);
        if (r < 0.32 * n + 0.08) {
          const tree = h(x, y, 3) < 0.75;
          out.push({ t: tree ? "tree" : "rock", x: x + 0.2 + h(x, y, 4) * 0.6, y: y + 0.2 + h(x, y, 5) * 0.6, r: h(x, y, 6) * 6.28, s: (tree ? 1.0 : 0.8) + h(x, y, 7) * 0.7, v: Math.floor(h(x, y, 8) * 6) });
        }
      }
    return out;
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = this.quality === "low" ? Math.min(1, this.dpr) : this.dpr;
    this.three.setPixelRatio(scale);
    this.three.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.overlayCanvas.width = Math.round(w * this.dpr);
    this.overlayCanvas.height = Math.round(h * this.dpr);
    this.overlayCanvas.style.width = `${w}px`;
    this.overlayCanvas.style.height = `${h}px`;
    this.effects.setScale((h * scale) / 2 / Math.tan(this.cam.fov / 2));
    const sm = this.quality === "low" ? 1024 : 2048;
    if (this.sun.shadow.mapSize.x !== sm) {
      this.sun.shadow.mapSize.set(sm, sm);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    // High quality: render through a bloom pass so flames, crystals and beams glow.
    this.composer?.dispose();
    this.composer = null;
    if (this.quality === "high") {
      const rt = new THREE.WebGLRenderTarget(w * scale, h * scale, { type: THREE.HalfFloatType, samples: 4 });
      const c = new EffectComposer(this.three, rt);
      c.setPixelRatio(scale);
      c.setSize(w, h);
      c.addPass(new RenderPass(this.scene, this.camera));
      c.addPass(new UnrealBloomPass(new THREE.Vector2(w / 2, h / 2), 0.45, 0.55, 0.82));
      c.addPass(new OutputPass());
      this.composer = c;
    }
  }

  // ---------------------------------------------------------- helpers

  /** Interpolated ground position in tiles. */
  pos(u: Unit, alpha: number): { x: number; y: number } {
    return { x: (u.px + (u.x - u.px) * alpha) / FP, y: (u.py + (u.y - u.py) * alpha) / FP };
  }

  /** Height of a unit's feet (ground, or flying height). */
  baseHeight(u: Unit, x: number, y: number): number {
    const k = KINDS[u.kind];
    if (k.structure) return this.heights.at(x, y);
    const g = this.heights.at(x, y);
    return k.fly ? Math.max(g, this.flyBase(x, y)) + k.fly / 1000 : g;
  }

  /** Flyers keep a steady altitude over the terrain instead of following every bump. */
  private flyBase(x: number, y: number): number {
    return (this.heights.at(x - 2, y) + this.heights.at(x + 2, y) + this.heights.at(x, y - 2) + this.heights.at(x, y + 2)) / 4;
  }

  private visible(u: Unit): boolean {
    if (!this.fogOn) return true;
    return this.world.canSee(this.me, u);
  }

  private explored(tx: number, ty: number): boolean {
    if (!this.fogOn) return true;
    const e = this.world.explored.get(this.world.teamOf(this.me));
    const m = this.world.map;
    if (!e || tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
    return e[ty * m.w + tx] === 1;
  }

  /** Is the point visible to the local player (for effects)? */
  seen(x: number, y: number): boolean {
    if (!this.fogOn) return true;
    return this.world.tileVisible(this.world.teamOf(this.me), Math.floor(x), Math.floor(y));
  }

  private batch(key: string, geo: THREE.BufferGeometry, mat: THREE.Material): Batch {
    let b = this.batches.get(key);
    if (!b) {
      b = new Batch(geo, mat, this.unitGroup, 32);
      this.batches.set(key, b);
    }
    return b;
  }

  private visOf(u: Unit, x: number, y: number): Vis {
    let v = this.vis.get(u.id);
    if (!v) {
      const m = this.world.map;
      v = { face: Math.atan2(m.h / 2 - y, m.w / 2 - x), phase: u.id * 0.7, lx: x, ly: y, moving: 0, seed: (u.id * 0.618) % 1 * 6.28, atkTick: u.attackTick, atkT: -10 };
      this.vis.set(u.id, v);
    }
    return v;
  }

  private factionColor(owner: number): THREE.Color {
    const p = this.world.players.get(owner);
    return linColor(FACTION_COLORS[p?.faction ?? 0]);
  }

  // ---------------------------------------------------------- frame

  draw(state: FrameState) {
    const w = this.world;
    const t = state.now / 1000;
    const dt = Math.min(0.1, state.dt);
    this.me = state.me;
    this.fogOn = state.fog && state.me !== -1;
    shared.time.value = t;
    shared.fogOn.value = this.fogOn ? 1 : 0;
    this.cam.follow(dt);
    this.syncCamera();
    this.updateFog();

    for (const b of this.batches.values()) b.begin();
    this.ringBatch.begin();
    this.gltfUnits?.begin();
    const fp = this.cam.footprint();
    const minX = Math.min(...fp.map((p) => p.x)) - 4;
    const maxX = Math.max(...fp.map((p) => p.x)) + 4;
    const minY = Math.min(...fp.map((p) => p.y)) - 4;
    const maxY = Math.max(...fp.map((p) => p.y)) + 8;
    const sel = new Set(state.selection.ids);
    const seenIds = new Set<number>();

    for (const u of w.units) {
      const k = KINDS[u.kind];
      if (u.hidden) continue;
      if (u.kind === K_GEYSER && u.link) continue; // covered by its extractor
      const p = this.pos(u, state.alpha);
      const vis = this.visible(u);
      if (k.structure && u.owner !== 0 && this.fogOn && !w.allied(this.me, u.owner)) {
        if (vis) this.snapshots.set(u.id, { kind: u.kind, owner: u.owner, x: p.x, y: p.y, tx: u.tx, ty: u.ty, progress: u.progress / Math.max(1, k.time) });
        else continue; // drawn from its snapshot below
      } else if (k.structure && u.owner === 0) {
        if (!this.explored(Math.floor(p.x), Math.floor(p.y))) continue;
      } else if (!vis) continue;
      if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
      seenIds.add(u.id);
      this.drawUnit(u, p.x, p.y, t, dt, state, sel.has(u.id) || u.id === state.hoverId);
    }
    // Enemy structures last seen in fog.
    for (const [id, s] of this.snapshots) {
      const live = w.byId.get(id);
      if (live && this.visible(live)) continue;
      const k = KINDS[s.kind];
      let gone = false;
      for (let y = s.ty; y < s.ty + k.h && !gone; y++) for (let x = s.tx; x < s.tx + k.w; x++) if (this.seen(x + 0.5, y + 0.5) && !live) gone = true;
      if (gone || !this.fogOn) {
        this.snapshots.delete(id);
        continue;
      }
      if (s.x < minX || s.x > maxX || s.y < minY || s.y > maxY) continue;
      this.drawStructure(s.kind, s.owner, s.x, s.y, s.progress, t, 1, 0);
    }
    this.drawCorpses(state.now);
    this.drawProjectiles(state.alpha, dt);
    for (const id of this.vis.keys()) if (!w.byId.has(id)) this.vis.delete(id);

    for (const b of this.batches.values()) b.end();
    this.gltfUnits?.end();
    this.drawRings(state);
    this.ringBatch.end();
    this.drawPlacement(state.placement);
    this.effects.update(dt, this.camera.position);
    this.updateSun();
    if (this.composer) this.composer.render();
    else this.three.render(this.scene, this.camera);
    this.drawOverlay(state);
  }

  private syncCamera() {
    const c = this.cam;
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldInverse.fromArray(c.view);
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert();
    this.camera.projectionMatrix.fromArray(c.proj);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.position.set(c.eye[0], c.eye[1], c.eye[2]);
  }

  private updateFog() {
    const w = this.world;
    if (!this.fogOn || w.tick === this.lastFogTick) return;
    this.lastFogTick = w.tick;
    const team = w.teamOf(this.me);
    const v = w.vis.get(team);
    const e = w.explored.get(team);
    if (!v || !e) return;
    for (let i = 0; i < this.fogData.length; i++) this.fogData[i] = v[i] ? 255 : e[i] ? 128 : 0;
    this.fogTex.needsUpdate = true;
  }

  private updateSun() {
    const fp = this.cam.footprint();
    const cx = fp.reduce((s, p) => s + p.x, 0) / 4;
    const cy = fp.reduce((s, p) => s + p.y, 0) / 4;
    const r = Math.max(...fp.map((p) => Math.hypot(p.x - cx, p.y - cy))) + 4;
    const h = this.cam.th;
    this.sun.target.position.set(cx, h, cy);
    this.sun.position.set(cx + LIGHT_DIR.x * 80, h + LIGHT_DIR.y * 80, cy + LIGHT_DIR.z * 80);
    const sc = this.sun.shadow.camera;
    sc.left = -r;
    sc.right = r;
    sc.top = r;
    sc.bottom = -r;
    sc.near = 10;
    sc.far = 180;
    sc.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ units

  private drawUnit(u: Unit, x: number, y: number, t: number, dt: number, state: FrameState, highlighted: boolean) {
    const k = KINDS[u.kind];
    if (k.structure) {
      const prog = u.progress / Math.max(1, k.time);
      let scale = 1;
      if (u.kind === K_MINERAL) scale = 0.55 + 0.45 * Math.min(1, u.amount / 1500);
      this.drawStructure(u.kind, u.owner, x, y, prog, t, scale, u.lastHit > this.world.tick - 3 ? 1 : 0, u.yield > 5);
      if (prog < 1 && this.seen(x, y) && Math.random() < dt * 6) this.effects.dust(new THREE.Vector3(x, this.heights.at(x, y), y), k.w * 0.4);
      // Production light.
      if (u.queue.length > 0 && Math.random() < dt * 3) this.effects.sprite(new THREE.Vector3(x, this.heights.at(x, y) + k.height / 1000 + 0.3, y), 0.35, [0.5, 0.9, 1, 0.8]);
      void highlighted;
      return;
    }
    const asset = assetFor(u.kind);
    const v = this.visOf(u, x, y);
    const moved = Math.hypot(x - v.lx, y - v.ly);
    v.lx = x;
    v.ly = y;
    const speedTiles = (k.speed * 22.4) / FP;
    const inst = dt > 0 ? moved / dt / Math.max(0.5, speedTiles) : 0;
    v.moving += (Math.min(1, inst) - v.moving) * Math.min(1, dt * 10);
    v.phase += (moved / Math.max(0.2, asset.height * 0.5)) * Math.PI;
    // Facing: toward the target while fighting, else along the velocity.
    let want: number | null = null;
    const tgt = u.target ? this.world.byId.get(u.target) : undefined;
    if (tgt && (u.engaged || this.world.tick - u.attackTick < 20)) want = Math.atan2(tgt.y - u.y, tgt.x - u.x);
    else if (u.vx * u.vx + u.vy * u.vy > (FP / 200) ** 2) want = Math.atan2(u.vy, u.vx);
    if (want !== null) {
      let d = want - v.face;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      v.face += d * Math.min(1, dt * 12);
    }
    if (u.attackTick !== v.atkTick) {
      v.atkTick = u.attackTick;
      v.atkT = t;
    }
    const atk = t - v.atkT < 0.35 ? (t - v.atkT) / 0.35 : -1;
    const s: AnimState = { phase: v.phase, moving: v.moving, t, attack: atk, seed: v.seed };
    const base = this.baseHeight(u, x, y);
    if (this.gltfUnits && this.gltf!.has(u.kind)) {
      // Real model: animated skinned mesh, plus a team-coloured ring so players stay readable.
      this.gltfUnits.draw(u.id, u.kind, x, base, y, v.face, v.moving, u.attackTick, dt);
      if (!highlighted) this.ring(x, y, this.heights.at(x, y), u.radius / FP + 0.05, teamColor(u.owner), 0.5);
      if (u.morphTo >= 0) this.effects.evolving(new THREE.Vector3(x, base, y), asset.height, dt);
      return;
    }
    const off = bodyOffset(asset, s);
    tmpQ.setFromAxisAngle(UP, -v.face);
    tmpM.compose(tmpV.set(x, base + off.y, y), tmpQ, new THREE.Vector3(1, off.sy, 1));
    tmpM.multiply(tmpL.makeTranslation(off.x, 0, 0));
    const team = linColor(teamColor(u.owner));
    // Evolving: glowing white silhouette (the classic evolution look). Hit: brief red flash.
    const morph = u.morphTo >= 0 ? 0.5 + 0.5 * Math.sin(t * (6 + (u.morphT / Math.max(1, u.morphTotal)) * 14)) : 0;
    const hit = this.world.tick - u.lastHit < 3 ? 1 : 0;
    const glow = 1 + morph * 0.85;
    for (let i = 0; i < asset.parts.length; i++) {
      const part = asset.parts[i];
      partMatrix(tmpL, asset, part, s);
      tmpW.multiplyMatrices(tmpM, tmpL);
      const b = this.batch(`${u.kind}:${i}`, part.geo, this.matUnit);
      if (part.tint === "team") b.push(tmpW, team.r * glow, team.g * glow, team.b * glow);
      else b.push(tmpW, glow + hit * 0.6, glow - hit * 0.35, glow - hit * 0.35);
    }
    if (u.morphTo >= 0) this.effects.evolving(new THREE.Vector3(x, base, y), asset.height, dt);
    // Tail flames and carried resources.
    for (const f of asset.flames) {
      const pi = asset.parts.findIndex((p) => p.name === f.part);
      if (pi >= 0) partMatrix(tmpL, asset, asset.parts[pi], s);
      else tmpL.identity();
      const p = f.p.clone().applyMatrix4(tmpL).applyMatrix4(tmpM);
      this.effects.flame(p, f.size, dt);
    }
    if (u.carry > 0) {
      const p = new THREE.Vector3(0.12, asset.height * 0.55, 0).applyMatrix4(tmpM);
      this.effects.sprite(p, 0.28, u.carryGas ? [0.35, 1, 0.45, 1] : [0.35, 0.8, 1, 1]);
    }
  }

  private drawStructure(kind: number, owner: number, x: number, y: number, prog: number, t: number, scale: number, hit: number, rich = false) {
    const asset = assetFor(kind, rich);
    const k = KINDS[kind];
    const h = this.heights.at(x, y);
    const building = prog < 1;
    const sy = building ? 0.2 + 0.8 * prog : 1;
    tmpM.compose(tmpV.set(x, h - 0.02, y), tmpQ.identity(), new THREE.Vector3(scale, sy * scale, scale));
    const team = linColor(teamColor(owner));
    const fac = this.factionColor(owner);
    const s: AnimState = { phase: 0, moving: 0, t, attack: -1, seed: x * 0.37 + y };
    const tint = building ? [0.55 + 0.25 * Math.sin(t * 4), 0.85, 1.4] : hit ? [1.4, 0.8, 0.8] : [1, 1, 1];
    for (let i = 0; i < asset.parts.length; i++) {
      const part = asset.parts[i];
      partMatrix(tmpL, asset, part, s);
      tmpW.multiplyMatrices(tmpM, tmpL);
      const b = this.batch(`${kind}:${rich ? "r" : ""}${i}`, part.geo, this.matStruct);
      const c = part.tint === "team" ? team : part.tint === "faction" ? fac : null;
      if (c) b.push(tmpW, c.r * tint[0], c.g * tint[1], c.b * tint[2]);
      else b.push(tmpW, tint[0], tint[1], tint[2]);
    }
    void k;
  }

  private drawCorpses(now: number) {
    const DUR = 700;
    this.corpses = this.corpses.filter((c) => now - c.t0 < DUR);
    for (const c of this.corpses) {
      const a = assetFor(c.kind);
      const f = (now - c.t0) / DUR;
      const sc = Math.max(0.01, 1 - f * f);
      tmpQ.setFromAxisAngle(UP, -c.face);
      tmpM.compose(tmpV.set(c.x, c.h + f * 0.3, c.y), tmpQ, new THREE.Vector3(sc, sc, sc));
      const team = linColor(teamColor(c.owner));
      const s: AnimState = { phase: 0, moving: 0, t: now / 1000, attack: -1, seed: 0 };
      const white = 1 + f * 3;
      for (let i = 0; i < a.parts.length; i++) {
        const part = a.parts[i];
        partMatrix(tmpL, a, part, s);
        tmpW.multiplyMatrices(tmpM, tmpL);
        const b = this.batch(`${c.kind}:${i}`, part.geo, this.matUnit);
        if (part.tint === "team") b.push(tmpW, team.r * white, team.g * white, team.b * white);
        else b.push(tmpW, white * 1.2, white * 0.6, white * 0.6);
      }
    }
  }

  private projHeight(id: number, air: boolean, x: number, y: number): number {
    const u = this.world.byId.get(id);
    if (u) {
      const k = KINDS[u.kind];
      return this.baseHeight(u, x, y) + (k.height / 1000) * 0.5;
    }
    return this.heights.at(x, y) + (air ? 3.2 : 0.4);
  }

  private drawProjectiles(alpha: number, dt: number) {
    const w = this.world;
    const live = new Set<number>();
    for (const p of w.projectiles) {
      live.add(p.id);
      const x = (p.px + (p.x - p.px) * alpha) / FP;
      const y = (p.py + (p.y - p.py) * alpha) / FP;
      let v = this.proj.get(p.id);
      if (!v) {
        const fx = KINDS[p.kind].weapon!.fx;
        const src = w.byId.get(p.src);
        let sh = this.heights.at(x, y) + (p.fromAir ? 3.2 : 0.5);
        let sx = x;
        let sy = y;
        if (src) {
          const m = this.muzzle(src);
          sx = m.x;
          sy = m.z;
          sh = m.y;
        }
        v = { sx, sy, sh, d0: Math.max(0.1, Math.hypot(p.tx / FP - sx, p.ty / FP - sy)), fx };
        this.proj.set(p.id, v);
      }
      if (!this.seen(x, y)) continue;
      const rem = Math.hypot(p.tx / FP - x, p.ty / FP - y);
      const prog = Math.max(0, Math.min(1, 1 - rem / v.d0));
      const th = this.projHeight(p.target, p.air, p.tx / FP, p.ty / FP);
      const arc = v.fx === "hydro" || v.fx === "leaf" ? Math.sin(prog * Math.PI) * 0.5 : 0;
      const h = v.sh + (th - v.sh) * prog + arc;
      this.effects.trail(v.fx, new THREE.Vector3(x, h, y), dt);
    }
    for (const id of this.proj.keys()) if (!live.has(id)) this.proj.delete(id);
  }

  /** World position attacks come out of. */
  private muzzle(u: Unit): THREE.Vector3 {
    const k = KINDS[u.kind];
    const x = u.x / FP;
    const y = u.y / FP;
    const base = this.baseHeight(u, x, y);
    if (k.structure) return new THREE.Vector3(x, base + (k.height / 1000) * 0.9, y);
    const a = assetFor(u.kind);
    const v = this.vis.get(u.id);
    const face = v ? v.face : 0;
    const m = a.muzzle[u.id % a.muzzle.length] ?? new THREE.Vector3(0, a.height * 0.6, 0);
    tmpQ.setFromAxisAngle(UP, -face);
    return m.clone().applyQuaternion(tmpQ).add(new THREE.Vector3(x, base, y));
  }

  // --------------------------------------------------------- events

  /** Turn sim events into effects (call after every sim step). */
  onEvents(events: SimEvent[], now: number) {
    const w = this.world;
    for (const e of events) {
      switch (e.e) {
        case "hit": {
          const k = KINDS[e.kind];
          const wpn = k.weapon!;
          const x = e.x / FP;
          const y = e.y / FP;
          if (!this.seen(x, y)) break;
          const tu = w.byId.get(e.target);
          const h = tu ? this.baseHeight(tu, x, y) + (KINDS[tu.kind].height / 1000) * 0.5 : this.heights.at(x, y) + (e.air ? 3.2 : 0.3);
          const p = new THREE.Vector3(x, h, y);
          this.effects.impact(wpn.fx, p, wpn.splash / FP);
          if (wpn.speed === 0) {
            const src = w.byId.get(e.src);
            if (src) this.effects.beam(wpn.fx, this.muzzle(src), p);
          }
          break;
        }
        case "death": {
          const k = KINDS[e.kind];
          const x = e.x / FP;
          const y = e.y / FP;
          const v = this.vis.get(e.id);
          if (!this.seen(x, y) && !(this.me !== -1 && w.allied(this.me, e.owner))) break;
          const h = this.heights.at(x, y);
          if (k.structure) {
            if (k.resource === 1) this.effects.sparkle(new THREE.Vector3(x, h + 0.4, y), 0.6, [0.4, 0.8, 1, 1]);
            else if (k.resource === 3) this.effects.smoke(new THREE.Vector3(x, h + 0.5, y), 14, 1.5);
            else this.effects.explode(new THREE.Vector3(x, h, y), Math.max(1, k.w * 0.6));
          } else {
            const base = k.fly ? h + k.fly / 1000 : h;
            this.corpses.push({ kind: e.kind, owner: e.owner, x, y, h: base, face: v?.face ?? 0, t0: now });
            this.effects.faint(new THREE.Vector3(x, base + (k.height / 1000) * 0.5, y), k.height / 1000);
          }
          break;
        }
        case "built":
        case "trained": {
          const u = w.byId.get(e.id);
          if (!u || !this.visible(u)) break;
          const x = u.x / FP;
          const y = u.y / FP;
          const k = KINDS[u.kind];
          this.effects.sparkle(new THREE.Vector3(x, this.baseHeight(u, x, y) + (k.height / 1000) * 0.5, y), e.e === "built" ? 1.6 : 0.6);
          break;
        }
        case "evolved": {
          const u = w.byId.get(e.id);
          if (!u || !this.visible(u)) break;
          const x = u.x / FP;
          const y = u.y / FP;
          this.effects.evolved(new THREE.Vector3(x, this.baseHeight(u, x, y), y), KINDS[u.kind].height / 1000);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------- decals

  private ring(x: number, y: number, h: number, r: number, color: string, alpha: number) {
    const c = linColor(color);
    tmpM.compose(tmpV.set(x, h + 0.06, y), tmpQ.identity(), new THREE.Vector3(r, 1, r));
    this.ringBatch.push(tmpM, c.r * alpha * 1.3, c.g * alpha * 1.3, c.b * alpha * 1.3);
  }

  private drawRings(state: FrameState) {
    const sel = state.selection;
    const push = (u: Unit, a: number) => {
      const p = this.pos(u, state.alpha);
      const k = KINDS[u.kind];
      const r = k.w ? Math.max(k.w, k.h) * 0.62 : u.radius / FP + 0.1;
      const h = k.fly ? this.baseHeight(u, p.x, p.y) - 0.35 : this.heights.at(p.x, p.y);
      const color = sel.isMine(u) ? SELECT_OWN : u.owner === 0 || u.owner === 7 ? SELECT_NEUTRAL : SELECT_ENEMY;
      this.ring(p.x, p.y, h, r, color, a);
    };
    for (const id of sel.ids) {
      const u = this.world.byId.get(id);
      if (u && !u.hidden && (this.visible(u) || KINDS[u.kind].resource)) push(u, 1);
    }
    const hover = this.world.byId.get(state.hoverId);
    if (hover && !sel.has(hover.id) && this.visible(hover)) push(hover, 0.45);
  }

  private drawPlacement(pl: Placement | null) {
    this.tileBatch.begin();
    if (!pl) {
      this.ghost.visible = false;
      this.tileBatch.end();
      return;
    }
    const k = KINDS[pl.kind];
    for (let j = 0; j < k.h; j++)
      for (let i = 0; i < k.w; i++) {
        const x = pl.tx + i + 0.5;
        const y = pl.ty + j + 0.5;
        tmpM.makeTranslation(x, this.heights.at(x, y) + 0.08, y);
        const ok = pl.tiles[j * k.w + i];
        this.tileBatch.push(tmpM, ok ? 0.2 : 1.0, ok ? 1.0 : 0.15, ok ? 0.3 : 0.1);
      }
    this.tileBatch.end();
    if (this.ghostKind !== pl.kind) {
      this.ghost.clear();
      for (const part of assetFor(pl.kind).parts) this.ghost.add(new THREE.Mesh(part.geo, this.ghostMat));
      this.ghostKind = pl.kind;
    }
    const cx = pl.tx + k.w / 2;
    const cy = pl.ty + k.h / 2;
    this.ghost.visible = true;
    this.ghost.position.set(cx, this.heights.at(cx, cy), cy);
    this.ghostMat.color.set(pl.ok ? "#7fe0ff" : "#ff6050");
    this.ghostMat.emissive.set(pl.ok ? "#205080" : "#802010");
  }

  // ---------------------------------------------------------- overlay

  private drawOverlay(state: FrameState) {
    const ctx = this.overlay;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cam.w, this.cam.h);
    this.drawBars(state);
    if (state.showWaypoints) this.drawWaypoints(state);
    this.drawRally(state);
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

  /** SC2-style segmented health bars (damaged, selected or hovered units). */
  private drawBars(state: FrameState) {
    const ctx = this.overlay;
    const sel = new Set(state.selection.ids);
    const w = this.world;
    for (const u of w.units) {
      const k = KINDS[u.kind];
      if (u.hidden || (k.resource && k.resource !== 3)) continue;
      if (!this.visible(u)) continue;
      const damaged = u.hp < k.hp;
      const building = k.structure && u.progress < k.time;
      const morph = u.morphTo >= 0;
      if (!(state.bars === "always" || damaged || sel.has(u.id) || u.id === state.hoverId || building || morph)) continue;
      const p = this.pos(u, state.alpha);
      const top = this.baseHeight(u, p.x, p.y) + k.height / 1000 + 0.25;
      const s = this.cam.project(p.x, top, p.y);
      if (s.x < -50 || s.y < -20 || s.x > this.cam.w + 50 || s.y > this.cam.h - this.cam.consoleH + 10) continue;
      const bw = Math.max(22, Math.min(90, k.structure ? k.w * 14 : 16 + k.hp / 9));
      const x = Math.round(s.x - bw / 2);
      const y = Math.round(s.y);
      const f = Math.max(0, Math.min(1, u.hp / k.hp));
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(x - 1, y - 1, bw + 2, 6);
      ctx.fillStyle = f > 0.5 ? "#3be04b" : f > 0.25 ? "#f2d22e" : "#f0402e";
      ctx.fillRect(x, y, Math.max(1, bw * f), 4);
      // Segments every 25 hp (SC2 draws ticks like these).
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      const seg = k.hp > 600 ? 100 : 25;
      for (let hp = seg; hp < k.hp; hp += seg) ctx.fillRect(x + Math.round((bw * hp) / k.hp), y, 1, 4);
      if (building || morph) {
        const pr = building ? u.progress / k.time : u.morphT / Math.max(1, u.morphTotal);
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.fillRect(x - 1, y + 5, bw + 2, 4);
        ctx.fillStyle = morph ? "#ffffff" : "#5ad0ff";
        ctx.fillRect(x, y + 6, bw * pr, 2);
      }
    }
  }

  private drawWaypoints(state: FrameState) {
    const ctx = this.overlay;
    ctx.lineWidth = 1.5;
    for (const u of state.selection.units()) {
      if (!state.selection.isMine(u) || u.orders.length === 0) continue;
      const p = this.pos(u, state.alpha);
      const h = this.baseHeight(u, p.x, p.y);
      let last = this.cam.project(p.x, h + 0.05, p.y);
      for (const o of u.orders) {
        const color =
          o.mode === MODE_ATTACK || o.mode === MODE_ATTACK_UNIT
            ? "rgba(255,70,60,0.8)"
            : o.mode === MODE_PATROL
              ? "rgba(255,220,60,0.8)"
              : o.mode === MODE_GATHER || o.mode === MODE_RETURN || o.mode === MODE_BUILD
                ? "rgba(90,200,255,0.8)"
                : "rgba(60,255,90,0.8)";
        let tx = o.x / FP;
        let ty = o.y / FP;
        if (o.target) {
          const t = this.world.byId.get(o.target);
          if (t) {
            tx = t.x / FP;
            ty = t.y / FP;
          }
        }
        const next = this.cam.project(tx, this.heights.at(tx, ty) + 0.05, ty);
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

  private drawRally(state: FrameState) {
    const ctx = this.overlay;
    for (const u of state.selection.units()) {
      if (!state.selection.isMine(u) || !KINDS[u.kind].structure || (!u.rallyX && !u.rallyId)) continue;
      const r = u.rallyId ? this.world.byId.get(u.rallyId) : undefined;
      const rx = (r ? r.x : u.rallyX) / FP;
      const ry = (r ? r.y : u.rallyY) / FP;
      const a = this.cam.project(u.x / FP, this.heights.at(u.x / FP, u.y / FP) + 0.3, u.y / FP);
      const b = this.cam.project(rx, this.heights.at(rx, ry) + 0.05, ry);
      ctx.strokeStyle = "rgba(90,255,110,0.75)";
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#5aff6e";
      ctx.fillRect(b.x, b.y - 14, 2, 14);
      ctx.beginPath();
      ctx.moveTo(b.x + 2, b.y - 14);
      ctx.lineTo(b.x + 11, b.y - 10);
      ctx.lineTo(b.x + 2, b.y - 6);
      ctx.fill();
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
      const gh = this.heights.at(m.x, m.y) + 0.05;
      ctx.strokeStyle = m.color;
      ctx.globalAlpha = 1 - t * t;
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const cx = m.x + Math.cos(a) * d;
        const cy = m.y + Math.sin(a) * d;
        const w = 0.22;
        const p1 = this.cam.project(cx + Math.cos(a + 2.4) * w, gh, cy + Math.sin(a + 2.4) * w);
        const p2 = this.cam.project(cx, gh, cy);
        const p3 = this.cam.project(cx + Math.cos(a - 2.4) * w, gh, cy + Math.sin(a - 2.4) * w);
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
    const k = KINDS[u.kind];
    const base = this.baseHeight(u, p.x, p.y);
    const r = k.w ? Math.max(k.w, k.h) * 0.45 : u.radius / FP;
    const top = this.cam.project(p.x, base + (k.height / 1000) * 0.9, p.y);
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
      if (u.hidden || !this.pickable(u)) continue;
      const { top, bottom, rpx } = this.screenShape(u, alpha);
      const vx = top.x - bottom.x;
      const vy = top.y - bottom.y;
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((sx - bottom.x) * vx + (sy - bottom.y) * vy) / len2));
      const d = Math.hypot(sx - (bottom.x + vx * t), sy - (bottom.y + vy * t));
      if (d > rpx * 1.1 + 2) continue;
      const score = bottom.depth - (u.air ? 1000 : 0) + (KINDS[u.kind].structure ? 500 : 0);
      if (score < bestScore) {
        best = u;
        bestScore = score;
      }
    }
    return best;
  }

  private pickable(u: Unit): boolean {
    const k = KINDS[u.kind];
    if (k.resource) return this.explored(Math.floor(u.x / FP), Math.floor(u.y / FP)) && !(u.kind === K_GEYSER && u.link);
    return this.visible(u);
  }

  /** Units whose on-screen body touches a screen rectangle. */
  pickBox(x0: number, y0: number, x1: number, y1: number, alpha: number): Unit[] {
    const ax = Math.min(x0, x1);
    const bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1);
    const by = Math.max(y0, y1);
    return this.world.units.filter((u) => {
      if (u.hidden || KINDS[u.kind].resource || !this.visible(u)) return false;
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
  private iconScene: THREE.Scene | null = null;

  /** Render a unit model to a small transparent PNG (wireframe icons, command card). */
  unitIcon(kind: number, owner: number, size: number): string {
    const key = `${kind}:${owner}:${size}`;
    const hit = this.iconCache.get(key);
    if (hit) return hit;
    const px = Math.round(size * this.dpr);
    if (!this.iconScene) {
      this.iconScene = new THREE.Scene();
      this.iconScene.add(new THREE.HemisphereLight("#dfeaff", "#40362a", 1.6));
      const d = new THREE.DirectionalLight("#ffffff", 2.2);
      d.position.set(2, 3, 4);
      this.iconScene.add(d);
    }
    const sc = this.iconScene;
    const group = new THREE.Group();
    const a = assetFor(kind);
    const team = linColor(teamColor(owner));
    const fac = this.factionColor(owner);
    const s: AnimState = { phase: 0, moving: 0, t: 0, attack: -1, seed: 0 };
    for (const part of a.parts) {
      const m = unitMaterial(false);
      if (part.tint === "team") m.color = team;
      if (part.tint === "faction") m.color = fac;
      const mesh = new THREE.Mesh(part.geo, m);
      mesh.matrixAutoUpdate = false;
      partMatrix(mesh.matrix, a, part, s);
      group.add(mesh);
    }
    const k = KINDS[kind];
    group.rotation.y = k.structure ? -0.5 : -Math.PI / 2 + 0.7;
    sc.add(group);
    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() * 0.5;
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    const dist = r / Math.sin((15 * Math.PI) / 180);
    cam.position.set(c.x, c.y + dist * 0.35, c.z + dist * 0.94);
    cam.lookAt(c);
    const rt = new THREE.WebGLRenderTarget(px, px, { samples: 4 });
    const prevTarget = this.three.getRenderTarget();
    const prevBg = sc.background;
    sc.background = null;
    this.three.setRenderTarget(rt);
    this.three.setClearColor(0x000000, 0);
    this.three.clear();
    this.three.render(sc, cam);
    const pixels = new Uint8Array(px * px * 4);
    this.three.readRenderTargetPixels(rt, 0, 0, px, px, pixels);
    this.three.setRenderTarget(prevTarget);
    sc.background = prevBg;
    sc.remove(group);
    rt.dispose();
    for (const ch of group.children) ((ch as THREE.Mesh).material as THREE.Material).dispose();
    const cv = document.createElement("canvas");
    cv.width = px;
    cv.height = px;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(px, px);
    for (let y = 0; y < px; y++) img.data.set(pixels.subarray((px - 1 - y) * px * 4, (px - y) * px * 4), y * px * 4);
    ctx.putImageData(img, 0, 0);
    const url = cv.toDataURL();
    this.iconCache.set(key, url);
    return url;
  }
}

/**
 * Live 3D portrait (SC2's talking-head window): the selected unit idling on
 * its own small canvas.
 */
export class Portrait {
  private three: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(26, 150 / 160, 0.1, 50);
  private group = new THREE.Group();
  private key = "";
  private asset: Asset | null = null;
  private meshes: { mesh: THREE.Mesh; part: Asset["parts"][number] }[] = [];
  private mixer: THREE.AnimationMixer | null = null;
  private last = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private models: GltfModels | null = null,
  ) {
    this.three = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.three.toneMapping = THREE.ACESFilmicToneMapping;
    this.three.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene.add(new THREE.HemisphereLight("#d6e6ff", "#2a2218", 1.4));
    const key = new THREE.DirectionalLight("#fff0dd", 2.4);
    key.position.set(2, 3, 3);
    const rim = new THREE.DirectionalLight("#6fc8ff", 1.8);
    rim.position.set(-3, 1, -2);
    this.scene.add(key, rim, this.group);
  }

  show(kind: number, owner: number, faction: string) {
    const key = kind < 0 ? "" : `${kind}:${owner}`;
    if (key === this.key) return;
    this.key = key;
    this.group.clear();
    this.meshes = [];
    this.asset = null;
    this.mixer = null;
    if (kind < 0) return;
    if (this.models?.has(kind)) {
      const inst = this.models.instance(kind);
      this.group.add(inst.root);
      this.mixer = inst.mixer;
    }
    const a = assetFor(kind);
    if (!this.mixer && !this.models?.has(kind)) this.asset = a;
    for (const part of this.models?.has(kind) ? [] : a.parts) {
      const m = unitMaterial(false);
      if (part.tint === "team") m.color = linColor(teamColor(owner));
      if (part.tint === "faction") m.color = linColor(faction);
      const mesh = new THREE.Mesh(part.geo, m);
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.meshes.push({ mesh, part });
    }
    const k = KINDS[kind];
    this.group.rotation.y = k.structure ? -0.6 : -Math.PI / 2 + 0.55;
    const box = new THREE.Box3().setFromObject(this.group);
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // Frame the head and shoulders of Pokémon, the whole building otherwise.
    const focusY = k.structure ? c.y : box.max.y - Math.min(size.y * 0.42, 0.55 + size.y * 0.1);
    const r = k.structure ? size.length() * 0.55 : Math.max(0.35, size.y * 0.42);
    const dist = r / Math.tan((13 * Math.PI) / 180);
    this.cam.position.set(c.x, focusY + dist * 0.18, c.z + dist);
    this.cam.lookAt(c.x, focusY, c.z);
  }

  render(now: number) {
    this.mixer?.update(Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== Math.round(w * this.three.getPixelRatio())) {
      this.three.setSize(w, h, false);
      this.cam.aspect = w / h;
      this.cam.updateProjectionMatrix();
    }
    if (this.asset) {
      const s: AnimState = { phase: 0, moving: 0, t: now / 1000, attack: -1, seed: 1 };
      const off = bodyOffset(this.asset, s);
      const m4 = new THREE.Matrix4();
      for (const { mesh, part } of this.meshes) {
        partMatrix(m4, this.asset, part, s);
        mesh.matrix.makeTranslation(0, off.y, 0).multiply(m4);
      }
      this.group.rotation.y += Math.sin(now / 1700) * 0.0015;
    }
    this.three.render(this.scene, this.cam);
  }
}

void K_EXTRACTOR;
