import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FP,
  F_FIRE,
  F_GRASS,
  F_WATER,
  KINDS,
  K_CENTER,
  K_CHARMANDER,
  K_CHARMELEON,
  K_EXTRACTOR,
  K_GEYSER,
  K_GYM,
  K_MART,
  K_WORKER,
  K_SHRINE,
  K_SQUIRTLE,
  MODE_ATTACK,
  MODE_ATTACK_UNIT,
  MODE_GATHER,
  type PlayerCommand,
  type Replay,
  ReplayRecorder,
  TY_FIRE,
  TY_GRASS,
  TY_WATER,
  World,
  type WorldOptions,
  typeMult,
  verifyReplay,
} from "../src/sim/index.ts";
import { Bot } from "../src/ai/bot.ts";
import { T, ownIds } from "./helpers.ts";

const melee: WorldOptions = { seed: 99, map: "pallet", players: [1, 2], factions: { 1: F_FIRE, 2: F_WATER } };

function steps(w: World, n: number, cmds: (t: number) => PlayerCommand[] = () => []) {
  for (let i = 0; i < n; i++) w.step(cmds(w.tick + 1));
}

test("starting bases: hall, 12 workers mining, 50 minerals, 12/15 supply", () => {
  const w = new World(melee);
  const p = w.players.get(1)!;
  assert.equal(ownIds(w, 1, K_CENTER).length, 1);
  assert.equal(ownIds(w, 1, K_WORKER).length, 12);
  assert.equal(p.m, 50);
  assert.equal(p.supply, 12);
  assert.equal(w.cap(1), 15);
  for (const id of ownIds(w, 1, K_WORKER)) assert.equal(w.byId.get(id)!.orders[0]?.mode, MODE_GATHER);
});

test("12 workers mine at roughly SC2 rates (600-800 per minute)", () => {
  const w = new World(melee);
  steps(w, 22 * 60 * 2);
  const perMin = w.players.get(1)!.stats.mined / 2;
  assert.ok(perMin > 600 && perMin < 800, `mined ${perMin}/min`);
});

test("worker builds a Poké Mart and a Gym, Gym trains the faction's unit", () => {
  const w = new World({ ...melee, sandbox: false });
  w.players.get(1)!.m = 1000;
  const hall = w.byId.get(ownIds(w, 1, K_CENTER)[0])!;
  const wk = ownIds(w, 1, K_WORKER)[0];
  // Below the hall (main minerals are to the west).
  const htx = hall.tx;
  const hty = hall.ty;
  steps(w, 1, (t) => (t === 1 ? [{ p: 1, c: { t: "build", ids: [wk], kind: K_MART, tx: htx + 1, ty: hty + 8, q: false } }, { p: 1, c: { t: "build", ids: [ownIds(w, 1, K_WORKER)[1]], kind: K_GYM, tx: htx + 7, ty: hty + 1, q: false } }] : []));
  steps(w, 22 * 70);
  const mart = w.units.find((u) => u.kind === K_MART && u.owner === 1);
  const gym = w.units.find((u) => u.kind === K_GYM && u.owner === 1);
  assert.ok(mart && w.isDone(mart), "mart finished");
  assert.ok(gym && w.isDone(gym), "gym finished");
  assert.equal(w.cap(1), 23);
  // The builder stays idle unless told to go back to mining.
  assert.equal(w.byId.get(wk)!.orders.length, 0);
  steps(w, 1, () => [{ p: 1, c: { t: "train", ids: [gym!.id], kind: K_CHARMANDER } }]);
  steps(w, 22 * 20);
  assert.equal(ownIds(w, 1, K_CHARMANDER).length, 1);
  // A Water player's Gym can't make Charmander.
  w.players.get(2)!.m = 1000;
  const before = w.players.get(2)!.m;
  steps(w, 1, () => [{ p: 2, c: { t: "train", ids: [gym!.id], kind: K_CHARMANDER } }]);
  assert.equal(w.players.get(2)!.m, before);
});

