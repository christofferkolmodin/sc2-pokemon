import type { Prim, V3 } from "./sdf.ts";

/**
 * Sculpted Pokémon. Every model faces +X, stands on y = 0 and is sized in
 * tiles. Parts are meshed separately so legs, arms, tails and wings can be
 * animated; `team` parts get the player's colour (a scarf, SC2-style team
 * colour); flames are drawn as glowing sprites at the given points.
 */

export type Anim = "legA" | "legB" | "armA" | "armB" | "tail" | "wingL" | "wingR" | "head" | "body";

export interface PartDef {
  name: string;
  prims: Prim[];
  anim: Anim;
  /** Rotation pivot (model space). */
  pivot: V3;
  team?: boolean;
  /** Mesh resolution override (tiles per cell). */
  cell?: number;
}

export interface PokeModel {
  parts: PartDef[];
  /** Default mesh resolution. */
  cell: number;
  flames: { part: string; p: V3; size: number }[];
  /** Where attacks come out (model space). */
  muzzle: V3[];
  /** Walk style: bipeds bob, quadrupeds trot. */
  gait: "biped" | "quad" | "fly";
  /** Seconds per stride at full speed (visual only). */
  stride: number;
}

// --------------------------------------------------------------- helpers

type Opt = Partial<Prim>;
const ell = (p: V3, r: V3, c: string, o: Opt = {}): Prim => ({ k: "ell", p, r, c, ...o });
const cap = (a: V3, b: V3, r1: number, r2: number, c: string, o: Opt = {}): Prim => ({ k: "cap", p: a, b, r: [r1, r2, 0], c, ...o });
const tor = (p: V3, R: number, r: number, c: string, o: Opt = {}): Prim => ({ k: "tor", p, r: [R, r, 0], c, ...o });
const box = (p: V3, r: V3, c: string, o: Opt = {}): Prim => ({ k: "box", p, r, c, round: Math.min(...r) * 0.6, ...o });

const z = (v: V3, s: number): V3 => [v[0], v[1], v[2] * s];

/** A pair of eyes with a white highlight, looking forward. */
function eyes(p: V3, r: V3, iris: string, shine = true): Prim[] {
  // Painted onto the head surface: deep along x so it always reaches the skin.
  const out = [ell(p, [r[0] * 2.2, r[1], r[2]], iris, { mirror: true, paint: true })];
  if (shine) out.push(ell([p[0] + r[0] * 0.4, p[1] + r[1] * 0.45, p[2] - r[2] * 0.2], [r[0] * 2.2, r[1] * 0.28, r[2] * 0.3], "#ffffff", { mirror: true, paint: true }));
  return out;
}

const paint = (q: Prim): Prim => ({ ...q, paint: true });

/** Left and right copies of a limb part (z mirrored), animated in opposite phase. */
function pair(name: string, prims: Prim[], pivot: V3, a: Anim, b: Anim): PartDef[] {
  const mz = (q: Prim): Prim => ({
    ...q,
    p: z(q.p, -1),
    b: q.b ? z(q.b, -1) : undefined,
    rot: q.rot ? [-q.rot[0], -q.rot[1], q.rot[2]] : undefined,
  });
  return [
    { name: name + "L", prims, pivot, anim: a },
    { name: name + "R", prims: prims.map(mz), pivot: z(pivot, -1), anim: b },
  ];
}

/** Team-coloured scarf: a ring with a little knot hanging at the front. */
function scarf(p: V3, R: number, r: number, tilt = 0): PartDef {
  const rot: V3 = [0, 0, tilt];
  const kx = p[0] + Math.cos(tilt) * R * 0.95;
  const ky = p[1] + Math.sin(tilt) * R * 0.95;
  return {
    name: "scarf",
    anim: "body",
    pivot: [0, 0, 0],
    team: true,
    prims: [tor(p, R, r, "#ffffff", { rot }), ell([kx + r * 0.6, ky - r * 1.6, R * 0.25], [r * 0.9, r * 2.2, r * 1.3], "#ffffff", { rot: [0.3, 0, -0.4], k2: r })],
  };
}

// ------------------------------------------------------------- colours

