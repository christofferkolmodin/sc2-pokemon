/** Visual constants shared by the renderer, minimap and HUD. */

/** SC2 default team colours by player id (7 = solo-lab dummy). */
export const TEAM_COLORS: Record<number, string> = {
  1: "#e0262f",
  2: "#1f6dff",
  3: "#1cc5d6",
  4: "#9a3be0",
  5: "#e8e02c",
  6: "#f0861c",
  7: "#c9b23a",
  8: "#3bd46a",
};
export const teamColor = (owner: number) => TEAM_COLORS[owner] ?? "#aaaaaa";

/** Fire, Water, Grass: roofs of Gyms, evolution stones. */
export const FACTION_COLORS = ["#ff7a2e", "#3a8dff", "#4cc25a", "#ffd23c"];

export const SELECT_OWN = "#3cff52";
export const SELECT_ENEMY = "#ff3b30";
export const SELECT_NEUTRAL = "#ffd23c";
