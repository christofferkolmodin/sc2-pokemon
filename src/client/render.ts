import { FP } from "../sim/fixed.ts";
import { MODE_ATTACK, MODE_PATROL } from "../sim/commands.ts";
import { KINDS } from "../sim/units.ts";
import type { Unit, World } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import type { Selection } from "./selection.ts";
import { AIR_LIFT, SELECT_ENEMY, SELECT_NEUTRAL, SELECT_OWN, TYPE_COLORS, teamColor } from "./style.ts";

/**
 * Canvas 2D renderer. Kept behind a small interface (draw + pick) so it can be
 * swapped for PixiJS/WebGL or Three.js later without touching the sim or input.
 */

export interface Marker {
  x: number;
  y: number;
  color: string;
  t0: number;
}

export interface FrameState {
  alpha: number;
  now: number;
  selection: Selection;
  hoverId: number;
  dragBox: { x0: number; y0: number; x1: number; y1: number } | null;
  showWaypoints: boolean;
  cursor: { x: number; y: number; targeting: string | null } | null;
}

const CHUNK = 16;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private chunks = new Map<string, HTMLCanvasElement>();
  private chunkPpt = 0;
  private facing = new Map<number, number>();
  markers: Marker[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private cam: Camera,
  ) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  /** Interpolated position in tiles. */
  pos(u: Unit, alpha: number): { x: number; y: number } {
    const x = (u.px + (u.x - u.px) * alpha) / FP;
    let y = (u.py + (u.y - u.py) * alpha) / FP;
    if (u.air) y -= AIR_LIFT;
    return { x, y };
  }

  // -------------------------------------------------------------- terrain

  private chunk(cx: number, cy: number): HTMLCanvasElement {
    const ppt = this.cam.ppt * this.dpr;
    if (ppt !== this.chunkPpt) {
      this.chunks.clear();
      this.chunkPpt = ppt;
    }
    const key = `${cx},${cy}`;
    let c = this.chunks.get(key);
    if (c) return c;
    c = document.createElement("canvas");
    const size = Math.ceil(CHUNK * ppt);
    c.width = size;
    c.height = size;
    const g = c.getContext("2d")!;
    const m = this.world.map;
    const blocked = (x: number, y: number) => x < 0 || y < 0 || x >= m.w || y >= m.h || m.blocked[y * m.w + x] === 1;
    for (let ty = 0; ty < CHUNK; ty++) {
      for (let tx = 0; tx < CHUNK; tx++) {
        const x = cx * CHUNK + tx;
        const y = cy * CHUNK + ty;
        if (x >= m.w || y >= m.h) continue;
        const px = tx * ppt;
        const py = ty * ppt;
        const n = ((x * 73856093) ^ (y * 19349663)) & 255;
        if (!blocked(x, y)) {
          // Ground: muted green-grey with a little per-tile variation.
          const l = 18 + (n % 3) * 0.6;
          g.fillStyle = `hsl(${96 + (n % 5)}, 11%, ${l}%)`;
          g.fillRect(px, py, ppt + 1, ppt + 1);
          if (n % 7 === 0) {
            g.fillStyle = "rgba(255,255,255,0.025)";
            g.fillRect(px + ppt * 0.3, py + ppt * 0.4, ppt * 0.15, ppt * 0.1);
          }
          // Soft shadow cast by a cliff above this tile.
          if (blocked(x, y - 1)) {
            const grd = g.createLinearGradient(0, py, 0, py + ppt * 0.6);
            grd.addColorStop(0, "rgba(0,0,0,0.45)");
            grd.addColorStop(1, "rgba(0,0,0,0)");
            g.fillStyle = grd;
            g.fillRect(px, py, ppt + 1, ppt * 0.6);
          }
        } else {
          // Rock / cliff: top face plus a darker face where it drops to walkable ground.
          g.fillStyle = `hsl(28, 14%, ${23 + (n % 4)}%)`;
          g.fillRect(px, py, ppt + 1, ppt + 1);
          if (!blocked(x, y + 1)) {
            g.fillStyle = "hsl(25, 16%, 13%)";
            g.fillRect(px, py + ppt * 0.62, ppt + 1, ppt * 0.38 + 1);
          }
          if (!blocked(x, y - 1)) {
            g.fillStyle = "rgba(255,240,220,0.14)";
            g.fillRect(px, py, ppt + 1, Math.max(1, ppt * 0.08));
          }
          if (!blocked(x - 1, y)) {
            g.fillStyle = "rgba(255,240,220,0.07)";
            g.fillRect(px, py, Math.max(1, ppt * 0.06), ppt + 1);
          }
          if (!blocked(x + 1, y)) {
            g.fillStyle = "rgba(0,0,0,0.25)";
            g.fillRect(px + ppt * 0.94, py, ppt * 0.06 + 1, ppt + 1);
          }
        }
      }
    }
    this.chunks.set(key, c);
    return c;
  }

  private drawTerrain() {
    const ctx = this.ctx;
    const v = this.cam.view();
    const m = this.world.map;
    const cx0 = Math.max(0, Math.floor(v.x0 / CHUNK));
    const cy0 = Math.max(0, Math.floor(v.y0 / CHUNK));
    const cx1 = Math.min(Math.ceil(m.w / CHUNK) - 1, Math.floor(v.x1 / CHUNK));
    const cy1 = Math.min(Math.ceil(m.h / CHUNK) - 1, Math.floor(v.y1 / CHUNK));
    const ppt = this.cam.ppt;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunk(cx, cy);
        const sx = this.cam.toScreenX(cx * CHUNK);
        const sy = this.cam.toScreenY(cy * CHUNK);
        ctx.drawImage(c, Math.floor(sx), Math.floor(sy), Math.ceil(CHUNK * ppt) + 1, Math.ceil(CHUNK * ppt) + 1);
      }
    }
  }

  // ---------------------------------------------------------------- units

  private updateFacing(u: Unit) {
    const speed2 = u.vx * u.vx + u.vy * u.vy;
    let f = this.facing.get(u.id) ?? -Math.PI / 2;
    if (speed2 > (FP / 200) ** 2) {
      const target = Math.atan2(u.vy, u.vx);
      let d = target - f;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      f += d * 0.35;
    }
    this.facing.set(u.id, f);
    return f;
  }

  private drawUnitBody(u: Unit, x: number, y: number, face: number) {
    const ctx = this.ctx;
    const k = KINDS[u.kind];
    const r = (u.radius / FP) * this.cam.ppt;
    const [main, dark, light] = TYPE_COLORS[k.type];
    const fx = Math.cos(face);
    const fy = Math.sin(face);
    const bx = x - fx * r * 0.55; // a point on the unit's back
    const by = y - fy * r * 0.55;

    // Kind-specific "back" features drawn under the body.
    if (k.name === "Charizard") {
      ctx.fillStyle = dark;
      for (const side of [-1, 1]) {
        const px = -fy * side;
        const py = fx * side;
        ctx.beginPath();
        ctx.moveTo(x + px * r * 0.3, y + py * r * 0.3);
        ctx.lineTo(x + px * r * 1.9 - fx * r * 0.5, y + py * r * 1.9 - fy * r * 0.5);
        ctx.lineTo(x + px * r * 0.9 - fx * r * 1.0, y + py * r * 0.9 - fy * r * 1.0);
        ctx.closePath();
        ctx.fill();
      }
    }
    if (k.name === "Charmander" || k.name === "Charizard") {
      // Flame tail.
      ctx.fillStyle = "#ffcf3a";
      ctx.beginPath();
      ctx.arc(x - fx * r * 1.15, y - fy * r * 1.15, r * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ff6a1a";
      ctx.beginPath();
      ctx.arc(x - fx * r * 1.15, y - fy * r * 1.15, r * 0.17, 0, Math.PI * 2);
      ctx.fill();
    }

    // Team-coloured rim + body.
    ctx.fillStyle = teamColor(u.owner);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    const grd = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r * 0.86);
    grd.addColorStop(0, light);
    grd.addColorStop(0.45, main);
    grd.addColorStop(1, dark);
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.86, 0, Math.PI * 2);
    ctx.fill();

    if (k.name === "Squirtle") {
      // Shell.
      ctx.strokeStyle = "#8a5a2a";
      ctx.lineWidth = Math.max(1, r * 0.14);
      ctx.beginPath();
      ctx.arc(bx, by, r * 0.42, 0, Math.PI * 2);
      ctx.stroke();
    } else if (k.name === "Bulbasaur" || k.name === "Venusaur") {
      // Bulb / flower on the back.
      ctx.fillStyle = "#2f7a46";
      ctx.beginPath();
      ctx.arc(bx, by, r * 0.42, 0, Math.PI * 2);
      ctx.fill();
      if (k.name === "Venusaur") {
        ctx.fillStyle = "#ff7d9c";
        for (let i = 0; i < 5; i++) {
          const a = face + (i * Math.PI * 2) / 5;
          ctx.beginPath();
          ctx.arc(bx + Math.cos(a) * r * 0.3, by + Math.sin(a) * r * 0.3, r * 0.17, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = "#ffe36b";
        ctx.beginPath();
        ctx.arc(bx, by, r * 0.12, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Eyes, so you can see which way it faces.
    ctx.fillStyle = "#16181c";
    const ex = x + fx * r * 0.45;
    const ey = y + fy * r * 0.45;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(ex - fy * side * r * 0.22, ey + fx * side * r * 0.22, Math.max(1, r * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawUnits(state: FrameState, air: boolean) {
    const ctx = this.ctx;
    const ppt = this.cam.ppt;
    const v = this.cam.view();
    const sel = state.selection;
    const selected = new Set(sel.ids);
    const list = this.world.units.filter((u) => u.air === air);

    // Shadows first (air shadows sit on the ground below the unit).
    ctx.fillStyle = air ? "rgba(0,0,0,0.28)" : "rgba(0,0,0,0.35)";
    for (const u of list) {
      const p = this.pos(u, state.alpha);
      if (p.x < v.x0 - 3 || p.x > v.x1 + 3 || p.y < v.y0 - 3 || p.y > v.y1 + 3) continue;
      const r = (u.radius / FP) * ppt;
      const sx = this.cam.toScreenX(p.x) + r * 0.12;
      const sy = this.cam.toScreenY(p.y + (air ? AIR_LIFT : 0)) + r * 0.18;
      ctx.beginPath();
      ctx.ellipse(sx, sy, r * 0.95, r * 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Selection circles under the bodies.
    for (const u of list) {
      if (!selected.has(u.id) && u.id !== state.hoverId) continue;
      const p = this.pos(u, state.alpha);
      const r = (u.radius / FP) * ppt;
      const color = sel.isMine(u) ? SELECT_OWN : u.owner === 7 ? SELECT_NEUTRAL : SELECT_ENEMY;
      ctx.strokeStyle = color;
      ctx.globalAlpha = selected.has(u.id) ? 1 : 0.45;
      ctx.lineWidth = Math.max(1.5, ppt * 0.035);
      ctx.beginPath();
      ctx.arc(this.cam.toScreenX(p.x), this.cam.toScreenY(p.y), r + ppt * 0.07, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const u of list) {
      const p = this.pos(u, state.alpha);
      const face = this.updateFacing(u);
      if (p.x < v.x0 - 3 || p.x > v.x1 + 3 || p.y < v.y0 - 3 || p.y > v.y1 + 3) continue;
      this.drawUnitBody(u, this.cam.toScreenX(p.x), this.cam.toScreenY(p.y), face);
    }
  }

  private drawWaypoints(state: FrameState) {
    const ctx = this.ctx;
    ctx.lineWidth = 1.5;
    for (const u of state.selection.units()) {
      if (!state.selection.isMine(u) || u.orders.length === 0) continue;
      const p = this.pos(u, state.alpha);
      let lx = this.cam.toScreenX(p.x);
      let ly = this.cam.toScreenY(p.y);
      for (const o of u.orders) {
        const color = o.mode === MODE_ATTACK ? "rgba(255,70,60,0.75)" : o.mode === MODE_PATROL ? "rgba(255,220,60,0.75)" : "rgba(60,255,90,0.75)";
        const nx = this.cam.toScreenX(o.x / FP);
        const ny = this.cam.toScreenY(o.y / FP - (u.air ? AIR_LIFT : 0));
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(nx, ny, 3, 0, Math.PI * 2);
        ctx.fill();
        lx = nx;
        ly = ny;
      }
    }
  }

  /** SC2-style click feedback: chevrons converging on the target. */
  private drawMarkers(now: number) {
    const ctx = this.ctx;
    const DUR = 420;
    this.markers = this.markers.filter((m) => now - m.t0 < DUR);
    for (const m of this.markers) {
      const t = (now - m.t0) / DUR;
      const x = this.cam.toScreenX(m.x);
      const y = this.cam.toScreenY(m.y);
      const s = this.cam.ppt * 0.5;
      const d = s * (1 - t) + s * 0.25;
      ctx.strokeStyle = m.color;
      ctx.globalAlpha = 1 - t * t;
      ctx.lineWidth = 2.5;
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        const cx = x + Math.cos(a) * d;
        const cy = y + Math.sin(a) * d * 0.8;
        const w = s * 0.28;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a + 2.3) * w, cy + Math.sin(a + 2.3) * w * 0.8);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a - 2.3) * w, cy + Math.sin(a - 2.3) * w * 0.8);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawCursor(c: NonNullable<FrameState["cursor"]>) {
    const ctx = this.ctx;
    if (c.targeting) {
      const color = c.targeting === "attack" ? SELECT_ENEMY : c.targeting === "patrol" ? SELECT_NEUTRAL : SELECT_OWN;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 11, 0, Math.PI * 2);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        ctx.moveTo(c.x + dx * 6, c.y + dy * 6);
        ctx.lineTo(c.x + dx * 16, c.y + dy * 16);
      }
      ctx.stroke();
      return;
    }
    ctx.fillStyle = "#c8ffb0";
    ctx.strokeStyle = "#0d2a10";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(c.x + 4, c.y + 18);
    ctx.lineTo(c.x + 8.5, c.y + 12);
    ctx.lineTo(c.x + 16, c.y + 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  draw(state: FrameState) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#07090b";
    ctx.fillRect(0, 0, this.cam.w, this.cam.h);
    this.drawTerrain();
    this.drawUnits(state, false);
    if (state.showWaypoints) this.drawWaypoints(state);
    this.drawUnits(state, true);
    this.drawMarkers(state.now);
    if (state.dragBox) {
      const b = state.dragBox;
      const x = Math.min(b.x0, b.x1);
      const y = Math.min(b.y0, b.y1);
      const w = Math.abs(b.x1 - b.x0);
      const h = Math.abs(b.y1 - b.y0);
      ctx.fillStyle = "rgba(60,255,82,0.07)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = SELECT_OWN;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }
    if (state.cursor) this.drawCursor(state.cursor);
  }

  // ---------------------------------------------------------------- picking

  /** Topmost unit under a screen point (air first, then ground). */
  pick(sx: number, sy: number, alpha: number): Unit | null {
    const w = this.cam.toWorld(sx, sy);
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const u of this.world.units) {
      const p = this.pos(u, alpha);
      const r = u.radius / FP + 0.15;
      const d = Math.hypot(p.x - w.x, p.y - w.y);
      const score = d - (u.air ? 0.5 : 0);
      if (d <= r && score < bestD) {
        best = u;
        bestD = score;
      }
    }
    return best;
  }

  /** Units whose drawn circle touches a screen rectangle. */
  pickBox(x0: number, y0: number, x1: number, y1: number, alpha: number): Unit[] {
    const a = this.cam.toWorld(Math.min(x0, x1), Math.min(y0, y1));
    const b = this.cam.toWorld(Math.max(x0, x1), Math.max(y0, y1));
    return this.world.units.filter((u) => {
      const p = this.pos(u, alpha);
      const r = u.radius / FP;
      return p.x + r >= a.x && p.x - r <= b.x && p.y + r >= a.y && p.y - r <= b.y;
    });
  }

  onScreen(u: Unit, alpha: number) {
    const v = this.cam.view();
    const p = this.pos(u, alpha);
    return p.x >= v.x0 && p.x <= v.x1 && p.y >= v.y0 && p.y <= v.y1;
  }
}
