import { FP } from "../sim/fixed.ts";
import { type Command, MODE_ATTACK, MODE_GATHER, MODE_MOVE } from "../sim/commands.ts";
import {
  FACTION_UNITS,
  KINDS,
  K_CENTER,
  K_ELITE,
  K_EXTRACTOR,
  K_GEYSER,
  K_GYM,
  K_MART,
  K_MINERAL,
  K_PIKACHU,
  K_SHRINE,
  K_TURRET,
  UP_ARMOR,
  UP_ATTACK,
  upgradeCost,
} from "../sim/units.ts";
import { type Unit, type World, G_MINE } from "../sim/world.ts";

/**
 * Computer opponent. It reads the world and returns commands, exactly like a
 * human player's input, so its games replay and stay in sync in multiplayer
 * (only the machine that runs it issues its commands).
 *
 * It knows where enemy buildings are (no scouting), which keeps it simple.
 */

export type Difficulty = "easy" | "medium" | "hard";

interface Base {
  x: number; // hall centre tile
  y: number;
  /** Centre of the resource cluster (tiles). */
  cx: number;
  cy: number;
  minerals: number;
}

const SETTINGS: Record<Difficulty, { every: number; workers: number; gyms: number; attackAt: number; expandAt: number; upgrades: boolean; turrets: number }> = {
  easy: { every: 33, workers: 16, gyms: 1, attackAt: 30, expandAt: 22 * 60 * 6, upgrades: false, turrets: 0 },
  medium: { every: 16, workers: 22, gyms: 2, attackAt: 24, expandAt: 22 * 60 * 3, upgrades: true, turrets: 1 },
  hard: { every: 8, workers: 22, gyms: 3, attackAt: 20, expandAt: 22 * 60 * 2, upgrades: true, turrets: 2 },
};

export class Bot {
  private s: (typeof SETTINGS)[Difficulty];
  private bases: Base[] | null = null;
  private wave = 0;
  private attacking = false;
  private lastAttackOrder = -1000;
  private pendingBuild = new Map<number, number>(); // kind -> tick ordered

  constructor(
    private world: World,
    readonly pid: number,
    readonly difficulty: Difficulty = "medium",
  ) {
    this.s = SETTINGS[difficulty];
  }

