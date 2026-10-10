import type { Prim, V3 } from "./sdf.ts";

/**
 * Sculpted Pokémon. Every model faces +X, stands on y = 0 and is sized in
 * tiles. Parts are meshed separately so legs, arms, tails and wings can be
 * animated; `team` parts get the player's colour (a scarf, SC2-style team
 * colour); flames are drawn as glowing sprites at the given points.
 */

export type Anim = "legA" | "legB" | "armA" | "armB" | "tail" | "wingL" | "wingR" | "head" | "body" | "roll";

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
  /** Walk style: bipeds bob, quadrupeds trot, balls roll. */
  gait: "biped" | "quad" | "fly" | "roll";
  /** Seconds per stride at full speed (visual only). */
  stride: number;
  /** Where a worker holds carried minerals or gas (model space); defaults to in front of the belly. */
  carry?: V3;
}

// --------------------------------------------------------------- helpers

type Opt = Partial<Prim>;
const ell = (p: V3, r: V3, c: string, o: Opt = {}): Prim => ({ k: "ell", p, r, c, ...o });
const cap = (a: V3, b: V3, r1: number, r2: number, c: string, o: Opt = {}): Prim => ({ k: "cap", p: a, b, r: [r1, r2, 0], c, ...o });
const tor = (p: V3, R: number, r: number, c: string, o: Opt = {}): Prim => ({ k: "tor", p, r: [R, r, 0], c, ...o });
const box = (p: V3, r: V3, c: string, o: Opt = {}): Prim => ({ k: "box", p, r, c, round: Math.min(...r) * 0.6, ...o });
/** Flat plate with any outline: points [along, across] in the plate's plane (before `rot`), half thickness t. */
const plate = (p: V3, poly: [number, number][], t: number, c: string, o: Opt = {}): Prim => ({ k: "poly", p, r: [t, 0, 0], poly, c, round: t * 0.8, ...o });
/** Flat trapezoid plate: r = [half thickness, half height, half width at the bottom], `top` = half width at the top. */
const trap = (p: V3, r: V3, top: number, c: string, o: Opt = {}): Prim => ({ k: "trap", p, r, top, c, round: r[0] * 0.8, ...o });

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

// Workers, one per faction. All share the same proportions so carried
// minerals line up: about 0.8 tall, belly at x ~ 0.2 (Voltorb sets its own carry point).

const GROW = "#ef8a36";
const GROWFUR = "#f6e4b8";

const growlithe: PokeModel = {
  cell: 0.018,
  gait: "biped",
  stride: 0.3,
  muzzle: [[0.3, 0.56, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.3, 0], [0.19, 0.22, 0.18], GROW),
        // Fluffy cream chest.
        ell([0.1, 0.36, 0], [0.12, 0.14, 0.13], GROWFUR, { k2: 0.04 }),
        // Black tiger stripes on the sides.
        ...([0.2, 0.3] as number[]).map((y) => paint(ell([-0.08, y, 0.16], [0.03, 0.012, 0.05], DARK, { mirror: true, rot: [0, 0, 0.5] }))),
        ell([0.05, 0.6, 0], [0.19, 0.17, 0.19], GROW, { k2: 0.07 }),
        ell([0.22, 0.55, 0], [0.09, 0.065, 0.085], GROWFUR, { k2: 0.04 }),
        paint(ell([0.305, 0.57, 0], [0.025, 0.02, 0.025], DARK)),
        ...eyes([0.19, 0.65, 0.09], [0.03, 0.045, 0.03], DARK),
        // Cream tuft on top of the head.
        ell([0.0, 0.76, 0], [0.11, 0.06, 0.09], GROWFUR, { k2: 0.04 }),
        ell([-0.02, 0.77, 0.13], [0.05, 0.08, 0.05], GROW, { mirror: true, rot: [0.45, 0, 0], k2: 0.03 }),
        paint(ell([0.02, 0.77, 0.13], [0.03, 0.05, 0.035], DARK, { mirror: true, rot: [0.45, 0, 0] })),
      ],
    },
    ...pair("arm", [cap([0.1, 0.4, 0.14], [0.2, 0.32, 0.16], 0.045, 0.04, GROW)], [0.1, 0.4, 0.14], "armA", "armB"),
    ...pair("leg", [ell([0.05, 0.05, 0.1], [0.09, 0.05, 0.06], GROW), cap([0.0, 0.16, 0.09], [0.03, 0.06, 0.1], 0.06, 0.05, GROW)], [0.0, 0.18, 0.09], "legA", "legB"),
    {
      // Big fluffy cream tail.
      name: "tail",
      anim: "tail",
      pivot: [-0.15, 0.22, 0],
      prims: [cap([-0.15, 0.22, 0], [-0.28, 0.32, 0], 0.04, 0.06, GROWFUR), ell([-0.33, 0.38, 0], [0.08, 0.1, 0.07], GROWFUR, { k2: 0.03 })],
    },
    scarf([0.03, 0.44, 0], 0.15, 0.032),
  ],
};

