/**
 * Lockstep relay server + static file host.
 *
 * The server never simulates the game. Each room runs a clock at 22.4 ticks/s;
 * every tick it broadcasts the commands it received since the previous tick.
 * Clients run the deterministic sim on those turns, and report state hashes so
 * the server can flag desyncs.
 *
 * Usage: npm start   (serves http://<host>:3000, reachable over Tailscale)
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { TICK_MS } from "../sim/fixed.ts";
import { type PlayerCommand, sanitizeCommand } from "../sim/commands.ts";
import { type ClientMsg, type LobbyPlayer, MAX_PLAYERS, type ServerMsg } from "../net/protocol.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const STATIC_DIR = resolve(import.meta.dirname, "..", "..", "dist", "client");

// ------------------------------------------------------------------ static

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    const file = normalize(join(STATIC_DIR, path));
    if (!file.startsWith(STATIC_DIR)) {
      res.writeHead(403).end();
      return;
    }
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found. Did you run `npm run build`?");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(await readFile(file));
  } catch {
    res.writeHead(500).end();
  }
});

// ------------------------------------------------------------------- rooms

interface Client {
  ws: WebSocket;
  id: number;
  name: string;
  room: Room | null;
}

interface Room {
  code: string;
  players: Client[];
  host: number;
  started: boolean;
  tick: number;
  t0: number;
  timer: ReturnType<typeof setInterval> | null;
  pending: PlayerCommand[];
  /** tick -> (player id -> hash) */
  hashes: Map<number, Map<number, number>>;
  activeIds: number[];
}

const rooms = new Map<string, Room>();

function send(c: Client, msg: ServerMsg) {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: ServerMsg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
}

function lobbyState(room: Room) {
  const players: LobbyPlayer[] = room.players.map((p) => ({ id: p.id, name: p.name }));
  for (const p of room.players) send(p, { type: "lobby", room: room.code, you: p.id, host: room.host, players });
}

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[^\p{L}\p{N} _\-.]/gu, "").trim().slice(0, 16) : "";
  return s || "Trainer";
}

function cleanRoom(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16) : "";
  return s || "lobby";
}

function join_(c: Client, code: string) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      players: [],
      host: 0,
      started: false,
      tick: 0,
      t0: 0,
      timer: null,
      pending: [],
      hashes: new Map(),
      activeIds: [],
    };
    rooms.set(code, room);
  }
  if (room.started) return send(c, { type: "error", msg: "That game has already started." });
  if (room.players.length >= MAX_PLAYERS) return send(c, { type: "error", msg: `Room is full (max ${MAX_PLAYERS}).` });
  // Player ids double as unit owner ids in the sim. Reuse the lowest free one.
  const used = new Set(room.players.map((p) => p.id));
  let id = 1;
  while (used.has(id)) id++;
  c.id = id;
  c.room = room;
  room.players.push(c);
  if (!room.host) room.host = id;
  lobbyState(room);
}

function startGame(room: Room) {
  room.started = true;
  room.players.sort((a, b) => a.id - b.id);
  room.activeIds = room.players.map((p) => p.id);
  const names: Record<number, string> = {};
  for (const p of room.players) names[p.id] = p.name;
  broadcast(room, {
    type: "start",
    options: {
      seed: (Math.random() * 0x7fffffff) | 0,
      map: "lab",
      players: room.activeIds,
      dummyOpponent: room.players.length === 1,
    },
    names,
  });
  room.t0 = performance.now();
  room.tick = 0;
  // Drift-free clock: emit as many turns as wall time says we owe.
  room.timer = setInterval(() => {
    const due = Math.floor((performance.now() - room.t0) / TICK_MS);
    while (room.tick < due) {
      room.tick++;
      const cmds = room.pending;
      room.pending = [];
      broadcast(room, { type: "turn", tick: room.tick, cmds });
    }
  }, 4);
  console.log(`[${room.code}] started with ${room.players.map((p) => p.name).join(", ")}`);
}

function leave(c: Client) {
  const room = c.room;
  if (!room) return;
  room.players = room.players.filter((p) => p !== c);
  c.room = null;
  if (room.players.length === 0) {
    if (room.timer) clearInterval(room.timer);
    rooms.delete(room.code);
    console.log(`[${room.code}] closed`);
    return;
  }
  if (room.host === c.id) room.host = room.players[0].id;
  if (room.started) {
    room.activeIds = room.activeIds.filter((id) => id !== c.id);
    broadcast(room, { type: "left", id: c.id, name: c.name });
  } else lobbyState(room);
}

function onHash(room: Room, c: Client, tick: number, h: number) {
  if (!Number.isInteger(tick) || !Number.isInteger(h) || tick > room.tick) return;
  let m = room.hashes.get(tick);
  if (!m) {
    m = new Map();
    room.hashes.set(tick, m);
  }
  m.set(c.id, h);
  if (room.activeIds.every((id) => m!.has(id))) {
    const values = new Set(m.values());
    if (values.size > 1) {
      const hashes: Record<number, number> = {};
      for (const [id, v] of m) hashes[id] = v;
      broadcast(room, { type: "desync", tick, hashes });
      console.warn(`[${room.code}] DESYNC at tick ${tick}`, hashes);
    }
    room.hashes.delete(tick);
  }
  // Drop stale entries (e.g. from players who left mid-report).
  for (const t of room.hashes.keys()) if (t < tick - 2000) room.hashes.delete(t);
}

const wss = new WebSocketServer({ server: http, path: "/ws" });

wss.on("connection", (ws) => {
  const c: Client = { ws, id: 0, name: "Trainer", room: null };
  ws.on("message", (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg?.type) {
      case "hello":
        if (c.room) return;
        c.name = cleanName(msg.name);
        join_(c, cleanRoom(msg.room));
        break;
      case "start":
        if (c.room && !c.room.started && c.room.host === c.id) startGame(c.room);
        break;
      case "cmd": {
        if (!c.room?.started) return;
        const cmd = sanitizeCommand(msg.c);
        if (cmd) c.room.pending.push({ p: c.id, c: cmd });
        break;
      }
      case "hash":
        if (c.room?.started) onHash(c.room, c, msg.tick, msg.h);
        break;
      case "ping":
        send(c, { type: "pong", t: typeof msg.t === "number" ? msg.t : 0 });
        break;
    }
  });
  ws.on("close", () => leave(c));
});

http.listen(PORT, HOST, () => {
  console.log(`SC2 Pokémon server on http://localhost:${PORT}`);
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const tag = a.address.startsWith("100.") ? "  <- Tailscale, share this with friends" : "";
      console.log(`  ${name}: http://${a.address}:${PORT}${tag}`);
    }
  }
});