  /** Call once per tick; returns this tick's commands (usually none). */
  think(): Command[] {
    const w = this.world;
    const me = w.players.get(this.pid);
    if (!me || !me.alive || w.gameOver) return [];
    if ((w.tick + this.pid * 5) % this.s.every !== 0) return [];
    if (!this.bases) this.bases = this.findBases();
    const out: Command[] = [];
    const mine = w.units.filter((u) => u.owner === this.pid && !u.dead);
    const done = (k: number) => mine.filter((u) => u.kind === k && w.isDone(u));
    const all = (k: number) => mine.filter((u) => u.kind === k);
    const halls = all(K_CENTER);
    const workers = all(K_PIKACHU);
    const army = mine.filter((u) => !KINDS[u.kind].structure && !KINDS[u.kind].worker);
    const gyms = all(K_GYM);
    const pending = (k: number) => (this.pendingBuild.has(k) && w.tick - this.pendingBuild.get(k)! < 22 * 25 ? 1 : 0);
    let m = me.m;
    let g = me.g;
    // Save up for the next base when it's time to expand.
    const time = w.tick;
    const wantExpand = time > this.s.expandAt * Math.max(1, halls.length) && halls.length < 4 && workers.length >= 15 * halls.length && !pending(K_CENTER);
    let reserve = wantExpand ? 400 : 0;
    const spend = (km: number, kg: number, urgent = false) => {
      if (m - (urgent ? 0 : reserve) < km || g < kg) return false;
      m -= km;
      g -= kg;
      return true;
    };

    const tryBuild = (kind: number, urgent = false) => {
      const k = KINDS[kind];
      if (!spend(k.m, k.g, urgent)) return;
      if (!this.build(kind, workers, out)) {
        m += k.m;
        g += k.g;
      }
    };

    // ---- economy
    const wantWorkers = Math.min(70, this.s.workers * Math.max(1, done(K_CENTER).length) + done(K_EXTRACTOR).length * 3);
    for (const h of done(K_CENTER)) {
      if (workers.length < wantWorkers && h.queue.length < 1 && me.supply < w.cap(this.pid) && spend(50, 0, true)) out.push({ t: "train", ids: [h.id], kind: K_PIKACHU });
    }
    this.assignWorkers(workers, out);

    // ---- supply
    const building = (k: number) => all(k).filter((u) => !w.isDone(u)).length + pending(k);
    const production = done(K_CENTER).length + done(K_GYM).length * 2;
    if (w.cap(this.pid) < 200 && w.cap(this.pid) - me.supply < 3 + production * 2 && building(K_MART) < 1 + (me.supply > 60 ? 1 : 0)) {
      tryBuild(K_MART, true);
    }

    // ---- tech and production buildings
    if (gyms.length === 0 && workers.length >= 14 && halls.length > 0 && !pending(K_GYM)) {
      tryBuild(K_GYM);
    } else if (gyms.length < this.s.gyms * Math.max(1, Math.min(2, done(K_CENTER).length)) && workers.length >= 18 && !pending(K_GYM) && m >= 300) {
      tryBuild(K_GYM);
    }
    const extractors = all(K_EXTRACTOR).length;
    if (extractors < Math.min(2 * done(K_CENTER).length, workers.length >= 16 ? (workers.length >= 22 ? 3 : 1) + (time > 22 * 300 ? 1 : 0) : 0) && !pending(K_EXTRACTOR)) {
      if (spend(75, 0) && !this.buildExtractor(workers, out)) m += 75;
    }
    if (done(K_GYM).length > 0 && all(K_SHRINE).length === 0 && time > 22 * 150 && !pending(K_SHRINE) && m >= 150 && g >= 100) {
      tryBuild(K_SHRINE);
    }
    if (done(K_SHRINE).length > 0 && all(K_ELITE).length === 0 && time > 22 * 330 && this.difficulty !== "easy" && !pending(K_ELITE) && m >= 150 && g >= 150) {
      tryBuild(K_ELITE);
    }
    if (done(K_GYM).length > 0 && all(K_TURRET).length < this.s.turrets && time > 22 * 240 && !pending(K_TURRET) && m >= 250) {
      tryBuild(K_TURRET);
    }
    // Expand.
    if (wantExpand && m >= 400) {
      reserve = 0;
      const spot = this.nextBase(halls);
      if (spot) {
        const k = KINDS[K_CENTER];
        const wk = this.freeWorker(workers);
        if (wk && w.placeError(this.pid, K_CENTER, spot.x - 2, spot.y - 2, wk) === null) {
          out.push({ t: "build", ids: [wk.id], kind: K_CENTER, tx: spot.x - (k.w >> 1), ty: spot.y - (k.h >> 1), q: false });
          this.pendingBuild.set(K_CENTER, time);
          spend(400, 0);
        }
      }
    }

    // ---- upgrades
    if (this.s.upgrades) {
      for (const up of [UP_ATTACK, UP_ARMOR]) {
        const lvl = me.up[up] + 1;
        if (me.researching[up] || lvl > 3) continue;
        const c = upgradeCost(lvl);
        const where = [...done(K_SHRINE), ...done(K_ELITE)].filter((b) => b.queue.length === 0);
        if (where.length && w.hasStructure(this.pid, c.requires) && army.length > 8 && spend(c.m, c.g)) out.push({ t: "research", ids: [where[0].id], up });
      }
    }

    // ---- army production
    const unit = FACTION_UNITS[me.faction][0];
    const uk = KINDS[unit];
    for (const gym of done(K_GYM)) {
      if (gym.queue.length >= 2) continue;
      if (me.supply + uk.supply > w.cap(this.pid)) break;
      if (spend(uk.m, uk.g)) out.push({ t: "train", ids: [gym.id], kind: unit });
    }
    // Evolutions: keep roughly a third of the army at each stage once the tech is there.
    const evolvers = army.filter((u) => u.morphTo < 0 && KINDS[u.kind].evolve && !u.engaged && !u.target && u.lastHit < w.tick - 22 * 5);
    let evolved = 0;
    for (const u of evolvers) {
      const e = KINDS[u.kind].evolve!;
      if (!w.hasStructure(this.pid, e.requires)) continue;
      const stage = KINDS[u.kind].stage;
      const higher = army.filter((a) => KINDS[a.kind].stage > stage).length;
      if (higher > army.length * (stage === 1 ? 0.5 : 0.3)) continue;
      if (spend(e.m, e.g)) {
        out.push({ t: "evolve", ids: [u.id] });
        if (++evolved >= 2) break;
      }
    }

    // ---- army control
    this.controlArmy(army, halls, out);
    return out;
  }

