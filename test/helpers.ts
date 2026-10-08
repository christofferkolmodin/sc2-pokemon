import { FP, World, type PlayerCommand, type WorldOptions, ReplayRecorder } from "../src/sim/index.ts";

export const T = (tiles: number) => Math.round(tiles * FP);

export function ownIds(w: World, p: number, kind?: number): number[] {
  return w.units.filter((u) => u.owner === p && (kind === undefined || u.kind === kind)).map((u) => u.id);
}

/** Run a world for `ticks` ticks, feeding commands from a schedule. Returns the recorder. */
export function run(
  opts: WorldOptions,
  ticks: number,
  schedule: (w: World, tick: number) => PlayerCommand[],
  onTick?: (w: World) => void,
): { world: World; rec: ReplayRecorder } {
  const world = new World(opts);
  const rec = new ReplayRecorder(opts, {});
  for (let t = 1; t <= ticks; t++) {
    const cmds = schedule(world, t);
    world.step(cmds);
    rec.record({ tick: t, cmds }, world);
    onTick?.(world);
  }
  return { world, rec };
}

export const tileOf = (v: number) => Math.floor(v / FP);