test("supply blocks training", () => {
  const w = new World(melee);
  w.players.get(1)!.m = 5000;
  const hall = ownIds(w, 1, K_CENTER)[0];
  const pl = w.players.get(1)!;
  for (let i = 0; i < 5; i++) steps(w, 1, () => [{ p: 1, c: { t: "train", ids: [hall], kind: K_WORKER } }]);
  // All five queue, but only the one in training takes supply.
  assert.equal(w.byId.get(hall)!.queue.length, 5);
  assert.equal(pl.supply, 13);
  // 12 + 3 = 15 = cap: the 4th waits at the front of the queue without progressing.
  steps(w, 22 * 60 * 2);
  const q = w.byId.get(hall)!.queue;
  assert.equal(ownIds(w, 1, K_WORKER).length, 15);
  assert.equal(q.length, 2);
  assert.equal(q[0].t, 0);
  assert.equal(pl.supply, 15);
  // Cancelling a waiting unit refunds minerals but no supply; an empty queue checks supply up front.
  const m = pl.m;
  steps(w, 1, () => [{ p: 1, c: { t: "cancel", id: hall, slot: 1 } }, { p: 1, c: { t: "cancel", id: hall, slot: 0 } }]);
  assert.ok(pl.m - m >= 100 && pl.m - m < 120, `refund ${pl.m - m}`); // plus any mining that tick
  assert.equal(pl.supply, 15);
  steps(w, 1, () => [{ p: 1, c: { t: "train", ids: [hall], kind: K_WORKER } }]);
  assert.equal(w.byId.get(hall)!.queue.length, 0);
});

test("extractor on a geyser yields gas", () => {
  const w = new World(melee);
  w.players.get(1)!.m = 1000;
  const hall = w.byId.get(ownIds(w, 1, K_CENTER)[0])!;
  const g = w.units.filter((u) => u.kind === K_GEYSER).sort((a, b) => Math.hypot(a.x - hall.x, a.y - hall.y) - Math.hypot(b.x - hall.x, b.y - hall.y))[0];
  const ws = ownIds(w, 1, K_WORKER);
  steps(w, 1, () => [{ p: 1, c: { t: "build", ids: [ws[0]], kind: K_EXTRACTOR, tx: g.tx, ty: g.ty, q: false } }]);
  steps(w, 22 * 30);
  const ex = w.units.find((u) => u.kind === K_EXTRACTOR && u.owner === 1)!;
  assert.ok(ex && w.isDone(ex));
  steps(w, 1, () => [{ p: 1, c: { t: "target", ids: ws.slice(1, 4), id: ex.id, q: false, mode: MODE_GATHER } }]);
  steps(w, 22 * 20);
  const g0 = w.players.get(1)!.stats.gas;
  steps(w, 22 * 60);
  const gas = w.players.get(1)!.stats.gas - g0;
  assert.ok(gas > 130 && gas < 200, `gas per minute with 3 workers: ${gas}`);
});

test("type chart", () => {
  assert.equal(typeMult(TY_WATER, KINDS[K_CHARMANDER].types), 150);
  assert.equal(typeMult(TY_FIRE, KINDS[K_SQUIRTLE].types), 70);
  assert.equal(typeMult(TY_GRASS, [TY_WATER]), 150);
  assert.equal(typeMult(TY_FIRE, [TY_GRASS]), 150);
});

test("combat: units auto-acquire, fight and die; water beats fire at equal numbers", () => {
  const w = new World({ seed: 5, map: "lab", players: [1, 2] });
  for (const u of [...w.units]) u.hp = 0; // clear the lab armies
  w.step([]);
  w.spawn(1, K_SQUIRTLE, T(40), T(36), 10);
  w.spawn(2, K_CHARMANDER, T(52), T(36), 10);
  steps(w, 2, (t) => (t === w.tick + 1 ? [{ p: 2, c: { t: "move", ids: ownIds(w, 2), x: T(40), y: T(36), q: false, mode: MODE_ATTACK } }] : []));
  steps(w, 22 * 30);
  const sq = ownIds(w, 1, K_SQUIRTLE).length;
  const ch = ownIds(w, 2, K_CHARMANDER).length;
  assert.equal(ch, 0, `charmanders left: ${ch}`);
  assert.ok(sq > 0, "some squirtles survive");
});

