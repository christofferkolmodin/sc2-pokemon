/** Control reference shown in the lobby and the in-game help panel. */
export const CONTROLS: [string, string][] = [
  ["Left click / drag", "Select unit / box select (empty ground keeps your selection)"],
  ["Shift + click / drag", "Add or remove from selection"],
  ["Ctrl + click, double-click", "Select all of that kind on screen"],
  ["Right click", "Move (Shift: queue a waypoint)"],
  ["A, then click", "Attack-move (moves for now; combat comes in milestone 3)"],
  ["M / P, then click", "Move / Patrol"],
  ["S / H", "Stop / Hold position"],
  ["Shift (hold)", "Show queued waypoints; keep targeting after a click"],
  ["Ctrl + 1–0", "Set control group"],
  ["Shift + 1–0", "Add to control group"],
  ["Alt + 1–0", "Steal into control group (removes from other groups)"],
  ["1–0 (tap twice)", "Select control group (centre camera)"],
  ["F2", "Select all army"],
  ["Ctrl + F5–F8 / F5–F8", "Save / jump to camera location"],
  ["Arrows, screen edge", "Scroll camera"],
  ["Middle mouse drag", "Drag camera"],
  ["Minimap", "Left: move camera · Right: move units"],
  ["Esc", "Cancel targeting · release cursor lock"],
  ["F10", "Movement tuning panel"],
];

export function controlsHtml(): string {
  return `<div class="keys">${CONTROLS.map(([k, d]) => `<b>${k}</b><span>${d}</span>`).join("")}</div>`;
}
