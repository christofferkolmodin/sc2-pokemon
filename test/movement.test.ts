import { test } from "node:test";
import assert from "node:assert/strict";
import { FP, MODE_MOVE, type World, isBlockedTile } from "../src/sim/index.ts";
import { T, ownIds, run, tileOf } from "./helpers.ts";

const solo = { seed: 7, map: "lab", players: [1] };

function idle(w: World, ids: number[]) {
  return ids.every((id) => w.byId.get(id)!.orders.length === 0);
}

function centroid(w: World, ids: number[]) {
  let x = 0;
  let y = 0;
  for (const id of ids) {
    x += w.byId.get(id)!.x;
    y += w.byId.get(id)!.y;
  }
  return { x: x / ids.length / FP, y: y / ids.length / FP };
}

test("whole army leaves the main through the ramp and reaches the far side", () => {
  let ids: number[] = [];
  const { world } = run(solo, 22 * 60, (w, t) => {
    if (t === 1) ids = ownIds(w, 1).filter((id) => !w.byId.get(id)!.air);
    return t === 1 ? [{ p: 1, c: { t: "move", ids, x: T(80), y: T(36), q: false, mode: MODE_MOVE } }] : [];
  });
  assert.ok(idle(world, ids), "all units should have arrived (or given up) within 60 s");
  for (const id of ids) {
    const u = world.byId.get(id)!;
    assert.ok(!isBlockedTile(world.map, tileOf(u.x), tileOf(u.y)), `unit ${id} ended inside a wall`);
    const d = Math.hypot(u.x / FP - 80, u.y / FP - 36);
    // Units keep their formation (magic box), so they spread a few tiles around the click.
    assert.ok(d < 10, `unit ${id} (${world.byId.get(id)!.kind}) ended ${d.toFixed(1)} tiles from target`);
  }
  assert.equal(world.fieldCount, 0, "flow fields should be released once everyone is idle");
});

test("units converge into a compact ball when clicked inside the group", () => {
  let ids: number[] = [];
  const { world } = run(solo, 22 * 15, (w, t) => {
    if (t === 1) ids = ownIds(w, 1, 1); // 16 Charmander
    if (t === 1) return [{ p: 1, c: { t: "move", ids, x: T(14), y: T(12), q: false, mode: MODE_MOVE } }];
    return [];
  });
  assert.ok(idle(world, ids));
  const c = centroid(world, ids);
  const spread = Math.max(...ids.map((id) => Math.hypot(world.byId.get(id)!.x / FP - c.x, world.byId.get(id)!.y / FP - c.y)));
  // 16 lings of radius 0.375 packed tight fit in roughly 1.8 tiles radius.
  assert.ok(spread < 2.6, `ball too loose: ${spread.toFixed(2)} tiles`);
});

test("magic box keeps formation when clicking far outside the group", () => {
  let ids: number[] = [];
  let before: Map<number, { x: number; y: number }> = new Map();
  const { world } = run({ seed: 7, map: "lab", players: [1] }, 22 * 25, (w, t) => {
    if (t === 1) {
      ids = ownIds(w, 1, 4); // air: no terrain in the way
      const c = centroid(w, ids);
      before = new Map(ids.map((id) => [id, { x: w.byId.get(id)!.x / FP - c.x, y: w.byId.get(id)!.y / FP - c.y }]));
      return [{ p: 1, c: { t: "move", ids, x: T(60), y: T(50), q: false, mode: MODE_MOVE } }];
    }
    return [];
  });
  const c = centroid(world, ids);
  for (const id of ids) {
    const u = world.byId.get(id)!;
    const off = before.get(id)!;
    const err = Math.hypot(u.x / FP - c.x - off.x, u.y / FP - c.y - off.y);
    assert.ok(err < 1.2, `unit ${id} lost its formation slot by ${err.toFixed(2)} tiles`);
  }
});

test("moving units push idle friendly units out of the way", () => {
  let movers: number[] = [];
  let blockers: number[] = [];
  let start = new Map<number, { x: number; y: number }>();
  const { world } = run(solo, 22 * 20, (w, t) => {
    if (t === 1) {
      movers = ownIds(w, 1, 1);
      blockers = ownIds(w, 1, 0);
      start = new Map(blockers.map((id) => [id, { x: w.byId.get(id)!.x, y: w.byId.get(id)!.y }]));
      const b = centroid(w, blockers);
      const m = centroid(w, movers);
      // Send the lings straight through the idle Squirtle block, out the other side.
      const dx = b.x - m.x;
      const dy = b.y - m.y;
      const len = Math.hypot(dx, dy);
      return [{ p: 1, c: { t: "move", ids: movers, x: T(b.x + (dx / len) * 4), y: T(b.y + (dy / len) * 4), q: false, mode: MODE_MOVE } }];
    }
    return [];
  });
  assert.ok(idle(world, movers));
  const moved = blockers.filter((id) => {
    const s = start.get(id)!;
    const u = world.byId.get(id)!;
    return Math.hypot(u.x - s.x, u.y - s.y) > FP / 4;
  });
  assert.ok(moved.length > 0, "at least some idle units should have been shoved aside");
});

test("hold position units are not pushed", () => {
  let movers: number[] = [];
  let holders: number[] = [];
  let start = new Map<number, { x: number; y: number }>();
  run(solo, 22 * 20, (w, t) => {
    if (t === 1) {
      movers = ownIds(w, 1, 1);
      holders = ownIds(w, 1, 0);
      start = new Map(holders.map((id) => [id, { x: w.byId.get(id)!.x, y: w.byId.get(id)!.y }]));
      const b = centroid(w, holders);
      return [
        { p: 1, c: { t: "hold", ids: holders } },
        { p: 1, c: { t: "move", ids: movers, x: T(b.x), y: T(b.y - 6), q: false, mode: MODE_MOVE } },
      ];
    }
    return [];
  }, (w) => {
    if (w.tick < 2) return;
    for (const id of holders) {
      const s = start.get(id)!;
      const u = w.byId.get(id)!;
      assert.equal(u.x, s.x, `held unit ${id} moved`);
      assert.equal(u.y, s.y, `held unit ${id} moved`);
    }
  });
});

test("shift-queued waypoints are visited in order", () => {
  let id = 0;
  const visited: number[] = [];
  const pts = [
    [16, 6],
    [6, 6],
    [6, 26],
  ];
  run(solo, 22 * 20, (w, t) => {
    if (t === 1) {
      id = ownIds(w, 1, 1)[0];
      return pts.map(([x, y], i) => ({ p: 1, c: { t: "move" as const, ids: [id], x: T(x), y: T(y), q: i > 0, mode: MODE_MOVE } }));
    }
    return [];
  }, (w) => {
    const u = w.byId.get(id);
    if (!u) return;
    pts.forEach(([x, y], i) => {
      if (!visited.includes(i) && Math.hypot(u.x / FP - x, u.y / FP - y) < 0.5) visited.push(i);
    });
  });
  assert.deepEqual(visited, [0, 1, 2]);
});
