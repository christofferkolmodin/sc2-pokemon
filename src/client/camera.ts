import { type Mat4, invert, lookAt, multiply, perspective, transform4 } from "./gl/math.ts";

/**
 * SC2-style camera: a perspective camera looking down at a fixed pitch from the
 * south, panning over the ground. (x, y) is the ground point the camera looks
 * at, in tiles. Defaults match SC2's standard camera (distance 34, pitch 56°,
 * ~31° vertical field of view). Like SC2, the camera rises and falls smoothly
 * with the terrain under it.
 */
export class Camera {
  x = 0;
  y = 0;
  w = 1;
  h = 1;
  /** Height of the HUD console covering the bottom of the screen (CSS px). */
  consoleH = 0;
  saved: ({ x: number; y: number } | null)[] = [null, null, null, null];

  fov = (31 * Math.PI) / 180;
  pitch = (56 * Math.PI) / 180;
  distance = 34;
  /** Height of the point the camera looks at (follows the terrain smoothly). */
  th = 0;
  /** Terrain height at a map position (set by the renderer). */
  ground: (x: number, y: number) => number = () => 0;

  readonly view: Mat4 = new Float32Array(16);
  readonly proj: Mat4 = new Float32Array(16);
  readonly viewProj: Mat4 = new Float32Array(16);
  private inv: Mat4 = new Float32Array(16);
  eye = [0, 0, 0];

  constructor(
    public mapW: number,
    public mapH: number,
  ) {}

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.update();
    this.clamp();
  }

  /** Ease the camera height toward the terrain under it (call once per frame). */
  follow(dt: number) {
    let sum = 0;
    // Average a few samples so cliffs don't make the camera jump.
    for (const [dx, dy] of [
      [0, 0],
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
    ])
      sum += this.ground(this.x + dx, this.y + dy);
    const target = sum / 5;
    this.th += (target - this.th) * Math.min(1, dt * 4);
    this.update();
  }

  update() {
    const t = [this.x, this.th, this.y];
    this.eye = [this.x, this.th + Math.sin(this.pitch) * this.distance, this.y + Math.cos(this.pitch) * this.distance];
    lookAt(this.view, this.eye, t, [0, 1, 0]);
    perspective(this.proj, this.fov, this.w / this.h, 1, 300);
    multiply(this.viewProj, this.proj, this.view);
    invert(this.inv, this.viewProj);
  }

  /** Approximate CSS pixels per tile at the screen centre (for drag-panning). */
  get ppt(): number {
    const a = this.toPlane(this.w / 2, this.h / 2);
    const b = this.toPlane(this.w / 2 + 100, this.h / 2);
    return 100 / Math.max(0.001, Math.hypot(b.x - a.x, b.y - a.y));
  }

  /**
   * SC2-like bounds: the top of the screen can't go past the north edge, and the
   * south edge of the map can scroll up to just above the console.
   */
  clamp() {
    this.update();
    const top = this.toPlane(this.w / 2, 0).y - this.y;
    const bottom = this.toPlane(this.w / 2, this.h - this.consoleH).y - this.y;
    const half = this.toPlane(this.w, this.h / 2).x - this.x;
    const minX = Math.min(half - 1, this.mapW / 2);
    const maxX = Math.max(this.mapW - half + 1, this.mapW / 2);
    this.x = Math.max(minX, Math.min(maxX, this.x));
    this.y = Math.max(-top - 1, Math.min(this.mapH + 1 - bottom, this.y));
    this.update();
  }

  /** Put a world point at the centre of the visible area above the console. */
  centerOn(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.update();
    const c = this.toPlane(this.w / 2, (this.h - this.consoleH) / 2);
    this.x += x - c.x;
    this.y += y - c.y;
    this.clamp();
  }

  pan(dx: number, dy: number) {
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  private ray(sx: number, sy: number) {
    const nx = (sx / this.w) * 2 - 1;
    const ny = 1 - (sy / this.h) * 2;
    const a = transform4(this.inv, nx, ny, -1);
    const b = transform4(this.inv, nx, ny, 1);
    return {
      ax: a[0] / a[3],
      ay: a[1] / a[3],
      az: a[2] / a[3],
      bx: b[0] / b[3],
      by: b[1] / b[3],
      bz: b[2] / b[3],
    };
  }

  /** Screen point to the horizontal plane at height `gy` (default: the camera's look-at height). */
  toPlane(sx: number, sy: number, gy = this.th): { x: number; y: number } {
    const r = this.ray(sx, sy);
    const t = (gy - r.ay) / (r.by - r.ay);
    return { x: r.ax + (r.bx - r.ax) * t, y: r.az + (r.bz - r.az) * t };
  }

  /** Screen point to the terrain surface (iterated ray / heightfield intersection). */
  toWorld(sx: number, sy: number): { x: number; y: number } {
    const r = this.ray(sx, sy);
    let p = this.toPlane(sx, sy);
    for (let i = 0; i < 6; i++) {
      const h = this.ground(p.x, p.y);
      const t = (h - r.ay) / (r.by - r.ay);
      const q = { x: r.ax + (r.bx - r.ax) * t, y: r.az + (r.bz - r.az) * t };
      // Damped so the iteration settles on cliffs instead of bouncing between levels.
      p = { x: p.x + (q.x - p.x) * 0.7, y: p.y + (q.y - p.y) * 0.7 };
    }
    return p;
  }

  /** World point (map x, height, map y) to screen. */
  project(wx: number, h: number, wy: number): { x: number; y: number; depth: number } {
    const c = transform4(this.viewProj, wx, h, wy);
    return { x: ((c[0] / c[3] + 1) / 2) * this.w, y: ((1 - c[1] / c[3]) / 2) * this.h, depth: c[3] };
  }

  /** Ground footprint of the screen (for the minimap and culling): TL, TR, BR, BL. */
  footprint(): { x: number; y: number }[] {
    return [this.toPlane(0, 0), this.toPlane(this.w, 0), this.toPlane(this.w, this.h), this.toPlane(0, this.h)];
  }
}
