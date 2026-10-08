import * as THREE from "three";
import { KINDS } from "../sim/units.ts";
import { type GameMap, makeMap } from "../sim/map.ts";
import { assetFor } from "./render/assets.ts";
import { type AnimState, partMatrix } from "./render/animate.ts";
import { unitMaterial } from "./render/materials.ts";

/**
 * Pictures for the lobby: Pokémon portraits rendered from the game's own
 * models, and preview images of built-in maps (imported maps bring a minimap).
 */

let renderer: THREE.WebGLRenderer | null = null;
const cache = new Map<string, string>();

/** A transparent PNG of a Pokémon, three-quarter view, scarf in `color`. */
export function pokemonPicture(key: string, color: string, size = 128): string {
  const id = `${key}:${color}:${size}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const kind = KINDS.find((k) => k.key === key);
  if (!kind) return "";
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
  }
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#dfeaff", "#40362a", 1.6));
  const sun = new THREE.DirectionalLight("#ffffff", 2.4);
  sun.position.set(2, 3, 4);
  scene.add(sun);
  const group = new THREE.Group();
  const a = assetFor(kind.id);
  const s: AnimState = { phase: 0, moving: 0, t: 0, attack: -1, seed: 0 };
  const mats: THREE.Material[] = [];
  for (const part of a.parts) {
    const m = unitMaterial(false);
    if (part.tint === "team") m.color = new THREE.Color(color);
    mats.push(m);
    const mesh = new THREE.Mesh(part.geo, m);
    mesh.matrixAutoUpdate = false;
    partMatrix(mesh.matrix, a, part, s);
    group.add(mesh);
  }
  group.rotation.y = -Math.PI / 2 + 0.6;
  scene.add(group);
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() * 0.5;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const dist = r / Math.sin((15 * Math.PI) / 180);
  cam.position.set(c.x, c.y + dist * 0.3, c.z + dist * 0.95);
  cam.lookAt(c);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL();
  for (const m of mats) m.dispose();
  cache.set(id, url);
  return url;
}

/** Overview image of a built-in map: levels, cliffs, resources and start locations. */
export function builtinMapPicture(key: string, px = 150): string {
  const id = `map:${key}:${px}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const m: GameMap = makeMap(key);
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const ctx = c.getContext("2d")!;
  const s = Math.min(px / m.w, px / m.h);
  const ox = (px - m.w * s) / 2;
  const oy = (px - m.h * s) / 2;
  const img = ctx.createImageData(px, px);
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px; x++) {
      const tx = Math.floor((x - ox) / s);
      const ty = Math.floor((y - oy) / s);
      const o = (y * px + x) * 4;
      img.data[o + 3] = 255;
      if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) continue;
      const i = ty * m.w + tx;
      const lv = m.level[i] / 16;
      const blocked = m.terrain[i];
      img.data[o] = blocked ? 32 : 70 + lv * 22;
      img.data[o + 1] = blocked ? 34 : 78 + lv * 24;
      img.data[o + 2] = blocked ? 30 : 52 + lv * 8;
    }
  ctx.putImageData(img, 0, 0);
  for (const o of m.objects) {
    ctx.fillStyle = o.kind === "geyser" ? "#4cff6a" : o.kind.startsWith("rock") ? "#8a7f6e" : o.kind === "tower" ? "#7ff4ff" : "#5ad0ff";
    ctx.fillRect(ox + o.tx * s, oy + o.ty * s, Math.max(1.5, 2 * s), Math.max(1.5, s));
  }
  const colors = ["#e0262f", "#1f6dff", "#1cc5d6", "#9a3be0"];
  m.starts.forEach((st, i) => {
    ctx.fillStyle = colors[i % colors.length];
    ctx.beginPath();
    ctx.arc(ox + (st.x + 0.5) * s, oy + (st.y + 0.5) * s, Math.max(3, 3 * s), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();
  });
  const url = c.toDataURL();
  cache.set(id, url);
  return url;
}
