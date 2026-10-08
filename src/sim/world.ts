import { FP, abs, clamp, fdiv, idiv, isqrt, pct } from "./fixed.ts";
import { type GameMap, clearanceFor, footprintFree, isBlockedAt, isBlockedTile, isPassable, makeMap, occupy } from "./map.ts";
import { FlowField, clearPath, nearestPassableTile, steerTarget } from "./flowfield.ts";
import {
  type Command,
  MODE_ATTACK,
  MODE_ATTACK_UNIT,
  MODE_BUILD,
  MODE_GATHER,
  MODE_MOVE,
  MODE_PATROL,
  MODE_RETURN,
  type PlayerCommand,
} from "./commands.ts";
import {
  BUILD_ADVANCED,
  BUILD_BASIC,
  FACTION_UNITS,
  GAS_CARRY,
  GAS_TICKS,
  KINDS,
  K_BULBASAUR,
  K_CENTER,
  K_CHARIZARD,
  K_CHARMANDER,
  K_EXTRACTOR,
  K_GEYSER,
  K_GYM,
  K_MINERAL,
  K_PIKACHU,
  K_ROCK,
  K_ROCK_SMALL,
  K_SQUIRTLE,
  K_TOWER,
  K_VENUSAUR,
  MAX_QUEUE,
  MAX_SUPPLY,
  MAX_UPGRADE,
  MINERAL_CARRY,
  MINE_TICKS,
  START_MINERALS,
  START_WORKERS,
  UP_ARMOR,
  UP_ATTACK,
  type UnitKind,
  typeMult,
  upgradeCost,
} from "./units.ts";
import { Prng } from "./prng.ts";
import { TUNE_DEFS, type Tuning, defaultTuning, tuneDef } from "./tuning.ts";

export interface Order {
  mode: number;
  /** This unit's own goal (differs from the shared target when keeping formation). */
  x: number;
  y: number;
  /** Goal tile for ground pathing (-1 = fly or walk straight). */
  tile: number;
  /** Shared flow field toward `tile`, acquired lazily when the goal isn't in a straight line. */
  field: FlowField | null;
  /** Units given the same command share a group id; used for SC2-style group arrival. */
  group: number;
  /** Keeping formation (magic box): each unit heads for its own slot, so no group arrival. */
  formation: boolean;
  /** Patrol: the point to return to. */
  ox: number;
  oy: number;
  /** Target unit for attack / gather / return. */
  target: number;
  /** Structure kind to build (-1 otherwise) and its top-left tile. */
  kind: number;
  tx: number;
  ty: number;
  /** Structure / resource the order is currently walking to (its approach tile is `tile`). */
  navId: number;
}

export interface QueueItem {
  /** Unit kind being trained, or -1 for research. */
  kind: number;
  /** Upgrade being researched (-1 for units). */
  up: number;
  t: number;
  total: number;
}

export const NAV_NONE = 0;
const NAV_ORDER = 1;
const NAV_CHASE = 2;

/** Worker gather states. */
export const G_GO = 0;
export const G_MINE = 1;
export const G_RETURN = 2;

export interface Unit {
  id: number;
  owner: number;
  kind: number;
  air: boolean;
  radius: number;
  /** Clearance class in milli-tiles: big units can't path through narrow gaps. */
  req: number;
  x: number;
  y: number;
  /** Position at the start of the current tick (renderer interpolates prev -> current). */
  px: number;
  py: number;
  vx: number;
  vy: number;
  orders: Order[];
  holding: boolean;
  /** Group id of the last order this unit finished. */
  arrivedGroup: number;
  wpx: number;
  wpy: number;
  wpTick: number;
  bestDist: number;
  stuck: number;
  // Navigation request for this tick (set by think, used by steer).
  navKind: number;
  navX: number;
  navY: number;
  chaseTile: number;
  chaseField: FlowField | null;
  // Combat.
  hp: number;
  cd: number;
  target: number;
  windup: number;
  wTarget: number;
  /** Tick the last attack started (renderer: attack animation). */
  attackTick: number;
  /** Stationary and attacking this tick. */
  engaged: boolean;
  guardX: number;
  guardY: number;
  lastHit: number;
  // Structures.
  tx: number;
  ty: number;
  /** Construction progress in ticks (== kind.time when finished; units are always finished). */
  progress: number;
  queue: QueueItem[];
  rallyX: number;
  rallyY: number;
  rallyId: number;
  /** Geyser <-> extractor link. */
  link: number;
  /** Resources left (minerals, geysers). */
  amount: number;
  /** Minerals per trip from this field. */
  yield: number;
  /** Worker currently mining this field / inside this extractor. */
  occupant: number;
  // Workers.
  carry: number;
  carryGas: boolean;
  gState: number;
  gTimer: number;
  lastGather: number;
  hidden: boolean;
  // Evolution.
  morphTo: number;
  morphT: number;
  morphTotal: number;
  dead: boolean;
}

export interface PlayerStats {
  mined: number;
  gas: number;
  made: number;
  lost: number;
  killed: number;
}

export interface Player {
  id: number;
  slot: number;
  team: number;
  faction: number;
  m: number;
  g: number;
  /** Supply used, including units in production and evolutions in progress. */
  supply: number;
  /** Supply provided by finished structures (uncapped; use World.cap()). */
  provided: number;
  up: number[];
  researching: number[];
  alive: boolean;
  stats: PlayerStats;
}

export interface Projectile {
  id: number;
  owner: number;
  src: number;
  kind: number;
  /** Attack upgrade level of the owner when fired. */
  lvl: number;
  x: number;
  y: number;
  px: number;
  py: number;
  target: number;
  tx: number;
  ty: number;
  air: boolean;
  /** Height the projectile started at (air attacker), for rendering. */
  fromAir: boolean;
}

export type SimEvent =
  | { e: "attack"; id: number; target: number }
  | { e: "hit"; x: number; y: number; air: boolean; kind: number; src: number; target: number; dmg: number }
  | { e: "death"; id: number; kind: number; owner: number; x: number; y: number; air: boolean }
  | { e: "built"; id: number; kind: number; owner: number }
  | { e: "trained"; id: number; kind: number; owner: number }
  | { e: "evolving"; id: number; kind: number; owner: number }
  | { e: "evolved"; id: number; kind: number; owner: number }
  | { e: "research"; owner: number; up: number; lvl: number }
  | { e: "error"; p: number; msg: "minerals" | "gas" | "supply" | "place" | "tech" | "queue" | "max" }
  | { e: "attacked"; p: number; x: number; y: number; id: number }
  | { e: "defeat"; p: number }
  | { e: "victory"; team: number };

export interface WorldOptions {
  seed: number;
  map: string;
  /** Player ids in slot order. Slot i starts at map.starts[i]. */
  players: number[];
  /** Faction per player id (default Fire). */
  factions?: Record<number, number>;
  /** Team per player id (default: everyone on their own team). */
  teams?: Record<number, number>;
  /** "melee" = bases and workers, "lab" = starter armies for movement tuning. Default: lab on the lab map, else melee. */
  mode?: "melee" | "lab";
  /** Free resources, spawn and tune commands allowed, no win condition. Default: on in lab mode. */
  sandbox?: boolean;
  /** Lab: add an idle opponent army (player 7) in the middle to bump into. */
  dummyOpponent?: boolean;
  /** Expected map checksum, so a client with a different copy of an imported map fails loudly. */
  mapSum?: number;
}

const MAX_UNITS = 2000;
const TOUCH_MARGIN = FP >> 3;
const CELL = FP * 4; // spatial hash cell: larger than the biggest unit diameter
const LEASH = FP * 10;
const REACH = FP >> 2;
const VISION_TICKS = 8;
const IDLE_FIELDS = 48;
export const NEUTRAL = 0;

// Deterministic fallback push directions when two units sit exactly on top of each other.
const JITTER_X = [1000, 707, 0, -707, -1000, -707, 0, 707];
const JITTER_Y = [0, 707, 1000, 707, 0, -707, -1000, -707];

// Vision discs by radius in tiles (integer offsets).
const DISCS: Int16Array[] = [];
function disc(r: number): Int16Array {
  let d = DISCS[r];
  if (d) return d;
  const pts: number[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) pts.push(dx, dy);
  d = new Int16Array(pts);
  DISCS[r] = d;
  return d;
}

export class World {
  readonly map: GameMap;
  readonly opts: WorldOptions;
  readonly mode: "melee" | "lab";
  readonly sandbox: boolean;
  tick = 0;
  units: Unit[] = [];
  readonly byId = new Map<number, Unit>();
  readonly players = new Map<number, Player>();
  projectiles: Projectile[] = [];
  /** Things that happened during the last step (for effects, sounds and messages). Not part of the state. */
  events: SimEvent[] = [];
  tune: Tuning = defaultTuning();
  rng: Prng;
  gameOver = false;
  winner = -1;
  /** Per-team visibility (1 = currently visible) and explored maps, updated every few ticks. */
  readonly vis = new Map<number, Uint8Array>();
  readonly explored = new Map<number, Uint8Array>();
  private nextId = 1;
  private nextGroup = 1;
  private nextProj = 1;
  private fields = new Map<number, FlowField>();
  private idleFields = new Map<number, FlowField>();
  private wp = { x: 0, y: 0 };
  private mapVersion = 0;
  private dirtyKeys: number[] = [];

  // Spatial hash scratch arrays (reused every tick, no per-tick allocation).
  private gw: number;
  private gh: number;
  private cellStart: Int32Array;
  private cellCount: Int32Array;
  private cellItems: Int32Array = new Int32Array(MAX_UNITS);
  private unitCell: Int32Array = new Int32Array(MAX_UNITS);
  private hashUnits: Unit[] = [];

  constructor(opts: WorldOptions) {
    this.opts = opts;
    this.map = makeMap(opts.map);
    this.mode = opts.mode ?? (opts.map === "lab" ? "lab" : "melee");
    this.sandbox = opts.sandbox ?? this.mode === "lab";
    this.rng = new Prng(opts.seed);
    this.gw = idiv(this.map.w * FP + CELL - 1, CELL);
    this.gh = idiv(this.map.h * FP + CELL - 1, CELL);
    this.cellStart = new Int32Array(this.gw * this.gh + 1);
    this.cellCount = new Int32Array(this.gw * this.gh);
    opts.players.forEach((pid, slot) => this.addPlayer(pid, slot));
    if (this.mode === "lab" && opts.dummyOpponent) this.addPlayer(7, opts.players.length);
    this.setupMapObjects();
    this.setupScenario();
    this.mapVersion = this.map.version;
    this.buildHash();
    this.updateVision();
  }

