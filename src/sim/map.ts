import { FP, abs, fdiv, idiv, isqrt } from "./fixed.ts";

export type MapObjectKind = "mineral" | "mineral900" | "rich" | "geyser" | "rock" | "rock2" | "tower";

/**
 * Map data as loaded from a built-in generator or an imported SC2 map.
 * Only integer grids; render-only data (heights, doodads, minimap image)
 * lives on the client.
 */
export interface MapDef {
  key: string;
  name: string;
  w: number; // tiles
  h: number; // tiles
  /** 1 = unpathable terrain (cliffs, water, doodads). Index = y * w + x. */
  terrain: Uint8Array;
  /** Height per tile in 1/16 cliff levels (0 = lowest, 16 = one cliff up). Ramps are in between. */
  level: Uint8Array;
  /** 1 = structures can't be placed here (ramps, painted unbuildable). */
  nobuild: Uint8Array;
  /** Start locations: centre tile of the starting Pokémon Center (5x5 footprint around it). */
  starts: { x: number; y: number }[];
  /** Resources and destructible rocks. (tx, ty) = top-left footprint tile. */
  objects: { kind: MapObjectKind; tx: number; ty: number }[];
}

export interface GameMap {
  key: string;
  name: string;
  w: number;
  h: number;
  terrain: Uint8Array;
  level: Uint8Array;
  nobuild: Uint8Array;
  /** Structure / resource / rock occupancy count per tile. */
  occ: Uint8Array;
  /** 1 = unpathable for ground units right now (terrain or occupied). */
  blocked: Uint8Array;
  /** 1 = walkable tile next to a blocked tile (paths prefer to avoid these). */
  nearWall: Uint8Array;
  /** Distance from tile centre to the nearest blocked tile, in milli-tiles (capped at 4000). 0 if blocked. */
  clearance: Uint16Array;
  starts: { x: number; y: number }[];
  objects: MapDef["objects"];
  /** Bumped every time the blocked grid changes (structures placed or destroyed). */
  version: number;
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

export function levelAt(m: GameMap, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return 0;
  return m.level[ty * m.w + tx];
}

/** Recompute blocked / nearWall / clearance inside a tile rectangle (inclusive). */
export function refreshRegion(m: GameMap, x0: number, y0: number, x1: number, y1: number) {
  const { w, h } = m;
  const ax = Math.max(0, x0);
  const ay = Math.max(0, y0);
  const bx = Math.min(w - 1, x1);
  const by = Math.min(h - 1, y1);
  for (let y = ay; y <= by; y++)
    for (let x = ax; x <= bx; x++) {
      const i = y * w + x;
      m.blocked[i] = m.terrain[i] || m.occ[i] ? 1 : 0;
    }
  // nearWall and clearance depend on blocked tiles up to 4 away.
  const cx0 = Math.max(0, ax - 4);
  const cy0 = Math.max(0, ay - 4);
  const cx1 = Math.min(w - 1, bx + 4);
  const cy1 = Math.min(h - 1, by + 4);
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const i = y * w + x;
      if (m.blocked[i]) {
        m.nearWall[i] = 0;
        m.clearance[i] = 0;
        continue;
      }
      let near = 0;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (isBlockedTile(m, x + dx, y + dy)) {
            near = 1;
            break;
          }
      m.nearWall[i] = near;
      let best = 4000;
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          if (!isBlockedTile(m, x + dx, y + dy)) continue;
          const hx = Math.max(0, 2 * abs(dx) - 1);
          const hy = Math.max(0, 2 * abs(dy) - 1);
          const d = isqrt((hx * hx + hy * hy) * 250000);
          if (d < best) best = d;
        }
      m.clearance[i] = best;
    }
  }
  m.version++;
}

