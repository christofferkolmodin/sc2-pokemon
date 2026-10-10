/**
 * Lockstep relay server + static file host.
 *
 * The server never simulates the game. Each room runs a clock at 22.4 ticks/s;
 * every tick it broadcasts the commands it received since the previous tick.
 * Clients run the deterministic sim on those turns, and report state hashes so
 * the server can flag desyncs. Computer players run in the host's browser,
 * which sends their commands tagged with `as`.
 *
 * Also serves maps imported from SC2 (assets-private/maps, see
 * tools/import-sc2maps.py) at /assets/maps/ and lists them at /api/maps.
 *
 * Usage: npm start   (serves http://<host>:3000, reachable over Tailscale)
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { TICK_MS } from "../sim/fixed.ts";
import { type PlayerCommand, sanitizeCommand } from "../sim/commands.ts";
import { BUILTIN_MAPS } from "../sim/map.ts";
import { FACTION_COUNT } from "../sim/units.ts";
import { type ClientMsg, DIFFICULTIES, type Difficulty, type LobbyPlayer, MAX_PLAYERS, type ServerMsg } from "../net/protocol.ts";
import { Gate, loadPassword } from "./auth.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const ROOT = resolve(import.meta.dirname, "..", "..");
const STATIC_DIR = join(ROOT, "dist", "client");
const ASSET_DIR = join(ROOT, "assets-private");
const PASSWORD = loadPassword(ROOT);
const gate = PASSWORD ? new Gate(PASSWORD) : null;

// ------------------------------------------------------------------ maps

interface MapInfo {
  key: string;
  name: string;
  players: number;
}

function mapList(): MapInfo[] {
  const builtins = BUILTIN_MAPS.map(([key, name, players]) => ({ key, name, players }));
  const idx = join(ASSET_DIR, "maps", "index.json");
  if (!existsSync(idx)) return builtins;
  try {
    return [...builtins, ...(JSON.parse(readFileSync(idx, "utf8")) as MapInfo[])];
  } catch {
    return builtins;
  }
}

// ------------------------------------------------------------------ static

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".ico": "image/x-icon",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

async function serveFile(res: import("node:http").ServerResponse, base: string, path: string) {
  const file = normalize(join(base, path));
  if (!file.startsWith(base)) {
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
}

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    let path = decodeURIComponent(url.pathname);
    if (path === "/robots.txt") {
      // Public on purpose: tells search engines not to crawl or list anything here.
      res.writeHead(200, { "content-type": "text/plain", "x-robots-tag": "noindex" }).end("User-agent: *\nDisallow: /\n");
      return;
    }
    if (gate) {
      if (await gate.handle(req, res, path)) return;
      if (!gate.allowed(req)) return gate.deny(req, res, path);
    }
    if (path === "/api/models") {
      const dir = join(ASSET_DIR, "models");
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(glb|gltf)$/i.test(f)) : [];
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(JSON.stringify(files));
      return;
    }
    if (path === "/api/sounds") {
      const dir = join(ASSET_DIR, "sounds");
      // Subfolders too: cries/latest, cries/legacy (npm run fetch-cries) and advisor/<who>.
      const files = existsSync(dir)
        ? readdirSync(dir, { recursive: true, encoding: "utf8" })
            .map((f) => f.replace(/\\/g, "/"))
            .filter((f) => /\.(mp3|ogg|wav|m4a)$/i.test(f))
        : [];
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(JSON.stringify(files));
      return;
    }
    if (path === "/api/rooms") {
      // Rooms still in the lobby, so friends can join without being told the name.
      const open = [...rooms.values()]
        .filter((r) => (r.started ? r.seats.some((s) => !r.players.some((p) => p.id === s.id)) : r.players.length > 0))
        .map((r) => ({
          code: r.code,
          host: r.players.find((p) => p.id === r.host)?.name ?? r.seats[0]?.name ?? "",
          players: r.players.length + r.ai.length,
          max: Math.min(MAX_PLAYERS, mapPlayers(r.map)),
          map: mapList().find((m) => m.key === r.map)?.name ?? r.map,
          // Running games are listed only so a player who dropped out can get back in.
          inProgress: r.started,
          missing: r.started ? r.seats.filter((s) => !r.players.some((p) => p.id === s.id)).map((s) => s.name) : [],
        }));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(JSON.stringify(open));
      return;
    }
    if (path === "/api/maps") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(JSON.stringify(mapList().filter((m) => !BUILTIN_MAPS.some(([k]) => k === m.key))));
      return;
    }
    if (path.startsWith("/assets/")) {
      const rest = path.slice("/assets/".length);
      // Only maps, models, sounds and lobby pictures are served from the private asset folder.
      if (!/^(maps|models|sounds|img)\//.test(rest)) {
        res.writeHead(404).end();
        return;
      }
      return await serveFile(res, ASSET_DIR, rest);
    }
    // Friendly page addresses; the old file names redirect so existing links keep working.
    if (path === "/viewer.html" || path === "/pokedex/") {
      res.writeHead(301, { location: "/pokedex" + url.search }).end();
      return;
    }
    if (path === "/") path = "/index.html";
    if (path === "/pokedex") path = "/viewer.html";
    await serveFile(res, STATIC_DIR, path);
  } catch {
    res.writeHead(500).end();
  }
});

// ------------------------------------------------------------------- rooms

interface Client {
  ws: WebSocket;
  id: number;
  name: string;
  faction: number;
  room: Room | null;
}

interface AiSlot {
  id: number;
  name: string;
  faction: number;
  difficulty: Difficulty;
}

interface Room {
  code: string;
  players: Client[];
  ai: AiSlot[];
  host: number;
  map: string;
  started: boolean;
  tick: number;
  t0: number;
  timer: ReturnType<typeof setInterval> | null;
  pending: PlayerCommand[];
  /** tick -> (player id -> hash) */
  hashes: Map<number, Map<number, number>>;
  activeIds: number[];
  /** Human seats at the start, so a player who drops out can take theirs back. */
  seats: { id: number; name: string; faction: number }[];
  /** Every non-empty turn so far, to fast-forward a rejoining player. */
  log: { tick: number; cmds: PlayerCommand[] }[];
  /** The start message, resent to rejoining players. */
  startMsg: Extract<ServerMsg, { type: "start" }> | null;
  /** Closes a started room nobody is in any more. */
  closeTimer: ReturnType<typeof setTimeout> | null;
}

