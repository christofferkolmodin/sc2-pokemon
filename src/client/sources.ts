import type { Command, PlayerCommand, Turn } from "../sim/commands.ts";
import { type Replay, ReplayCursor } from "../sim/replay.ts";
import type { ClientMsg, ServerMsg } from "../net/protocol.ts";

/**
 * Where turns come from. The game loop asks for the turn for the next tick and
 * only advances the sim when one is available, so solo, multiplayer and replays
 * all run through exactly the same code path.
 */
export interface TurnSource {
  readonly kind: "solo" | "net" | "replay";
  /** Turn for `tick`, or null if it hasn't arrived yet. */
  next(tick: number): Turn | null;
  /** How many turns are buffered and ready to run. */
  buffered(): number;
  /** Issue a command as the local player. */
  send(c: Command): void;
  /** Issue a command for a computer player this machine runs. */
  sendAs(p: number, c: Command): void;
  close(): void;
}

/** Solo: commands go straight into the next tick (about one tick, 45 ms, of input delay). */
export class SoloSource implements TurnSource {
  readonly kind = "solo";
  private pending: PlayerCommand[] = [];
  constructor(private me: number) {}
  next(tick: number): Turn {
    const cmds = this.pending;
    this.pending = [];
    return { tick, cmds };
  }
  buffered() {
    return 1;
  }
  send(c: Command) {
    this.pending.push({ p: this.me, c });
  }
  sendAs(p: number, c: Command) {
    this.pending.push({ p, c });
  }
  close() {}
}

export class ReplaySource implements TurnSource {
  readonly kind = "replay";
  private cursor: ReplayCursor;
  private at = 0;
  constructor(readonly replay: Replay) {
    this.cursor = new ReplayCursor(replay);
  }
  next(tick: number): Turn | null {
    const t = this.cursor.next(tick);
    if (t) this.at = tick;
    return t;
  }
  buffered() {
    return this.replay.endTick - this.at;
  }
  send() {}
  sendAs() {}
  close() {}
}

/** Lockstep over WebSocket. Turns arrive from the relay server at 22.4/s. */
export class NetSource implements TurnSource {
  readonly kind = "net";
  private queue: Turn[] = [];
  rtt = 0;
  private pingTimer: ReturnType<typeof setInterval>;
  onDesync: ((tick: number, hashes: Record<number, number>) => void) | null = null;
  onLeft: ((name: string) => void) | null = null;
  onClosed: (() => void) | null = null;
  onChat: ((from: number, name: string, text: string) => void) | null = null;
  onPing: ((from: number, x: number, y: number) => void) | null = null;

  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => this.onMessage(JSON.parse(String(e.data)) as ServerMsg));
    ws.addEventListener("close", () => this.onClosed?.());
    this.pingTimer = setInterval(() => this.raw({ type: "ping", t: performance.now() }), 2000);
  }

  private onMessage(m: ServerMsg) {
    switch (m.type) {
      case "turn":
        this.queue.push({ tick: m.tick, cmds: m.cmds });
        break;
      case "pong":
        this.rtt = performance.now() - m.t;
        break;
      case "desync":
        this.onDesync?.(m.tick, m.hashes);
        break;
      case "left":
        this.onLeft?.(m.name);
        break;
      case "chat":
        this.onChat?.(m.from, m.name, m.text);
        break;
      case "mping":
        this.onPing?.(m.from, m.x, m.y);
        break;
    }
  }

  private raw(m: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  next(tick: number): Turn | null {
    // Drop anything stale (shouldn't happen, but never run a turn twice).
    while (this.queue.length > 0 && this.queue[0].tick < tick) this.queue.shift();
    if (this.queue.length > 0 && this.queue[0].tick === tick) return this.queue.shift()!;
    return null;
  }
  buffered() {
    return this.queue.length;
  }
  send(c: Command) {
    this.raw({ type: "cmd", c });
  }
  sendAs(p: number, c: Command) {
    this.raw({ type: "cmd", c, as: p });
  }
  chat(text: string) {
    this.raw({ type: "chat", text });
  }
  ping(x: number, y: number) {
    this.raw({ type: "mping", x, y });
  }
  sendHash(tick: number, h: number) {
    this.raw({ type: "hash", tick, h });
  }
  close() {
    clearInterval(this.pingTimer);
    this.ws.close();
  }
}