const YEL = "#f6cf37";
const BROWN = "#8a5a2b";
const DARK = "#1c1512";
const CHAR = "#f08637";
const CREAM = "#f7d78f";
const MELEON = "#d84a2c";
const SQ = "#78c2ee";
const SHELL = "#a2662d";
const RIM = "#f1e7c9";
const WAR = "#8ea6e6";
const BLAST = "#5a8bd9";
const BULBA = "#69c0a4";
const SPOT = "#3f8f78";
const LEAF = "#3d8b53";
const DLEAF = "#2d7342";
const PINK = "#f07a96";
const REDEYE = "#c3283a";

// ------------------------------------------------------------- models

const pikachu: PokeModel = {
  cell: 0.018,
  gait: "biped",
  stride: 0.32,
  muzzle: [[0.2, 0.56, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.3, 0], [0.19, 0.23, 0.18], YEL),
        ell([0.04, 0.6, 0], [0.2, 0.18, 0.21], YEL, { k2: 0.08 }),
        paint(ell([-0.17, 0.42, 0], [0.08, 0.03, 0.14], BROWN, { rot: [0, 0, 0.35] })),
        paint(ell([-0.19, 0.31, 0], [0.07, 0.026, 0.13], BROWN, { rot: [0, 0, 0.2] })),
        paint(ell([0.17, 0.545, 0.14], [0.06, 0.045, 0.045], "#e5423a", { mirror: true })),
        ...eyes([0.19, 0.645, 0.085], [0.035, 0.05, 0.035], DARK),
        paint(ell([0.24, 0.6, 0], [0.03, 0.012, 0.016], DARK)),
        // Ears with black tips.
        cap([0.0, 0.72, 0.1], [-0.07, 1.0, 0.22], 0.055, 0.03, YEL, { mirror: true, k2: 0.03 }),
        cap([-0.055, 0.92, 0.185], [-0.075, 1.01, 0.225], 0.047, 0.03, DARK, { mirror: true }),
      ],
    },
    ...pair("arm", [cap([0.1, 0.4, 0.14], [0.2, 0.32, 0.16], 0.045, 0.04, YEL)], [0.1, 0.4, 0.14], "armA", "armB"),
    ...pair("leg", [ell([0.05, 0.05, 0.1], [0.09, 0.05, 0.06], YEL), cap([0.0, 0.16, 0.09], [0.03, 0.06, 0.1], 0.06, 0.05, YEL)], [0.0, 0.18, 0.09], "legA", "legB"),
    {
      name: "tail",
      anim: "tail",
      pivot: [-0.16, 0.2, 0],
      prims: [
        box([-0.24, 0.28, 0], [0.03, 0.1, 0.018], BROWN, { rot: [0, 0, 0.7] }),
        box([-0.3, 0.43, 0], [0.035, 0.12, 0.018], YEL, { rot: [0, 0, -0.55], k2: 0.01 }),
        box([-0.38, 0.6, 0], [0.11, 0.08, 0.018], YEL, { rot: [0, 0, 0.35], k2: 0.01 }),
      ],
      cell: 0.012,
    },
    scarf([0.02, 0.45, 0], 0.15, 0.032),
  ],
};

const charmander: PokeModel = {
  cell: 0.018,
  gait: "biped",
  stride: 0.3,
  muzzle: [[0.32, 0.64, 0]],
  flames: [{ part: "tail", p: [-0.45, 0.5, 0], size: 0.16 }],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.33, 0], [0.19, 0.25, 0.18], CHAR),
        ell([0.07, 0.3, 0], [0.135, 0.2, 0.14], CREAM),
        ell([0.08, 0.68, 0], [0.19, 0.18, 0.18], CHAR, { k2: 0.06 }),
        ell([0.22, 0.64, 0], [0.12, 0.09, 0.12], CHAR, { k2: 0.05 }),
        ...eyes([0.235, 0.74, 0.085], [0.035, 0.06, 0.035], DARK),
        paint(ell([0.34, 0.665, 0.03], [0.03, 0.01, 0.01], DARK, { mirror: true })),
      ],
    },
    ...pair("arm", [cap([0.1, 0.42, 0.15], [0.21, 0.35, 0.2], 0.05, 0.04, CHAR)], [0.1, 0.42, 0.15], "armA", "armB"),
    ...pair("leg", [cap([0.0, 0.2, 0.11], [0.04, 0.06, 0.12], 0.08, 0.065, CHAR), ell([0.07, 0.035, 0.12], [0.09, 0.04, 0.06], CHAR, { k2: 0.03 })], [0, 0.22, 0.11], "legA", "legB"),
    { name: "tail", anim: "tail", pivot: [-0.14, 0.22, 0], prims: [cap([-0.14, 0.22, 0], [-0.43, 0.43, 0], 0.07, 0.035, CHAR)] },
    scarf([0.05, 0.5, 0], 0.15, 0.034),
  ],
};