/** How long a running game waits (paused) for someone to come back before it's closed. */
const EMPTY_ROOM_GRACE_MS = 10 * 60 * 1000;

const rooms = new Map<string, Room>();

function send(c: Client, msg: ServerMsg) {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: ServerMsg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
}

function lobbyState(room: Room) {
  const players: LobbyPlayer[] = [
    ...room.players.map((p) => ({ id: p.id, name: p.name, faction: p.faction })),
    ...room.ai.map((a) => ({ id: a.id, name: a.name, faction: a.faction, ai: a.difficulty })),
  ].sort((a, b) => a.id - b.id);
  for (const p of room.players) send(p, { type: "lobby", room: room.code, you: p.id, host: room.host, players, map: room.map });
}

function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[^\p{L}\p{N} _\-.]/gu, "").trim().slice(0, 16) : "";
  return s || "Trainer";
}

function cleanRoom(v: unknown): string {
  const s = typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16) : "";
  return s || "lobby";
}

function freeId(room: Room): number {
  const used = new Set([...room.players.map((p) => p.id), ...room.ai.map((a) => a.id)]);
  let id = 1;
  while (used.has(id)) id++;
  return id;
}

function mapPlayers(key: string): number {
  return mapList().find((m) => m.key === key)?.players ?? 2;
}

function join_(c: Client, code: string) {
  let room = rooms.get(code);
  if (!room) {
    room = { code, players: [], ai: [], host: 0, map: "pallet", started: false, tick: 0, t0: 0, timer: null, pending: [], hashes: new Map(), activeIds: [], seats: [], log: [], startMsg: null, closeTimer: null };
    rooms.set(code, room);
  }
  if (room.started) return rejoin(c, room);
  if (room.players.length + room.ai.length >= MAX_PLAYERS) return send(c, { type: "error", msg: `Room is full (max ${MAX_PLAYERS}).` });
  // Player ids double as unit owner ids in the sim. Reuse the lowest free one.
  c.id = freeId(room);
  c.room = room;
  room.players.push(c);
  if (!room.host) room.host = c.id;
  lobbyState(room);
}

