import { FP } from "../sim/fixed.ts";
import type { World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import { teamColor } from "./style.ts";

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement;
  private scale = 1;
  private lastDraw = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private world: World,
    private cam: Camera,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.terrain = document.createElement("canvas");
    this.layout();
  }

  layout() {
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const m = this.world.map;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.scale = Math.min(box.width / m.w, box.height / m.h);
    const w = Math.floor(m.w * this.scale);
    const h = Math.floor(m.h * this.scale);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Pre-render terrain.
    this.terrain.width = m.w;
    this.terrain.height = m.h;
    const g = this.terrain.getContext("2d")!;
    const img = g.createImageData(m.w, m.h);
    for (let i = 0; i < m.w * m.h; i++) {
      const b = m.blocked[i];
      img.data[i * 4] = b ? 70 : 38;
      img.data[i * 4 + 1] = b ? 58 : 46;
      img.data[i * 4 + 2] = b ? 48 : 36;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  /** Minimap pixel (relative to the canvas) to world tiles. */
  toWorld(px: number, py: number) {
    return { x: px / this.scale, y: py / this.scale };
  }

  draw(now: number) {
    if (now - this.lastDraw < 50) return; // ~20 Hz is plenty
    this.lastDraw = now;
    const ctx = this.ctx;
    const s = this.scale;
    const m = this.world.map;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrain, 0, 0, m.w * s, m.h * s);
    for (const u of this.world.units) {
      ctx.fillStyle = teamColor(u.owner);
      const r = Math.max(1.5, (u.radius / FP) * s);
      ctx.fillRect((u.x / FP) * s - r, (u.y / FP) * s - r, r * 2, r * 2);
    }
    // Camera frustum. The bottom part hidden by the console still counts as on-screen in SC2.
    const v = this.cam.view();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(v.x0 * s + 0.5, v.y0 * s + 0.5, (v.x1 - v.x0) * s, (v.y1 - v.y0) * s);
  }
}
