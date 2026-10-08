import { FP, abs, fdiv, idiv, isqrt } from "./fixed.ts";
import { type GameMap, isBlockedAt, isPassable } from "./map.ts";

export const UNREACHABLE = 0x3fffffff;
const COST_ORTHO = 10;
const COST_DIAG = 14;
const COST_NEAR_WALL = 6;

/**
 * Integration field (Dijkstra distance to a goal tile) shared by every unit
 * moving to the same target. One field per command, not per unit, so moving
 * 200 units costs about as much as moving one.
 */
export class FlowField {
  readonly key: number;
  readonly goalTile: number;
  /** Clearance class (milli-tiles) this field was built for. */
  readonly req: number;
  readonly dist: Int32Array;
  refs = 0;

  constructor(map: GameMap, goalTile: number, req: number, key: number) {
    this.key = key;
    this.goalTile = goalTile;
    this.req = req;
    this.dist = new Int32Array(map.w * map.h).fill(UNREACHABLE);
    compute(map, this.dist, goalTile, req);
  }
}

// Binary min-heap keyed by (dist, index): ties broken by index for determinism.
class Heap {
  d: number[] = [];
  i: number[] = [];
  get size() {
    return this.d.length;
  }
  push(dist: number, idx: number) {
    const d = this.d;
    const ix = this.i;
    d.push(dist);
    ix.push(idx);
    let c = d.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (d[p] < d[c] || (d[p] === d[c] && ix[p] < ix[c])) break;
      [d[p], d[c]] = [d[c], d[p]];
      [ix[p], ix[c]] = [ix[c], ix[p]];
      c = p;
    }
  }
  pop(): [number, number] {
    const d = this.d;
    const ix = this.i;
    const top: [number, number] = [d[0], ix[0]];
    const ld = d.pop()!;
    const li = ix.pop()!;
    if (d.length > 0) {
      d[0] = ld;
      ix[0] = li;
      let p = 0;
      const n = d.length;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let m = p;
        if (l < n && (d[l] < d[m] || (d[l] === d[m] && ix[l] < ix[m]))) m = l;
        if (r < n && (d[r] < d[m] || (d[r] === d[m] && ix[r] < ix[m]))) m = r;
        if (m === p) break;
        [d[p], d[m]] = [d[m], d[p]];
        [ix[p], ix[m]] = [ix[m], ix[p]];
        p = m;
      }
    }
    return top;
  }
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

function compute(map: GameMap, dist: Int32Array, goal: number, req: number) {
  const w = map.w;
  const heap = new Heap();
  dist[goal] = 0;
  heap.push(0, goal);
  while (heap.size > 0) {
    const [d, idx] = heap.pop();
    if (d !== dist[idx]) continue;
    const x = idx % w;
    const y = idx - x;
    const ty = idiv(y, w);
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = ty + DY[k];
      if (!isPassable(map, nx, ny, req)) continue;
      if (k >= 4 && (!isPassable(map, x + DX[k], ty, req) || !isPassable(map, x, ty + DY[k], req))) continue; // no corner cutting
      const n = ny * w + nx;
      const nd = d + (k < 4 ? COST_ORTHO : COST_DIAG) + (map.nearWall[n] ? COST_NEAR_WALL : 0);
      if (nd < dist[n]) {
        dist[n] = nd;
        heap.push(nd, n);
      }
    }
  }
}

/** Nearest tile passable for clearance `req` to (tx, ty), searching outward in rings. Deterministic. */
export function nearestPassableTile(map: GameMap, tx: number, ty: number, req: number): number {
  if (isPassable(map, tx, ty, req)) return ty * map.w + tx;
  for (let r = 1; r < 64; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (abs(dx) !== r && abs(dy) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (isPassable(map, x, y, req)) return y * map.w + x;
      }
    }
  }
  return -1;
}

/**
 * Line of sight for a disc of radius r moving from (ax,ay) to (bx,by):
 * samples the centre line and both edge lines every quarter tile.
 */
export function clearPath(map: GameMap, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len = isqrt(dx * dx + dy * dy);
  if (len === 0) return !isBlockedAt(map, ax, ay);
  const ox = len > 0 ? idiv(-dy * r, len) : 0;
  const oy = len > 0 ? idiv(dx * r, len) : 0;
  const step = idiv(FP, 4);
  const n = idiv(len, step) + 1;
  for (let i = 0; i <= n; i++) {
    const t = i >= n ? len : i * step;
    const px = ax + idiv(dx * t, len);
    const py = ay + idiv(dy * t, len);
    if (isBlockedAt(map, px, py)) return false;
    if (r > 0 && (isBlockedAt(map, px + ox, py + oy) || isBlockedAt(map, px - ox, py - oy))) return false;
  }
  return true;
}

const LOOKAHEAD = 12;

/**
 * Where should a unit at (x,y) steer next? Follows the field downhill for a few
 * tiles and returns the farthest tile centre it can reach in a straight line
 * (string-pulling on the fly), which gives smooth, non-grid-like paths.
 * Returns false if the unit's tile has no path.
 */
export function steerTarget(
  map: GameMap,
  field: FlowField,
  x: number,
  y: number,
  r: number,
  out: { x: number; y: number },
): boolean {
  const w = map.w;
  const req = field.req;
  const tx = fdiv(x, FP);
  const ty = fdiv(y, FP);
  let cur = ty * w + tx;
  if (!isPassable(map, tx, ty, req) || field.dist[cur] >= UNREACHABLE) {
    // Pushed into a wall or onto an unreachable tile: find a neighbour that is on the field.
    let best = -1;
    let bestD = UNREACHABLE;
    for (let k = 0; k < 8; k++) {
      const nx = tx + DX[k];
      const ny = ty + DY[k];
      if (!isPassable(map, nx, ny, req)) continue;
      const n = ny * w + nx;
      if (field.dist[n] < bestD) {
        bestD = field.dist[n];
        best = n;
      }
    }
    if (best < 0) return false;
    out.x = (best % w) * FP + (FP >> 1);
    out.y = idiv(best - (best % w), w) * FP + (FP >> 1);
    return true;
  }
  const chain: number[] = [];
  for (let s = 0; s < LOOKAHEAD; s++) {
    const d = field.dist[cur];
    if (d === 0) break;
    let best = -1;
    let bestD = d;
    const cx = cur % w;
    const cy = idiv(cur - cx, w);
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k];
      const ny = cy + DY[k];
      if (!isPassable(map, nx, ny, req)) continue;
      if (k >= 4 && (!isPassable(map, cx + DX[k], cy, req) || !isPassable(map, cx, cy + DY[k], req))) continue;
      const n = ny * w + nx;
      if (field.dist[n] < bestD) {
        bestD = field.dist[n];
        best = n;
      }
    }
    if (best < 0) break;
    chain.push(best);
    cur = best;
  }
  if (chain.length === 0) {
    out.x = tx * FP + (FP >> 1);
    out.y = ty * FP + (FP >> 1);
    return true;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const c = chain[i];
    const cx = (c % w) * FP + (FP >> 1);
    const cy = idiv(c - (c % w), w) * FP + (FP >> 1);
    if (i === 0 || clearPath(map, x, y, cx, cy, r)) {
      out.x = cx;
      out.y = cy;
      return true;
    }
  }
  return true;
}