  private addPlayer(pid: number, slot: number) {
    const rich = this.sandbox ? 50000 : 0;
    this.players.set(pid, {
      id: pid,
      slot,
      team: this.opts.teams?.[pid] ?? pid,
      faction: clamp(this.opts.factions?.[pid] ?? 0, 0, 2),
      m: rich || START_MINERALS,
      g: rich,
      supply: 0,
      provided: 0,
      up: [0, 0],
      researching: [0, 0],
      alive: true,
      stats: { mined: 0, gas: 0, made: 0, lost: 0, killed: 0 },
    });
    if (!this.vis.has(this.teamOf(pid))) {
      const n = this.map.w * this.map.h;
      this.vis.set(this.teamOf(pid), new Uint8Array(n));
      this.explored.set(this.teamOf(pid), new Uint8Array(n));
    }
  }

  private setupMapObjects() {
    for (const o of this.map.objects) {
      if (o.kind === "geyser") {
        const g = this.spawnStructure(NEUTRAL, K_GEYSER, o.tx, o.ty, true);
        g.amount = 2250;
      } else if (o.kind === "rock" || o.kind === "rock2") {
        this.spawnStructure(NEUTRAL, o.kind === "rock" ? K_ROCK : K_ROCK_SMALL, o.tx, o.ty, true);
      } else if (o.kind === "tower") {
        this.spawnStructure(NEUTRAL, K_TOWER, o.tx, o.ty, true);
      } else {
        const m = this.spawnStructure(NEUTRAL, K_MINERAL, o.tx, o.ty, true);
        m.amount = o.kind === "mineral900" ? 900 : 1800;
        m.yield = o.kind === "rich" ? 7 : MINERAL_CARRY;
      }
    }
  }

  private setupScenario() {
    if (this.mode === "lab") return this.setupLab();
    this.opts.players.forEach((pid, slot) => {
      const s = this.map.starts[slot % this.map.starts.length];
      const hall = this.spawnStructure(pid, K_CENTER, s.x - 2, s.y - 2, true);
      // Workers stand between the hall and its minerals and start mining (2 per patch at most).
      const minerals = this.mineralsNear(hall.x, hall.y, FP * 12);
      const cx = minerals.length ? idiv(minerals.reduce((a, m) => a + m.x, 0), minerals.length) : hall.x;
      const cy = minerals.length ? idiv(minerals.reduce((a, m) => a + m.y, 0), minerals.length) : hall.y + FP * 4;
      const dx = cx - hall.x;
      const dy = cy - hall.y;
      const d = Math.max(1, isqrt(dx * dx + dy * dy));
      const sx = hall.x + idiv(dx * FP * 4, d);
      const sy = hall.y + idiv(dy * FP * 4, d);
      const ws = this.spawn(pid, K_PIKACHU, sx, sy, START_WORKERS);
      ws.forEach((w, i) => {
        const m = minerals[i % Math.max(1, minerals.length)];
        if (m) this.orderTarget(w, m, MODE_GATHER, false);
      });
    });
  }

  private setupLab() {
    const army: [number, number][] = [
      [K_SQUIRTLE, 12],
      [K_CHARMANDER, 16],
      [K_BULBASAUR, 8],
      [K_VENUSAUR, 2],
      [K_CHARIZARD, 8],
    ];
    this.opts.players.forEach((pid, slot) => {
      const s = this.map.starts[slot % this.map.starts.length];
      const cx = s.x * FP + (FP >> 1);
      const cy = s.y * FP + (FP >> 1);
      // Each kind in its own little block around the start.
      const offs = [
        [-4, -3],
        [3, -3],
        [-4, 3],
        [3, 3],
        [0, 6],
      ];
      army.forEach(([kind, n], i) => this.spawn(pid, kind, cx + offs[i][0] * FP, cy + offs[i][1] * FP, n));
    });
    if (this.opts.dummyOpponent) {
      const dummy = 7;
      const cx = idiv(this.map.w * FP, 2);
      const cy = idiv(this.map.h * FP, 2);
      this.spawn(dummy, K_BULBASAUR, cx - 8 * FP, cy, 8);
      this.spawn(dummy, K_SQUIRTLE, cx + 8 * FP, cy, 12);
    }
  }

  // ---------------------------------------------------------- queries

  teamOf(pid: number): number {
    return this.players.get(pid)?.team ?? -pid - 100;
  }

  allied(a: number, b: number): boolean {
    return a === b || this.teamOf(a) === this.teamOf(b);
  }

  /** Effective supply cap (provided, capped at 200). */
  cap(pid: number): number {
    const p = this.players.get(pid);
    return p ? Math.min(MAX_SUPPLY, p.provided) : 0;
  }

  isDone(u: Unit): boolean {
    return u.progress >= KINDS[u.kind].time;
  }

  hasStructure(pid: number, kind: number): boolean {
    if (kind < 0) return true;
    for (const u of this.units) if (u.owner === pid && u.kind === kind && !u.dead && this.isDone(u)) return true;
    return false;
  }

