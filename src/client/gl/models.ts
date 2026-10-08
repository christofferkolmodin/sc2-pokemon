/**
 * Placeholder 3D Pokémon built from primitives. Each model faces +X, stands on
 * y=0 and is sized in tiles to match the SC2 unit it borrows stats from.
 *
 * When real models arrive (glTF), they replace these definitions; the rest of
 * the renderer only needs "a list of meshes with matrices and colours".
 */

export type MeshName = "sphere" | "cone" | "cylinder" | "torus" | "wing";
export type Anim = "legA" | "legB" | "flame" | "wingL" | "wingR" | "none";

export interface Part {
  mesh: MeshName;
  t: [number, number, number];
  /** [yaw (around Y), pitch (around Z), roll (around X)] */
  r?: [number, number, number];
  s: [number, number, number];
  /** Hex colour, or "team" for the player's team colour. */
  c: string;
  /** 0..1: how much the part glows (flames). */
  e?: number;
  anim?: Anim;
}

export interface Model {
  parts: Part[];
  /** Height of the model, used for picking and selection. */
  height: number;
  /** Flying height above the ground for air units. */
  fly?: number;
}

const S = (x: number, y = x, z = x): [number, number, number] => [x, y, z];

const SQUIRTLE_BLUE = "#6ab8ea";
const CREAM = "#f2dc9c";
const CHAR_ORANGE = "#f28a3c";
const BULBA_TEAL = "#6cc2a6";
const BULB_GREEN = "#3f8f55";
const EYE = "#1d1612";
const RED_EYE = "#b0222c";

const squirtle: Model = {
  height: 0.85,
  parts: [
    { mesh: "sphere", t: [0, 0.34, 0], s: S(0.27, 0.28, 0.27), c: SQUIRTLE_BLUE },
    { mesh: "sphere", t: [0.09, 0.33, 0], s: S(0.2, 0.24, 0.22), c: CREAM },
    { mesh: "sphere", t: [-0.1, 0.36, 0], s: S(0.23, 0.28, 0.29), c: "#a86b32" },
    { mesh: "torus", t: [-0.02, 0.36, 0], r: [0, 1.57, 0], s: S(0.26, 0.26, 0.28), c: "#f0e6c8" },
    { mesh: "sphere", t: [0.08, 0.7, 0], s: S(0.21, 0.2, 0.21), c: SQUIRTLE_BLUE },
    { mesh: "sphere", t: [0.24, 0.74, 0.085], s: S(0.045, 0.065, 0.045), c: EYE },
    { mesh: "sphere", t: [0.24, 0.74, -0.085], s: S(0.045, 0.065, 0.045), c: EYE },
    { mesh: "sphere", t: [0.12, 0.4, 0.24], s: S(0.08), c: SQUIRTLE_BLUE },
    { mesh: "sphere", t: [0.12, 0.4, -0.24], s: S(0.08), c: SQUIRTLE_BLUE },
    { mesh: "sphere", t: [0.06, 0.07, 0.13], s: S(0.1, 0.07, 0.09), c: SQUIRTLE_BLUE, anim: "legA" },
    { mesh: "sphere", t: [0.06, 0.07, -0.13], s: S(0.1, 0.07, 0.09), c: SQUIRTLE_BLUE, anim: "legB" },
    { mesh: "torus", t: [-0.36, 0.28, 0], r: [0, 0, 1.57], s: S(0.09), c: SQUIRTLE_BLUE },
    { mesh: "torus", t: [0.06, 0.53, 0], s: S(0.18, 0.2, 0.18), c: "team" },
  ],
};

