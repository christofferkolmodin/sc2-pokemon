import { type GameMap, makeMap } from "../sim/map.ts";

/** Preview images of built-in maps for the lobby (imported maps bring their own minimap). */

const cache = new Map<string, string>();

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
