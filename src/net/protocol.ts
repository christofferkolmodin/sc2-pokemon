import type { Command, PlayerCommand } from "../sim/commands.ts";
import type { WorldOptions } from "../sim/world.ts";

/** Lockstep protocol. JSON over one WebSocket at /ws. */

export type Difficulty = "easy" | "medium" | "hard";

export type ClientMsg =
  /**
   * Join a room. In a game that already started, a player who dropped out gets
   * their seat back; `rejoinFrom` (the last tick this client has) asks for just
   * the missing turns instead of a fresh start, for a reconnect mid-game.
   */
  | { type: "hello"; name: string; room: string; rejoinFrom?: number }
  /** Lobby settings: your faction (anyone), the map and AI slots (host only). */
  | { type: "setup"; faction?: number; map?: string; addAi?: Difficulty; removeAi?: number; aiFaction?: { id: number; faction: number } }
  | { type: "start" }
  /** `as`: the host issues commands for the AI players it runs. */
  | { type: "cmd"; c: Command; as?: number }
  | { type: "hash"; tick: number; h: number }
  | { type: "chat"; text: string }
  /** Minimap ping (alt+click), relayed to allies. */
  | { type: "mping"; x: number; y: number }
  | { type: "ping"; t: number };

export interface LobbyPlayer {
  id: number;
  name: string;
  faction: number;
  /** Set for computer players (run by the host's browser). */
  ai?: Difficulty;
}

export type ServerMsg =
  | { type: "lobby"; room: string; you: number; host: number; players: LobbyPlayer[]; map: string }
  /** `host` runs the computer players listed in `ai`. */
  | { type: "start"; options: WorldOptions; names: Record<number, string>; host: number; ai: { id: number; difficulty: Difficulty }[]; /** Your player id, when rejoining a running game. */ you?: number }
  /** Commands to run at the start of `tick`. Sent for every tick, empty or not. */
  | { type: "turn"; tick: number; cmds: PlayerCommand[] }
  | { type: "desync"; tick: number; hashes: Record<number, number> }
  | { type: "left"; id: number; name: string }
  /** A player who dropped out is back in the game. */
  | { type: "rejoined"; id: number; name: string }
  /** Every turn after `from`, up to and including `upTo` (only non-empty ones listed), for a player rejoining a running game. */
  | { type: "catchup"; from: number; upTo: number; turns: { tick: number; cmds: PlayerCommand[] }[] }
  /** You now run these computer players (the previous host left). */
  | { type: "host"; ai: { id: number; difficulty: Difficulty }[] }
  | { type: "chat"; from: number; name: string; text: string }
  | { type: "mping"; from: number; x: number; y: number }
  | { type: "pong"; t: number }
  | { type: "error"; msg: string };

export const MAX_PLAYERS = 8;
