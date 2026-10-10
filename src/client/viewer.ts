import * as THREE from "three";
import { FP } from "../sim/fixed.ts";
import { FACTION_NAMES, FACTION_UNITS, FACTION_WORKERS, KINDS, TYPE_NAMES, type UnitKind } from "../sim/units.ts";
import { type Asset, assetFor } from "./render/assets.ts";
import { type AnimState, bodyOffset, partMatrix } from "./render/animate.ts";
import { unitMaterial } from "./render/materials.ts";

/**
 * Pokédex (viewer.html): every Pokémon and structure on its own card with a
 * live 3D model, grouped by faction (worker, then the evolution line), then
 * buildings and map objects. The grid wraps to the window, so nothing runs off
 * screen. All models are drawn by one WebGL canvas behind the page, one
 * scissored viewport per visible card.
 *
 * ?only=charizard shows one model up close (handy while sculpting
 * src/client/render/pokemon.ts); ?walk=0 stops the walk cycle, ?spin=0 the turntable.
 */

const q = new URLSearchParams(location.search);
const only = q.get("only");
const walk = q.get("walk") !== "0";
const spin = q.get("spin") !== "0";

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.setClearColor(0x000000, 0);
const canvas = renderer.domElement;
canvas.className = "dex-canvas";
document.body.prepend(canvas);

const mat = unitMaterial(false);
const TEAM = new THREE.Color("#e0262f");
const FACTION_COLOR = ["#f0703a", "#4a9cf0", "#4fbf6a", "#f5c542"];

interface Card {
  kind: UnitKind;
  stage: HTMLElement | null;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  root: THREE.Group;
  asset: Asset;
  meshes: { mesh: THREE.Mesh; part: Asset["parts"][number] }[];
  seed: number;
}

/** A scene with one model, lit like the game, and a camera that fits it. */
function makeCard(kind: UnitKind, stage: HTMLElement | null, seed: number, closeUp = false): Card {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#cfe3ff", "#5a4a38", 1.2));
  const sun = new THREE.DirectionalLight("#fff3e0", 2.4);
  sun.position.set(-3, 6, 4);
  scene.add(sun);
  const asset = assetFor(kind.id);
  const root = new THREE.Group();
  const meshes = asset.parts.map((part) => {
    const m = mat.clone();
    if (part.tint === "team") m.color = TEAM;
    if (part.tint === "faction") m.color = new THREE.Color("#ff7a2e");
    const mesh = new THREE.Mesh(part.geo, m);
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    return { mesh, part };
  });
  scene.add(root);
  // A soft disc to stand on.
  if (!closeUp) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(asset.radius * 1.15, 48), new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.22 }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.002;
    scene.add(disc);
  }
  // Fit the camera to the model's size (flying units hover, so include that).
  const h = Math.max(asset.height, 0.3);
  const r = Math.max(asset.radius, h * 0.6);
  const camera = new THREE.PerspectiveCamera(closeUp ? 30 : 32, 1, 0.05, 200);
  if (closeUp) {
    // The original close-up framing, so screenshots stay comparable.
    camera.position.set(0, 1.4, 4.2);
    camera.lookAt(0, 0.55, 0);
  } else {
    // Pokémon get framed a little tighter than buildings; their radius includes tails and wings.
    const dist = (r / Math.sin((16 * Math.PI) / 180)) * (kind.structure ? 1.05 : 0.82);
    const look = new THREE.Vector3(0, h * 0.45, 0);
    camera.position.set(0, look.y + dist * 0.32, dist * 0.95);
    camera.lookAt(look);
  }
  return { kind, stage, scene, camera, root, asset, meshes, seed };
}

function animate(c: Card, t: number) {
  c.root.rotation.y = spin ? t * 0.45 + c.seed : -Math.PI / 2 + 0.5;
  const moving = walk && !c.kind.structure ? 1 : 0;
  const s: AnimState = {
    phase: moving ? t * 9 : 0,
    moving,
    t,
    attack: (t * 0.8 + c.seed * 0.3) % 2 < 1 ? -1 : (t * 0.8 + c.seed * 0.3) % 1,
    seed: c.seed,
  };
  const off = bodyOffset(c.asset, s);
  const m4 = new THREE.Matrix4();
  for (const { mesh, part } of c.meshes) {
    partMatrix(m4, c.asset, part, s);
    mesh.matrix.makeTranslation(off.x, off.y, 0).multiply(m4);
  }
}

// ------------------------------------------------------------- close-up