function onSetup(c: Client, room: Room, m: Extract<ClientMsg, { type: "setup" }>) {
  if (room.started) return;
  const isHost = room.host === c.id;
  if (Number.isInteger(m.faction) && m.faction! >= 0 && m.faction! < FACTION_COUNT) c.faction = m.faction!;
  if (isHost && typeof m.map === "string" && mapList().some((x) => x.key === m.map)) room.map = m.map;
  if (isHost && m.addAi && DIFFICULTIES.includes(m.addAi)) {
    if (room.players.length + room.ai.length < Math.min(MAX_PLAYERS, mapPlayers(room.map))) {
      const id = freeId(room);
      const faction = Math.floor(Math.random() * FACTION_COUNT);
      room.ai.push({ id, name: `Computer ${id}`, faction, difficulty: m.addAi });
    }
  }
  if (isHost && Number.isInteger(m.removeAi)) room.ai = room.ai.filter((a) => a.id !== m.removeAi);
  lobbyState(room);
}

function startGame(room: Room) {
  const total = room.players.length + room.ai.length;
  if (room.map !== "lab" && total > mapPlayers(room.map)) {
    for (const p of room.players) send(p, { type: "error", msg: `Too many players for this map (${mapPlayers(room.map)} max).` });
    return;
  }
  room.started = true;
  room.players.sort((a, b) => a.id - b.id);
  room.activeIds = room.players.map((p) => p.id);
  const ids = [...room.players.map((p) => p.id), ...room.ai.map((a) => a.id)].sort((a, b) => a - b);
  const names: Record<number, string> = {};
  const factions: Record<number, number> = {};
  for (const p of room.players) {
    names[p.id] = p.name;
    factions[p.id] = p.faction;
  }
  for (const a of room.ai) {
    names[a.id] = a.name;
    factions[a.id] = a.faction;
  }
  const lab = room.map === "lab";
  room.seats = room.players.map((p) => ({ id: p.id, name: p.name, faction: p.faction }));
  room.log = [];
  room.startMsg = {
    type: "start",
    options: {
      seed: (Math.random() * 0x7fffffff) | 0,
      map: room.map,
      players: ids,
      factions,
      mode: lab ? "lab" : "melee",
      dummyOpponent: lab && ids.length === 1,
    },
    names,
    host: room.host,
    ai: room.ai.map((a) => ({ id: a.id, difficulty: a.difficulty })),
  };
  broadcast(room, room.startMsg);
  room.tick = 0;
  runClock(room);
  console.log(`[${room.code}] started on ${room.map} with ${ids.map((id) => names[id]).join(", ")}`);
}

/** Drift-free clock: emits as many turns as wall time says we owe, from the current tick on. */
function runClock(room: Room) {
  room.t0 = performance.now() - room.tick * TICK_MS;
  room.timer = setInterval(() => {
    const due = Math.floor((performance.now() - room.t0) / TICK_MS);
    while (room.tick < due) {
      room.tick++;
      const cmds = room.pending;
      room.pending = [];
      if (cmds.length) room.log.push({ tick: room.tick, cmds });
      broadcast(room, { type: "turn", tick: room.tick, cmds });
    }
  }, 4);
}

function closeRoom(room: Room) {
  if (room.timer) clearInterval(room.timer);
  if (room.closeTimer) clearTimeout(room.closeTimer);
  rooms.delete(room.code);
  console.log(`[${room.code}] closed`);
}

/** The computer players are run by the host's browser; tell a new host to take them over. */
function handOverAi(room: Room) {
  const host = room.players.find((p) => p.id === room.host);
  if (host && room.ai.length) send(host, { type: "host", ai: room.ai.map((a) => ({ id: a.id, difficulty: a.difficulty })) });
}

function leave(c: Client) {
  const room = c.room;
  if (!room) return;
  room.players = room.players.filter((p) => p !== c);
  c.room = null;
  if (room.players.length === 0) {
    if (!room.started) return closeRoom(room);
    // Nobody left in a running game: pause it and wait a while for someone to come back.
    if (room.timer) clearInterval(room.timer);
    room.timer = null;
    room.activeIds = [];
    room.closeTimer = setTimeout(() => closeRoom(room), EMPTY_ROOM_GRACE_MS);
    console.log(`[${room.code}] everyone left; paused at tick ${room.tick}, waiting for a rejoin`);
    return;
  }
  const wasHost = room.host === c.id;
  if (wasHost) room.host = room.players[0].id;
  if (room.started) {
    room.activeIds = room.activeIds.filter((id) => id !== c.id);
    broadcast(room, { type: "left", id: c.id, name: c.name });
    if (wasHost) handOverAi(room);
  } else lobbyState(room);
}

