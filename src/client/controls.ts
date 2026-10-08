/** Control reference shown in the lobby and the in-game help panel. */
export const CONTROLS: [string, string][] = [
  ["Left click / drag", "Select unit / box select (empty ground keeps your selection)"],
  ["Shift + click / drag", "Add or remove from selection"],
  ["Ctrl + click, double-click", "Select all of that kind on screen"],
  ["Right click", "Smart command: move, attack enemy, gather, return cargo, set rally (Shift: queue)"],
  ["A, then click", "Attack-move, or attack the clicked unit"],
  ["M / P / S / H", "Move / Patrol / Stop / Hold position"],
  ["Worker: B, V", "Build menu / advanced build menu (then the building's key)"],
  ["Worker: G, C", "Gather / Return cargo"],
  ["E", "Evolve the selected Pokémon (needs an Evolution Shrine, then an Elite Hall)"],
  ["Pokémon Center: S · Gym: A", "Train a worker / train your faction's starter"],
  ["Shrine, Elite Hall: A / D", "Research attack / defense upgrades"],
  ["Y", "Set rally point (production buildings)"],
  ["Tab", "Cycle subgroup (which kind the command card controls)"],
  ["Shift (hold)", "Show queued waypoints; keep targeting / placing after a click"],
  ["Ctrl + 1–0", "Set control group"],
  ["Shift + 1–0", "Add to control group"],
  ["Alt + 1–0", "Steal into control group (removes from other groups)"],
  ["1–0 (tap twice)", "Select control group (centre camera)"],
  ["F1 / Ctrl + F1", "Select an idle worker / all idle workers"],
  ["F2", "Select all army"],
  ["Backspace", "Cycle camera between your bases"],
  ["Space", "Jump to the last alert"],
  ["Ctrl + F5–F8 / F5–F8", "Save / jump to camera location"],
  ["Arrows, screen edge", "Scroll camera"],
  ["Middle mouse drag", "Drag camera"],
  ["Minimap", "Left: move camera · Right: move units · Alt+click: ping allies"],
  ["Enter", "Chat (multiplayer)"],
  ["Esc", "Cancel targeting, placement or submenu · release cursor lock"],
  ["F10 / F9", "Menu / lab panel (sandbox)"],
];

export function controlsHtml(): string {
  return `<div class="keys">${CONTROLS.map(([k, d]) => `<b>${k}</b><span>${d}</span>`).join("")}</div>`;
}