const charmander: Model = {
  height: 0.85,
  parts: [
    { mesh: "sphere", t: [0, 0.33, 0], s: S(0.22, 0.27, 0.22), c: CHAR_ORANGE },
    { mesh: "sphere", t: [0.09, 0.32, 0], s: S(0.15, 0.22, 0.17), c: "#f6d98b" },
    { mesh: "sphere", t: [0.07, 0.7, 0], s: S(0.2, 0.19, 0.2), c: CHAR_ORANGE },
    { mesh: "sphere", t: [0.22, 0.66, 0], s: S(0.11, 0.09, 0.12), c: CHAR_ORANGE },
    { mesh: "sphere", t: [0.23, 0.76, 0.085], s: S(0.04, 0.065, 0.04), c: EYE },
    { mesh: "sphere", t: [0.23, 0.76, -0.085], s: S(0.04, 0.065, 0.04), c: EYE },
    { mesh: "sphere", t: [0.1, 0.42, 0.2], s: S(0.07), c: CHAR_ORANGE },
    { mesh: "sphere", t: [0.1, 0.42, -0.2], s: S(0.07), c: CHAR_ORANGE },
    { mesh: "sphere", t: [0.05, 0.07, 0.12], s: S(0.1, 0.07, 0.08), c: CHAR_ORANGE, anim: "legA" },
    { mesh: "sphere", t: [0.05, 0.07, -0.12], s: S(0.1, 0.07, 0.08), c: CHAR_ORANGE, anim: "legB" },
    { mesh: "cone", t: [-0.14, 0.24, 0], r: [0, 0.93, 0], s: S(0.075, 0.4, 0.075), c: CHAR_ORANGE },
    { mesh: "sphere", t: [-0.46, 0.52, 0], s: S(0.09, 0.14, 0.09), c: "#ff9a2e", e: 1, anim: "flame" },
    { mesh: "sphere", t: [-0.46, 0.5, 0], s: S(0.05, 0.085, 0.05), c: "#fff3a6", e: 1, anim: "flame" },
    { mesh: "torus", t: [0.05, 0.52, 0], s: S(0.17, 0.2, 0.17), c: "team" },
  ],
};

const bulbasaur: Model = {
  height: 0.95,
  parts: [
    { mesh: "sphere", t: [0, 0.34, 0], s: S(0.42, 0.27, 0.33), c: BULBA_TEAL },
    { mesh: "sphere", t: [0.42, 0.42, 0], s: S(0.26, 0.23, 0.28), c: BULBA_TEAL },
    { mesh: "cone", t: [0.42, 0.6, 0.16], r: [0, 0, -0.5], s: S(0.07, 0.13, 0.07), c: BULBA_TEAL },
    { mesh: "cone", t: [0.42, 0.6, -0.16], r: [0, 0, 0.5], s: S(0.07, 0.13, 0.07), c: BULBA_TEAL },
    { mesh: "sphere", t: [0.6, 0.48, 0.13], s: S(0.05, 0.06, 0.05), c: RED_EYE },
    { mesh: "sphere", t: [0.6, 0.48, -0.13], s: S(0.05, 0.06, 0.05), c: RED_EYE },
    { mesh: "sphere", t: [-0.08, 0.62, 0], s: S(0.3), c: BULB_GREEN },
    { mesh: "cone", t: [-0.08, 0.84, 0], s: S(0.13, 0.2, 0.13), c: BULB_GREEN },
    { mesh: "cylinder", t: [0.24, 0, 0.2], s: S(0.09, 0.24, 0.09), c: BULBA_TEAL, anim: "legA" },
    { mesh: "cylinder", t: [0.24, 0, -0.2], s: S(0.09, 0.24, 0.09), c: BULBA_TEAL, anim: "legB" },
    { mesh: "cylinder", t: [-0.24, 0, 0.2], s: S(0.09, 0.24, 0.09), c: BULBA_TEAL, anim: "legB" },
    { mesh: "cylinder", t: [-0.24, 0, -0.2], s: S(0.09, 0.24, 0.09), c: BULBA_TEAL, anim: "legA" },
    { mesh: "torus", t: [0.27, 0.44, 0], r: [0, -1.1, 0], s: S(0.2, 0.22, 0.2), c: "team" },
  ],
};

const venusaurLeaves: Part[] = [0, 1, 2, 3, 4, 5].map((i) => {
  const a = (i / 6) * Math.PI * 2 + 0.3;
  return { mesh: "sphere", t: [-0.1 + Math.cos(a) * 0.62, 1.12, Math.sin(a) * 0.62], r: [-a, 0, 0], s: S(0.62, 0.07, 0.26), c: "#2f7d45" } as Part;
});
const venusaurPetals: Part[] = [0, 1, 2, 3, 4].map((i) => {
  const a = (i / 5) * Math.PI * 2;
  return { mesh: "sphere", t: [-0.1 + Math.cos(a) * 0.48, 1.52, Math.sin(a) * 0.48], r: [-a, 0.15, 0], s: S(0.5, 0.09, 0.3), c: "#f27c95" } as Part;
});