const charmeleon: PokeModel = {
  cell: 0.022,
  gait: "biped",
  stride: 0.34,
  muzzle: [[0.36, 0.88, 0]],
  flames: [{ part: "tail", p: [-0.6, 0.6, 0], size: 0.22 }],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.45, 0], [0.2, 0.3, 0.18], MELEON),
        ell([0.07, 0.42, 0], [0.15, 0.23, 0.14], CREAM),
        ell([0.06, 0.92, 0], [0.2, 0.17, 0.17], MELEON, { k2: 0.07 }),
        ell([0.24, 0.87, 0], [0.13, 0.08, 0.11], MELEON, { k2: 0.05 }),
        cap([-0.08, 1.02, 0], [-0.28, 1.13, 0], 0.07, 0.02, MELEON, { k2: 0.04 }),
        ...eyes([0.25, 0.96, 0.08], [0.03, 0.045, 0.03], "#1d4a4a"),
      ],
    },
    ...pair("arm", [cap([0.08, 0.6, 0.17], [0.25, 0.48, 0.2], 0.055, 0.045, MELEON), cap([0.25, 0.48, 0.2], [0.31, 0.44, 0.2], 0.022, 0.008, "#f4efe6")], [0.08, 0.6, 0.17], "armA", "armB"),
    ...pair("leg", [cap([0, 0.3, 0.12], [0.06, 0.06, 0.13], 0.09, 0.07, MELEON), ell([0.09, 0.04, 0.13], [0.1, 0.04, 0.07], MELEON, { k2: 0.03 })], [0, 0.3, 0.12], "legA", "legB"),
    { name: "tail", anim: "tail", pivot: [-0.16, 0.3, 0], prims: [cap([-0.16, 0.3, 0], [-0.58, 0.52, 0], 0.08, 0.035, MELEON)] },
    scarf([0.04, 0.72, 0], 0.16, 0.038),
  ],
};

const charizard: PokeModel = {
  cell: 0.028,
  gait: "fly",
  stride: 1,
  muzzle: [[0.66, 1.33, 0]],
  flames: [{ part: "tail", p: [-0.66, 0.22, 0], size: 0.28 }],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.75, 0], [0.27, 0.42, 0.25], CHAR, { rot: [0, 0, -0.35] }),
        ell([0.1, 0.72, 0], [0.19, 0.34, 0.19], CREAM, { rot: [0, 0, -0.35] }),
        cap([0.12, 1.05, 0], [0.3, 1.3, 0], 0.12, 0.09, CHAR, { k2: 0.06 }),
        ell([0.38, 1.37, 0], [0.19, 0.14, 0.15], CHAR, { k2: 0.06 }),
        ell([0.54, 1.33, 0], [0.13, 0.075, 0.11], CHAR, { k2: 0.05 }),
        cap([0.27, 1.47, 0.07], [0.08, 1.63, 0.11], 0.04, 0.012, CREAM, { mirror: true }),
        ...eyes([0.48, 1.42, 0.08], [0.03, 0.04, 0.025], DARK),
        cap([-0.05, 0.5, 0.16], [0.01, 0.17, 0.19], 0.1, 0.075, CHAR, { mirror: true }),
        ell([0.07, 0.12, 0.19], [0.1, 0.05, 0.07], CHAR, { mirror: true, k2: 0.03 }),
        cap([0.2, 0.95, 0.2], [0.39, 0.8, 0.25], 0.06, 0.045, CHAR, { mirror: true, k2: 0.03 }),
      ],
    },
    ...pair(
      "wing",
      [
        cap([0.02, 1.06, 0.18], [-0.06, 1.12, 0.98], 0.04, 0.02, CHAR),
        ell([-0.16, 1.06, 0.58], [0.3, 0.035, 0.36], "#2c8aa7", { k2: 0.02 }),
        ell([-0.32, 1.06, 0.82], [0.16, 0.035, 0.2], "#2c8aa7", { k2: 0.03 }),
      ],
      [0.02, 1.06, 0.18],
      "wingL",
      "wingR",
    ).map((p) => ({ ...p, cell: 0.016 })),
    { name: "tail", anim: "tail", pivot: [-0.2, 0.5, 0], prims: [cap([-0.2, 0.5, 0], [-0.62, 0.24, 0], 0.1, 0.045, CHAR)] },
    scarf([0.17, 1.12, 0], 0.15, 0.045, -0.6),
  ],
};