/** Add (delta = 1) or remove (delta = -1) a footprint from the occupancy grid. */
export function occupy(m: GameMap, tx: number, ty: number, fw: number, fh: number, delta: number) {
  for (let y = ty; y < ty + fh; y++)
    for (let x = tx; x < tx + fw; x++) {
      if (x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
      const i = y * m.w + x;
      m.occ[i] = Math.max(0, m.occ[i] + delta);
    }
  refreshRegion(m, tx, ty, tx + fw - 1, ty + fh - 1);
}

/** Every tile of the footprint is walkable terrain, unoccupied and buildable. */
export function footprintFree(m: GameMap, tx: number, ty: number, fw: number, fh: number): boolean {
  if (tx < 1 || ty < 1 || tx + fw > m.w - 1 || ty + fh > m.h - 1) return false;
  for (let y = ty; y < ty + fh; y++)
    for (let x = tx; x < tx + fw; x++) {
      const i = y * m.w + x;
      if (m.blocked[i] || m.nobuild[i]) return false;
    }
  return true;
}

// -------------------------------------------------------------- registry

const registry = new Map<string, () => MapDef>();

/** Make a map available to `new World({ map: key })`. Clients register imported maps before starting. */
export function registerMap(def: MapDef) {
  registry.set(def.key, () => def);
}

export function hasMap(key: string): boolean {
  return registry.has(key);
}

export function mapKeys(): string[] {
  return [...registry.keys()];
}

export function makeMap(key: string): GameMap {
  const make = registry.get(key) ?? registry.get("lab")!;
  const d = make();
  const n = d.w * d.h;
  const m: GameMap = {
    key: d.key,
    name: d.name,
    w: d.w,
    h: d.h,
    terrain: d.terrain,
    level: d.level,
    nobuild: d.nobuild,
    occ: new Uint8Array(n),
    blocked: new Uint8Array(n),
    nearWall: new Uint8Array(n),
    clearance: new Uint16Array(n),
    starts: d.starts,
    objects: d.objects,
    version: 0,
  };
  refreshRegion(m, 0, 0, d.w - 1, d.h - 1);
  m.version = 0;
  return m;
}

/** Cheap checksum of a map definition, so clients can verify they loaded the same map. */
export function mapChecksum(d: MapDef): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    h = Math.imul(h ^ (v | 0), 16777619);
  };
  mix(d.w);
  mix(d.h);
  for (let i = 0; i < d.terrain.length; i++) mix(d.terrain[i] | (d.level[i] << 1) | (d.nobuild[i] << 9));
  for (const s of d.starts) {
    mix(s.x);
    mix(s.y);
  }
  for (const o of d.objects) {
    mix(o.kind.length);
    mix(o.tx);
    mix(o.ty);
  }
  return h >>> 0;
}

// --------------------------------------------------------------- painter

/** Helper for authoring built-in maps with point symmetry. */
class Painter {
  terrain: Uint8Array;
  level: Uint8Array;
  ramp: Uint8Array;
  nobuild: Uint8Array;
  objects: MapDef["objects"] = [];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.terrain = new Uint8Array(w * h);
    this.level = new Uint8Array(w * h);
    this.ramp = new Uint8Array(w * h);
    this.nobuild = new Uint8Array(w * h);
  }
  private both(x: number, y: number, fn: (i: number) => void) {
    const { w, h } = this;
    if (x >= 0 && y >= 0 && x < w && y < h) fn(y * w + x);
    const mx = w - 1 - x;
    const my = h - 1 - y;
    if (mx >= 0 && my >= 0 && mx < w && my < h) fn(my * w + mx);
  }
  rect(x0: number, y0: number, x1: number, y1: number, fn: (i: number) => void) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.both(x, y, fn);
  }
  disc(cx: number, cy: number, r: number, fn: (i: number) => void) {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r + r) this.both(x, y, fn);
      }
  }
  setLevel(x0: number, y0: number, x1: number, y1: number, lv: number) {
    this.rect(x0, y0, x1, y1, (i) => (this.level[i] = lv));
  }
  discLevel(cx: number, cy: number, r: number, lv: number) {
    this.disc(cx, cy, r, (i) => (this.level[i] = lv));
  }
  block(x0: number, y0: number, x1: number, y1: number) {
    this.rect(x0, y0, x1, y1, (i) => (this.terrain[i] = 1));
  }
  discBlock(cx: number, cy: number, r: number) {
    this.disc(cx, cy, r, (i) => (this.terrain[i] = 1));
  }
  /**
   * Ramp between two levels. `dir` is the axis the ramp descends along:
   * "x+" means high at x0 and low at x1, "y+" high at y0, low at y1, etc.
   */
  rampRect(x0: number, y0: number, x1: number, y1: number, hi: number, lo: number, dir: "x+" | "x-" | "y+" | "y-") {
    const len = dir[0] === "x" ? x1 - x0 + 1 : y1 - y0 + 1;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        let t = dir === "x+" ? x - x0 : dir === "x-" ? x1 - x : dir === "y+" ? y - y0 : y1 - y;
        t = t * 2 + 1; // tile centre, in half-tiles
        const lv = hi - idiv((hi - lo) * t, len * 2);
        this.both(x, y, (i) => {
          this.level[i] = lv;
          this.ramp[i] = 1;
          this.nobuild[i] = 1;
          this.terrain[i] = 0;
        });
      }
  }
  /** Standard base: 8 mineral patches and 2 geysers on the west ("w") or east ("e") side of a hall centred on (hx, hy). */
  base(hx: number, hy: number, side: "w" | "e", rich = false) {
    const DX = [-6, -7, -7, -8, -8, -7, -7, -6];
    const small = [0, 7];
    for (let i = 0; i < 8; i++) {
      const dy = i - 4;
      const dx = side === "w" ? DX[i] : -DX[i] - 1;
      const kind = rich ? "rich" : small.includes(i) ? "mineral900" : "mineral";
      this.obj(kind, hx + dx, hy + dy, 2, 1);
    }
    const gx = side === "w" ? hx - 5 : hx + 3;
    this.obj("geyser", gx, hy - 8, 3, 3);
    this.obj("geyser", gx, hy + 6, 3, 3);
  }
  obj(kind: MapObjectKind, tx: number, ty: number, fw: number, fh: number) {
    this.objects.push({ kind, tx, ty });
    this.objects.push({ kind, tx: this.w - tx - fw, ty: this.h - ty - fh });
  }
  /** Cliffs: walkable non-ramp tiles next to a tile more than half a level higher or lower become unpathable. */
  finish(): void {
    const { w, h, level, ramp, terrain } = this;
    const cliff = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (ramp[i]) continue;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (abs(level[ny * w + nx] - level[i]) > 8) cliff[i] = 1;
          }
      }
    for (let i = 0; i < w * h; i++) if (cliff[i]) terrain[i] = 1;
    // Map border.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) terrain[y * w + x] = 1;
    // Nothing can be built right next to cliffs or ramps (keeps ramps open like SC2).
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (terrain[i]) this.nobuild[i] = 1;
      }
  }
}

