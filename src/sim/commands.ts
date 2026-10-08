/**
 * Commands are the ONLY input to the simulation. In multiplayer, clients send
 * commands to the relay server, which stamps them with a player id and a tick
 * and broadcasts them to everyone. Coordinates are in subunits (see fixed.ts).
 */

export const MODE_MOVE = 0;
/** Attack-move: move, but fight anything met on the way. */
export const MODE_ATTACK = 1;
export const MODE_PATROL = 2;
/** Attack one specific unit (right-click on an enemy). */
export const MODE_ATTACK_UNIT = 3;
/** Worker: gather from a mineral field or extractor, forever. */
export const MODE_GATHER = 4;
/** Worker: bring carried resources to the nearest Pokémon Center. */
export const MODE_RETURN = 5;
/** Worker: walk to a site and place a structure. */
export const MODE_BUILD = 6;

export type Command =
  | { t: "move"; ids: number[]; x: number; y: number; q: boolean; mode: number }
  /** Smart command on a unit: attack it, gather from it or return cargo to it. */
  | { t: "target"; ids: number[]; id: number; q: boolean; mode: number }
  | { t: "stop"; ids: number[] }
  | { t: "hold"; ids: number[] }
  /** Order one worker (the first usable id) to place a structure with its top-left tile at (tx, ty). */
  | { t: "build"; ids: number[]; kind: number; tx: number; ty: number; q: boolean }
  /** Queue a unit at the least busy of the given structures. */
  | { t: "train"; ids: number[]; kind: number }
  | { t: "research"; ids: number[]; up: number }
  /** Evolve every given unit that can. */
  | { t: "evolve"; ids: number[] }
  /** Cancel: slot >= 0 = queue slot, -1 = construction or evolution in progress. */
  | { t: "cancel"; id: number; slot: number }
  /** Rally point for structures; `id` = unit to rally to (0 = ground). */
  | { t: "rally"; ids: number[]; x: number; y: number; id: number }
  | { t: "surrender" }
  /** Sandbox only: spawn n units of a kind for player `owner` (defaults to sender). */
  | { t: "spawn"; kind: number; x: number; y: number; n: number; owner?: number }
  /** Sandbox only: change a tuning value for everyone (goes through lockstep, so it stays in sync). */
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
  const q = o.q === true;
  switch (o.t) {
    case "move": {
      const i = ids();
      const x = int(o.x, 0, BIG);
      const y = int(o.y, 0, BIG);
      const mode = int(o.mode, 0, 2);
      if (!i || x === null || y === null || mode === null) return null;
      return { t: "move", ids: i, x, y, q, mode };
    }
    case "target": {
      const i = ids();
      const id = int(o.id, 0, 0x7fffffff);
      const mode = int(o.mode, 3, 5);
      if (!i || id === null || mode === null) return null;
      return { t: "target", ids: i, id, q, mode };
    }
    case "stop":
    case "hold":
    case "evolve": {
      const i = ids();
      return i ? { t: o.t, ids: i } : null;
    }
    case "build": {
      const i = ids();
      const kind = int(o.kind, 0, 63);
      const tx = int(o.tx, 0, 4096);
      const ty = int(o.ty, 0, 4096);
      if (!i || kind === null || tx === null || ty === null) return null;
      return { t: "build", ids: i, kind, tx, ty, q };
    }
    case "train": {
      const i = ids();
      const kind = int(o.kind, 0, 63);
      if (!i || kind === null) return null;
      return { t: "train", ids: i, kind };
    }
    case "research": {
      const i = ids();
      const up = int(o.up, 0, 7);
      if (!i || up === null) return null;
      return { t: "research", ids: i, up };
    }
    case "cancel": {
      const id = int(o.id, 0, 0x7fffffff);
      const slot = int(o.slot, -1, 7);
      if (id === null || slot === null) return null;
      return { t: "cancel", id, slot };
    }
    case "rally": {
      const i = ids();
      const x = int(o.x, 0, BIG);
      const y = int(o.y, 0, BIG);
      const id = int(o.id ?? 0, 0, 0x7fffffff);
      if (!i || x === null || y === null || id === null) return null;
      return { t: "rally", ids: i, x, y, id };
    }
    case "surrender":
      return { t: "surrender" };
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
