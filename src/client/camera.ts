import { VIEW_TILES_Y } from "./style.ts";

/** Top-down camera. Positions are in tiles (floats are fine: this is client-side only). */
export class Camera {
  x = 0;
  y = 0;
  /** CSS pixels per tile. */
  ppt = 64;
  w = 1;
  h = 1;
  /** Height of the HUD console that covers the bottom of the screen (CSS px). */
  consoleH = 0;
  saved: ({ x: number; y: number } | null)[] = [null, null, null, null];

  constructor(
    public mapW: number,
    public mapH: number,
  ) {}

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.ppt = h / VIEW_TILES_Y;
    this.clamp();
  }

  /** Like SC2, the camera can look a little past the map edge so units at the bottom aren't hidden by the console. */
  clamp() {
    const halfW = this.w / 2 / this.ppt;
    const halfH = this.h / 2 / this.ppt;
    const bottomPad = this.consoleH / this.ppt;
    this.x = Math.max(halfW - 2, Math.min(this.mapW - halfW + 2, this.x));
    this.y = Math.max(halfH - 2, Math.min(this.mapH - halfH + 2 + bottomPad, this.y));
  }

  /** Centre the camera on a world point, accounting for the console at the bottom. */
  centerOn(x: number, y: number) {
    this.x = x;
    this.y = y + this.consoleH / 2 / this.ppt;
    this.clamp();
  }

  pan(dx: number, dy: number) {
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.w / 2) / this.ppt + this.x, y: (sy - this.h / 2) / this.ppt + this.y };
  }

  toScreenX(wx: number) {
    return (wx - this.x) * this.ppt + this.w / 2;
  }
  toScreenY(wy: number) {
    return (wy - this.y) * this.ppt + this.h / 2;
  }

  /** Visible world rectangle (tiles). */
  view() {
    const halfW = this.w / 2 / this.ppt;
    const halfH = this.h / 2 / this.ppt;
    return { x0: this.x - halfW, y0: this.y - halfH, x1: this.x + halfW, y1: this.y + halfH };
  }
}