if (only) {
  document.body.classList.add("dex-only");
  const kind = KINDS.find((k) => k.key === only);
  if (kind) {
    const card = makeCard(kind, null, 0, true);
    card.scene.background = new THREE.Color("#2b3a42");
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: "#5d6b4a", roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    card.scene.add(ground);
    const fit = () => {
      renderer.setSize(innerWidth, innerHeight);
      card.camera.aspect = innerWidth / innerHeight;
      card.camera.updateProjectionMatrix();
    };
    fit();
    addEventListener("resize", fit);
    const frame = (now: number) => {
      animate(card, now / 1000);
      renderer.render(card.scene, card.camera);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
} else {
  buildDex();
}

// ------------------------------------------------------------- the dex

function esc(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** Short stat lines for a card. */
function stats(k: UnitKind): string {
  const rows: [string, string][] = [];
  if (k.resource) {
    const what = ["", "Workers mine minerals here", "Build an Extractor on it to mine gas", "Blocks paths until destroyed", "Stand next to it to see far"][k.resource];
    return `<p class="dex-note">${what}</p>`;
  }
  rows.push(["HP", String(k.hp)]);
  if (k.weapon) {
    const w = k.weapon;
    const range = w.range / FP;
    rows.push(["Move", `${esc(w.name)} · ${w.damage} dmg`]);
    rows.push(["Range", range <= 0.2 ? "Melee" : `${+range.toFixed(1)}`]);
    rows.push(["Hits", w.ground && w.air ? "Ground & air" : w.air ? "Air" : "Ground"]);
  }
  if (k.m || k.g) rows.push(["Cost", `${k.m} minerals${k.g ? ` · ${k.g} gas` : ""}`]);
  if (k.ref) rows.push(["Plays like", esc(k.ref)]);
  return `<dl class="dex-stats">${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>`;
}

function typeChips(k: UnitKind): string {
  if (k.structure) return "";
  return `<span class="dex-types">${k.types.map((t) => `<i class="ty ty-${TYPE_NAMES[t]}">${TYPE_NAMES[t]}</i>`).join("")}</span>`;
}

function buildDex() {
  const main = document.getElementById("dex")!;
  const sections: { title: string; color?: string; sub?: string; kinds: UnitKind[] }[] = [];
  for (let f = 0; f < FACTION_NAMES.length; f++) {
    const line: UnitKind[] = [KINDS[FACTION_WORKERS[f]]];
    let k: UnitKind | undefined = KINDS[FACTION_UNITS[f][0]];
    while (k) {
      line.push(k);
      k = k.evolve ? KINDS[k.evolve.to] : undefined;
    }
    sections.push({ title: FACTION_NAMES[f], color: FACTION_COLOR[f], sub: "Worker, then the evolution line", kinds: line });
  }
  sections.push({ title: "Buildings", sub: "Every faction builds the same structures", kinds: KINDS.filter((k) => k.structure && !k.resource) });
  sections.push({ title: "Map objects", kinds: KINDS.filter((k) => k.resource) });

  const cards: Card[] = [];
  main.innerHTML = sections
    .map(
      (s) => `<section class="dex-section" style="--fc:${s.color ?? "#8b97a4"}">
        <h2>${s.color ? "<i class='dot'></i>" : ""}${esc(s.title)}${s.sub ? `<small>${esc(s.sub)}</small>` : ""}</h2>
        <div class="dex-grid">${s.kinds
          .map(
            (k) => `<article class="dex-card" data-id="${k.id}">
              <div class="dex-stage"></div>
              <div class="dex-info">
                <h3>${esc(k.name)}${k.worker ? `<span class="tag">Worker</span>` : k.stage ? `<span class="tag">Stage ${k.stage}</span>` : ""}</h3>
                ${typeChips(k)}
                ${stats(k)}
              </div>
            </article>`,
          )
          .join("")}</div>
      </section>`,
    )
    .join("");
  let seed = 0;
  for (const el of main.querySelectorAll<HTMLElement>(".dex-card")) {
    const kind = KINDS[Number(el.dataset.id)];
    cards.push(makeCard(kind, el.querySelector(".dex-stage"), seed++));
  }

  const size = new THREE.Vector2();
  const frame = (now: number) => {
    const t = now / 1000;
    renderer.getSize(size);
    if (size.x !== innerWidth || size.y !== innerHeight) renderer.setSize(innerWidth, innerHeight, false);
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    for (const c of cards) {
      const r = c.stage!.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      animate(c, t);
      const y = innerHeight - r.bottom;
      renderer.setViewport(r.left, y, r.width, r.height);
      renderer.setScissor(r.left, y, r.width, r.height);
      c.camera.aspect = r.width / r.height;
      c.camera.updateProjectionMatrix();
      renderer.render(c.scene, c.camera);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