  /** Can team `team` currently see tile (tx, ty)? */
  tileVisible(team: number, tx: number, ty: number): boolean {
    const v = this.vis.get(team);
    if (!v || tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return false;
    return v[ty * this.map.w + tx] === 1;
  }

  /** Is unit `u` visible to player `pid`? (Own and allied units always are.) */
  canSee(pid: number, u: Unit): boolean {
    if (this.allied(pid, u.owner)) return true;
    if (u.hidden) return false;
    const team = this.teamOf(pid);
    const k = KINDS[u.kind];
    if (k.w > 0) {
      // Structures and resources are visible if any footprint tile is.
      for (let y = u.ty; y < u.ty + k.h; y++) for (let x = u.tx; x < u.tx + k.w; x++) if (this.tileVisible(team, x, y)) return true;
      return false;
    }
    return this.tileVisible(team, fdiv(u.x, FP), fdiv(u.y, FP));
  }

  /** Units a Gym or Pokémon Center owned by `pid` can train. */
  trainable(pid: number, structureKind: number): number[] {
    if (structureKind === K_GYM) return FACTION_UNITS[this.players.get(pid)?.faction ?? 0];
    return KINDS[structureKind].trains;
  }

  /** Why `pid` can't place `kind` at (tx, ty), or null if it can. Ignores cost. */
  placeError(pid: number, kind: number, tx: number, ty: number, builder: Unit | null): "place" | "tech" | null {
    const k = KINDS[kind];
    if (!k.structure || k.resource || !(BUILD_BASIC.includes(kind) || BUILD_ADVANCED.includes(kind))) return "place";
    if (!this.hasStructure(pid, k.requires)) return "tech";
    if (kind === K_EXTRACTOR) {
      const g = this.geyserAt(tx, ty);
      return g && !g.link ? null : "place";
    }
    if (!footprintFree(this.map, tx, ty, k.w, k.h)) return "place";
    if (kind === K_CENTER) {
      // Like SC2: no town hall within 3 tiles of a resource.
      for (const u of this.units) {
        const rk = KINDS[u.kind];
        if (u.dead || (rk.resource !== 1 && rk.resource !== 2)) continue;
        const gx = Math.max(u.tx - (tx + k.w), tx - (u.tx + rk.w), -1);
        const gy = Math.max(u.ty - (ty + k.h), ty - (u.ty + rk.h), -1);
        if (Math.max(gx, gy) < 3) return "place";
      }
    }
    // Enemy ground units standing on the site block it; own units get pushed aside.
    const x0 = tx * FP;
    const y0 = ty * FP;
    const x1 = (tx + k.w) * FP;
    const y1 = (ty + k.h) * FP;
    for (const u of this.units) {
      if (u.dead || u.air || KINDS[u.kind].structure || u === builder) continue;
      if (this.allied(u.owner, pid)) continue;
      if (u.x + u.radius > x0 && u.x - u.radius < x1 && u.y + u.radius > y0 && u.y - u.radius < y1) return "place";
    }
    return null;
  }

  geyserAt(tx: number, ty: number): Unit | null {
    for (const u of this.units) if (u.kind === K_GEYSER && u.tx === tx && u.ty === ty && !u.dead) return u;
    return null;
  }

  mineralsNear(x: number, y: number, r: number): Unit[] {
    return this.units
      .filter((u) => u.kind === K_MINERAL && !u.dead && this.dist2(u.x, u.y, x, y) <= r * r)
      .sort((a, b) => this.dist2(a.x, a.y, x, y) - this.dist2(b.x, b.y, x, y) || a.id - b.id);
  }

  private dist2(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
  }

  // ---------------------------------------------------------------- units

  /** Spawn n units in a spiral around (x, y). Returns the units created. */
  spawn(owner: number, kind: number, x: number, y: number, n: number): Unit[] {
    const k = KINDS[kind];
    const out: Unit[] = [];
    if (!k || k.resource) return out;
    if (k.structure) {
      const tx = fdiv(x, FP) - (k.w >> 1);
      const ty = fdiv(y, FP) - (k.h >> 1);
      if (kind !== K_EXTRACTOR && footprintFree(this.map, tx, ty, k.w, k.h)) out.push(this.spawnStructure(owner, kind, tx, ty, true));
      return out;
    }
    const spacing = k.radius * 2 + (FP >> 4);
    for (let ring = 0; ring < 40 && out.length < n; ring++) {
      for (let gy = -ring; gy <= ring && out.length < n; gy++) {
        for (let gx = -ring; gx <= ring && out.length < n; gx++) {
          if (abs(gx) !== ring && abs(gy) !== ring) continue;
          const px = x + gx * spacing;
          const py = y + gy * spacing;
          if (!k.air && this.discBlocked(px, py, k.radius)) continue;
          if (px < FP || py < FP || px > (this.map.w - 1) * FP || py > (this.map.h - 1) * FP) continue;
          if (this.units.length >= MAX_UNITS) return out;
          out.push(this.addUnit(owner, kind, px, py));
        }
      }
    }
    return out;
  }

  private discBlocked(x: number, y: number, r: number): boolean {
    return (
      isBlockedAt(this.map, x, y) ||
      isBlockedAt(this.map, x - r, y - r) ||
      isBlockedAt(this.map, x + r, y - r) ||
      isBlockedAt(this.map, x - r, y + r) ||
      isBlockedAt(this.map, x + r, y + r)
    );
  }

  private addUnit(owner: number, kind: number, x: number, y: number): Unit {
    const k = KINDS[kind];
    const u: Unit = {
      id: this.nextId++,
      owner,
      kind,
      air: k.air,
      radius: k.radius,
      req: clearanceFor(idiv(k.radius * 1000, FP)),
      x,
      y,
      px: x,
      py: y,
      vx: 0,
      vy: 0,
      orders: [],
      holding: false,
      arrivedGroup: 0,
      wpx: x,
      wpy: y,
      wpTick: -1,
      bestDist: 0,
      stuck: 0,
      navKind: NAV_NONE,
      navX: x,
      navY: y,
      chaseTile: -1,
      chaseField: null,
      hp: k.hp,
      cd: 0,
      target: 0,
      windup: 0,
      wTarget: 0,
      attackTick: -1000,
      engaged: false,
      guardX: x,
      guardY: y,
      lastHit: -1000,
      tx: -1,
      ty: -1,
      progress: k.time,
      queue: [],
      rallyX: 0,
      rallyY: 0,
      rallyId: 0,
      link: 0,
      amount: 0,
      yield: MINERAL_CARRY,
      occupant: 0,
      carry: 0,
      carryGas: false,
      gState: G_GO,
      gTimer: 0,
      lastGather: 0,
      hidden: false,
      morphTo: -1,
      morphT: 0,
      morphTotal: 0,
      dead: false,
    };
    this.units.push(u);
    this.byId.set(u.id, u);
    const p = this.players.get(owner);
    if (p && !k.structure) p.supply += k.supply;
    return u;
  }

  private spawnStructure(owner: number, kind: number, tx: number, ty: number, complete: boolean): Unit {
    const k = KINDS[kind];
    const u = this.addUnit(owner, kind, tx * FP + idiv(k.w * FP, 2), ty * FP + idiv(k.h * FP, 2));
    u.tx = tx;
    u.ty = ty;
    if (kind === K_EXTRACTOR) {
      const g = this.geyserAt(tx, ty);
      if (g) {
        g.link = u.id;
        u.link = g.id;
      }
    } else {
      occupy(this.map, tx, ty, k.w, k.h, 1);
      this.pushOutOf(u);
    }
    if (complete) {
      u.progress = k.time;
      const p = this.players.get(owner);
      if (p) p.provided += k.provides;
    } else {
      u.progress = 0;
      u.hp = Math.max(1, idiv(k.hp, 10));
    }
    return u;
  }

  /** Move ground units off a freshly placed footprint to the nearest free tile. */
  private pushOutOf(s: Unit) {
    const k = KINDS[s.kind];
    const x0 = s.tx * FP;
    const y0 = s.ty * FP;
    const x1 = (s.tx + k.w) * FP;
    const y1 = (s.ty + k.h) * FP;
    for (const u of this.units) {
      if (u === s || u.dead || u.air || KINDS[u.kind].structure || u.hidden) continue;
      if (!(u.x + u.radius > x0 && u.x - u.radius < x1 && u.y + u.radius > y0 && u.y - u.radius < y1)) continue;
      const t = nearestPassableTile(this.map, fdiv(u.x, FP), fdiv(u.y, FP), u.req);
      if (t < 0) continue;
      const tx = t % this.map.w;
      u.x = tx * FP + (FP >> 1);
      u.y = idiv(t - tx, this.map.w) * FP + (FP >> 1);
      u.px = u.x;
      u.py = u.y;
      u.wpTick = -1;
    }
  }

  // --------------------------------------------------------------- orders

  private acquireField(tile: number, req: number): FlowField {
    const key = tile * 4 + (req === 0 ? 0 : req <= 500 ? 1 : req <= 750 ? 2 : 3);
    let f = this.fields.get(key);
    if (!f) {
      f = this.idleFields.get(key);
      if (f) {
        this.idleFields.delete(key);
        if (f.dirty) f.recompute(this.map);
      } else f = new FlowField(this.map, tile, req, key);
      this.fields.set(key, f);
    }
    f.refs++;
    return f;
  }

  private releaseField(f: FlowField | null) {
    if (!f) return;
    f.refs--;
    if (f.refs <= 0) {
      this.fields.delete(f.key);
      // Keep recently used fields around: workers walk the same routes again and again.
      this.idleFields.set(f.key, f);
      if (this.idleFields.size > IDLE_FIELDS) this.idleFields.delete(this.idleFields.keys().next().value!);
    }
  }

  private releaseOrder(o: Order) {
    this.releaseField(o.field);
    o.field = null;
  }

  private clearOrders(u: Unit) {
    this.leaveResource(u);
    for (const o of u.orders) this.releaseOrder(o);
    u.orders.length = 0;
    u.target = 0;
    this.stopChase(u);
  }

  private stopChase(u: Unit) {
    this.releaseField(u.chaseField);
    u.chaseField = null;
    u.chaseTile = -1;
  }

  private beginOrder(u: Unit) {
    u.arrivedGroup = 0;
    u.wpTick = -1;
    u.bestDist = 0x3fffffff;
    u.stuck = 0;
  }

  private ownedUnits(p: number, ids: number[]): Unit[] {
    const out: Unit[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const u = this.byId.get(id);
      if (u && u.owner === p && !u.dead) out.push(u);
    }
    return out;
  }

  /** Units that can take movement orders (not structures, not evolving). */
  private mobile(p: number, ids: number[]): Unit[] {
    return this.ownedUnits(p, ids).filter((u) => !KINDS[u.kind].structure && u.morphTo < 0);
  }

  private clampToMap(v: number, size: number): number {
    return clamp(v, FP, (size - 1) * FP - 1);
  }

  /** Pathing goal for ground units: the target, or the nearest passable tile centre if it is in a wall or too tight. */
  private groundGoal(x: number, y: number, req: number): { x: number; y: number; tile: number } {
    const tx = fdiv(x, FP);
    const ty = fdiv(y, FP);
    const tile = nearestPassableTile(this.map, tx, ty, req);
    if (tile === ty * this.map.w + tx || tile < 0) return { x, y, tile };
    const gx = tile % this.map.w;
    const gy = idiv(tile - gx, this.map.w);
    return { x: gx * FP + (FP >> 1), y: gy * FP + (FP >> 1), tile };
  }

  private newOrder(mode: number, x: number, y: number, tile: number, group: number): Order {
    return { mode, x, y, tile, field: null, group, formation: false, ox: x, oy: y, target: 0, kind: -1, tx: 0, ty: 0, navId: 0 };
  }

  private applyMove(p: number, c: Extract<Command, { t: "move" }>) {
    const units = this.mobile(p, c.ids);
    if (units.length === 0) return;
    const tx = this.clampToMap(c.x, this.map.w);
    const ty = this.clampToMap(c.y, this.map.h);
    const goals = new Map<number, { x: number; y: number; tile: number }>();
    const goalFor = (req: number) => {
      let r = goals.get(req);
      if (!r) {
        r = this.groundGoal(tx, ty, req);
        goals.set(req, r);
      }
      return r;
    };
    const group = this.nextGroup++;

    // SC2 "magic box": clicking outside the selection's bounding box keeps the
    // units' relative spacing; clicking inside it makes them converge.
    let formation = false;
    let cx = 0;
    let cy = 0;
    if (this.tune.magicBox && units.length > 1) {
      let x0 = 0x3fffffff;
      let y0 = 0x3fffffff;
      let x1 = -1;
      let y1 = -1;
      for (const u of units) {
        const [ux, uy] = this.queueEnd(u, c.q);
        if (ux < x0) x0 = ux;
        if (uy < y0) y0 = uy;
        if (ux > x1) x1 = ux;
        if (uy > y1) y1 = uy;
        cx += ux;
        cy += uy;
      }
      const maxSize = idiv(this.tune.magicBoxMax * FP, 1000);
      const outside = tx < x0 || tx > x1 || ty < y0 || ty > y1;
      if (outside && x1 - x0 <= maxSize && y1 - y0 <= maxSize) {
        formation = true;
        cx = idiv(cx, units.length);
        cy = idiv(cy, units.length);
      }
    }

    for (const u of units) {
      if (u.hidden) continue;
      const [sx, sy] = this.queueEnd(u, c.q);
      if (!c.q) {
        this.clearOrders(u);
        u.holding = false;
      }
      const ug = goalFor(u.req);
      let gx = u.air ? tx : ug.x;
      let gy = u.air ? ty : ug.y;
      let slot = false;
      if (formation) {
        // Keep this unit's offset from the group centre. Near walls, shrink the
        // offset (4/4, 3/4, 2/4, 1/4) until the slot is reachable from the target.
        for (let q4 = 4; q4 >= 1 && !slot; q4--) {
          const fx = this.clampToMap(gx + idiv((sx - cx) * q4, 4), this.map.w);
          const fy = this.clampToMap(gy + idiv((sy - cy) * q4, 4), this.map.h);
          if (u.air || (!this.discBlocked(fx, fy, u.radius) && clearPath(this.map, ug.x, ug.y, fx, fy, 0))) {
            gx = fx;
            gy = fy;
            slot = true;
          }
        }
      }
      const o = this.newOrder(c.mode, gx, gy, u.air ? -1 : ug.tile, group);
      o.formation = slot;
      o.ox = sx;
      o.oy = sy;
      u.orders.push(o);
      if (u.orders.length === 1) this.beginOrder(u);
    }
  }

  /** Single-unit move used internally (rally points, leash return). */
  private orderMove(u: Unit, x: number, y: number, mode: number, queue: boolean) {
    if (!queue) this.clearOrders(u);
    const g = u.air ? { x: this.clampToMap(x, this.map.w), y: this.clampToMap(y, this.map.h), tile: -1 } : this.groundGoal(this.clampToMap(x, this.map.w), this.clampToMap(y, this.map.h), u.req);
    const o = this.newOrder(mode, g.x, g.y, g.tile, this.nextGroup++);
    o.ox = u.x;
    o.oy = u.y;
    u.orders.push(o);
    if (u.orders.length === 1) this.beginOrder(u);
  }

  private orderTarget(u: Unit, t: Unit, mode: number, queue: boolean) {
    if (!queue) {
      this.clearOrders(u);
      u.holding = false;
    }
    const o = this.newOrder(mode, t.x, t.y, -1, this.nextGroup++);
    o.target = t.id;
    u.orders.push(o);
    if (u.orders.length === 1) {
      this.beginOrder(u);
      if (mode === MODE_GATHER) u.gState = u.carry > 0 && u.lastGather === t.id ? G_RETURN : G_GO;
    }
    if (mode === MODE_GATHER) u.lastGather = t.id;
  }

  /** Where the unit will be when its current queue finishes (for shift-queue and patrol). */
  private queueEnd(u: Unit, queued: boolean): [number, number] {
    if (queued && u.orders.length > 0) {
      const last = u.orders[u.orders.length - 1];
      return [last.x, last.y];
    }
    return [u.x, u.y];
  }

  private isGatherTarget(u: Unit, t: Unit): boolean {
    if (t.kind === K_MINERAL) return true;
    return t.kind === K_EXTRACTOR && t.owner === u.owner && this.isDone(t);
  }

  private applyTarget(p: number, c: Extract<Command, { t: "target" }>) {
    const t = this.byId.get(c.id);
    if (!t || t.dead) return;
    for (const u of this.mobile(p, c.ids)) {
      if (u.hidden) continue;
      const k = KINDS[u.kind];
      let mode = c.mode;
      if (mode === MODE_GATHER || mode === MODE_RETURN) {
        if (!k.worker) mode = MODE_MOVE;
        else if (mode === MODE_GATHER && !this.isGatherTarget(u, t)) mode = t.owner === u.owner && KINDS[t.kind].dropoff && u.carry > 0 ? MODE_RETURN : MODE_MOVE;
        else if (mode === MODE_RETURN && u.carry === 0) mode = MODE_MOVE;
      } else if (mode === MODE_ATTACK_UNIT) {
        if (!this.canTarget(u, t, true)) mode = MODE_MOVE;
      }
      if (mode === MODE_MOVE) {
        this.orderMove(u, t.x, t.y, MODE_MOVE, c.q);
        if (!c.q) u.holding = false;
        continue;
      }
      if (mode === MODE_RETURN) {
        if (!c.q) this.clearOrders(u);
        const o = this.newOrder(MODE_RETURN, u.x, u.y, -1, this.nextGroup++);
        u.orders.push(o);
        if (u.orders.length === 1) this.beginOrder(u);
        continue;
      }
      this.orderTarget(u, t, mode, c.q);
    }
  }

  private applyBuild(p: number, c: Extract<Command, { t: "build" }>) {
    const k = KINDS[c.kind];
    if (!k) return;
    const site = { x: c.tx * FP + idiv(k.w * FP, 2), y: c.ty * FP + idiv(k.h * FP, 2) };
    // The selected worker closest to the site goes.
    let best: Unit | null = null;
    let bestD = 0;
    for (const u of this.mobile(p, c.ids)) {
      if (!KINDS[u.kind].worker || u.hidden) continue;
      const d = this.dist2(u.x, u.y, site.x, site.y);
      if (!best || d < bestD) {
        best = u;
        bestD = d;
      }
    }
    if (!best) return;
    const err = this.placeError(p, c.kind, c.tx, c.ty, best);
    if (err) return this.error(p, err);
    if (!this.canAfford(p, k.m, k.g)) return;
    if (!c.q) this.clearOrders(best);
    best.holding = false;
    const o = this.newOrder(MODE_BUILD, site.x, site.y, -1, this.nextGroup++);
    o.kind = c.kind;
    o.tx = c.tx;
    o.ty = c.ty;
    best.orders.push(o);
    if (best.orders.length === 1) this.beginOrder(best);
  }

  private canAfford(p: number, m: number, g: number, supply = 0): boolean {
    const pl = this.players.get(p);
    if (!pl) return false;
    if (pl.m < m) return this.error(p, "minerals"), false;
    if (pl.g < g) return this.error(p, "gas"), false;
    if (supply > 0 && !this.sandbox && pl.supply + supply > this.cap(p)) return this.error(p, pl.supply + supply > MAX_SUPPLY ? "max" : "supply"), false;
    return true;
  }

  private error(p: number, msg: Extract<SimEvent, { e: "error" }>["msg"]) {
    this.events.push({ e: "error", p, msg });
  }

  private applyTrain(p: number, c: Extract<Command, { t: "train" }>) {
    const k = KINDS[c.kind];
    if (!k || k.structure) return;
    let best: Unit | null = null;
    for (const b of this.ownedUnits(p, c.ids)) {
      if (!KINDS[b.kind].structure || !this.isDone(b) || b.queue.length >= MAX_QUEUE) continue;
      if (!this.trainable(p, b.kind).includes(c.kind)) continue;
      if (!best || b.queue.length < best.queue.length) best = b;
    }
    if (!best) return this.error(p, "queue");
    if (!this.hasStructure(p, k.requires)) return this.error(p, "tech");
    if (!this.canAfford(p, k.m, k.g, k.supply)) return;
    const pl = this.players.get(p)!;
    pl.m -= k.m;
    pl.g -= k.g;
    pl.supply += k.supply;
    best.queue.push({ kind: c.kind, up: -1, t: 0, total: k.time });
  }

  private applyResearch(p: number, c: Extract<Command, { t: "research" }>) {
    const pl = this.players.get(p);
    if (!pl || c.up > UP_ARMOR) return;
    if (pl.researching[c.up]) return this.error(p, "queue");
    const lvl = pl.up[c.up] + 1;
    if (lvl > MAX_UPGRADE) return;
    const cost = upgradeCost(lvl);
    let best: Unit | null = null;
    for (const b of this.ownedUnits(p, c.ids)) {
      if (!KINDS[b.kind].research || !this.isDone(b) || b.queue.length >= MAX_QUEUE) continue;
      if (!best || b.queue.length < best.queue.length) best = b;
    }
    if (!best) return this.error(p, "queue");
    if (!this.hasStructure(p, cost.requires)) return this.error(p, "tech");
    if (!this.canAfford(p, cost.m, cost.g)) return;
    pl.m -= cost.m;
    pl.g -= cost.g;
    pl.researching[c.up] = 1;
    best.queue.push({ kind: -1, up: c.up, t: 0, total: cost.time });
  }

  private applyEvolve(p: number, c: Extract<Command, { t: "evolve" }>) {
    const pl = this.players.get(p);
    if (!pl) return;
    for (const u of this.mobile(p, c.ids)) {
      const e = KINDS[u.kind].evolve;
      if (!e || u.hidden) continue;
      if (!this.hasStructure(p, e.requires)) return this.error(p, "tech");
      const dSupply = KINDS[e.to].supply - KINDS[u.kind].supply;
      if (!this.canAfford(p, e.m, e.g, dSupply)) return;
      pl.m -= e.m;
      pl.g -= e.g;
      pl.supply += dSupply;
      this.clearOrders(u);
      u.holding = false;
      u.morphTo = e.to;
      u.morphT = 0;
      u.morphTotal = e.time;
      u.vx = 0;
      u.vy = 0;
      this.events.push({ e: "evolving", id: u.id, kind: e.to, owner: p });
    }
  }

  private applyCancel(p: number, c: Extract<Command, { t: "cancel" }>) {
    const u = this.byId.get(c.id);
    const pl = this.players.get(p);
    if (!u || u.dead || u.owner !== p || !pl) return;
    const k = KINDS[u.kind];
    if (c.slot >= 0) {
      const item = u.queue[c.slot];
      if (!item) return;
      u.queue.splice(c.slot, 1);
      this.refundItem(pl, item);
      return;
    }
    if (u.morphTo >= 0) {
      const e = k.evolve!;
      pl.m += idiv(e.m * 3, 4);
      pl.g += idiv(e.g * 3, 4);
      pl.supply -= KINDS[u.morphTo].supply - k.supply;
      u.morphTo = -1;
      return;
    }
    if (k.structure && !this.isDone(u)) {
      pl.m += idiv(k.m * 3, 4);
      pl.g += idiv(k.g * 3, 4);
      this.kill(u, 0);
    }
  }

  private refundItem(pl: Player, item: QueueItem) {
    if (item.kind >= 0) {
      const k = KINDS[item.kind];
      pl.m += k.m;
      pl.g += k.g;
      pl.supply -= k.supply;
    } else {
      const cost = upgradeCost(pl.up[item.up] + 1);
      pl.m += cost.m;
      pl.g += cost.g;
      pl.researching[item.up] = 0;
    }
  }

  applyCommand(pc: PlayerCommand) {
    const { p, c } = pc;
    const pl = this.players.get(p);
    if (this.gameOver || (pl && !pl.alive)) return;
    switch (c.t) {
      case "move":
        this.applyMove(p, c);
        break;
      case "target":
        this.applyTarget(p, c);
        break;
      case "stop":
      case "hold":
        for (const u of this.mobile(p, c.ids)) {
          if (u.hidden) continue;
          this.clearOrders(u);
          u.holding = c.t === "hold";
          u.guardX = u.x;
          u.guardY = u.y;
        }
        break;
      case "build":
        this.applyBuild(p, c);
        break;
      case "train":
        this.applyTrain(p, c);
        break;
      case "research":
        this.applyResearch(p, c);
        break;
      case "evolve":
        this.applyEvolve(p, c);
        break;
      case "cancel":
        this.applyCancel(p, c);
        break;
      case "rally":
        for (const b of this.ownedUnits(p, c.ids)) {
          if (!KINDS[b.kind].structure) continue;
          b.rallyX = this.clampToMap(c.x, this.map.w);
          b.rallyY = this.clampToMap(c.y, this.map.h);
          b.rallyId = c.id;
        }
        break;
      case "surrender":
        if (pl && this.mode === "melee") this.defeat(p);
        break;
      case "spawn":
        if (this.sandbox) this.spawn(c.owner ?? p, c.kind, c.x, c.y, c.n);
        break;
      case "tune": {
        const d = tuneDef(c.key);
        if (d && this.sandbox) this.tune[d.key] = clamp(c.value, d.min, d.max);
        break;
      }
    }
  }

  // ----------------------------------------------------------------- tick

  /** Advance one simulation tick. `cmds` are the commands scheduled for this tick. */
  step(cmds: PlayerCommand[]) {
    this.tick++;
    this.events.length = 0;
    for (const pc of cmds) this.applyCommand(pc);
    const units = this.units;
    for (const u of units) {
      u.px = u.x;
      u.py = u.y;
    }
    this.refreshFields();
    this.buildHash();
    const n = units.length; // units spawned during think() start next tick
    for (let i = 0; i < n; i++) this.think(units[i]);
    for (let i = 0; i < n; i++) this.steer(units[i]);
    this.collide();
    for (const u of units) {
      if (u.dead || u.hidden || KINDS[u.kind].structure) continue;
      if (u.air) {
        u.x = this.clampToMap(u.x, this.map.w);
        u.y = this.clampToMap(u.y, this.map.h);
      } else this.pushOutOfTerrain(u);
    }
    this.buildHash();
    this.stepProjectiles();
    this.reap();
    for (let i = 0; i < this.hashUnits.length; i++) {
      const u = this.hashUnits[i];
      if (!u.dead && u.orders.length > 0 && u.navKind === NAV_ORDER && u.orders[0].mode <= MODE_PATROL) this.checkArrival(u, i);
    }
    if (this.map.version !== this.mapVersion) this.onMapChanged();
    if (this.tick % VISION_TICKS === 0) this.updateVision();
    if (this.tick % 16 === 0 && this.mode === "melee" && !this.sandbox) this.checkDefeat();
  }

  private onMapChanged() {
    this.mapVersion = this.map.version;
    this.idleFields.clear();
    for (const f of this.fields.values()) f.dirty = true;
    this.dirtyKeys = [...this.fields.keys()].sort((a, b) => a - b);
    for (const u of this.units) u.wpTick = -1;
  }

  /** Rebuild a few stale flow fields per tick (units steer on the old one meanwhile). */
  private refreshFields() {
    let budget = 3;
    while (budget > 0 && this.dirtyKeys.length > 0) {
      const f = this.fields.get(this.dirtyKeys.shift()!);
      if (f && f.dirty) {
        f.recompute(this.map);
        budget--;
      }
    }
  }

  // ---------------------------------------------------------- per unit

  private think(u: Unit) {
    if (u.dead) return;
    const k = KINDS[u.kind];
    u.navKind = NAV_NONE;
    u.engaged = false;
    if (k.resource) return;
    if (k.structure) return this.thinkStructure(u, k);
    if (u.morphTo >= 0) {
      if (++u.morphT >= u.morphTotal) this.finishEvolve(u);
      return;
    }
    const o = u.orders[0];
    if (o && (o.mode === MODE_GATHER || o.mode === MODE_RETURN)) this.thinkGather(u, o);
    else if (o && o.mode === MODE_BUILD) this.thinkBuild(u, o);
    if (k.weapon) this.thinkCombat(u, k);
    if (u.navKind === NAV_NONE && !u.engaged) {
      const o2 = u.orders[0];
      if (o2 && o2.mode <= MODE_PATROL) this.navOrder(u, o2.x, o2.y);
    }
  }

  private navOrder(u: Unit, x: number, y: number) {
    u.navKind = NAV_ORDER;
    u.navX = x;
    u.navY = y;
  }

  private thinkStructure(u: Unit, k: UnitKind) {
    if (u.progress < k.time) {
      // Construction: health grows with progress, like SC2.
      const before = idiv(k.hp * 9 * u.progress, k.time * 10);
      u.progress++;
      u.hp += idiv(k.hp * 9 * u.progress, k.time * 10) - before;
      if (u.progress >= k.time) {
        const p = this.players.get(u.owner);
        if (p) p.provided += k.provides;
        this.events.push({ e: "built", id: u.id, kind: u.kind, owner: u.owner });
      }
      return;
    }
    const item = u.queue[0];
    if (item && ++item.t >= item.total) {
      u.queue.shift();
      if (item.kind >= 0) this.finishTrain(u, item.kind);
      else this.finishResearch(u, item.up);
    }
    if (k.weapon) this.thinkCombat(u, k);
  }

  private finishTrain(b: Unit, kind: number) {
    const k = KINDS[kind];
    const p = this.players.get(b.owner);
    // Spawn at the free tile next to the footprint closest to the rally point (or below the building).
    let pos = { x: b.x, y: b.y };
    if (!k.air) {
      const rx = b.rallyX || b.x;
      const ry = b.rallyY || b.y + FP * 8;
      const t = this.approachTile(b, rx, ry, clearanceFor(idiv(k.radius * 1000, FP)));
      if (t >= 0) {
        const tx = t % this.map.w;
        pos = { x: tx * FP + (FP >> 1), y: idiv(t - tx, this.map.w) * FP + (FP >> 1) };
      }
    }
    if (p) p.supply -= k.supply; // addUnit counts it again
    const u = this.addUnit(b.owner, kind, pos.x, pos.y);
    if (p) p.stats.made++;
    this.events.push({ e: "trained", id: u.id, kind, owner: b.owner });
    const r = b.rallyId ? this.byId.get(b.rallyId) : undefined;
    if (r && !r.dead) {
      if (k.worker && this.isGatherTarget(u, r)) this.orderTarget(u, r, MODE_GATHER, false);
      else this.orderMove(u, r.x, r.y, MODE_MOVE, false);
    } else if (b.rallyX > 0) {
      this.orderMove(u, b.rallyX, b.rallyY, MODE_MOVE, false);
    } else if (k.worker) {
      const m = this.mineralsNear(b.x, b.y, FP * 12)[0];
      if (m) this.orderTarget(u, m, MODE_GATHER, false);
    }
  }

  private finishResearch(b: Unit, up: number) {
    const p = this.players.get(b.owner);
    if (!p) return;
    p.researching[up] = 0;
    p.up[up] = Math.min(MAX_UPGRADE, p.up[up] + 1);
    this.events.push({ e: "research", owner: b.owner, up, lvl: p.up[up] });
  }

  private finishEvolve(u: Unit) {
    const from = KINDS[u.kind];
    const to = KINDS[u.morphTo];
    u.hp = Math.max(1, idiv(u.hp * to.hp, from.hp));
    u.kind = to.id;
    u.air = to.air;
    u.radius = to.radius;
    u.req = clearanceFor(idiv(to.radius * 1000, FP));
    u.morphTo = -1;
    u.cd = 0;
    u.guardX = u.x;
    u.guardY = u.y;
    this.events.push({ e: "evolved", id: u.id, kind: to.id, owner: u.owner });
  }

  // ------------------------------------------------------------ combat

  /** Edge-to-edge distance between two units (structures use their footprint rectangle). */
  edgeDist(a: Unit, b: Unit): number {
    const kb = KINDS[b.kind];
    const ka = KINDS[a.kind];
    if (kb.w > 0) return Math.max(0, this.rectDist(a.x, a.y, b) - a.radius);
    if (ka.w > 0) return Math.max(0, this.rectDist(b.x, b.y, a) - b.radius);
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.max(0, isqrt(dx * dx + dy * dy) - a.radius - b.radius);
  }

  /** Distance from a point to a structure's footprint (0 inside). */
  private rectDist(x: number, y: number, s: Unit): number {
    const k = KINDS[s.kind];
    const x0 = s.tx * FP;
    const y0 = s.ty * FP;
    const dx = Math.max(x0 - x, 0, x - (x0 + k.w * FP));
    const dy = Math.max(y0 - y, 0, y - (y0 + k.h * FP));
    return isqrt(dx * dx + dy * dy);
  }

  /** Could `u` attack `t` right now? Explicit = a direct order (lets you hit rocks). */
  canTarget(u: Unit, t: Unit | undefined, explicit: boolean): boolean {
    if (!t || t.dead || t.hidden || t === u) return false;
    const tk = KINDS[t.kind];
    if (tk.resource === 1 || tk.resource === 2) return false;
    if (tk.resource === 3) {
      if (!explicit) return false;
    } else if (t.owner === NEUTRAL) return false;
    // Allies (and your own units) only when ordered to: SC2-style friendly fire via A-click.
    else if (this.allied(u.owner, t.owner) && !explicit) return false;
    const w = KINDS[u.kind].weapon;
    if (!w) return false;
    if (t.air ? !w.air : !w.ground) return false;
    return this.canSee(u.owner, t);
  }

  private priority(t: Unit): number {
    const k = KINDS[t.kind];
    if (k.structure) return k.weapon ? 3 : 1;
    if (k.worker) return 2;
    return k.weapon ? 3 : 2;
  }

  /** Best target within `range` (edge distance): highest priority, then nearest, then lowest id. */
  private acquire(u: Unit, range: number): Unit | null {
    let best: Unit | null = null;
    let bestP = -1;
    let bestD = 0;
    const reach = range + u.radius + FP * 3;
    const cx0 = clamp(fdiv(u.x - reach, CELL), 0, this.gw - 1);
    const cx1 = clamp(fdiv(u.x + reach, CELL), 0, this.gw - 1);
    const cy0 = clamp(fdiv(u.y - reach, CELL), 0, this.gh - 1);
    const cy1 = clamp(fdiv(u.y + reach, CELL), 0, this.gh - 1);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = cy * this.gw + cx;
        for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) {
          const t = this.hashUnits[this.cellItems[k]];
          if (!this.canTarget(u, t, false)) continue;
          const d = this.edgeDist(u, t);
          if (d > range) continue;
          const p = this.priority(t);
          if (p > bestP || (p === bestP && (d < bestD || (d === bestD && t.id < best!.id)))) {
            best = t;
            bestP = p;
            bestD = d;
          }
        }
      }
    return best;
  }

  private thinkCombat(u: Unit, k: UnitKind) {
    const w = k.weapon!;
    if (u.cd > 0) u.cd--;
    if (u.windup > 0 && --u.windup === 0) this.fire(u);
    if (u.hidden) return;
    const o = u.orders[0];
    const mode = o ? o.mode : -1;
    const structure = k.structure;
    if (mode === MODE_ATTACK_UNIT) {
      const t = this.byId.get(o.target);
      if (!this.canTarget(u, t, true)) {
        this.completeOrder(u);
        return;
      }
      u.target = t!.id;
    } else if (mode === -1 || mode === MODE_ATTACK || mode === MODE_PATROL) {
      if (k.worker && mode === -1 && !u.target) return; // workers only fight back when ordered or hit
      const cur = this.byId.get(u.target);
      if (!this.canTarget(u, cur, false)) u.target = 0;
      const curIn = u.target !== 0 && this.edgeDist(u, cur!) <= w.range;
      if (!curIn && (u.target === 0 || (this.tick + u.id) % 4 === 0)) {
        const range = u.holding || structure ? w.range : w.range + FP * (mode === -1 ? 2 : 3);
        const t = this.acquire(u, range);
        if (t) u.target = t.id;
      }
    } else {
      u.target = 0;
      return;
    }
    if (!u.target) {
      this.stopChase(u);
      return;
    }
    const t = this.byId.get(u.target)!;
    if (this.edgeDist(u, t) <= w.range) {
      u.engaged = true;
      u.navKind = NAV_NONE;
      this.stopChase(u);
      if (u.cd === 0 && u.windup === 0) {
        u.windup = Math.max(1, w.point);
        u.wTarget = t.id;
        u.cd = w.cooldown;
        u.attackTick = this.tick;
        this.events.push({ e: "attack", id: u.id, target: t.id });
      }
      return;
    }
    if (structure || (u.holding && mode === -1)) {
      u.target = 0;
      return;
    }
    if (mode === -1 && this.dist2(u.x, u.y, u.guardX, u.guardY) > LEASH * LEASH) {
      // Idle units chase only so far, then walk back.
      u.target = 0;
      this.stopChase(u);
      this.orderMove(u, u.guardX, u.guardY, MODE_MOVE, false);
      return;
    }
    this.navChase(u, t);
  }

  private navChase(u: Unit, t: Unit) {
    u.navKind = NAV_CHASE;
    if (u.air) {
      u.navX = t.x;
      u.navY = t.y;
      return;
    }
    const tk = KINDS[t.kind];
    let tile: number;
    if (tk.w > 0) {
      tile = this.approachTile(t, u.x, u.y, u.req);
    } else {
      tile = nearestPassableTile(this.map, fdiv(t.x, FP), fdiv(t.y, FP), u.req);
    }
    if (tk.w > 0 && tile >= 0) {
      const tx = tile % this.map.w;
      u.navX = tx * FP + (FP >> 1);
      u.navY = idiv(tile - tx, this.map.w) * FP + (FP >> 1);
    } else {
      u.navX = t.x;
      u.navY = t.y;
    }
    if (tile !== u.chaseTile) {
      u.chaseTile = tile;
      u.wpTick = -1;
    }
  }

  /** Damage `a` deals to `t` with its weapon. */
  private damage(akind: number, lvl: number, t: Unit): number {
    const w = KINDS[akind].weapon!;
    const tk = KINDS[t.kind];
    const base = w.damage + w.upgrade * lvl;
    const armor = tk.armor + (tk.structure ? 0 : (this.players.get(t.owner)?.up[UP_ARMOR] ?? 0));
    return Math.max(1, idiv(base * typeMult(w.type, tk.types), 100) - armor);
  }

  private fire(u: Unit) {
    const t = this.byId.get(u.wTarget);
    const w = KINDS[u.kind].weapon!;
    if (!t || t.dead || t.hidden || this.edgeDist(u, t) > w.range + FP) return;
    const lvl = this.players.get(u.owner)?.up[UP_ATTACK] ?? 0;
    if (w.speed === 0) {
      this.impact(u.owner, u.id, u.kind, lvl, t, t.x, t.y, t.air);
      return;
    }
    this.projectiles.push({
      id: this.nextProj++,
      owner: u.owner,
      src: u.id,
      kind: u.kind,
      lvl,
      x: u.x,
      y: u.y,
      px: u.x,
      py: u.y,
      target: t.id,
      tx: t.x,
      ty: t.y,
      air: t.air,
      fromAir: u.air,
    });
  }

  private stepProjectiles() {
    const keep: Projectile[] = [];
    for (const p of this.projectiles) {
      p.px = p.x;
      p.py = p.y;
      const t = this.byId.get(p.target);
      if (t && !t.dead && !t.hidden) {
        p.tx = t.x;
        p.ty = t.y;
      }
      const speed = KINDS[p.kind].weapon!.speed;
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const d = isqrt(dx * dx + dy * dy);
      if (d <= speed) {
        p.x = p.tx;
        p.y = p.ty;
        this.impact(p.owner, p.src, p.kind, p.lvl, t && !t.dead && !t.hidden ? t : null, p.tx, p.ty, p.air);
        continue;
      }
      p.x += idiv(dx * speed, d);
      p.y += idiv(dy * speed, d);
      keep.push(p);
    }
    this.projectiles = keep;
  }

  private impact(owner: number, src: number, akind: number, lvl: number, t: Unit | null, x: number, y: number, air: boolean) {
    const w = KINDS[akind].weapon!;
    let main = 0;
    if (t) {
      main = this.damage(akind, lvl, t);
      this.hurt(t, main, owner, src);
    }
    this.events.push({ e: "hit", x, y, air, kind: akind, src, target: t ? t.id : 0, dmg: main });
    if (w.splash <= 0) return;
    const r = w.splash;
    const cx0 = clamp(fdiv(x - r - FP * 3, CELL), 0, this.gw - 1);
    const cx1 = clamp(fdiv(x + r + FP * 3, CELL), 0, this.gw - 1);
    const cy0 = clamp(fdiv(y - r - FP * 3, CELL), 0, this.gh - 1);
    const cy1 = clamp(fdiv(y + r + FP * 3, CELL), 0, this.gh - 1);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = cy * this.gw + cx;
        for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) {
          const v = this.hashUnits[this.cellItems[k]];
          if (v === t || v.dead || v.hidden || v.air !== air || v.owner === NEUTRAL || this.allied(owner, v.owner)) continue;
          const dx = v.x - x;
          const dy = v.y - y;
          const d = Math.max(0, isqrt(dx * dx + dy * dy) - v.radius);
          if (d > r) continue;
          const dmg = this.damage(akind, lvl, v);
          this.hurt(v, d * 2 <= r ? dmg : Math.max(1, dmg >> 1), owner, src);
        }
      }
  }

  private hurt(t: Unit, dmg: number, owner: number, src: number) {
    if (t.dead || t.hp <= 0) return;
    t.hp -= dmg;
    if (t.lastHit < this.tick - 60 && this.players.has(t.owner)) this.events.push({ e: "attacked", p: t.owner, x: t.x, y: t.y, id: t.id });
    t.lastHit = this.tick;
    if (t.hp <= 0) {
      const p = this.players.get(owner);
      if (p && !KINDS[t.kind].resource) p.stats.killed++;
      return;
    }
    // Idle units fight back (or chase) when hit.
    const a = this.byId.get(src);
    const k = KINDS[t.kind];
    if (a && !a.dead && t.orders.length === 0 && !t.holding && !k.structure && t.morphTo < 0 && !t.target && this.canTarget(t, a, false)) {
      t.target = a.id;
      t.guardX = t.x;
      t.guardY = t.y;
    }
  }

  /** Remove units that died this tick. */
  private reap() {
    let any = false;
    for (const u of this.units) {
      if (!u.dead && u.hp <= 0) this.kill(u, 0);
      if (u.dead) any = true;
    }
    if (any) {
      this.units = this.units.filter((u) => !u.dead);
    }
  }

  private kill(u: Unit, _cause: number) {
    if (u.dead) return;
    u.dead = true;
    u.hp = Math.min(u.hp, 0);
    const k = KINDS[u.kind];
    this.events.push({ e: "death", id: u.id, kind: u.kind, owner: u.owner, x: u.x, y: u.y, air: u.air });
    this.leaveResource(u);
    for (const o of u.orders) this.releaseOrder(o);
    u.orders.length = 0;
    this.stopChase(u);
    this.byId.delete(u.id);
    const p = this.players.get(u.owner);
    if (p) {
      if (!k.resource) p.stats.lost++;
      if (!k.structure) {
        p.supply -= k.supply;
        if (u.morphTo >= 0) p.supply -= KINDS[u.morphTo].supply - k.supply;
      } else {
        if (this.isDone(u)) p.provided -= k.provides;
        for (const item of u.queue) {
          if (item.kind >= 0) p.supply -= KINDS[item.kind].supply;
          else p.researching[item.up] = 0;
        }
      }
    }
    if (k.structure) {
      if (u.kind === K_EXTRACTOR) {
        const g = this.byId.get(u.link);
        if (g) g.link = 0;
        const w = this.byId.get(u.occupant);
        if (w && w.hidden) this.popOut(w, u);
      } else occupy(this.map, u.tx, u.ty, k.w, k.h, -1);
    }
  }

  // ------------------------------------------------------------ workers

  /** A worker leaving its mineral / extractor (stop, new order, death). */
  private leaveResource(u: Unit) {
    if (u.gState !== G_MINE) return;
    u.gState = G_GO;
    const o = u.orders[0];
    const r = o ? this.byId.get(o.target) : undefined;
    if (r && r.occupant === u.id) {
      r.occupant = 0;
      if (u.hidden) this.popOut(u, r);
    }
    u.hidden = false;
  }

  private popOut(w: Unit, ex: Unit) {
    w.hidden = false;
    const d = this.nearestDropoff(w.owner, ex.x, ex.y);
    const t = this.approachTile(ex, d ? d.x : ex.x, d ? d.y : ex.y + FP * 4, w.req);
    if (t >= 0) {
      const tx = t % this.map.w;
      w.x = tx * FP + (FP >> 1);
      w.y = idiv(t - tx, this.map.w) * FP + (FP >> 1);
      w.px = w.x;
      w.py = w.y;
    }
    w.wpTick = -1;
  }

  nearestDropoff(pid: number, x: number, y: number): Unit | null {
    let best: Unit | null = null;
    let bestD = 0;
    for (const u of this.units) {
      if (u.owner !== pid || u.dead || !KINDS[u.kind].dropoff || !this.isDone(u)) continue;
      const d = this.dist2(u.x, u.y, x, y);
      if (!best || d < bestD) {
        best = u;
        bestD = d;
      }
    }
    return best;
  }

  /** Passable tile just outside a structure's footprint, closest to (x, y). */
  approachTile(s: Unit, x: number, y: number, req: number): number {
    const k = KINDS[s.kind];
    const w = this.map.w;
    let best = -1;
    let bestD = 0;
    for (let ty = s.ty - 1; ty <= s.ty + k.h; ty++)
      for (let tx = s.tx - 1; tx <= s.tx + k.w; tx++) {
        const insideX = tx >= s.tx && tx < s.tx + k.w;
        const insideY = ty >= s.ty && ty < s.ty + k.h;
        // Edge neighbours only: diagonal corner tiles are too far to reach the footprint from.
        if (insideX === insideY) continue;
        if (!isPassable(this.map, tx, ty, req)) continue;
        const d = this.dist2(tx * FP + (FP >> 1), ty * FP + (FP >> 1), x, y);
        if (best < 0 || d < bestD) {
          best = ty * w + tx;
          bestD = d;
        }
      }
    if (best < 0) best = nearestPassableTile(this.map, fdiv(s.x, FP), fdiv(s.y, FP), req);
    return best;
  }

  private reached(u: Unit, s: Unit, extra = 0): boolean {
    return this.rectDist(u.x, u.y, s) <= u.radius + REACH + extra;
  }

  /** Walk toward a structure / resource: aim at the approach tile chosen when we started walking to it. */
  private navTo(u: Unit, o: Order, s: Unit) {
    const w = this.map.w;
    if (o.navId !== s.id || (o.tile >= 0 && !isPassable(this.map, o.tile % w, idiv(o.tile - (o.tile % w), w), u.req))) {
      o.navId = s.id;
      o.tile = u.air ? -1 : this.approachTile(s, u.x, u.y, u.req);
      u.wpTick = -1;
    }
    if (o.tile >= 0) {
      const tx = o.tile % this.map.w;
      o.x = tx * FP + (FP >> 1);
      o.y = idiv(o.tile - tx, this.map.w) * FP + (FP >> 1);
    } else {
      o.x = s.x;
      o.y = s.y;
    }
    this.navOrder(u, o.x, o.y);
  }

  private thinkGather(u: Unit, o: Order) {
    if (o.mode === MODE_RETURN || u.gState === G_RETURN) {
      if (u.carry === 0) {
        if (o.mode === MODE_RETURN) {
          this.completeOrder(u);
          this.resumeGather(u);
          return;
        }
        u.gState = G_GO;
      } else {
        const d = this.nearestDropoff(u.owner, u.x, u.y);
        if (!d) return;
        if (!this.reached(u, d)) return this.navTo(u, o, d);
        const p = this.players.get(u.owner);
        if (p) {
          if (u.carryGas) {
            p.g += u.carry;
            p.stats.gas += u.carry;
          } else {
            p.m += u.carry;
            p.stats.mined += u.carry;
          }
        }
        u.carry = 0;
        if (o.mode === MODE_RETURN) {
          this.completeOrder(u);
          this.resumeGather(u);
          return;
        }
        u.gState = G_GO;
      }
    }
    // Gathering.
    let r = this.byId.get(o.target);
    if (!r || r.dead || !this.isGatherTarget(u, r)) {
      const alt = !r || r.dead || r.kind === K_MINERAL ? this.freeMineral(u, o.x, o.y, FP * 10) : null;
      if (!alt) return this.completeOrder(u);
      o.target = alt.id;
      u.lastGather = alt.id;
      r = alt;
    }
    if (u.carry > 0 && u.gState === G_GO) {
      u.gState = G_RETURN;
      return;
    }
    if (u.gState === G_MINE) {
      if (--u.gTimer > 0) return;
      this.harvest(u, r);
      u.gState = G_RETURN;
      return;
    }
    if (!this.reached(u, r)) return this.navTo(u, o, r);
    if (!this.occupantValid(r)) r.occupant = 0;
    if (r.occupant === 0 || r.occupant === u.id) {
      r.occupant = u.id;
      u.gState = G_MINE;
      u.vx = 0;
      u.vy = 0;
      if (r.kind === K_EXTRACTOR) {
        u.hidden = true;
        u.gTimer = GAS_TICKS;
      } else u.gTimer = MINE_TICKS;
      return;
    }
    // Occupied: SC2 workers look for a free patch next to it, otherwise wait their turn.
    if (r.kind === K_MINERAL) {
      const alt = this.freeMineral(u, r.x, r.y, FP * 4);
      if (alt && alt !== r) {
        o.target = alt.id;
        u.lastGather = alt.id;
      }
    }
  }

  /** After returning cargo or building: go back to the last resource, like SC2 workers. */
  private resumeGather(u: Unit) {
    const r = this.byId.get(u.lastGather);
    if (u.orders.length === 0 && r && !r.dead && this.isGatherTarget(u, r)) this.orderTarget(u, r, MODE_GATHER, false);
  }

  private occupantValid(r: Unit): boolean {
    if (!r.occupant) return true;
    const w = this.byId.get(r.occupant);
    return !!w && !w.dead && w.gState === G_MINE && w.orders[0]?.target === r.id;
  }

  /** Nearest mineral field around (x, y) that nobody is mining (falls back to the nearest one). */
  private freeMineral(u: Unit, x: number, y: number, r: number): Unit | null {
    let best: Unit | null = null;
    let bestScore = 0;
    for (const m of this.units) {
      if (m.kind !== K_MINERAL || m.dead) continue;
      const d = this.dist2(m.x, m.y, x, y);
      if (d > r * r) continue;
      const busy = m.occupant !== 0 && m.occupant !== u.id && this.occupantValid(m);
      const du = this.dist2(m.x, m.y, u.x, u.y);
      const score = (busy ? 1 << 30 : 0) + idiv(du, FP);
      if (!best || score < bestScore) {
        best = m;
        bestScore = score;
      }
    }
    return best;
  }

  private harvest(u: Unit, r: Unit) {
    if (r.kind === K_EXTRACTOR) {
      const g = this.byId.get(r.link);
      const amt = g ? Math.min(GAS_CARRY, g.amount) : 0;
      if (g) g.amount -= amt;
      u.carry = amt;
      u.carryGas = true;
      r.occupant = 0;
      this.popOut(u, r);
      return;
    }
    const amt = Math.min(r.yield, r.amount);
    r.amount -= amt;
    u.carry = amt;
    u.carryGas = false;
    r.occupant = 0;
    if (r.amount <= 0) this.kill(r, 0);
  }

  private thinkBuild(u: Unit, o: Order) {
    const k = KINDS[o.kind];
    const site = { tx: o.tx, ty: o.ty };
    const x0 = site.tx * FP;
    const y0 = site.ty * FP;
    const dx = Math.max(x0 - u.x, 0, u.x - (x0 + k.w * FP));
    const dy = Math.max(y0 - u.y, 0, u.y - (y0 + k.h * FP));
    if (isqrt(dx * dx + dy * dy) > u.radius + FP + REACH) {
      if (o.tile < 0) {
        // Approach tile next to the site, from where the worker is now.
        let best = -1;
        let bestD = 0;
        for (let ty = site.ty - 1; ty <= site.ty + k.h; ty++)
          for (let tx = site.tx - 1; tx <= site.tx + k.w; tx++) {
            if (tx >= site.tx && tx < site.tx + k.w && ty >= site.ty && ty < site.ty + k.h) continue;
            if (!isPassable(this.map, tx, ty, u.req)) continue;
            const d = this.dist2(tx * FP + (FP >> 1), ty * FP + (FP >> 1), u.x, u.y);
            if (best < 0 || d < bestD) {
              best = ty * this.map.w + tx;
              bestD = d;
            }
          }
        o.tile = best >= 0 ? best : this.groundGoal(o.x, o.y, u.req).tile;
        if (o.tile >= 0) {
          const tx = o.tile % this.map.w;
          o.x = tx * FP + (FP >> 1);
          o.y = idiv(o.tile - tx, this.map.w) * FP + (FP >> 1);
        }
      }
      this.navOrder(u, o.x, o.y);
      if (++u.stuck > 22 * 30) this.completeOrder(u);
      return;
    }
    const p = this.players.get(u.owner);
    const err = this.placeError(u.owner, o.kind, site.tx, site.ty, u);
    if (err) this.error(u.owner, err);
    else if (p && this.canAfford(u.owner, k.m, k.g)) {
      p.m -= k.m;
      p.g -= k.g;
      this.spawnStructure(u.owner, o.kind, site.tx, site.ty, false);
    }
    // The builder stays put afterwards; shift-queue a gather order to send it back to mining.
    this.completeOrder(u);
  }

  // ---------------------------------------------------------- movement

  private navField(u: Unit): FlowField | null {
    if (u.navKind === NAV_CHASE) {
      if (u.chaseTile < 0) return null;
      const f = u.chaseField;
      if (f && f.goalTile === u.chaseTile) return f;
      if (f) {
        // Don't rebuild for small target moves.
        const w = this.map.w;
        const ax = f.goalTile % w;
        const bx = u.chaseTile % w;
        const ay = idiv(f.goalTile - ax, w);
        const by = idiv(u.chaseTile - bx, w);
        if (abs(ax - bx) <= 2 && abs(ay - by) <= 2 && f.dist[fdiv(u.y, FP) * w + fdiv(u.x, FP)] < 0x3fffffff) return f;
      }
      this.releaseField(f);
      u.chaseField = this.acquireField(u.chaseTile, u.req);
      return u.chaseField;
    }
    const o = u.orders[0];
    if (!o || o.tile < 0) return null;
    if (o.field && o.field.goalTile !== o.tile) this.releaseOrder(o);
    if (!o.field) o.field = this.acquireField(o.tile, u.req);
    return o.field;
  }

  private steer(u: Unit) {
    if (u.dead) return;
    const k = KINDS[u.kind];
    if (k.speed === 0 || u.hidden || u.morphTo >= 0) {
      u.vx = 0;
      u.vy = 0;
      return;
    }
    const t = this.tune;
    const maxSpeed = Math.max(1, pct(k.speed, t.speedPct));
    const accel = Math.max(1, pct(k.accel, t.accelPct));
    let dvx = 0;
    let dvy = 0;
    if (u.navKind !== NAV_NONE) {
      // Pick a steering waypoint (direct if the goal is in sight, else follow the flow field).
      if (u.air) {
        u.wpx = u.navX;
        u.wpy = u.navY;
      } else {
        const wdx = u.wpx - u.x;
        const wdy = u.wpy - u.y;
        const nearWp = wdx * wdx + wdy * wdy <= u.radius * u.radius;
        if (u.wpTick < 0 || nearWp || (this.tick + u.id) % t.repathTicks === 0) {
          if (clearPath(this.map, u.x, u.y, u.navX, u.navY, u.radius)) {
            u.wpx = u.navX;
            u.wpy = u.navY;
          } else {
            const f = this.navField(u);
            if (f && steerTarget(this.map, f, u.x, u.y, u.radius, this.wp)) {
              u.wpx = this.wp.x;
              u.wpy = this.wp.y;
            } else {
              u.wpx = u.navX;
              u.wpy = u.navY;
            }
          }
          u.wpTick = this.tick;
        }
      }
      const dx = u.wpx - u.x;
      const dy = u.wpy - u.y;
      const d = isqrt(dx * dx + dy * dy);
      const gx = u.navX - u.x;
      const gy = u.navY - u.y;
      const goalDist = isqrt(gx * gx + gy * gy);
      // Brake so we arrive without overshooting.
      let speed = maxSpeed;
      const brake = isqrt(2 * accel * goalDist);
      if (brake < speed) speed = brake;
      if (goalDist < speed) speed = goalDist;
      if (d > 0) {
        dvx = idiv(dx * speed, d);
        dvy = idiv(dy * speed, d);
      }
    }
    // Accelerate toward the desired velocity, limited by accel per tick.
    let ax = dvx - u.vx;
    let ay = dvy - u.vy;
    const al = isqrt(ax * ax + ay * ay);
    if (al > accel) {
      ax = idiv(ax * accel, al);
      ay = idiv(ay * accel, al);
    }
    u.vx += ax;
    u.vy += ay;
    u.x += u.vx;
    u.y += u.vy;
  }

  // ------------------------------------------------------------ collision

  private buildHash() {
    const list = this.units;
    this.hashUnits = list;
    const n = list.length;
    const counts = this.cellCount;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const u = list[i];
      const cx = clamp(fdiv(u.x, CELL), 0, this.gw - 1);
      const cy = clamp(fdiv(u.y, CELL), 0, this.gh - 1);
      const c = cy * this.gw + cx;
      this.unitCell[i] = c;
      counts[c]++;
    }
    let acc = 0;
    for (let c = 0; c < counts.length; c++) {
      this.cellStart[c] = acc;
      acc += counts[c];
    }
    this.cellStart[counts.length] = acc;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = this.unitCell[i];
      this.cellItems[this.cellStart[c] + counts[c]++] = i;
    }
  }

  /** Visit every unit index j > i in the 3x3 cells around unit i. */
  private forNeighbours(i: number, fn: (j: number) => void) {
    const c = this.unitCell[i];
    const cx = c % this.gw;
    const cy = idiv(c - cx, this.gw);
    for (let y = cy - 1; y <= cy + 1; y++) {
      if (y < 0 || y >= this.gh) continue;
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (x < 0 || x >= this.gw) continue;
        const cell = y * this.gw + x;
        for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) fn(this.cellItems[k]);
      }
    }
  }

  /** Mining workers ghost through other units, like SC2's mineral walk. */
  private ghost(u: Unit): boolean {
    const o = u.orders[0];
    return u.hidden || (!!o && (o.mode === MODE_GATHER || o.mode === MODE_RETURN));
  }

  private collide() {
    const iters = this.tune.collisionIters;
    const n = this.units.length;
    for (let it = 0; it < iters; it++) {
      this.buildHash();
      for (let i = 0; i < n; i++) {
        const a = this.units[i];
        if (a.dead || KINDS[a.kind].structure || this.ghost(a)) continue;
        this.forNeighbours(i, (j) => {
          if (j <= i) return;
          const b = this.units[j];
          if (b.dead || a.air !== b.air || KINDS[b.kind].structure || this.ghost(b)) return;
          if (a.air) this.separateAir(a, b);
          else this.separateGround(a, b);
        });
      }
    }
  }

  /** How readily `u` yields when overlapping `other` (0 = immovable). */
  private yieldWeight(u: Unit, other: Unit): number {
    if (u.morphTo >= 0) return 0;
    if (u.holding && u.orders.length === 0) return 0;
    if (u.owner !== other.owner) return 2;
    const uMoving = u.orders.length > 0;
    const oMoving = other.orders.length > 0;
    if (this.tune.pushIdle) {
      if (!uMoving && oMoving) return 4; // idle units get shoved aside
      if (uMoving && !oMoving) return 1;
    }
    return 2;
  }

  private separateGround(a: Unit, b: Unit) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const minD = a.radius + b.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 >= minD * minD) return;
    let d = isqrt(d2);
    if (d === 0) {
      const k = (a.id * 7 + b.id * 13) & 7;
      dx = JITTER_X[k];
      dy = JITTER_Y[k];
      d = 1000;
    }
    let wa = this.yieldWeight(a, b);
    let wb = this.yieldWeight(b, a);
    if (wa + wb === 0) {
      wa = 1;
      wb = 1;
    }
    const push = idiv((minD - (d2 === 0 ? 0 : d)) * this.tune.pushStrength, 1000);
    const den = d * (wa + wb);
    a.x -= idiv(dx * push * wa, den);
    a.y -= idiv(dy * push * wa, den);
    b.x += idiv(dx * push * wb, den);
    b.y += idiv(dy * push * wb, den);
  }

  /** SC2 air: stacked while moving, slowly drift apart when idle. */
  private separateAir(a: Unit, b: Unit) {
    if (a.orders.length > 0 || b.orders.length > 0 || a.engaged || b.engaged) return;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const minD = a.radius + b.radius;
    const d2 = dx * dx + dy * dy;
    if (d2 >= minD * minD) return;
    let d = isqrt(d2);
    if (d === 0) {
      const k = (a.id * 7 + b.id * 13) & 7;
      dx = JITTER_X[k];
      dy = JITTER_Y[k];
      d = 1000;
    }
    const push = Math.max(1, idiv((minD - (d2 === 0 ? 0 : d)) * this.tune.airSpread, 1000));
    const den = d * 2;
    a.x -= idiv(dx * push, den);
    a.y -= idiv(dy * push, den);
    b.x += idiv(dx * push, den);
    b.y += idiv(dy * push, den);
  }

  /** Resolve overlap between a ground unit's disc and blocked tiles. */
  private pushOutOfTerrain(u: Unit) {
    const r = u.radius;
    const m = this.map;
    for (let pass = 0; pass < 2; pass++) {
      const tx0 = fdiv(u.x - r, FP);
      const tx1 = fdiv(u.x + r, FP);
      const ty0 = fdiv(u.y - r, FP);
      const ty1 = fdiv(u.y + r, FP);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          if (!isBlockedTile(m, tx, ty)) continue;
          const left = tx * FP;
          const top = ty * FP;
          const right = left + FP;
          const bottom = top + FP;
          const cx = clamp(u.x, left, right);
          const cy = clamp(u.y, top, bottom);
          const dx = u.x - cx;
          const dy = u.y - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          if (d2 === 0) {
            // Centre inside the tile: leave through the nearest open side.
            const opts: [number, number, number][] = [
              [u.x - left, -1, 0],
              [right - u.x, 1, 0],
              [u.y - top, 0, -1],
              [bottom - u.y, 0, 1],
            ];
            let best = -1;
            let bestD = 0x3fffffff;
            for (let i = 0; i < 4; i++) {
              const [dist, sx, sy] = opts[i];
              if (isBlockedTile(m, tx + sx, ty + sy)) continue;
              if (dist < bestD) {
                bestD = dist;
                best = i;
              }
            }
            if (best < 0) continue;
            const [dist, sx, sy] = opts[best];
            u.x += sx * (dist + r + 1);
            u.y += sy * (dist + r + 1);
          } else {
            const d = isqrt(d2);
            const push = r - d + 1;
            u.x += idiv(dx * push, d);
            u.y += idiv(dy * push, d);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------- arrival

  private checkArrival(u: Unit, i: number) {
    const o = u.orders[0];
    const t = this.tune;
    const dx = o.x - u.x;
    const dy = o.y - u.y;
    const dist = isqrt(dx * dx + dy * dy);
    const arrive = idiv(t.arriveDist * FP, 1000);
    if (dist <= arrive) return this.completeOrder(u);

    // Group arrival: touching a group-mate that already arrived means we're part of the ball.
    if (t.clumpArrive && !o.formation && dist <= idiv(t.clumpMaxDist * FP, 1000)) {
      let touched = false;
      const c = this.unitCell[i];
      const cx = c % this.gw;
      const cy = idiv(c - cx, this.gw);
      for (let y = cy - 1; y <= cy + 1 && !touched; y++) {
        if (y < 0 || y >= this.gh) continue;
        for (let x = cx - 1; x <= cx + 1 && !touched; x++) {
          if (x < 0 || x >= this.gw) continue;
          const cell = y * this.gw + x;
          for (let k = this.cellStart[cell]; k < this.cellStart[cell + 1]; k++) {
            const b = this.hashUnits[this.cellItems[k]];
            if (b === u || b.owner !== u.owner || b.air !== u.air || b.dead) continue;
            if (b.arrivedGroup !== o.group) continue;
            if (b.orders.length > 0 && b.orders[0].group === o.group) continue;
            const ex = b.x - u.x;
            const ey = b.y - u.y;
            const reach = b.radius + u.radius + TOUCH_MARGIN;
            if (ex * ex + ey * ey <= reach * reach) {
              touched = true;
              break;
            }
          }
        }
      }
      if (touched) return this.completeOrder(u);
    }

    // Give up when no progress is being made (blocked by a wall of units, etc.).
    if (dist + (FP >> 4) < u.bestDist) {
      u.bestDist = dist;
      u.stuck = 0;
    } else if (++u.stuck >= t.giveUpTicks) {
      this.completeOrder(u);
    }
  }

  private completeOrder(u: Unit) {
    const first = u.orders[0];
    if (!first) return;
    if (first.mode === MODE_GATHER) this.leaveResource(u);
    const o = u.orders.shift()!;
    u.arrivedGroup = o.group;
    this.releaseOrder(o);
    u.target = 0;
    this.stopChase(u);
    if (o.mode === MODE_PATROL) {
      const back = this.newOrder(MODE_PATROL, o.ox, o.oy, -1, this.nextGroup++);
      back.ox = o.x;
      back.oy = o.y;
      if (!u.air) {
        const g = this.groundGoal(o.ox, o.oy, u.req);
        back.x = g.x;
        back.y = g.y;
        back.tile = g.tile;
      }
      u.orders.push(back);
    }
    if (u.orders.length > 0) {
      const keepArrived = u.arrivedGroup;
      this.beginOrder(u);
      u.arrivedGroup = keepArrived;
      const n = u.orders[0];
      if (n.mode === MODE_GATHER) u.gState = u.carry > 0 ? G_RETURN : G_GO;
    } else {
      u.guardX = u.x;
      u.guardY = u.y;
    }
  }

  // ------------------------------------------------------------- vision

  private updateVision() {
    const { w, h, level } = this.map;
    for (const v of this.vis.values()) v.fill(0);
    for (const u of this.units) {
      if (u.dead) continue;
      const p = this.players.get(u.owner);
      if (!p) continue;
      const k = KINDS[u.kind];
      const r = k.structure && !this.isDone(u) ? Math.min(k.sight, 5) : k.sight;
      if (r <= 0) continue;
      const vis = this.vis.get(p.team)!;
      const cx = fdiv(u.x, FP);
      const cy = fdiv(u.y, FP);
      const ci = clamp(cy, 0, h - 1) * w + clamp(cx, 0, w - 1);
      // High ground rule: ground units can't see up cliffs.
      const eye = u.air ? 255 : level[ci] + 4;
      const d = disc(r);
      for (let i = 0; i < d.length; i += 2) {
        const x = cx + d[i];
        const y = cy + d[i + 1];
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const t = y * w + x;
        if (level[t] <= eye) vis[t] = 1;
      }
    }
    // Watchtowers: a ground unit within 2.5 tiles gives its team the tower's sight.
    for (const t of this.units) {
      if (t.kind !== K_TOWER || t.dead) continue;
      const seen = new Set<number>();
      for (const u of this.units) {
        if (u.dead || u.air || u.owner === NEUTRAL || KINDS[u.kind].structure) continue;
        const p = this.players.get(u.owner);
        if (!p || seen.has(p.team) || this.rectDist(u.x, u.y, t) > FP * 2 + (FP >> 1)) continue;
        seen.add(p.team);
        const vis = this.vis.get(p.team)!;
        const cx = fdiv(t.x, FP);
        const cy = fdiv(t.y, FP);
        const d = disc(KINDS[K_TOWER].sight);
        for (let i = 0; i < d.length; i += 2) {
          const x = cx + d[i];
          const y = cy + d[i + 1];
          if (x >= 0 && y >= 0 && x < w && y < h) vis[y * w + x] = 1;
        }
      }
    }
    for (const [team, v] of this.vis) {
      const e = this.explored.get(team)!;
      for (let i = 0; i < v.length; i++) if (v[i]) e[i] = 1;
    }
  }

  // ------------------------------------------------------------ victory

  private checkDefeat() {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      let has = false;
      for (const u of this.units)
        if (u.owner === p.id && !u.dead && KINDS[u.kind].structure) {
          has = true;
          break;
        }
      if (!has) this.defeat(p.id);
    }
  }

  private defeat(pid: number) {
    const p = this.players.get(pid);
    if (!p || !p.alive) return;
    p.alive = false;
    this.events.push({ e: "defeat", p: pid });
    for (const u of this.units) if (u.owner === pid && !u.dead) this.kill(u, 0);
    this.units = this.units.filter((u) => !u.dead);
    const teams = new Set<number>();
    const all = new Set<number>();
    for (const q of this.players.values()) {
      all.add(q.team);
      if (q.alive) teams.add(q.team);
    }
    if (all.size > 1 && teams.size <= 1) {
      this.gameOver = true;
      this.winner = teams.size ? [...teams][0] : -1;
      this.events.push({ e: "victory", team: this.winner });
    }
  }

  // ----------------------------------------------------------- inspection

  /** 32-bit FNV-1a over everything that matters. Compared between clients to detect desyncs. */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h = Math.imul(h ^ (v | 0), 16777619);
    };
    mix(this.tick);
    mix(this.units.length);
    for (const u of this.units) {
      mix(u.id);
      mix(u.owner);
      mix(u.kind);
      mix(u.x);
      mix(u.y);
      mix(u.vx);
      mix(u.vy);
      mix(u.hp);
      mix(u.cd);
      mix(u.target);
      mix(u.orders.length);
      mix(u.holding ? 1 : 0);
      mix(u.arrivedGroup);
      mix(u.carry);
      mix(u.gState);
      mix(u.progress);
      mix(u.amount);
      mix(u.queue.length);
      if (u.queue.length) mix(u.queue[0].t);
      mix(u.morphTo);
    }
    for (const p of this.players.values()) {
      mix(p.m);
      mix(p.g);
      mix(p.supply);
      mix(p.provided);
      mix(p.up[0] + p.up[1] * 4);
      mix(p.alive ? 1 : 0);
    }
    mix(this.projectiles.length);
    for (const p of this.projectiles) {
      mix(p.x);
      mix(p.y);
    }
    for (const d of TUNE_DEFS) mix(this.tune[d.key]);
    mix(this.rng.state);
    return h >>> 0;
  }

  /** Debug: number of flow fields in use (drops to 0 when all units are idle). */
  get fieldCount(): number {
    return this.fields.size;
  }
}
