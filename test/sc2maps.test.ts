import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FlowField, K_CENTER, K_MINERAL, K_WORKER, World, isBlockedTile, registerMap } from "../src/sim/index.ts";
import { type MapIndexEntry, type MapJson, mapFromJson } from "../src/maps/load.ts";
import { Bot } from "../src/ai/bot.ts";

/**
 * Checks maps imported from SC2 (tools/import-sc2maps.py). They live in the
 * git-ignored assets-private/ folder, so this is skipped on machines without them.
 */
const dir = join(import.meta.dirname, "..", "assets-private", "maps");
const indexFile = join(dir, "index.json");
const maps: MapIndexEntry[] = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : [];

function load(key: string) {
  const j = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as MapJson;
  const { def } = mapFromJson(j);
  registerMap(def);
  return def;
}

test("imported maps: start bases are on open ground and workers can reach their minerals", { skip: maps.length === 0 && "no imported maps" }, () => {
  for (const m of maps) {
    const def = load(m.key);
    const players = def.starts.map((_, i) => i + 1);
    const w = new World({ seed: 1, map: m.key, players });
    for (const hall of w.units.filter((u) => u.kind === K_CENTER)) {
      for (let y = hall.ty; y < hall.ty + 5; y++)
        for (let x = hall.tx; x < hall.tx + 5; x++) assert.ok(!def.terrain[y * def.w + x], `${m.name}: start hall on blocked terrain at ${x},${y}`);
      assert.ok(w.mineralsNear(hall.x, hall.y, 4096 * 12).length >= 6, `${m.name}: start without minerals`);
    }
    for (let t = 0; t < 22 * 40; t++) w.step([]);
    for (const p of w.players.values()) assert.ok(p.stats.mined > 150, `${m.name}: player ${p.id} mined only ${p.stats.mined} in 40 s`);
    for (const u of w.units)
      if (u.kind === K_WORKER) assert.ok(!isBlockedTile(w.map, Math.floor(u.x / 4096), Math.floor(u.y / 4096)), `${m.name}: worker inside a wall`);
    assert.ok(w.units.some((u) => u.kind === K_MINERAL));
  }
});

test("imported maps: bots play a few minutes on 1v1 ladder maps", { skip: maps.length === 0 && "no imported maps" }, () => {
  const ladder = maps.filter((m) => m.players === 2).slice(0, 4);
  for (const m of ladder) {
    load(m.key);
    const w = new World({ seed: 3, map: m.key, players: [1, 2], factions: { 1: 0, 2: 2 } });
    const bots = [new Bot(w, 1, "hard"), new Bot(w, 2, "hard")];
    for (let t = 0; t < 22 * 60 * 4 && !w.gameOver; t++) w.step(bots.flatMap((b) => b.think().map((c) => ({ p: b.pid, c }))));
    for (const p of w.players.values()) {
      assert.ok(p.stats.mined > 2000, `${m.name}: player ${p.id} mined ${p.stats.mined}`);
      assert.ok(p.stats.made > 10, `${m.name}: player ${p.id} made ${p.stats.made} units`);
    }
  }
});

test("imported maps: every start location and base can be walked to from the first base (ignoring rocks and mineral walls)", { skip: maps.length === 0 && "no imported maps" }, () => {
  const bad: string[] = [];
  for (const m of maps) {
    const def = load(m.key);
    const w = new World({ seed: 1, map: m.key, players: def.starts.map((_, i) => i + 1) });
    const hall = w.units.find((u) => u.kind === K_CENTER)!;
    const start = w.approachTile(hall, hall.x, hall.y + 4096 * 6, 0);
    // Terrain only: mineral walls and destructible rocks may legitimately block a base until cleared.
    const occ = w.map.occ.slice();
    w.map.occ.fill(0);
    for (let i = 0; i < w.map.blocked.length; i++) w.map.blocked[i] = w.map.terrain[i];
    const f = new FlowField(w.map, start, 0, 0);
    w.map.occ.set(occ);
    const reach = (u: (typeof w.units)[number]) => {
      const t = w.approachTile(u, hall.x, hall.y, 0);
      return t >= 0 && f.dist[t] < 0x3fffffff;
    };
    const halls = w.units.filter((u) => u.kind === K_CENTER);
    const minerals = w.units.filter((u) => u.kind === K_MINERAL);
    const lostHalls = halls.filter((u) => !reach(u)).length;
    // Mineral lines: count lines where no patch is reachable (single patches tucked behind others are fine).
    const lines: (typeof minerals)[] = [];
    for (const mm of minerals) {
      const l = lines.find((ln) => ln.some((o) => Math.hypot(o.x - mm.x, o.y - mm.y) < 4096 * 7));
      if (l) l.push(mm);
      else lines.push([mm]);
    }
    // Real bases only (6+ patches); small clusters are often mineral walls.
    const lostLines = lines.filter((ln) => ln.length >= 6 && !ln.some(reach)).length;
    // These old maps have island expansions (ringed by cliffs, air only) by design.
    if (["dig-site", "lava-flow", "temple-of-the-preservers"].includes(m.key) && !lostHalls) continue;
    if (lostHalls || lostLines) bad.push(`${m.name}: ${lostHalls} unreachable starts, ${lostLines}/${lines.length} unreachable mineral lines`);
  }
  assert.deepEqual(bad, []);
});
