import type { PlayerCommand, Turn } from "./commands.ts";
import { World, type WorldOptions } from "./world.ts";

/**
 * A replay is just the world options plus every command and the tick it ran on.
 * Re-running it must reproduce the exact same state, which makes replays both
 * a feature and the main determinism test.
 */
export interface Replay {
  version: 1;
  options: WorldOptions;
  playerNames: Record<number, string>;
  /** Only ticks that had commands: [tick, commands]. */
  turns: [number, PlayerCommand[]][];
  endTick: number;
  /** Periodic state hashes, used to verify playback. [tick, hash] */
  hashes: [number, number][];
}

export const HASH_INTERVAL = 32;

export class ReplayRecorder {
  readonly replay: Replay;
  constructor(options: WorldOptions, playerNames: Record<number, string>) {
    this.replay = { version: 1, options, playerNames, turns: [], endTick: 0, hashes: [] };
  }
  /** Call after world.step(turn.cmds). */
  record(turn: Turn, world: World) {
    if (turn.cmds.length > 0) this.replay.turns.push([turn.tick, turn.cmds]);
    this.replay.endTick = turn.tick;
    if (turn.tick % HASH_INTERVAL === 0) this.replay.hashes.push([turn.tick, world.hash()]);
  }
}

/** Turn source that yields a replay's turns in order. */
export class ReplayCursor {
  private i = 0;
  constructor(readonly replay: Replay) {}
  next(tick: number): Turn | null {
    if (tick > this.replay.endTick) return null;
    const t = this.replay.turns[this.i];
    if (t && t[0] === tick) {
      this.i++;
      return { tick, cmds: t[1] };
    }
    return { tick, cmds: [] };
  }
}

/** Run a replay headless. Returns the final world and the first tick whose hash didn't match (or -1). */
export function verifyReplay(replay: Replay): { world: World; firstMismatch: number } {
  const world = new World(replay.options);
  const cursor = new ReplayCursor(replay);
  const expected = new Map(replay.hashes);
  let firstMismatch = -1;
  for (let tick = 1; tick <= replay.endTick; tick++) {
    const turn = cursor.next(tick)!;
    world.step(turn.cmds);
    const h = expected.get(tick);
    if (h !== undefined && h !== world.hash() && firstMismatch < 0) firstMismatch = tick;
  }
  return { world, firstMismatch };
}
