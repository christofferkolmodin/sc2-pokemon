import { FP, abs, clamp, fdiv, idiv, isqrt, pct } from "./fixed.ts";
import { type GameMap, clearanceFor, isBlockedAt, isBlockedTile, makeMap } from "./map.ts";
import { FlowField, clearPath, nearestPassableTile, steerTarget } from "./flowfield.ts";
import { type Command, MODE_PATROL, type PlayerCommand } from "./commands.ts";
import { KINDS } from "./units.ts";
import { Prng } from "./prng.ts";
import { TUNE_DEFS, type Tuning, defaultTuning, tuneDef } from "./tuning.ts";

export interface Order {
  mode: number;
  /** This unit's own goal (differs from the shared target when keeping formation). */
  x: number;
  y: number;
  /** Shared flow field toward the clicked target; null for air units (they fly straight). */
  field: FlowField | null;
  /** Units given the same command share a group id; used for SC2-style group arrival. */
  group: number;
  /** Keeping formation (magic box): each unit heads for its own slot, so no group arrival. */
  formation: boolean;
  /** Patrol: the point to return to. */
  ox: number;
  oy: number;
}

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
}

export interface WorldOptions {
  seed: number;
  map: string;
  /** Player ids in slot order. Slot i starts at map.starts[i]. */
  players: number[];
  /** Solo lab: add an idle neutral-ish opponent army in the middle to bump into. */
  dummyOpponent?: boolean;
}

const MAX_UNITS = 800;
const TOUCH_MARGIN = FP >> 3;
const CELL = FP * 4; // spatial hash cell: larger than the biggest unit diameter

// Deterministic fallback push directions when two units sit exactly on top of each other.
const JITTER_X = [1000, 707, 0, -707, -1000, -707, 0, 707];
const JITTER_Y = [0, 707, 1000, 707, 0, -707, -1000, -707];

export class World {
  readonly map: GameMap;
  readonly opts: WorldOptions;
  tick = 0;
  units: Unit[] = [];
  readonly byId = new Map<number, Unit>();
  tune: Tuning = defaultTuning();
  rng: Prng;
  private nextId = 1;
  private nextGroup = 1;
  private fields = new Map<number, FlowField>();
  private wp = { x: 0, y: 0 };

  // Spatial hash scratch arrays (reused every tick, no per-tick allocation).
  private gw: number;
  private gh: number;
  private cellStart: Int32Array;
  private cellCount: Int32Array;
  private cellItems: Int32Array = new Int32Array(MAX_UNITS);
  private unitCell: Int32Array = new Int32Array(MAX_UNITS);

  constructor(opts: WorldOptions) {
    this.opts = opts;
    this.map = makeMap(opts.map);
    this.rng = new Prng(opts.seed);
    this.gw = idiv(this.map.w * FP + CELL - 1, CELL);
    this.gh = idiv(this.map.h * FP + CELL - 1, CELL);
    this.cellStart = new Int32Array(this.gw * this.gh + 1);
    this.cellCount = new Int32Array(this.gw * this.gh);
    this.setupScenario();
  }

  private setupScenario() {
    const army: [number, number][] = [
      [0, 12],
      [1, 16],
      [2, 8],
      [3, 2],
      [4, 8],
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
      this.spawn(dummy, 2, cx - 8 * FP, cy, 8);
      this.spawn(dummy, 0, cx + 8 * FP, cy, 12);
    }
  }

  // ---------------------------------------------------------------- units