const PSY = "#f4cf55";
const BILL = "#f3e2b0";

const psyduck: PokeModel = {
  cell: 0.018,
  gait: "biped",
  stride: 0.32,
  muzzle: [[0.32, 0.53, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.29, 0], [0.18, 0.23, 0.17], PSY),
        ell([0.05, 0.6, 0], [0.2, 0.17, 0.19], PSY, { k2: 0.07 }),
        // Wide flat bill.
        ell([0.24, 0.53, 0], [0.1, 0.035, 0.08], BILL, { k2: 0.02 }),
        // Blank stare: white eyes with tiny pupils.
        ...eyes([0.19, 0.65, 0.08], [0.035, 0.045, 0.04], "#fbfbf6", false),
        paint(ell([0.24, 0.65, 0.08], [0.04, 0.016, 0.016], DARK, { mirror: true })),
        // Three hairs on top.
        cap([0.04, 0.74, 0], [0.02, 0.86, 0], 0.012, 0.008, DARK),
        cap([0.03, 0.74, 0.03], [0.0, 0.84, 0.07], 0.012, 0.008, DARK, { mirror: true }),
      ],
    },
    ...pair("arm", [cap([0.1, 0.4, 0.14], [0.2, 0.32, 0.16], 0.045, 0.04, PSY)], [0.1, 0.4, 0.14], "armA", "armB"),
    ...pair("leg", [ell([0.07, 0.035, 0.1], [0.11, 0.035, 0.07], BILL), cap([0.0, 0.16, 0.09], [0.03, 0.06, 0.1], 0.06, 0.05, PSY)], [0.0, 0.18, 0.09], "legA", "legB"),
    { name: "tail", anim: "tail", pivot: [-0.15, 0.2, 0], prims: [ell([-0.18, 0.2, 0], [0.06, 0.04, 0.05], PSY, { rot: [0, 0, 0.4] })] },
    scarf([0.03, 0.45, 0], 0.15, 0.032),
  ],
};

const ODD = "#3f62b0";
const ODDFOOT = "#2c4688";

const oddish: PokeModel = {
  cell: 0.012,
  gait: "biped",
  stride: 0.26,
  muzzle: [[0.22, 0.28, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.26, 0], [0.2, 0.2, 0.2], ODD),
        ...eyes([0.17, 0.3, 0.08], [0.03, 0.04, 0.03], "#d23a3a"),
        paint(ell([0.2, 0.22, 0], [0.02, 0.008, 0.03], DARK)),
        // Five broad flat leaves fanning out from the top: tilt outward (x), then turn to face direction a (y).
        ...[0, 1, 2, 3, 4].map((i) => {
          const a = (i / 5) * Math.PI * 2 + 0.3;
          const tilt = 0.75;
          const half = 0.18;
          const d: V3 = [Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt)];
          return ell([d[0] * half, 0.4 + d[1] * half, d[2] * half], [0.08, half, 0.02], i % 2 ? LEAF : DLEAF, { rot: [tilt, Math.PI / 2 - a, 0], k2: 0.03 });
        }),
      ],
    },
    ...pair("leg", [ell([0.05, 0.04, 0.1], [0.08, 0.04, 0.06], ODDFOOT), cap([0.0, 0.12, 0.09], [0.03, 0.05, 0.1], 0.05, 0.045, ODD)], [0.0, 0.14, 0.09], "legA", "legB"),
    scarf([0.0, 0.14, 0], 0.18, 0.03),
  ],
};

const VOLT = "#d8342f";