  private assignWorkers(workers: Unit[], out: Command[]) {
    const w = this.world;
    const idle = workers.filter((u) => u.orders.length === 0 && !u.hidden);
    // Gas first: 3 per finished extractor.
    const exs = w.units.filter((u) => u.owner === this.pid && u.kind === K_EXTRACTOR && w.isDone(u));
    for (const ex of exs) {
      const on = workers.filter((u) => u.orders[0]?.mode === MODE_GATHER && u.orders[0].target === ex.id).length;
      for (let i = on; i < 3; i++) {
        const wk = idle.pop() ?? this.freeWorker(workers.filter((u) => u.orders[0]?.target !== ex.id));
        if (!wk) break;
        out.push({ t: "target", ids: [wk.id], id: ex.id, q: false, mode: MODE_GATHER });
      }
    }
    for (const u of idle) {
      const hall = w.nearestDropoff(this.pid, u.x, u.y);
      if (!hall) continue;
      const m = this.leastSaturated(hall, workers);
      if (m) out.push({ t: "target", ids: [u.id], id: m.id, q: false, mode: MODE_GATHER });
    }
  }

  private leastSaturated(hall: Unit, workers: Unit[]): Unit | null {
    const w = this.world;
    const halls = w.units.filter((u) => u.owner === this.pid && u.kind === K_CENTER && w.isDone(u));
    let best: Unit | null = null;
    let bestN = Infinity;
    for (const h of [hall, ...halls]) {
      for (const m of w.mineralsNear(h.x, h.y, FP * 10)) {
        const n = workers.filter((u) => u.orders[0]?.target === m.id).length;
        if (n < bestN) {
          best = m;
          bestN = n;
        }
      }
      if (best && bestN < 2) return best;
    }
    return best;
  }

  /** A mining worker that isn't carrying anything (cheapest to pull). */
  private freeWorker(workers: Unit[]): Unit | null {
    let best: Unit | null = null;
    for (const u of workers) {
      if (u.hidden || u.dead) continue;
      const o = u.orders[0];
      if (o && o.mode !== MODE_GATHER) continue;
      if (o && this.world.byId.get(o.target)?.kind !== K_MINERAL) continue;
      if (u.gState === G_MINE) continue;
      if (!best || u.carry < best.carry) best = u;
    }
    return best;
  }

  private build(kind: number, workers: Unit[], out: Command[]): boolean {
    const w = this.world;
    const wk = this.freeWorker(workers);
    if (!wk) return false;
    const halls = w.units.filter((u) => u.owner === this.pid && u.kind === K_CENTER && !u.dead);
    const home = halls[0];
    if (!home) return false;
    const spot = this.findSpot(kind, home, wk);
    if (!spot) return false;
    out.push({ t: "build", ids: [wk.id], kind, tx: spot.x, ty: spot.y, q: false });
    this.pendingBuild.set(kind, w.tick);
    return true;
  }

  private buildExtractor(workers: Unit[], out: Command[]): boolean {
    const w = this.world;
    const halls = w.units.filter((u) => u.owner === this.pid && u.kind === K_CENTER && w.isDone(u));
    for (const h of halls) {
      for (const g of w.units) {
        if (g.kind !== K_GEYSER || g.link || g.amount <= 0) continue;
        if (Math.hypot(g.x - h.x, g.y - h.y) > FP * 10) continue;
        const wk = this.freeWorker(workers);
        if (!wk) return false;
        out.push({ t: "build", ids: [wk.id], kind: K_EXTRACTOR, tx: g.tx, ty: g.ty, q: false });
        this.pendingBuild.set(K_EXTRACTOR, w.tick);
        return true;
      }
    }
    return false;
  }

