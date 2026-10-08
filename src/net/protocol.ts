import type { Command, PlayerCommand } from "../sim/commands.ts";
import type { WorldOptions } from "../sim/world.ts";

/** Lockstep protocol. JSON over one WebSocket at /ws. */

export type ClientMsg =
  | { type: "hello"; name: string; room: string }
  | { type: "start" }
  | { type: "cmd"; c: Command }
  | { type: "hash"; tick: number; h: number }
  | { type: "ping"; t: number };

export interface LobbyPlayer {
  id: number;
  name: string;
}

export type ServerMsg =
  | { type: "lobby"; room: string; you: number; host: number; players: LobbyPlayer[] }
  | { type: "start"; options: WorldOptions; names: Record<number, string> }
  /** Commands to run at the start of `tick`. Sent for every tick, empty or not. */
  | { type: "turn"; tick: number; cmds: PlayerCommand[] }
  | { type: "desync"; tick: number; hashes: Record<number, number> }
  | { type: "left"; id: number; name: string }
  | { type: "pong"; t: number }
  | { type: "error"; msg: string };

export const MAX_PLAYERS = 4;
