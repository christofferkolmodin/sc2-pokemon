import { FP } from "../sim/fixed.ts";
import { KINDS } from "../sim/units.ts";
import type { World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import type { Renderer } from "./render/renderer.ts";
import { teamColor } from "./style.ts";

/**
 * SC2 minimap: terrain (the map's own minimap image when imported), fog of
 * war, resources, structures as squares, units as dots, the camera's
 * trapezoid and alert pings.
 */
export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private terrain: HTMLCanvasElement;
  private fog: HTMLCanvasElement;
  private fogImg: ImageData | null = null;
  private scale = 1;
  private lastDraw = 0;
  private lastFogTick = -1;
  private pings: { x: number; y: number; color: string; t0: number }[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    private world: World,
    private cam: Camera,
    private image: HTMLImageElement | null,
    private renderer: Renderer,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.terrain = document.createElement("canvas");
    this.fog = document.createElement("canvas");
    this.layout();
  }

  layout() {
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const m = this.world.map;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // Content box: the frame has 14 px of padding.
    this.scale = Math.min((box.width - 28) / m.w, (box.height - 28) / m.h);
    const w = Math.floor(m.w * this.scale);
    const h = Math.floor(m.h * this.scale);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Pre-render terrain: the map's minimap image, or levels and pathing shaded like SC2's.
    const R = 3;
    this.terrain.width = m.w * R;
    this.terrain.height = m.h * R;
    const g = this.terrain.getContext("2d")!;
    if (this.image) {
      g.drawImage(this.image, 0, 0, this.terrain.width, this.terrain.height);
      // Darken unpathable ground a little so paths read clearly.
      g.fillStyle = "rgba(0,0,0,0.35)";
      for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.terrain[y * m.w + x]) g.fillRect(x * R, y * R, R, R);
    } else {
      const img = g.createImageData(m.w * R, m.h * R);
      for (let y = 0; y < m.h * R; y++)
        for (let x = 0; x < m.w * R; x++) {
          const i = Math.floor(y / R) * m.w + Math.floor(x / R);
          const lv = m.level[i] / 16;
          const b = m.terrain[i];
          const o = (y * m.w * R + x) * 4;
          img.data[o] = b ? 28 : 52 + lv * 16;
          img.data[o + 1] = b ? 30 : 58 + lv * 18;
          img.data[o + 2] = b ? 28 : 42 + lv * 6;
          img.data[o + 3] = 255;
        }
      g.putImageData(img, 0, 0);
    }
    this.fog.width = m.w;
    this.fog.height = m.h;
    this.fogImg = this.fog.getContext("2d")!.createImageData(m.w, m.h);
    this.lastFogTick = -1;
  }

  /** Minimap pixel (relative to the canvas) to world tiles. */
  toWorld(px: number, py: number) {
    return { x: px / this.scale, y: py / this.scale };
  }

  ping(x: number, y: number, color: string) {
    this.pings.push({ x, y, color, t0: performance.now() });
  }

  draw(now: number, me: number, fogOn: boolean) {
    if (now - this.lastDraw < 50) return; // ~20 Hz is plenty
    this.lastDraw = now;
    const ctx = this.ctx;
    const s = this.scale;
    const w = this.world;
    const m = w.map;
    const fog = fogOn && me !== -1;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.terrain, 0, 0, m.w * s, m.h * s);
    if (fog && w.tick !== this.lastFogTick && this.fogImg) {
      this.lastFogTick = w.tick;
      const team = w.teamOf(me);
      const vis = w.vis.get(team);
      const exp = w.explored.get(team);
      const d = this.fogImg.data;
      if (vis && exp)
        for (let i = 0; i < vis.length; i++) {
          d[i * 4 + 3] = vis[i] ? 0 : exp[i] ? 110 : 215;
        }
      this.fog.getContext("2d")!.putImageData(this.fogImg, 0, 0);
    }
    if (fog) ctx.drawImage(this.fog, 0, 0, m.w * s, m.h * s);

    for (const u of w.units) {
      const k = KINDS[u.kind];
      if (u.hidden) continue;
      if (k.resource) {
        // Like SC2, resource fields show on the minimap even where you haven't scouted.
        if (k.resource > 2) continue;
        ctx.fillStyle = k.resource === 1 ? "#5ad0ff" : "#4cff6a";
        ctx.fillRect(u.tx * s, u.ty * s, Math.max(1.5, k.w * s), Math.max(1.5, k.h * s));
        continue;
      }
      if (fog && !w.canSee(me, u)) continue;
      ctx.fillStyle = teamColor(u.owner);
      if (k.structure) {
        ctx.fillRect(u.tx * s, u.ty * s, k.w * s, k.h * s);
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(u.tx * s, u.ty * s, k.w * s, k.h * s);
      } else {
        const r = Math.max(1.4, (u.radius / FP) * s);
        ctx.fillRect((u.x / FP) * s - r, (u.y / FP) * s - r, r * 2, r * 2);
      }
    }
    // Camera frustum: a trapezoid, like SC2, because the camera is tilted.
    const fp = this.cam.footprint();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    fp.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
    ctx.closePath();
    ctx.stroke();
    // Pings: shrinking circles.
    this.pings = this.pings.filter((p) => now - p.t0 < 3000);
    for (const p of this.pings) {
      const t = (now - p.t0) / 3000;
      for (const k of [0, 0.33, 0.66]) {
        const tt = (t * 3 + k) % 1;
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = (1 - tt) * (1 - t * 0.5);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x * s, p.y * s, 4 + (1 - tt) * 14, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    void this.renderer;
  }
}
