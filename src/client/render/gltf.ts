import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { KINDS } from "../../sim/units.ts";

/**
 * Optional real models. Drop `<kind>.glb` files (e.g. `charizard.glb`) into
 * assets-private/models/ and they replace the sculpted placeholders. Clips
 * are matched by name: idle/stand/wait, walk/run/move, attack/atk/hit.
 * An optional assets-private/models/models.json tunes each model:
 *   { "charizard": { "scale": 1.2, "yaw": 90, "y": 0.1 } }
 * (scale multiplies the automatic fit, yaw is in degrees, y lifts the model in tiles).
 */

interface Loaded {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  /** Normalising transform: fits the model to the unit's height and faces it along +X. */
  scale: number;
  yaw: number;
  y: number;
}

export interface GltfInstance {
  root: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  idle: THREE.AnimationAction | null;
  walk: THREE.AnimationAction | null;
  attack: THREE.AnimationAction | null;
  current: THREE.AnimationAction | null;
  lastAttack: number;
}

const pick = (clips: THREE.AnimationClip[], re: RegExp) => clips.find((c) => re.test(c.name)) ?? null;

export class GltfModels {
  private loaded = new Map<number, Loaded>();

  /** Fetch the list of available models from the server and load them. Missing models are fine. */
  async loadAll(): Promise<void> {
    let names: string[] = [];
    let tune: Record<string, { scale?: number; yaw?: number; y?: number }> = {};
    try {
      const r = await fetch("/api/models");
      if (r.ok) names = (await r.json()) as string[];
    } catch {
      return;
    }
    if (!names.length) return;
    try {
      const r = await fetch("/assets/models/models.json");
      if (r.ok) tune = await r.json();
    } catch {
      /* optional */
    }
    const loader = new GLTFLoader();
    await Promise.all(
      names.map(async (file) => {
        const key = file.replace(/\.(glb|gltf)$/i, "").toLowerCase();
        const kind = KINDS.find((k) => k.key === key);
        if (!kind) return;
        try {
          const gltf = await loader.loadAsync(`/assets/models/${encodeURIComponent(file)}`);
          const scene = gltf.scene;
          scene.traverse((o) => {
            if ((o as THREE.Mesh).isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
          // Fit: the model's height becomes the unit's visual height.
          const box = new THREE.Box3().setFromObject(scene);
          const size = box.getSize(new THREE.Vector3());
          const want = (kind.height / 1000) * (kind.structure ? 1 : 1.05);
          const t = tune[key] ?? {};
          const scale = (want / Math.max(0.001, size.y)) * (t.scale ?? 1);
          scene.position.y = -box.min.y;
          const wrap = new THREE.Group();
          wrap.add(scene);
          this.loaded.set(kind.id, { scene: wrap, clips: gltf.animations, scale, yaw: ((t.yaw ?? 90) * Math.PI) / 180, y: t.y ?? 0 });
          console.info(`model: ${file} -> ${kind.name} (${gltf.animations.length} animations: ${gltf.animations.map((a) => a.name).join(", ")})`);
        } catch (e) {
          console.warn(`couldn't load model ${file}`, e);
        }
      }),
    );
  }

  has(kind: number): boolean {
    return this.loaded.has(kind);
  }

  /** A new animated copy of a model. */
  instance(kind: number): GltfInstance {
    const l = this.loaded.get(kind)!;
    const inner = cloneSkinned(l.scene);
    inner.scale.setScalar(l.scale);
    inner.rotation.y = l.yaw;
    inner.position.y = l.y;
    const root = new THREE.Group();
    root.add(inner);
    let mixer: THREE.AnimationMixer | null = null;
    let idle: THREE.AnimationAction | null = null;
    let walk: THREE.AnimationAction | null = null;
    let attack: THREE.AnimationAction | null = null;
    if (l.clips.length) {
      mixer = new THREE.AnimationMixer(inner);
      const c = l.clips;
      const idleClip = pick(c, /idle|stand|wait|breath/i) ?? c[0];
      const walkClip = pick(c, /walk|run|move|locomot/i);
      const atkClip = pick(c, /attack|atk|hit|strike|bite|shoot/i);
      idle = mixer.clipAction(idleClip);
      if (walkClip) walk = mixer.clipAction(walkClip);
      if (atkClip) {
        attack = mixer.clipAction(atkClip);
        attack.setLoop(THREE.LoopOnce, 1);
        attack.clampWhenFinished = false;
      }
      idle.play();
    }
    return { root, mixer, idle, walk, attack, current: idle, lastAttack: -1 };
  }
}

/** Keeps one animated model per visible unit, created and removed as units come and go. */
export class GltfUnits {
  private live = new Map<number, GltfInstance & { kind: number; seen: boolean }>();
  readonly group = new THREE.Group();

  constructor(private models: GltfModels) {}

  begin() {
    for (const v of this.live.values()) v.seen = false;
  }

  draw(id: number, kind: number, x: number, h: number, y: number, face: number, moving: number, attackTick: number, dt: number) {
    let v = this.live.get(id);
    if (v && v.kind !== kind) {
      this.group.remove(v.root);
      this.live.delete(id);
      v = undefined;
    }
    if (!v) {
      v = { ...this.models.instance(kind), kind, seen: true };
      this.live.set(id, v);
      this.group.add(v.root);
    }
    v.seen = true;
    v.root.position.set(x, h, y);
    v.root.rotation.y = -face;
    v.root.scale.setScalar(1);
    // Crossfade between idle and walk; play attack once per swing.
    const want = moving > 0.3 && v.walk ? v.walk : v.idle;
    if (want && want !== v.current && v.current !== v.attack) {
      want.reset().fadeIn(0.15).play();
      v.current?.fadeOut(0.15);
      v.current = want;
    }
    if (v.attack && attackTick !== v.lastAttack) {
      v.lastAttack = attackTick;
      v.attack.reset().setEffectiveWeight(1).fadeIn(0.05).play();
    }
    v.mixer?.update(dt);
  }

  end() {
    for (const [id, v] of this.live) {
      if (v.seen) continue;
      this.group.remove(v.root);
      this.live.delete(id);
    }
  }
}