const venusaur: Model = {
  height: 1.9,
  parts: [
    { mesh: "sphere", t: [0, 0.72, 0], s: S(0.95, 0.58, 0.8), c: "#5fb39a" },
    { mesh: "sphere", t: [0.86, 0.78, 0], s: S(0.46, 0.38, 0.46), c: "#5fb39a" },
    { mesh: "sphere", t: [1.24, 0.9, 0.2], s: S(0.07), c: RED_EYE },
    { mesh: "sphere", t: [1.24, 0.9, -0.2], s: S(0.07), c: RED_EYE },
    { mesh: "cylinder", t: [0.5, 0, 0.5], s: S(0.2, 0.5, 0.2), c: "#5fb39a", anim: "legA" },
    { mesh: "cylinder", t: [0.5, 0, -0.5], s: S(0.2, 0.5, 0.2), c: "#5fb39a", anim: "legB" },
    { mesh: "cylinder", t: [-0.5, 0, 0.5], s: S(0.2, 0.5, 0.2), c: "#5fb39a", anim: "legB" },
    { mesh: "cylinder", t: [-0.5, 0, -0.5], s: S(0.2, 0.5, 0.2), c: "#5fb39a", anim: "legA" },
    { mesh: "cylinder", t: [-0.1, 1.05, 0], s: S(0.22, 0.4, 0.22), c: "#7a5a3a" },
    ...venusaurLeaves,
    ...venusaurPetals,
    { mesh: "sphere", t: [-0.1, 1.6, 0], s: S(0.22, 0.14, 0.22), c: "#ffd84a" },
    { mesh: "torus", t: [0.62, 0.95, 0], r: [0, -1.1, 0], s: S(0.42, 0.45, 0.42), c: "team" },
  ],
};

const charizard: Model = {
  height: 1.0,
  fly: 3.2,
  parts: [
    { mesh: "sphere", t: [0, 0, 0], r: [0, -0.7, 0], s: S(0.26, 0.36, 0.24), c: CHAR_ORANGE },
    { mesh: "sphere", t: [0.06, -0.03, 0], r: [0, -0.7, 0], s: S(0.2, 0.29, 0.18), c: "#f3d68a" },
    { mesh: "sphere", t: [0.3, 0.3, 0], s: S(0.17, 0.15, 0.16), c: CHAR_ORANGE },
    { mesh: "sphere", t: [0.45, 0.28, 0], s: S(0.1, 0.08, 0.1), c: CHAR_ORANGE },
    { mesh: "cone", t: [0.24, 0.42, 0.07], r: [0, 0.7, 0], s: S(0.03, 0.13, 0.03), c: "#f3d68a" },
    { mesh: "cone", t: [0.24, 0.42, -0.07], r: [0, 0.7, 0], s: S(0.03, 0.13, 0.03), c: "#f3d68a" },
    { mesh: "sphere", t: [0.41, 0.36, 0.08], s: S(0.03, 0.045, 0.03), c: EYE },
    { mesh: "sphere", t: [0.41, 0.36, -0.08], s: S(0.03, 0.045, 0.03), c: EYE },
    { mesh: "wing", t: [0, 0.14, 0.12], s: S(0.9, 1, 0.9), c: "#2a6f8a", anim: "wingR" },
    { mesh: "wing", t: [0, 0.14, -0.12], s: S(0.9, 1, -0.9), c: "#2a6f8a", anim: "wingL" },
    { mesh: "sphere", t: [-0.05, -0.32, 0.1], s: S(0.07, 0.09, 0.07), c: CHAR_ORANGE },
    { mesh: "sphere", t: [-0.05, -0.32, -0.1], s: S(0.07, 0.09, 0.07), c: CHAR_ORANGE },
    { mesh: "cone", t: [-0.18, -0.18, 0], r: [0, 1.98, 0], s: S(0.07, 0.42, 0.07), c: CHAR_ORANGE },
    { mesh: "sphere", t: [-0.57, -0.36, 0], s: S(0.09, 0.14, 0.09), c: "#ff9a2e", e: 1, anim: "flame" },
    { mesh: "sphere", t: [-0.57, -0.38, 0], s: S(0.05, 0.085, 0.05), c: "#fff3a6", e: 1, anim: "flame" },
    { mesh: "torus", t: [0.2, 0.2, 0], r: [0, -1.0, 0], s: S(0.14, 0.18, 0.14), c: "team" },
  ],
};

/** Indexed by unit kind (see src/sim/units.ts). */
export const MODELS: Model[] = [squirtle, charmander, bulbasaur, venusaur, charizard];