const squirtle: PokeModel = {
  cell: 0.018,
  gait: "biped",
  stride: 0.34,
  muzzle: [[0.34, 0.67, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.33, 0], [0.2, 0.24, 0.2], SQ),
        ell([-0.06, 0.36, 0], [0.2, 0.25, 0.22], SHELL),
        tor([-0.02, 0.36, 0], 0.205, 0.03, RIM, { rot: [0, 0, 1.45] }),
        ell([0.08, 0.33, 0], [0.155, 0.21, 0.165], "#f2d99a"),
        ell([0.08, 0.7, 0], [0.21, 0.2, 0.21], SQ, { k2: 0.05 }),
        ...eyes([0.25, 0.74, 0.09], [0.04, 0.065, 0.04], "#5a2418"),
      ],
    },
    ...pair("arm", [cap([0.1, 0.42, 0.18], [0.2, 0.35, 0.24], 0.05, 0.045, SQ)], [0.1, 0.42, 0.18], "armA", "armB"),
    ...pair("leg", [ell([0.05, 0.06, 0.12], [0.1, 0.06, 0.08], SQ), cap([0.0, 0.18, 0.12], [0.03, 0.07, 0.12], 0.07, 0.06, SQ)], [0, 0.2, 0.12], "legA", "legB"),
    { name: "tail", anim: "tail", pivot: [-0.2, 0.24, 0], prims: [cap([-0.2, 0.24, 0], [-0.3, 0.25, 0], 0.05, 0.05, SQ), tor([-0.36, 0.33, 0], 0.08, 0.04, SQ, { rot: [1.57, 0, 0] })] },
    scarf([0.06, 0.53, 0], 0.17, 0.034),
  ],
};

const wartortle: PokeModel = {
  cell: 0.022,
  gait: "biped",
  stride: 0.36,
  muzzle: [[0.36, 0.9, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.45, 0], [0.22, 0.3, 0.21], WAR),
        ell([-0.07, 0.48, 0], [0.22, 0.3, 0.23], "#9a6230"),
        tor([-0.02, 0.48, 0], 0.225, 0.035, RIM, { rot: [0, 0, 1.45] }),
        ell([0.09, 0.44, 0], [0.165, 0.25, 0.17], "#f2d99a"),
        ell([0.08, 0.92, 0], [0.2, 0.19, 0.2], WAR, { k2: 0.06 }),
        ...eyes([0.25, 0.96, 0.08], [0.033, 0.05, 0.033], "#2a1e3a"),
        ell([-0.1, 1.08, 0.15], [0.15, 0.06, 0.04], "#f5f5fb", { mirror: true, rot: [-0.5, 0, 0.6] }),
        ell([-0.2, 1.17, 0.19], [0.08, 0.05, 0.035], "#f5f5fb", { mirror: true, rot: [-0.5, 0, 1.2], k2: 0.03 }),
      ],
    },
    ...pair("arm", [cap([0.1, 0.58, 0.2], [0.24, 0.48, 0.25], 0.055, 0.045, WAR)], [0.1, 0.58, 0.2], "armA", "armB"),
    ...pair("leg", [ell([0.05, 0.07, 0.13], [0.11, 0.07, 0.09], WAR), cap([0, 0.24, 0.13], [0.03, 0.08, 0.13], 0.08, 0.07, WAR)], [0, 0.26, 0.13], "legA", "legB"),
    { name: "tail", anim: "tail", pivot: [-0.22, 0.32, 0], prims: [ell([-0.38, 0.5, 0], [0.18, 0.11, 0.08], "#f5f5fb", { rot: [0, 0, -0.9] }), ell([-0.5, 0.72, 0], [0.12, 0.1, 0.07], "#e6e8f6", { k2: 0.05 })] },
    scarf([0.05, 0.73, 0], 0.18, 0.04),
  ],
};

