import { FP, abs, fdiv, isqrt } from "./fixed.ts";

export interface GameMap {
  name: string;
  w: number; // tiles
  h: number; // tiles
  /** 1 = unpathable for ground units. Index = y * w + x. */
  blocked: Uint8Array;
  /** 1 = walkable tile next to a blocked tile (paths prefer to avoid these). */
  nearWall: Uint8Array;
  /** Distance from tile centre to the nearest blocked tile, in milli-tiles (capped at 4000). 0 if blocked. */
  clearance: Uint16Array;
  /** Start locations in tile coordinates (tile centers). */
  starts: { x: number; y: number }[];
}

/**
 * Can a unit needing `req` milli-tiles of clearance stand on this tile centre?
 * Big units need wider gaps, so they get their own flow fields (see clearanceFor()).
 */
export function isPassable(m: GameMap, tx: number, ty: number, req: number): boolean {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
  const i = ty * m.w + tx;
  return m.blocked[i] === 0 && m.clearance[i] >= req;
}

/** Clearance class for a unit radius (milli-tiles). A small tolerance lets units squeeze between tile centres. */
export function clearanceFor(radiusMilli: number): number {
  if (radiusMilli <= 500) return 0;
  if (radiusMilli <= 750) return 500;
  if (radiusMilli <= 1000) return 750;
  return 1000;
}

export function isBlockedTile(m: GameMap, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return true;
  return m.blocked[ty * m.w + tx] === 1;
}

/** Is the point (in subunits) inside a blocked tile? */
export function isBlockedAt(m: GameMap, x: number, y: number): boolean {
  return isBlockedTile(m, fdiv(x, FP), fdiv(y, FP));
}

function finalize(m: GameMap): GameMap {
  const { w, h, blocked, nearWall } = m;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (blocked[y * w + x]) continue;
      let near = 0;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (isBlockedTile(m, x + dx, y + dy)) {
            near = 1;
            break;
          }
      nearWall[y * w + x] = near;
      // Clearance: distance from this tile's centre to the nearest edge of any blocked tile.
      let best = 4000;
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          if (!isBlockedTile(m, x + dx, y + dy)) continue;
          const hx = Math.max(0, 2 * abs(dx) - 1);
          const hy = Math.max(0, 2 * abs(dy) - 1);
          const d = isqrt((hx * hx + hy * hy) * 250000);
          if (d < best) best = d;
        }
      m.clearance[y * w + x] = best;
    }
  }
  return m;
}

/**
 * "Feel lab" test map: point-symmetric 2-player layout with a main base and ramp,
 * a narrow choke, rocks, a diagonal wall and a wide open field.
 * Designed for tuning movement, not for balance.
 */
export function makeLabMap(): GameMap {
  const w = 96;
  const h = 72;
  const blocked = new Uint8Array(w * h);
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < w && y < h) blocked[y * w + x] = 1;
  };
  // Border.
  rect(0, 0, w - 1, 0);
  rect(0, h - 1, w - 1, h - 1);
  rect(0, 0, 0, h - 1);
  rect(w - 1, 0, w - 1, h - 1);

  // Main base cliff with a 3-tile ramp opening to the east.
  rect(22, 1, 23, 22);
  rect(22, 26, 23, 32);
  rect(1, 31, 23, 32);
  // Ramp "shoulders" so the opening behaves like a ramp choke.
  rect(24, 21, 25, 22);
  rect(24, 26, 25, 27);

  // Long wall with a 2-tile gap (tests heavy congestion).
  rect(30, 10, 43, 12);
  rect(46, 10, 60, 12);

  // Rock clusters.
  rect(40, 20, 43, 23);
  rect(30, 44, 33, 50);
  rect(12, 44, 15, 47);
  // Central pillar (symmetric on its own).
  rect(46, 34, 49, 37);

  // Diagonal wall (staircase) to test smoothing along non-axis-aligned edges.
  for (let i = 0; i < 12; i++) rect(58 + i, 40 + i, 59 + i, 41 + i);

  // Mirror (point symmetry around the map center).
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (blocked[y * w + x]) blocked[(h - 1 - y) * w + (w - 1 - x)] = 1;

  return finalize({
    name: "Feel Lab",
    w,
    h,
    blocked,
    nearWall: new Uint8Array(w * h),
    clearance: new Uint16Array(w * h),
    starts: [
      { x: 11, y: 15 },
      { x: w - 1 - 11, y: h - 1 - 15 },
      { x: 11, y: h - 1 - 12 },
      { x: w - 1 - 11, y: 12 },
    ],
  });
}

export function makeMap(name: string): GameMap {
  switch (name) {
    case "lab":
    default:
      return makeLabMap();
  }
}
