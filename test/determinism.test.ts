import { test } from "node:test";
import assert from "node:assert/strict";
import { MODE_ATTACK, MODE_MOVE, MODE_PATROL, type PlayerCommand, type WorldOptions, isqrt, verifyReplay } from "../src/sim/index.ts";
import { T, ownIds, run } from "./helpers.ts";

const opts: WorldOptions = { seed: 1234, map: "lab", players: [1, 2], dummyOpponent: true };

// A busy scripted game: big moves through chokes, shift-queues, patrols, spawns, tuning changes.
function script(w: import("../src/sim/index.ts").World, t: number): PlayerCommand[] {
  const out: PlayerCommand[] = [];
  if (t === 5) out.push({ p: 1, c: { t: "move", ids: ownIds(w, 1), x: T(80), y: T(40), q: false, mode: MODE_MOVE } });
  if (t === 8) out.push({ p: 2, c: { t: "move", ids: ownIds(w, 2), x: T(15), y: T(30), q: false, mode: MODE_ATTACK } });
  if (t === 200) out.push({ p: 1, c: { t: "move", ids: ownIds(w, 1, 1), x: T(44.5), y: T(5), q: true, mode: MODE_MOVE } });
  if (t === 220) out.push({ p: 2, c: { t: "spawn", kind: 0, x: T(48), y: T(60), n: 20 } });
  if (t === 300) out.push({ p: 1, c: { t: "tune", key: "accelPct", value: 40 } });
  if (t === 320) out.push({ p: 2, c: { t: "move", ids: ownIds(w, 2, 4), x: T(10), y: T(10), q: false, mode: MODE_PATROL } });
  if (t === 400) out.push({ p: 1, c: { t: "hold", ids: ownIds(w, 1, 2) } });
  if (t === 500) out.push({ p: 2, c: { t: "move", ids: ownIds(w, 2), x: T(47.5), y: T(35.5), q: false, mode: MODE_MOVE } });
  // Commands for units the player doesn't own must be ignored.
  if (t === 510) out.push({ p: 1, c: { t: "stop", ids: ownIds(w, 2) } });
  return out;
}

test("isqrt is exact", () => {
  for (let i = 0; i < 20000; i++) {
    const n = i * i + (i % 7);
    assert.equal(isqrt(n), i);
  }
  for (const n of [0, 1, 2, 3, 4, 2 ** 40, 2 ** 40 - 1, 2 ** 51 + 12345]) {
    const r = isqrt(n);
    assert.ok(r * r <= n && (r + 1) * (r + 1) > n, `isqrt(${n})`);
  }
});

test("same commands produce the same state", () => {
  const a = run(opts, 900, script);
  const b = run(opts, 900, script);
  assert.equal(a.world.hash(), b.world.hash());
  assert.deepEqual(a.rec.replay.hashes, b.rec.replay.hashes);
});

test("replay reproduces the game exactly (also after a JSON round trip)", () => {
  const { world, rec } = run(opts, 900, script);
  const replay = JSON.parse(JSON.stringify(rec.replay));
  const res = verifyReplay(replay);
  assert.equal(res.firstMismatch, -1);
  assert.equal(res.world.hash(), world.hash());
});

test("simulation state stays integer", () => {
  run(opts, 600, script, (w) => {
    for (const u of w.units) {
      for (const v of [u.x, u.y, u.vx, u.vy, u.px, u.py]) {
        if (!Number.isSafeInteger(v)) assert.fail(`non-integer state on unit ${u.id} at tick ${w.tick}: ${v}`);
      }
    }
  });
});

test("different seeds or commands diverge (hash is actually sensitive)", () => {
  const a = run(opts, 50, script);
  const b = run(opts, 50, (w, t) => (t === 5 ? [{ p: 1, c: { t: "move", ids: ownIds(w, 1), x: T(80), y: T(41), q: false, mode: MODE_MOVE } }] : []));
  assert.notEqual(a.world.hash(), b.world.hash());
});