test("evolution needs the shrine, costs resources and changes the kind", () => {
  const w = new World({ seed: 5, map: "lab", players: [1] });
  const id = ownIds(w, 1, K_CHARMANDER)[0];
  const p = w.players.get(1)!;
  const m0 = p.m;
  steps(w, 1, () => [{ p: 1, c: { t: "evolve", ids: [id] } }]);
  assert.equal(w.byId.get(id)!.morphTo, -1, "no shrine yet");
  steps(w, 1, () => [{ p: 1, c: { t: "spawn", kind: K_SHRINE, x: T(30), y: T(60), n: 1 } }]);
  assert.ok(w.hasStructure(1, K_SHRINE));
  steps(w, 1, () => [{ p: 1, c: { t: "evolve", ids: [id] } }]);
  assert.equal(w.byId.get(id)!.morphTo, K_CHARMELEON);
  assert.equal(p.m, m0 - KINDS[K_CHARMANDER].evolve!.m);
  steps(w, KINDS[K_CHARMANDER].evolve!.time + 2);
  assert.equal(w.byId.get(id)!.kind, K_CHARMELEON);
});

test("destroying every structure defeats a player", () => {
  const w = new World(melee);
  for (const u of w.units) if (u.owner === 2 && KINDS[u.kind].structure) u.hp = 0;
  steps(w, 20);
  assert.equal(w.players.get(2)!.alive, false);
  assert.equal(w.gameOver, true);
  assert.equal(w.winner, w.teamOf(1));
  assert.equal(ownIds(w, 2).length, 0);
});

function botGame(opts: WorldOptions, ticks: number) {
  const w = new World(opts);
  const rec = new ReplayRecorder(opts, {});
  const bots = opts.players.map((p) => new Bot(w, p, "hard"));
  for (let t = 1; t <= ticks && !w.gameOver; t++) {
    const cmds: PlayerCommand[] = [];
    for (const b of bots) for (const c of b.think()) cmds.push({ p: b.pid, c });
    w.step(cmds);
    rec.record({ tick: t, cmds }, w);
  }
  return { w, rec };
}

test("bot vs bot: a real game happens and its replay is bit-identical", () => {
  const opts: WorldOptions = { seed: 4242, map: "pallet", players: [1, 2], factions: { 1: F_GRASS, 2: F_FIRE } };
  const { w, rec } = botGame(opts, 22 * 60 * 9);
  const p1 = w.players.get(1)!;
  const p2 = w.players.get(2)!;
  assert.ok(p1.stats.mined > 3000 && p2.stats.mined > 3000, `mined ${p1.stats.mined} / ${p2.stats.mined}`);
  assert.ok(p1.stats.made + p2.stats.made > 40, "units were made");
  assert.ok(p1.stats.killed + p2.stats.killed > 5, "there was fighting");
  const replay = JSON.parse(JSON.stringify(rec.replay)) as Replay;
  const res = verifyReplay(replay);
  assert.equal(res.firstMismatch, -1);
  assert.equal(res.world.hash(), w.hash());
});

test("state stays integer through a whole bot game", () => {
  const { w } = botGame({ seed: 7, map: "pallet", players: [1, 2], factions: { 1: F_WATER, 2: F_GRASS } }, 22 * 60 * 6);
  for (const u of w.units) for (const v of [u.x, u.y, u.vx, u.vy, u.hp]) assert.ok(Number.isSafeInteger(v), `unit ${u.id}: ${v}`);
  for (const p of w.players.values()) for (const v of [p.m, p.g, p.supply]) assert.ok(Number.isSafeInteger(v));
  assert.ok(FP > 0);
});

test("friendly fire: an explicit attack order hits your own units, auto-targeting never does", () => {
  const w = new World({ seed: 5, map: "lab", players: [1] });
  const [a, b] = ownIds(w, 1, K_SQUIRTLE);
  const hp0 = w.byId.get(b)!.hp;
  steps(w, 22 * 3);
  assert.equal(w.byId.get(b)!.hp, hp0, "idle units leave their friends alone");
  steps(w, 1, () => [{ p: 1, c: { t: "target", ids: [a], id: b, q: false, mode: MODE_ATTACK_UNIT } }]);
  steps(w, 22 * 3);
  assert.ok(w.byId.get(b)!.hp < hp0, "the ordered attack landed");
});

test("cancelling refunds production and construction", () => {
  const w = new World(melee);
  const p = w.players.get(1)!;
  p.m = 1000;
  const hall = ownIds(w, 1, K_CENTER)[0];
  steps(w, 1, () => [{ p: 1, c: { t: "train", ids: [hall], kind: K_WORKER } }]);
  assert.equal(p.m, 950);
  steps(w, 1, () => [{ p: 1, c: { t: "cancel", id: hall, slot: 0 } }]);
  assert.equal(p.m, 1000);
  assert.equal(w.byId.get(hall)!.queue.length, 0);
  assert.equal(p.supply, 12);
});