const blastoise: PokeModel = {
  cell: 0.032,
  gait: "biped",
  stride: 0.5,
  muzzle: [
    [0.42, 1.18, 0.27],
    [0.42, 1.18, -0.27],
  ],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.65, 0], [0.37, 0.45, 0.35], BLAST),
        ell([-0.11, 0.68, 0], [0.37, 0.46, 0.38], "#8b5a2c"),
        tor([-0.03, 0.68, 0], 0.38, 0.05, RIM, { rot: [0, 0, 1.45] }),
        ell([0.15, 0.62, 0], [0.27, 0.36, 0.27], "#f0d58e"),
        ell([0.22, 1.22, 0], [0.2, 0.17, 0.19], BLAST, { k2: 0.08 }),
        ...eyes([0.38, 1.27, 0.09], [0.03, 0.035, 0.03], "#3a1810"),
        cap([0.1, 1.33, 0.12], [0.06, 1.42, 0.16], 0.04, 0.02, BLAST, { mirror: true }),
        ell([-0.1, 1.04, 0.25], [0.12, 0.1, 0.1], "#a9b3be", { mirror: true }),
        cap([-0.06, 1.05, 0.25], [0.4, 1.18, 0.27], 0.085, 0.075, "#b9c1ca", { mirror: true }),
        cap([0.36, 1.17, 0.27], [0.43, 1.19, 0.27], 0.09, 0.09, "#7d8792", { mirror: true }),
      ],
    },
    ...pair("arm", [cap([0.15, 0.85, 0.32], [0.36, 0.64, 0.38], 0.1, 0.085, BLAST)], [0.15, 0.85, 0.32], "armA", "armB"),
    ...pair("leg", [cap([0, 0.38, 0.2], [0.05, 0.1, 0.22], 0.14, 0.12, BLAST), ell([0.1, 0.06, 0.22], [0.15, 0.06, 0.11], BLAST, { k2: 0.04 })], [0, 0.4, 0.2], "legA", "legB"),
    { name: "tail", anim: "tail", pivot: [-0.35, 0.3, 0], prims: [ell([-0.45, 0.28, 0], [0.13, 0.08, 0.08], BLAST)] },
    scarf([0.15, 1.04, 0], 0.23, 0.05, -0.3),
  ],
};

function bulbLegs(front: number, back: number, y: number, zz: number, r: number, color: string): PartDef[] {
  const leg = (x: number): Prim[] => [cap([x, y, zz], [x + 0.02, 0.05, zz + 0.01], r, r * 0.9, color), ell([x + 0.04, 0.035, zz + 0.01], [r * 1.1, r * 0.5, r * 0.9], color, { k2: 0.02 })];
  const fl = pair("legF", leg(front), [front, y, zz], "legA", "legB");
  const bl = pair("legB", leg(back), [back, y, zz], "legB", "legA");
  return [...fl, ...bl];
}

const bulbasaur: PokeModel = {
  cell: 0.02,
  gait: "quad",
  stride: 0.3,
  muzzle: [[0.56, 0.4, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.32, 0], [0.34, 0.21, 0.25], BULBA),
        ell([0.36, 0.4, 0], [0.22, 0.19, 0.24], BULBA, { k2: 0.08 }),
        paint(ell([0.1, 0.5, 0.13], [0.07, 0.06, 0.06], SPOT, { mirror: true })),
        paint(ell([-0.16, 0.42, 0.19], [0.06, 0.06, 0.06], SPOT, { mirror: true })),
        paint(ell([0.33, 0.58, 0.08], [0.06, 0.05, 0.05], SPOT, { mirror: true })),
        ...eyes([0.53, 0.45, 0.12], [0.045, 0.055, 0.045], REDEYE),
        cap([0.33, 0.56, 0.14], [0.3, 0.68, 0.21], 0.05, 0.022, BULBA, { mirror: true, k2: 0.02 }),
        ell([-0.08, 0.56, 0], [0.24, 0.23, 0.24], LEAF, { k2: 0.06 }),
        cap([-0.08, 0.74, 0], [-0.1, 0.87, 0], 0.12, 0.015, LEAF, { k2: 0.06 }),
        ell([-0.08, 0.58, 0], [0.245, 0.15, 0.02], DLEAF),
        ell([-0.08, 0.58, 0], [0.02, 0.15, 0.245], DLEAF),
      ],
    },
    ...bulbLegs(0.2, -0.2, 0.25, 0.17, 0.085, BULBA),
    scarf([0.24, 0.42, 0], 0.16, 0.035, -1.15),
  ],
};

const ivyLeaves: Prim[] = [0, 1, 2, 3].map((i) => {
  const a = (i / 4) * Math.PI * 2 + 0.4;
  return ell([-0.08 + Math.cos(a) * 0.24, 0.66, Math.sin(a) * 0.24], [0.3, 0.025, 0.12], DLEAF, { rot: [0, -a, -0.35] });
});

