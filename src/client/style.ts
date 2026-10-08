/** Visual constants shared by the renderer, minimap and HUD. */

/** SC2 default team colours by player id (7 = solo-lab dummy). */
export const TEAM_COLORS: Record<number, string> = {
  1: "#e0262f",
  2: "#1f6dff",
  3: "#1cc5d6",
  4: "#9a3be0",
  7: "#c9b23a",
};
export const teamColor = (owner: number) => TEAM_COLORS[owner] ?? "#aaaaaa";

/** Body colours per Pokémon type. [main, dark, light] */
export const TYPE_COLORS: Record<string, [string, string, string]> = {
  water: ["#5aa9f0", "#2e6aa8", "#bfe2ff"],
  fire: ["#f28a3c", "#b64f1a", "#ffd27a"],
  grass: ["#6cc46a", "#327a3a", "#c8f0a8"],
  flying: ["#f0874a", "#a8481c", "#ffe08a"],
};

export const SELECT_OWN = "#3cff52";
export const SELECT_ENEMY = "#ff3b30";
export const SELECT_NEUTRAL = "#ffd23c";

/** Vertical field of view in tiles. Wider screens see more horizontally, like SC2. */
export const VIEW_TILES_Y = 20;

/** How high air units are drawn above their ground position (tiles). */
export const AIR_LIFT = 0.55;