/**
 * Joining a game that already started: a player who dropped out (same name, or
 * the only free seat) gets their seat back and is fast-forwarded through every
 * turn so far. Anyone else is turned away.
 */
function rejoin(c: Client, room: Room, rejoinFrom?: number) {
  const free = room.seats.filter((s) => !room.players.some((p) => p.id === s.id));
  const seat = free.find((s) => s.name.toLowerCase() === c.name.toLowerCase()) ?? (free.length === 1 ? free[0] : undefined);
  if (!seat || !room.startMsg) return send(c, { type: "error", msg: "That game has already started." });
  c.id = seat.id;
  c.name = seat.name;
  c.faction = seat.faction;
  c.room = room;
  room.players.push(c);
  if (!room.activeIds.includes(c.id)) room.activeIds.push(c.id);
  if (room.closeTimer) clearTimeout(room.closeTimer);
  room.closeTimer = null;
  // Nobody running the computer players any more (host gone): this player takes over.
  const hostHere = room.players.some((p) => p.id === room.host && p !== c);
  if (!hostHere) room.host = c.id;
  if (rejoinFrom === undefined) send(c, { ...room.startMsg, host: room.host, you: c.id });
  else if (room.host === c.id) handOverAi(room);
  const from = rejoinFrom ?? 0;
  send(c, { type: "catchup", from, upTo: room.tick, turns: room.log.filter((t) => t.tick > from) });
  for (const p of room.players) if (p !== c) send(p, { type: "rejoined", id: c.id, name: c.name });
  if (!room.timer) runClock(room);
  console.log(`[${room.code}] ${c.name} rejoined at tick ${room.tick}`);
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

const wss = new WebSocketServer({ server: http, path: "/ws", verifyClient: (info: { req: import("node:http").IncomingMessage }) => !gate || gate.allowed(info.req) });

wss.on("connection", (ws) => {
  const c: Client = { ws, id: 0, name: "Trainer", faction: 0, room: null };
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
        if (Number.isInteger(msg.rejoinFrom) && rooms.get(cleanRoom(msg.room))?.started) {
          rejoin(c, rooms.get(cleanRoom(msg.room))!, Math.max(0, msg.rejoinFrom!));
          break;
        }
        join_(c, cleanRoom(msg.room));
        break;
      case "setup":
        if (c.room) onSetup(c, c.room, msg);
        break;
      case "start":
        if (c.room && !c.room.started && c.room.host === c.id) startGame(c.room);
        break;
      case "cmd": {
        const room = c.room;
        if (!room?.started) return;
        const cmd = sanitizeCommand(msg.c);
        if (!cmd) return;
        // Only the host may speak for computer players, and only for those.
        let p = c.id;
        if (msg.as !== undefined) {
          if (room.host !== c.id || !room.ai.some((a) => a.id === msg.as)) return;
          p = msg.as;
        }
        room.pending.push({ p, c: cmd });
        break;
      }
      case "hash":
        if (c.room?.started) onHash(c.room, c, msg.tick, msg.h);
        break;
      case "chat": {
        const text = typeof msg.text === "string" ? msg.text.slice(0, 200) : "";
        if (c.room && text.trim()) broadcast(c.room, { type: "chat", from: c.id, name: c.name, text });
        break;
      }
      case "mping":
        if (c.room?.started && Number.isFinite(msg.x) && Number.isFinite(msg.y)) broadcast(c.room, { type: "mping", from: c.id, x: msg.x, y: msg.y });
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
  console.log(gate ? "  password required for visitors (localhost skips it)" : "  no password set (GAME_PASSWORD or .game-password): open to anyone who can reach it");
  const imported = mapList().length - BUILTIN_MAPS.length;
  if (imported > 0) console.log(`  ${imported} imported SC2 maps available`);
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const tag = a.address.startsWith("100.") ? "  <- Tailscale, share this with friends" : "";
      console.log(`  ${name}: http://${a.address}:${PORT}${tag}`);
    }
  }
});