const ivysaur: PokeModel = {
  cell: 0.024,
  gait: "quad",
  stride: 0.34,
  muzzle: [[0.68, 0.55, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.42, 0], [0.42, 0.27, 0.31], "#5fa898"),
        ell([0.44, 0.55, 0], [0.24, 0.2, 0.25], "#5fa898", { k2: 0.09 }),
        paint(ell([0.12, 0.62, 0.16], [0.08, 0.07, 0.07], "#3d7f71", { mirror: true })),
        ...eyes([0.62, 0.6, 0.12], [0.04, 0.05, 0.04], REDEYE),
        cap([0.42, 0.7, 0.15], [0.38, 0.84, 0.22], 0.055, 0.025, "#5fa898", { mirror: true, k2: 0.02 }),
        ell([-0.08, 0.68, 0], [0.18, 0.12, 0.18], "#6aa85d", { k2: 0.06 }),
        ell([-0.08, 0.86, 0], [0.15, 0.2, 0.15], PINK, { k2: 0.05 }),
        cap([-0.08, 1.0, 0], [-0.08, 1.12, 0], 0.08, 0.015, "#e8607f", { k2: 0.05 }),
        ...ivyLeaves,
      ],
    },
    ...bulbLegs(0.26, -0.24, 0.32, 0.2, 0.1, "#5fa898"),
    scarf([0.33, 0.55, 0], 0.19, 0.04, -1.15),
  ],
};

const venuLeaves: Prim[] = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = (i / 6) * Math.PI * 2 + 0.3;
  return ell([-0.1 + Math.cos(a) * 0.62, 1.16, Math.sin(a) * 0.62], [0.62, 0.05, 0.25], DLEAF, { rot: [0, -a, -0.18] });
});
const venuPetals: Prim[] = [0, 1, 2, 3, 4].map((i) => {
  const a = (i / 5) * Math.PI * 2;
  return ell([-0.1 + Math.cos(a) * 0.5, 1.56, Math.sin(a) * 0.5], [0.52, 0.07, 0.31], "#f27c95", { rot: [0, -a, 0.16] });
});
const venuDots: Prim[] = [0, 1, 2, 3, 4].map((i) => {
  const a = (i / 5) * Math.PI * 2 + 0.2;
  return paint(ell([-0.1 + Math.cos(a) * 0.62, 1.61, Math.sin(a) * 0.62], [0.09, 0.08, 0.07], "#f7f0f2", { rot: [0, -a, 0.16] }));
});

const venusaur: PokeModel = {
  cell: 0.04,
  gait: "quad",
  stride: 0.55,
  muzzle: [[-0.1, 1.7, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.75, 0], [0.82, 0.5, 0.64], "#5fb39a"),
        ell([0.82, 0.82, 0], [0.42, 0.34, 0.42], "#5fb39a", { k2: 0.14 }),
        paint(ell([0.2, 1.05, 0.42], [0.14, 0.1, 0.12], "#3c8f78", { mirror: true })),
        paint(ell([-0.4, 0.92, 0.5], [0.12, 0.1, 0.1], "#3c8f78", { mirror: true })),
        ...eyes([1.13, 0.94, 0.2], [0.05, 0.06, 0.06], REDEYE),
        cap([0.8, 1.1, 0.25], [0.74, 1.24, 0.34], 0.08, 0.035, "#5fb39a", { mirror: true, k2: 0.04 }),
        cap([-0.1, 1.08, 0], [-0.1, 1.42, 0], 0.22, 0.17, "#7a5a3a", { k2: 0.08 }),
        ...venuLeaves,
        ...venuPetals,
        ...venuDots,
        ell([-0.1, 1.62, 0], [0.22, 0.12, 0.22], "#ffd84a", { k2: 0.04 }),
      ],
    },
    ...bulbLegs(0.48, -0.45, 0.6, 0.45, 0.2, "#5fb39a"),
    scarf([0.58, 0.86, 0], 0.33, 0.06, -1.35),
  ],
};

/** Models by unit kind key. */
export const POKEMON: Record<string, PokeModel> = {
  pikachu,
  charmander,
  charmeleon,
  charizard,
  squirtle,
  wartortle,
  blastoise,
  bulbasaur,
  ivysaur,
  venusaur,
};
