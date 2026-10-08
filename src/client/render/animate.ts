import * as THREE from "three";
import type { Asset, AssetPart } from "./assets.ts";

/** Per-unit animation inputs, all presentation-side. */
export interface AnimState {
  /** Walk cycle phase (radians), advanced by distance travelled. */
  phase: number;
  /** 0 = standing, 1 = walking at full speed. */
  moving: number;
  /** Seconds (wall clock). */
  t: number;
  /** Attack swing progress 0..1, or -1 when not attacking. */
  attack: number;
  /** Per-unit random offset so idle animations aren't in sync. */
  seed: number;
}

const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);

function rotateAbout(out: THREE.Matrix4, pivot: THREE.Vector3, rx: number, ry: number, rz: number) {
  tmpE.set(rx, ry, rz);
  tmpQ.setFromEuler(tmpE);
  out.makeTranslation(pivot.x, pivot.y, pivot.z);
  tmpM.compose(tmpV.set(0, 0, 0), tmpQ, ONE);
  out.multiply(tmpM);
  tmpM.makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  out.multiply(tmpM);
  return out;
}

/** Local matrix of one part (model space) for the current animation state. */
export function partMatrix(out: THREE.Matrix4, a: Asset, part: AssetPart, s: AnimState): THREE.Matrix4 {
  const h = a.height;
  const sw = Math.sin(s.phase) * s.moving;
  const atk = s.attack >= 0 ? Math.sin(Math.PI * s.attack) : 0;
  switch (part.anim) {
    case "legA":
    case "legB": {
      const k = part.anim === "legA" ? 1 : -1;
      return rotateAbout(out, part.pivot, 0, 0, sw * 0.6 * k);
    }
    case "armA":
    case "armB": {
      const k = part.anim === "armA" ? 1 : -1;
      return rotateAbout(out, part.pivot, 0, 0, -sw * 0.5 * k + atk * 1.1);
    }
    case "tail":
      return rotateAbout(out, part.pivot, 0, Math.sin(s.t * 2.4 + s.seed) * 0.22 + sw * 0.25, Math.sin(s.t * 1.7 + s.seed) * 0.05);
    case "wingL":
    case "wingR": {
      const flap = 0.25 + 0.6 * Math.sin(s.t * 6.5 + s.seed);
      return rotateAbout(out, part.pivot, part.anim === "wingL" ? -flap : flap, 0, 0);
    }
    case "spin": {
      out.makeRotationY(s.t * 1.1 + s.seed);
      out.setPosition(part.pivot.x, part.pivot.y + Math.sin(s.t * 1.8 + s.seed) * 0.12, part.pivot.z);
      return out;
    }
    default:
      return out.identity();
  }
}

/** Whole-model offset: walk bob, idle breathing, attack lunge, hover. */
export function bodyOffset(a: Asset, s: AnimState): { y: number; x: number; sy: number } {
  const h = a.height;
  const breathe = Math.sin(s.t * 2.1 + s.seed) * 0.012;
  const atk = s.attack >= 0 ? Math.sin(Math.PI * s.attack) : 0;
  let y = 0;
  if (a.gait === "biped") y = Math.abs(Math.sin(s.phase)) * 0.035 * h * s.moving;
  else if (a.gait === "quad") y = Math.abs(Math.sin(s.phase * 2)) * 0.018 * h * s.moving;
  else if (a.gait === "fly") y = Math.sin(s.t * 2.2 + s.seed) * 0.12;
  return { y, x: atk * 0.07 * Math.max(0.6, h), sy: 1 + (a.gait === "static" ? 0 : breathe) };
}