const voltorb: PokeModel = {
  cell: 0.018,
  gait: "roll",
  stride: 0.3,
  muzzle: [[0.36, 0.36, 0]],
  carry: [0.46, 0.3, 0],
  flames: [],
  parts: [
    {
      // Rolls about its centre while moving, and rights itself (face forward) when it stops.
      name: "body",
      anim: "roll",
      pivot: [0, 0.36, 0],
      prims: [
        // A Poké Ball: red top, white bottom, dark seam.
        ell([0, 0.36, 0], [0.35, 0.35, 0.35], "#f2f2ee"),
        paint(box([0, 0.6, 0], [0.4, 0.24, 0.4], VOLT, { round: 0 })),
        paint(box([0, 0.36, 0], [0.4, 0.012, 0.4], DARK, { round: 0 })),
        // Angry slanted eyes on the red half.
        paint(ell([0.3, 0.47, 0.11], [0.12, 0.05, 0.07], "#ffffff", { mirror: true, rot: [0.45, 0, 0] })),
        paint(ell([0.33, 0.46, 0.09], [0.12, 0.03, 0.025], DARK, { mirror: true })),
      ],
    },
    scarf([0, 0.17, 0], 0.32, 0.03),
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

// Lightning line: Pichu -> Pikachu -> Raichu.

const YEL = "#f6cf37";
const BROWN = "#8a5a2b";
const CHEEK = "#f39aa6";
const RAI = "#ee9a3a";
const RAIBELLY = "#f8dfae";
const RAIEAR = "#7a4a25";

/** Scales a primitive about the origin. */
function scaled(q: Prim, f: number): Prim {
  const v = (a: V3): V3 => [a[0] * f, a[1] * f, a[2] * f];
  return {
    ...q,
    p: v(q.p),
    b: q.b ? v(q.b) : undefined,
    r: q.k === "cap" || q.k === "tor" ? [q.r[0] * f, q.r[1] * f, 0] : v(q.r),
    k2: q.k2 !== undefined ? q.k2 * f : undefined,
    round: q.round !== undefined ? q.round * f : undefined,
    top: q.top !== undefined ? q.top * f : undefined,
    corner: q.corner !== undefined ? q.corner * f : undefined,
    poly: q.poly ? q.poly.map(([a, b]): [number, number] => [a * f, b * f]) : undefined,
  };
}

function scaleModel(m: PokeModel, f: number): PokeModel {
  const v = (a: V3): V3 => [a[0] * f, a[1] * f, a[2] * f];
  return {
    ...m,
    cell: m.cell * f,
    stride: m.stride * f,
    muzzle: m.muzzle.map(v),
    flames: m.flames.map((x) => ({ ...x, p: v(x.p), size: x.size * f })),
    parts: m.parts.map((p) => ({ ...p, pivot: v(p.pivot), cell: p.cell ? p.cell * f : undefined, prims: p.prims.map((q) => scaled(q, f)) })),
  };
}

// Pichu is paler and creamier than Pikachu.
const PICHU = "#fbe25a";

/**
 * Pichu's ears, traced from the pixels of the Smash Bros. Ultimate render and
 * scaled to the model: a narrow stem at the head (about a third of the ear's
 * full width; the head blend rounds it into a fillet), flaring out quickly just
 * above it, widest about a quarter to a third of the way up, then a long taper
 * to the tip. Points are [along, across] in the ear's plane, across > 0 toward
 * the outer edge; the left ear is mirrored.
 */
const PICHU_EAR: [number, number][] = [
  [0.34, 0], // tip
  [0.334, -0.013],
  [0.264, -0.063],
  [0.189, -0.106],
  [0.154, -0.123],
  [0.14, -0.126],
  [0.015, -0.045], // stem, inner side
  [-0.03, -0.05],
  [-0.03, 0.043],
  [-0.014, 0.046], // stem, outer side
  [0.03, 0.113],
  [0.055, 0.141],
  [0.102, 0.133],
  [0.166, 0.11],
  [0.249, 0.064],
];
/**
 * The yellow, traced the same way: it fills the stem and the lower ear and ends
 * in two points with a notch between them; a thick black band runs down the
 * inner edge and a thinner one down the outer edge.
 */
const PICHU_EAR_YELLOW: [number, number][] = [
  [0.215, -0.008], // inner point
  [0.069, -0.079],
  [0.015, -0.045],
  [-0.04, -0.051],
  [-0.04, 0.042],
  [-0.014, 0.046],
  [0.011, 0.085],
  [0.043, 0.093],
  [0.066, 0.092],
  [0.111, 0.084],
  [0.15, 0.072],
  [0.205, 0.048], // outer point
  [0.158, 0.02], // notch
];

function pichuEar(base: V3, tilt: number): Prim[] {
  const o = { rot: [tilt, 0, 0] as V3, mirror: true };
  return [
    plate(base, PICHU_EAR, 0.026, DARK, { ...o, k2: 0.05, corner: 0.006 }),
    paint(plate(base, PICHU_EAR_YELLOW, 0.08, PICHU, { ...o, round: 0 })),
  ];
}

/** Big glossy eyes: dark brown-black with one large highlight up top. */
function cuteEyes(p: V3, r: V3, iris: string): Prim[] {
  const d = r[0] * 2.4;
  return [
    paint(ell(p, [d, r[1], r[2]], iris, { mirror: true })),
    paint(ell([p[0], p[1] + r[1] * 0.38, p[2] - r[2] * 0.28], [d, r[1] * 0.38, r[2] * 0.36], "#ffffff", { mirror: true })),
  ];
}

const pichu: PokeModel = {
  cell: 0.011,
  gait: "biped",
  stride: 0.2,
  muzzle: [[0.19, 0.34, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      // Finer mesh so the painted eyes, collar and ear pattern have clean edges.
      cell: 0.008,
      prims: [
        // Baby proportions: a small round body under a big, wide, round head.
        ell([0, 0.12, 0], [0.11, 0.115, 0.11], PICHU),
        ell([0.01, 0.355, 0], [0.185, 0.158, 0.21], PICHU, { k2: 0.06 }),
        // Large eyes set low and wide, soft pink cheeks, a tiny nose and a little smile.
        ...cuteEyes([0.155, 0.35, 0.088], [0.05, 0.062, 0.05], "#24130f"),
        paint(ell([0.125, 0.29, 0.15], [0.07, 0.05, 0.056], "#f7a1b0", { mirror: true })),
        paint(ell([0.19, 0.31, 0], [0.02, 0.007, 0.009], DARK)),
        // Open, happy mouth with a pink tongue: a dark half-oval (top half painted back to yellow).
        paint(ell([0.18, 0.282, 0], [0.035, 0.034, 0.04], "#5a2026")),
        paint(ell([0.188, 0.264, 0], [0.035, 0.015, 0.026], "#f08aa0")),
        paint(ell([0.18, 0.31, 0], [0.045, 0.02, 0.055], PICHU)),
        // The black zigzag collar: a band round the neck with short teeth at the front.
        paint(ell([0.01, 0.2, 0], [0.15, 0.018, 0.15], DARK)),
        ...[-0.066, -0.022, 0.022, 0.066].map((zz) => paint(trap([0.1, 0.18, zz], [0.08, 0.022, 0.001], 0.02, DARK, { round: 0 }))),
        ...pichuEar([-0.02, 0.44, 0.16], 0.3),
      ],
    },
    // Stubby arms ending in round paws.
    ...pair("arm", [cap([0.03, 0.16, 0.09], [0.075, 0.14, 0.15], 0.032, 0.03, PICHU), ell([0.08, 0.137, 0.155], [0.036, 0.034, 0.034], PICHU, { k2: 0.02 })], [0.03, 0.16, 0.09], "armA", "armB"),
    // Little round feet.
    ...pair("leg", [ell([0.035, 0.026, 0.06], [0.058, 0.028, 0.042], PICHU), cap([0.0, 0.06, 0.06], [0.015, 0.03, 0.06], 0.038, 0.035, PICHU)], [0.0, 0.07, 0.06], "legA", "legB"),
    {
      // Short, flat black tail with a kink.
      name: "tail",
      anim: "tail",
      pivot: [-0.1, 0.08, 0],
      prims: [
        box([-0.15, 0.09, 0], [0.045, 0.018, 0.01], DARK, { rot: [0, 0, 0.3] }),
        box([-0.18, 0.145, 0], [0.018, 0.04, 0.01], DARK, { rot: [0, 0, -0.4], k2: 0.01 }),
        box([-0.235, 0.185, 0], [0.045, 0.022, 0.01], DARK, { rot: [0, 0, 0.25], k2: 0.01 }),
      ],
      cell: 0.008,
    },
    // Team colour as a thin belt, so it doesn't hide Pichu's black collar.
    { name: "band", anim: "body", pivot: [0, 0, 0], team: true, cell: 0.008, prims: [tor([0, 0.075, 0], 0.11, 0.012, "#ffffff")] },
  ],
};

const pikachuBase: PokeModel = {
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
        paint(cap([-0.05, 0.9, 0.18], [-0.08, 1.04, 0.23], 0.065, 0.05, DARK, { mirror: true })),
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
const pikachu = scaleModel(pikachuBase, 1.1);

/** Raichu, authored at Pikachu size and scaled up. */
const raichuBase: PokeModel = {
  cell: 0.018,
  gait: "biped",
  stride: 0.32,
  muzzle: [[0.22, 0.58, 0]],
  flames: [],
  parts: [
    {
      name: "body",
      anim: "body",
      pivot: [0, 0, 0],
      prims: [
        ell([0, 0.31, 0], [0.21, 0.25, 0.2], RAI),
        paint(ell([0.13, 0.28, 0], [0.12, 0.19, 0.16], RAIBELLY)),
        ell([0.05, 0.62, 0], [0.19, 0.17, 0.2], RAI, { k2: 0.08 }),
        paint(ell([0.18, 0.56, 0.14], [0.06, 0.045, 0.045], YEL, { mirror: true })),
        ...eyes([0.2, 0.66, 0.085], [0.035, 0.05, 0.035], DARK),
        paint(ell([0.25, 0.615, 0], [0.03, 0.012, 0.016], DARK)),
        // Long ears, brown outside with a curl at the tip.
        cap([-0.01, 0.73, 0.1], [-0.12, 0.98, 0.24], 0.065, 0.04, RAIEAR, { mirror: true, k2: 0.03 }),
        paint(ell([0.0, 0.84, 0.16], [0.03, 0.09, 0.06], YEL, { mirror: true, rot: [0.4, 0, 0.4] })),
        ell([-0.15, 1.0, 0.25], [0.04, 0.035, 0.035], RAIEAR, { mirror: true, k2: 0.02 }),
      ],
    },
    ...pair("arm", [cap([0.1, 0.42, 0.15], [0.21, 0.33, 0.17], 0.048, 0.042, RAI), paint(ell([0.21, 0.33, 0.17], [0.05, 0.05, 0.05], BROWN))], [0.1, 0.42, 0.15], "armA", "armB"),
    ...pair("leg", [ell([0.06, 0.05, 0.1], [0.1, 0.05, 0.065], RAI), paint(ell([0.14, 0.05, 0.1], [0.04, 0.06, 0.07], BROWN)), cap([0.0, 0.17, 0.09], [0.03, 0.06, 0.1], 0.065, 0.055, RAI)], [0.0, 0.19, 0.09], "legA", "legB"),
    {
      // Long thin black tail ending in a lightning bolt.
      name: "tail",
      anim: "tail",
      pivot: [-0.18, 0.18, 0],
      prims: [
        cap([-0.18, 0.18, 0], [-0.42, 0.1, 0], 0.025, 0.02, DARK),
        cap([-0.42, 0.1, 0], [-0.58, 0.38, 0], 0.02, 0.018, DARK),
        box([-0.62, 0.48, 0], [0.04, 0.09, 0.018], YEL, { rot: [0, 0, 0.6] }),
        box([-0.66, 0.6, 0], [0.09, 0.05, 0.018], YEL, { rot: [0, 0, -0.5], k2: 0.01 }),
      ],
      cell: 0.012,
    },
    scarf([0.03, 0.46, 0], 0.16, 0.034),
  ],
};
const raichu = scaleModel(raichuBase, 1.5);

/** Models by unit kind key. */
export const POKEMON: Record<string, PokeModel> = {
  growlithe,
  psyduck,
  oddish,
  voltorb,
  charmander,
  charmeleon,
  charizard,
  squirtle,
  wartortle,
  blastoise,
  bulbasaur,
  ivysaur,
  venusaur,
  pichu,
  pikachu,
  raichu,
};