// ------------------------------------------------------------- built-ins

/**
 * "Feel lab" test map: point-symmetric 2-player layout with a main base and ramp,
 * a narrow choke, rocks, a diagonal wall and a wide open field.
 * Designed for tuning movement, not for balance.
 */
function labDef(): MapDef {
  const w = 96;
  const h = 72;
  const terrain = new Uint8Array(w * h);
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) if (x >= 0 && y >= 0 && x < w && y < h) terrain[y * w + x] = 1;
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

  // Diagonal wall (staircase) to test smoothing along non-axis-aligned edges. Placed so
  // its mirror image stays clear of the other main's ramp (big units need 3 tiles to pass).
  for (let i = 0; i < 12; i++) rect(58 + i, 20 + i, 59 + i, 21 + i);

  // Mirror (point symmetry around the map center).
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (terrain[y * w + x]) terrain[(h - 1 - y) * w + (w - 1 - x)] = 1;

  return {
    key: "lab",
    name: "Feel Lab",
    w,
    h,
    terrain,
    level: new Uint8Array(w * h),
    nobuild: new Uint8Array(w * h),
    starts: [
      { x: 11, y: 15 },
      { x: w - 1 - 11, y: h - 1 - 15 },
      { x: 11, y: h - 1 - 12 },
      { x: w - 1 - 11, y: 12 },
    ],
    objects: [],
  };
}

/**
 * "Pallet Plateau": a 1v1 melee map in the SC2 ladder mould. Main on high
 * ground with one ramp into a natural on mid ground, a natural choke down to
 * the low-ground centre, a back door blocked by destructible rocks, and two
 * third-base options per side.
 */
function palletDef(): MapDef {
  const W = 136;
  const H = 120;
  const p = new Painter(W, H);
  const LOW = 0;
  const MID = 16;
  const HIGH = 32;
  p.setLevel(0, 0, W - 1, H - 1, LOW);

  // Natural (mid ground) below the main.
  p.setLevel(2, 33, 46, 66, MID);
  // Main (high ground), top-left.
  p.setLevel(2, 2, 36, 32, HIGH);
  p.discLevel(19, 17, 15, HIGH);
  // Main ramp: high (north) to mid (south), 4 wide.
  p.rampRect(29, 33, 32, 36, HIGH, MID, "y+");
  // Natural choke: mid (west) to low (east), 6 tall.
  p.rampRect(47, 49, 50, 54, MID, LOW, "x+");
  // Back door from the natural down to the third, blocked by rocks.
  p.rampRect(19, 67, 22, 70, MID, LOW, "y+");

  // Low-ground features: rock formations to break up the centre.
  p.discBlock(68, 60, 3); // centre (self-symmetric)
  p.discBlock(56, 38, 2);
  p.discBlock(80, 30, 3);
  p.discBlock(60, 84, 2);
  p.discBlock(44, 92, 3);
  p.block(100, 44, 103, 50);
  p.discBlock(92, 12, 2);

  p.finish();

  // Bases (point-mirrored automatically).
  p.base(17, 17, "w"); // main
  p.base(13, 52, "w"); // natural
  p.base(14, 92, "w"); // triangle third (low ground, behind the back door)
  p.base(70, 12, "e"); // linear third along the top edge
  p.obj("rock", 18, 71, 6, 6); // back-door rocks
  p.obj("rock2", 62, 46, 2, 2); // debris near the centre

  return {
    key: "pallet",
    name: "Pallet Plateau",
    w: W,
    h: H,
    terrain: p.terrain,
    level: p.level,
    nobuild: p.nobuild,
    starts: [
      { x: 17, y: 17 },
      { x: W - 1 - 17, y: H - 1 - 17 },
    ],
    objects: p.objects,
  };
}

registry.set("lab", labDef);
registry.set("pallet", palletDef);

/** Built-in map list for the lobby: [key, name, players]. */
export const BUILTIN_MAPS: [string, string, number][] = [
  ["pallet", "Pallet Plateau", 2],
  ["lab", "Feel Lab (sandbox)", 4],
];
