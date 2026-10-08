/**
 * Commands are the ONLY input to the simulation. In multiplayer, clients send
 * commands to the relay server, which stamps them with a player id and a tick
 * and broadcasts them to everyone. Coordinates are in subunits (see fixed.ts).
 */

export const MODE_MOVE = 0;
export const MODE_ATTACK = 1; // attack-move (behaves like move until combat lands)
export const MODE_PATROL = 2;

export type Command =
  | { t: "move"; ids: number[]; x: number; y: number; q: boolean; mode: number }
  | { t: "stop"; ids: number[] }
  | { t: "hold"; ids: number[] }
  /** Sandbox: spawn n units of a kind for player `owner` (defaults to sender). */
  | { t: "spawn"; kind: number; x: number; y: number; n: number; owner?: number }
  /** Sandbox: change a tuning value for everyone (goes through lockstep, so it stays in sync). */
  | { t: "tune"; key: string; value: number };

export interface PlayerCommand {
  p: number; // player id (stamped by the server, never trusted from the client)
  c: Command;
}

/** A batch of commands that all execute at the start of `tick`. */
export interface Turn {
  tick: number;
  cmds: PlayerCommand[];
}

const MAX_IDS = 500;

function int(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== "number" || !Number.isInteger(v)) return null;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Validate/sanitize untrusted input. Returns null if the command is malformed. */
export function sanitizeCommand(raw: unknown): Command | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const ids = () => {
    if (!Array.isArray(o.ids) || o.ids.length > MAX_IDS) return null;
    const out: number[] = [];
    for (const v of o.ids) {
      const n = int(v, 0, 0x7fffffff);
      if (n === null) return null;
      out.push(n);
    }
    return out;
  };
  const BIG = 1 << 24;
  switch (o.t) {
    case "move": {
      const i = ids();
      const x = int(o.x, 0, BIG);
      const y = int(o.y, 0, BIG);
      const mode = int(o.mode, 0, 2);
      if (!i || x === null || y === null || mode === null) return null;
      return { t: "move", ids: i, x, y, q: o.q === true, mode };
    }
    case "stop":
    case "hold": {
      const i = ids();
      return i ? { t: o.t, ids: i } : null;
    }
    case "spawn": {
      const kind = int(o.kind, 0, 63);
      const x = int(o.x, 0, BIG);
      const y = int(o.y, 0, BIG);
      const n = int(o.n, 1, 50);
      const owner = o.owner === undefined ? undefined : int(o.owner, 0, 7);
      if (kind === null || x === null || y === null || n === null || owner === null) return null;
      return owner === undefined ? { t: "spawn", kind, x, y, n } : { t: "spawn", kind, x, y, n, owner };
    }
    case "tune": {
      const value = int(o.value, -1000000, 1000000);
      if (typeof o.key !== "string" || o.key.length > 32 || value === null) return null;
      return { t: "tune", key: o.key, value };
    }
  }
  return null;
}