  /** Spiral out from the hall (away from its minerals) for a free spot with a one-tile gap around it. */
  private findSpot(kind: number, hall: Unit, builder: Unit): { x: number; y: number } | null {
    const w = this.world;
    const k = KINDS[kind];
    const minerals = w.mineralsNear(hall.x, hall.y, FP * 12);
    let ax = 0;
    let ay = 0;
    for (const m of minerals) {
      ax += m.x - hall.x;
      ay += m.y - hall.y;
    }
    const len = Math.hypot(ax, ay) || 1;
    const cx = hall.x / FP - (ax / len) * 7;
    const cy = hall.y / FP - (ay / len) * 7;
    const rng = (this.world.tick * 2654435761 + kind * 97) >>> 0;
    for (let r = 0; r < 18; r++) {
      const n = Math.max(1, r * 8);
      for (let i = 0; i < n; i++) {
        const a = ((i + (rng % n)) / n) * Math.PI * 2;
        const tx = Math.round(cx + Math.cos(a) * r - k.w / 2);
        const ty = Math.round(cy + Math.sin(a) * r - k.h / 2);
        if (w.placeError(this.pid, kind, tx, ty, builder) !== null) continue;
        // Leave a walkable ring so bases don't wall themselves in.
        if (!this.ringFree(tx - 1, ty - 1, k.w + 2, k.h + 2)) continue;
        if (this.nearResource(tx, ty, k.w, k.h)) continue;
        return { x: tx, y: ty };
      }
    }
    return null;
  }

  private ringFree(tx: number, ty: number, fw: number, fh: number): boolean {
    const m = this.world.map;
    for (let y = ty; y < ty + fh; y++)
      for (let x = tx; x < tx + fw; x++) {
        if (x < 0 || y < 0 || x >= m.w || y >= m.h) return false;
        const edge = x === tx || y === ty || x === tx + fw - 1 || y === ty + fh - 1;
        if (edge && m.blocked[y * m.w + x]) return false;
      }
    return true;
  }

  private nearResource(tx: number, ty: number, fw: number, fh: number): boolean {
    for (const u of this.world.units) {
      const k = KINDS[u.kind];
      if (k.resource !== 1 && k.resource !== 2) continue;
      const gx = Math.max(u.tx - (tx + fw), tx - (u.tx + k.w));
      const gy = Math.max(u.ty - (ty + fh), ty - (u.ty + k.h));
      if (Math.max(gx, gy) < 3) return true;
    }
    return false;
  }

  /** Base locations: one per mineral cluster, at the valid hall spot closest to the cluster's resources. */
  private findBases(): Base[] {
    const w = this.world;
    const minerals = w.units.filter((u) => u.kind === K_MINERAL);
    const clusters: Unit[][] = [];
    for (const m of minerals) {
      const c = clusters.find((cl) => cl.some((o) => Math.hypot(o.x - m.x, o.y - m.y) < FP * 7));
      if (c) c.push(m);
      else clusters.push([m]);
    }
    const out: Base[] = [];
    for (const cl of clusters) {
      if (cl.length < 4) continue;
      const geysers = w.units.filter((u) => u.kind === K_GEYSER && cl.some((m) => Math.hypot(m.x - u.x, m.y - u.y) < FP * 9));
      const res = [...cl, ...geysers];
      const cx = Math.round(res.reduce((a, r) => a + r.x, 0) / res.length / FP);
      const cy = Math.round(res.reduce((a, r) => a + r.y, 0) / res.length / FP);
      let best: { x: number; y: number; score: number } | null = null;
      for (let dy = -12; dy <= 12; dy++)
        for (let dx = -12; dx <= 12; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (w.placeError(-1, K_CENTER, x - 2, y - 2, null) === "place") continue;
          // SC2 base layout: every patch about 7 tiles from the hall centre, geysers 7.5.
          const score = res.reduce((a, r) => {
            const d = Math.hypot(r.x / FP - (x + 0.5), r.y / FP - (y + 0.5)) - (r.kind === K_GEYSER ? 7.5 : 7);
            return a + d * d;
          }, 0);
          if (!best || score < best.score) best = { x, y, score };
        }
      const rx = res.reduce((a, r) => a + r.x, 0) / res.length / FP;
      const ry = res.reduce((a, r) => a + r.y, 0) / res.length / FP;
      if (best) out.push({ x: best.x, y: best.y, cx: rx, cy: ry, minerals: cl.length });
    }
    return out;
  }