  spawn(owner: number, kind: number, x: number, y: number, n: number) {
    const k = KINDS[kind];
    if (!k) return;
    const spacing = k.radius * 2 + (FP >> 4);
    let placed = 0;
    for (let ring = 0; ring < 40 && placed < n; ring++) {
      for (let gy = -ring; gy <= ring && placed < n; gy++) {
        for (let gx = -ring; gx <= ring && placed < n; gx++) {
          if (abs(gx) !== ring && abs(gy) !== ring) continue;
          const px = x + gx * spacing;
          const py = y + gy * spacing;
          if (!k.air && this.discBlocked(px, py, k.radius)) continue;
          if (px < FP || py < FP || px > (this.map.w - 1) * FP || py > (this.map.h - 1) * FP) continue;
          if (this.units.length >= MAX_UNITS) return;
          this.addUnit(owner, kind, px, py);
          placed++;
        }
      }
    }
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
    };
    this.units.push(u);
    this.byId.set(u.id, u);
    return u;
  }

  // --------------------------------------------------------------- orders

  private acquireField(tile: number, req: number): FlowField {
    const key = tile * 4 + (req === 0 ? 0 : req <= 500 ? 1 : req <= 750 ? 2 : 3);
    let f = this.fields.get(key);
    if (!f) {
      f = new FlowField(this.map, tile, req, key);
      this.fields.set(key, f);
    }
    f.refs++;
    return f;
  }

  private releaseOrder(o: Order) {
    const f = o.field;
    if (!f) return;
    f.refs--;
    if (f.refs <= 0) this.fields.delete(f.key);
    o.field = null;
  }

  private clearOrders(u: Unit) {
    for (const o of u.orders) this.releaseOrder(o);
    u.orders.length = 0;
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
      if (u && u.owner === p) out.push(u);
    }
    return out;
  }

  private clampToMap(v: number, size: number): number {
    return clamp(v, FP, (size - 1) * FP - 1);
  }

  /** Pathing goal for ground units: the target, or the nearest passable tile centre if it is in a wall or too tight. */
  private groundGoal(x: number, y: number, req: number): { x: number; y: number; tile: number } {
    const tx = fdiv(x, FP);
    const ty = fdiv(y, FP);
    const tile = nearestPassableTile(this.map, tx, ty, req);
    if (tile === ty * this.map.w + tx) return { x, y, tile };
    const gx = tile % this.map.w;
    const gy = idiv(tile - gx, this.map.w);
    return { x: gx * FP + (FP >> 1), y: gy * FP + (FP >> 1), tile };
  }

  private applyMove(p: number, c: Extract<Command, { t: "move" }>) {
    const units = this.ownedUnits(p, c.ids);
    if (units.length === 0) return;
    const tx = this.clampToMap(c.x, this.map.w);
    const ty = this.clampToMap(c.y, this.map.h);
    const g = this.groundGoal(tx, ty, 0);
    const goals = new Map<number, { x: number; y: number; tile: number }>([[0, g]]);
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
      u.orders.push({
        mode: c.mode,
        x: gx,
        y: gy,
        field: u.air ? null : this.acquireField(ug.tile, u.req),
        group,
        formation: slot,
        ox: sx,
        oy: sy,
      });
      if (u.orders.length === 1) this.beginOrder(u);
    }
  }

  /** Where the unit will be when its current queue finishes (for shift-queue and patrol). */
  private queueEnd(u: Unit, queued: boolean): [number, number] {
    if (queued && u.orders.length > 0) {
      const last = u.orders[u.orders.length - 1];
      return [last.x, last.y];
    }
    return [u.x, u.y];
  }

  applyCommand(pc: PlayerCommand) {
    const { p, c } = pc;
    switch (c.t) {
      case "move":
        this.applyMove(p, c);
        break;
      case "stop":
      case "hold":
        for (const u of this.ownedUnits(p, c.ids)) {
          this.clearOrders(u);
          u.holding = c.t === "hold";
        }
        break;
      case "spawn":
        this.spawn(c.owner ?? p, c.kind, c.x, c.y, c.n);
        break;
      case "tune": {
        const d = tuneDef(c.key);
        if (d) this.tune[d.key] = clamp(c.value, d.min, d.max);
        break;
      }
    }
  }

  // ----------------------------------------------------------------- tick

  /** Advance one simulation tick. `cmds` are the commands scheduled for this tick. */
  step(cmds: PlayerCommand[]) {
    this.tick++;
    for (const pc of cmds) this.applyCommand(pc);
    const units = this.units;
    for (const u of units) {
      u.px = u.x;
      u.py = u.y;
    }
    for (const u of units) this.steer(u);
    this.collide();
    for (const u of units) {
      if (u.air) {
        u.x = this.clampToMap(u.x, this.map.w);
        u.y = this.clampToMap(u.y, this.map.h);
      } else this.pushOutOfTerrain(u);
    }
    this.buildHash();
    for (let i = 0; i < units.length; i++) if (units[i].orders.length > 0) this.checkArrival(units[i], i);
  }

  private steer(u: Unit) {
    const k = KINDS[u.kind];
    const t = this.tune;
    const maxSpeed = Math.max(1, pct(k.speed, t.speedPct));
    const accel = Math.max(1, pct(k.accel, t.accelPct));
    let dvx = 0;
    let dvy = 0;
    const o = u.orders[0];
    if (o) {
      // Pick a steering waypoint (direct if the goal is in sight, else follow the flow field).
      if (o.field === null) {
        u.wpx = o.x;
        u.wpy = o.y;
      } else {
        const wdx = u.wpx - u.x;
        const wdy = u.wpy - u.y;
        const nearWp = wdx * wdx + wdy * wdy <= u.radius * u.radius;
        if (u.wpTick < 0 || nearWp || (this.tick + u.id) % t.repathTicks === 0) {
          if (clearPath(this.map, u.x, u.y, o.x, o.y, u.radius)) {
            u.wpx = o.x;
            u.wpy = o.y;
          } else if (steerTarget(this.map, o.field, u.x, u.y, u.radius, this.wp)) {
            u.wpx = this.wp.x;
            u.wpy = this.wp.y;
          } else {
            u.wpx = o.x;
            u.wpy = o.y;
          }
          u.wpTick = this.tick;
        }
      }
      const dx = u.wpx - u.x;
      const dy = u.wpy - u.y;
      const d = isqrt(dx * dx + dy * dy);
      const gx = o.x - u.x;
      const gy = o.y - u.y;
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
    const n = this.units.length;
    const counts = this.cellCount;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const u = this.units[i];
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

  private collide() {
    const iters = this.tune.collisionIters;
    const n = this.units.length;
    for (let it = 0; it < iters; it++) {
      this.buildHash();
      for (let i = 0; i < n; i++) {
        const a = this.units[i];
        this.forNeighbours(i, (j) => {
          if (j <= i) return;
          const b = this.units[j];
          if (a.air !== b.air) return;
          if (a.air) this.separateAir(a, b);
          else this.separateGround(a, b);
        });
      }
    }
  }

  /** How readily `u` yields when overlapping `other` (0 = immovable). */
  private yieldWeight(u: Unit, other: Unit): number {
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
    if (a.orders.length > 0 || b.orders.length > 0) return;
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
            const b = this.units[this.cellItems[k]];
            if (b === u || b.owner !== u.owner || b.air !== u.air) continue;
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
    const o = u.orders.shift()!;
    u.arrivedGroup = o.group;
    this.releaseOrder(o);
    if (o.mode === MODE_PATROL) {
      const back: Order = {
        mode: MODE_PATROL,
        x: o.ox,
        y: o.oy,
        field: null,
        group: this.nextGroup++,
        formation: false,
        ox: o.x,
        oy: o.y,
      };
      if (!u.air) {
        const g = this.groundGoal(o.ox, o.oy, u.req);
        back.x = g.x;
        back.y = g.y;
        back.field = this.acquireField(g.tile, u.req);
      }
      u.orders.push(back);
    }
    if (u.orders.length > 0) {
      const keepArrived = u.arrivedGroup;
      this.beginOrder(u);
      u.arrivedGroup = keepArrived;
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
      mix(u.x);
      mix(u.y);
      mix(u.vx);
      mix(u.vy);
      mix(u.orders.length);
      mix(u.holding ? 1 : 0);
      mix(u.arrivedGroup);
    }
    for (const d of TUNE_DEFS) mix(this.tune[d.key]);
    mix(this.rng.state);
    return h >>> 0;
  }

  /** Debug: number of cached flow fields (should drop to 0 when all units are idle). */
  get fieldCount(): number {
    return this.fields.size;
  }
}
