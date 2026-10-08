import * as THREE from "three";
import { KINDS } from "../sim/units.ts";
import { type Asset, assetFor } from "./render/assets.ts";
import { type AnimState, bodyOffset, partMatrix } from "./render/animate.ts";
import { unitMaterial } from "./render/materials.ts";

/**
 * Model viewer (viewer.html): every Pokémon and structure on a turntable,
 * walking. Handy for sculpting the models in src/client/render/pokemon.ts.
 * ?only=charizard shows one model up close; ?walk=0 stops the walk cycle.
 */

const q = new URLSearchParams(location.search);
const only = q.get("only");
const walk = q.get("walk") !== "0";

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#2b3a42");
scene.add(new THREE.HemisphereLight("#cfe3ff", "#5a4a38", 1.1));
const sun = new THREE.DirectionalLight("#fff3e0", 2.6);
sun.position.set(-6, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: "#5d6b4a", roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const mat = unitMaterial(false);
const team = new THREE.Color("#e0262f");

interface Item {
  root: THREE.Group;
  asset: Asset;
  meshes: { mesh: THREE.Mesh; part: Asset["parts"][number] }[];
}
const items: Item[] = [];
const spin = q.get("spin") !== "0";
const kinds = KINDS.filter((k) => (only ? k.key === only : true)).sort((a, b) => Number(a.structure) - Number(b.structure));
const t0 = performance.now();
let x = 0;
let row = 0;
for (const k of kinds) {
  const asset = assetFor(k.id);
  const root = new THREE.Group();
  const meshes = asset.parts.map((part) => {
    const m = mat.clone();
    if (part.tint === "team") m.color = team;
    if (part.tint === "faction") m.color = new THREE.Color("#ff7a2e");
    const mesh = new THREE.Mesh(part.geo, m);
    mesh.castShadow = true;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    return { mesh, part };
  });
  const width = k.structure ? Math.max(2, k.w + 0.6) : Math.max(1.2, asset.radius * 1.3);
  if (!only && k.structure && row === 0) {
    row = 1;
    x = 0;
  }
  root.position.set(x + width / 2 - (only ? width / 2 : row ? 12 : 6.5), 0, row ? -5 : 1.5);
  x += width;
  scene.add(root);
  items.push({ root, asset, meshes });
}
console.log(`built ${items.length} models in ${(performance.now() - t0).toFixed(0)} ms`);

const camera = new THREE.PerspectiveCamera(only ? 30 : 38, innerWidth / innerHeight, 0.1, 200);
if (only) camera.position.set(0, 1.4, 4.2);
else camera.position.set(0, 9, 16);
camera.lookAt(0, only ? 0.55 : 0, only ? 0 : -1);

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

const m4 = new THREE.Matrix4();
function frame(now: number) {
  const t = now / 1000;
  for (const [i, it] of items.entries()) {
    it.root.rotation.y = spin ? t * 0.4 + i : -Math.PI / 2 + 0.5;
    const s: AnimState = { phase: walk ? t * 9 : 0, moving: walk ? 1 : 0, t, attack: (t * 0.8 + i * 0.3) % 2 < 1 ? -1 : ((t * 0.8 + i * 0.3) % 1), seed: i };
    const off = bodyOffset(it.asset, s);
    for (const { mesh, part } of it.meshes) {
      partMatrix(m4, it.asset, part, s);
      mesh.matrix.makeTranslation(off.x, off.y, 0).multiply(m4);
    }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