  private nextBase(halls: Unit[]): Base | null {
    const w = this.world;
    const home = halls[0];
    if (!home || !this.bases) return null;
    const taken = (b: Base) => w.units.some((u) => u.kind === K_CENTER && !u.dead && Math.hypot(u.x / FP - b.cx, u.y / FP - b.cy) < 11);
    const free = this.bases.filter((b) => !taken(b));
    free.sort((a, b) => Math.hypot(a.x - home.x / FP, a.y - home.y / FP) - Math.hypot(b.x - home.x / FP, b.y - home.y / FP));
    return free[0] ?? null;
  }

  private controlArmy(army: Unit[], halls: Unit[], out: Command[]) {
    const w = this.world;
    const ready = army.filter((u) => u.morphTo < 0);
    if (ready.length === 0) return;
    const ids = ready.map((u) => u.id);
    const supply = ready.reduce((a, u) => a + KINDS[u.kind].supply, 0);

    // Defend: enemies near our structures.
    const mine = w.units.filter((u) => u.owner === this.pid && KINDS[u.kind].structure && !u.dead);
    let threat: Unit | null = null;
    for (const e of w.units) {
      if (e.dead || e.owner === 0 || w.allied(e.owner, this.pid) || KINDS[e.kind].structure) continue;
      if (mine.some((s) => Math.hypot(s.x - e.x, s.y - e.y) < FP * 14)) {
        threat = e;
        break;
      }
    }
    if (threat && !this.attacking) {
      if (w.tick - this.lastAttackOrder > 22 * 2) {
        out.push({ t: "move", ids, x: threat.x, y: threat.y, q: false, mode: MODE_ATTACK });
        this.lastAttackOrder = w.tick;
      }
      return;
    }

    const need = this.s.attackAt + this.wave * 10;
    if (!this.attacking && supply >= Math.min(need, 120)) {
      this.attacking = true;
      this.wave++;
    }
    if (this.attacking && supply < Math.max(6, need * 0.3)) this.attacking = false;

    if (this.attacking) {
      if (w.tick - this.lastAttackOrder < 22 * 6) return;
      const target = this.enemyTarget(ready);
      if (target) {
        out.push({ t: "move", ids, x: target.x, y: target.y, q: false, mode: MODE_ATTACK });
        this.lastAttackOrder = w.tick;
      }
      return;
    }
    // Gather idle army in front of the newest base.
    if (w.tick - this.lastAttackOrder < 22 * 10) return;
    const home = halls[halls.length - 1] ?? halls[0];
    if (!home) return;
    const enemy = this.enemyTarget(ready);
    let rx = home.x;
    let ry = home.y;
    if (enemy) {
      const dx = enemy.x - home.x;
      const dy = enemy.y - home.y;
      const d = Math.hypot(dx, dy) || 1;
      rx += (dx / d) * FP * 8;
      ry += (dy / d) * FP * 8;
    }
    const idle = ready.filter((u) => u.orders.length === 0 && Math.hypot(u.x - rx, u.y - ry) > FP * 6);
    if (idle.length) out.push({ t: "move", ids: idle.map((u) => u.id), x: Math.round(rx), y: Math.round(ry), q: false, mode: MODE_MOVE });
    this.lastAttackOrder = w.tick;
  }

  private enemyTarget(army: Unit[]): { x: number; y: number } | null {
    const w = this.world;
    let cx = 0;
    let cy = 0;
    for (const u of army) {
      cx += u.x;
      cy += u.y;
    }
    cx /= army.length;
    cy /= army.length;
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const u of w.units) {
      if (u.dead || u.owner === 0 || w.allied(u.owner, this.pid) || !KINDS[u.kind].structure) continue;
      const d = Math.hypot(u.x - cx, u.y - cy);
      if (d < bestD) {
        best = u;
        bestD = d;
      }
    }
    if (best) return { x: best.x, y: best.y };
    for (const p of w.players.values()) {
      if (w.allied(p.id, this.pid) || !p.alive) continue;
      const s = w.map.starts[p.slot % w.map.starts.length];
      return { x: s.x * FP, y: s.y * FP };
    }
    return null;
  }
}
