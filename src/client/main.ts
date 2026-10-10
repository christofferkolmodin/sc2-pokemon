import { DIFFICULTY_NAMES, type Difficulty, type LobbyPlayer, type ServerMsg } from "../net/protocol.ts";
import type { Replay } from "../sim/replay.ts";
import { BUILTIN_MAPS, hasMap, makeMap, registerMap } from "../sim/map.ts";
import { FACTION_COUNT, FACTION_NAMES } from "../sim/units.ts";
import { type MapIndexEntry, type MapJson, type RenderData, mapFromJson } from "../maps/load.ts";
import { Game, type GameSetup } from "./game.ts";
import { GltfModels } from "./render/gltf.ts";
import { NetSource, ReplaySource, SoloSource } from "./sources.ts";
import { controlsHtml } from "./controls.ts";
import { teamColor } from "./style.ts";
import { builtinMapPicture } from "./lobbyArt.ts";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const lobby = $("#lobby");
const gameRoot = $("#game");
const nameInput = $<HTMLInputElement>("#name");
const roomInput = $<HTMLInputElement>("#room");
const err = $("#lobby-error");
const loading = $("#loading");

$("#controls-list").innerHTML = controlsHtml();

function store(key: string, value?: string): string {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

let errTimer = 0;
function showError(msg: string) {
  err.textContent = msg;
  clearTimeout(errTimer);
  if (msg) errTimer = window.setTimeout(() => (err.textContent = ""), 7000);
}

// Controls reference lives in a dialog.
const controlsDialog = $<HTMLDialogElement>("#controls-dialog");
$("#btn-controls").onclick = () => controlsDialog.showModal();
controlsDialog.addEventListener("click", (e) => {
  // Close on the X or a click on the backdrop.
  if (e.target === controlsDialog || (e.target as HTMLElement).closest("[data-close]")) controlsDialog.close();
});

const trainerName = () => nameInput.value.trim() || "Trainer";

// ------------------------------------------------------------ step 1: name

nameInput.value = store("sc2poke.name");
nameInput.addEventListener("change", () => store("sc2poke.name", nameInput.value.trim()));

// --------------------------------------------------------- step 2: faction

/** What each faction plays like, its evolution line and its worker (lobby text only). */
const FACTION_INFO: { name: string; color: string; style: string; line: string[]; worker: string }[] = [
  { name: "Fire", color: "var(--fire)", style: "Fast and aggressive. Swarm early, then take to the skies with Charizard.", line: ["Charmander", "Charmeleon", "Charizard"], worker: "Growlithe" },
  { name: "Water", color: "var(--water)", style: "Ranged and steady. Hold the line, then shell them with Hydro Pump.", line: ["Squirtle", "Wartortle", "Blastoise"], worker: "Psyduck" },
  { name: "Grass", color: "var(--grass)", style: "Tough and patient. Outlast every fight and finish with Solar Beam.", line: ["Bulbasaur", "Ivysaur", "Venusaur"], worker: "Oddish" },
  { name: "Lightning", color: "var(--electric)", style: "Quick and shocking. Hit and run, and every stage can hit air.", line: ["Pichu", "Pikachu", "Raichu"], worker: "Voltorb" },
];

let faction = Number(store("sc2poke.faction") || "0");
function showFaction(sel: string, f: number) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`${sel} button`)) {
    b.classList.toggle("on", Number(b.dataset.f) === f);
    b.setAttribute("aria-checked", String(Number(b.dataset.f) === f));
  }
  if (sel !== "#factions") return;
  const info = FACTION_INFO[f];
  $("#faction-info").innerHTML = info
    ? `<div class="ttl" style="--fc:${info.color}"><i></i>${info.name}</div><p>${info.style}</p><div class="lb-evo">${info.line.map((n) => `<span>${n}</span>`).join("<em>›</em>")}<span class="wk">Worker: ${info.worker}</span></div>`
    : `<div class="ttl" style="--fc:var(--random)"><i></i>Random</div><p>A different faction every game. Good for keeping things fresh.</p>`;
}
showFaction("#factions", faction);
$("#factions").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b) return;
  faction = Number(b.dataset.f);
  store("sc2poke.faction", String(faction));
  showFaction("#factions", faction);
});
const pickFaction = (f: number) => (f >= 0 ? f : Math.floor(Math.random() * FACTION_COUNT));

// ----------------------------------------------------------------- sound
// Saved to the same keys as the in-game menu; picking one plays a preview.

const STARTERS = ["charmander", "squirtle", "bulbasaur", "pichu"];
/** A new key when anime voices became the default, so everyone starts on them once. */
const CRY_KEY = "sc2poke.crySet";
let soundFiles: Promise<string[]> | null = null;
const listSounds = () =>
  (soundFiles ??= fetch("/api/sounds")
    .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
    .catch(() => []));
let preview: HTMLAudioElement | null = null;
/** `gain` roughly matches the in-game levelling: the raw cry files are far louder than voices. */
function playPreview(file: string, gain = 1) {
  preview?.pause();
  preview = new window.Audio(`/assets/sounds/${file.split("/").map(encodeURIComponent).join("/")}`);
  preview.volume = Math.min(1, (gain * Number(store("sc2poke.volume") || "50")) / 100);
  void preview.play().catch(() => {});
}

async function showSound(previewWhat?: "cries" | "advisor") {
  const cries = store(CRY_KEY) || "anime";
  const advisor = store("sc2poke.advisor") || "professor";
  for (const b of document.querySelectorAll<HTMLElement>("#lobby-cries button")) b.classList.toggle("on", b.dataset.v === cries);
  for (const b of document.querySelectorAll<HTMLElement>("#lobby-advisor button")) b.classList.toggle("on", b.dataset.v === advisor);
  const files = await listSounds();
  const hasCries = files.some((f) => f.startsWith(`cries/${cries}/`));
  const lines = files.filter((f) => f.startsWith(`advisor/${advisor}/minerals`));
  const about: Record<string, [string, string]> = {
    latest: ["Remastered cries from the recent games.", "npm run fetch-cries"],
    legacy: ["The original Game Boy cries.", "npm run fetch-cries"],
    anime: ["Pokémon say their names, like in the anime.", "npm run fetch-anime-cries"],
  };
  const [text, cmd] = about[cries] ?? about.latest;
  $("#sound-help").textContent = [
    hasCries ? text : `Cries not downloaded yet (${cmd}).`,
    lines.length ? "" : "The advisor uses your browser's voice until lines are recorded (npm run gen-advisor).",
  ].join(" ");
  const starter = STARTERS[faction] ?? "pikachu";
  if (previewWhat === "cries" && cries === "anime") {
    const takes = files.filter((f) => f.startsWith(`cries/anime/${starter}/`));
    if (takes.length) playPreview(takes[Math.floor(Math.random() * takes.length)], 0.5);
  } else if (previewWhat === "cries" && hasCries) playPreview(`cries/${cries}/${starter}.ogg`, 0.2);
  if (previewWhat === "advisor" && lines.length) playPreview(lines[0]);
}
void showSound();
for (const [sel, key] of [["#lobby-cries", "cries"], ["#lobby-advisor", "advisor"]] as const) {
  $(sel).addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
    if (!b) return;
    store(key === "cries" ? CRY_KEY : `sc2poke.${key}`, b.dataset.v!);
    void showSound(key);
  });
}

// ------------------------------------------------------------ step 3: mode

type Mode = "ai" | "friends" | "lab" | "replay";
const params = new URLSearchParams(location.search);
let mode: Mode = params.has("room") ? "friends" : ((store("sc2poke.mode") as Mode) || "ai");
function showMode(m: Mode) {
  mode = m;
  store("sc2poke.mode", m);
  for (const b of document.querySelectorAll<HTMLElement>("#modes [data-mode]")) {
    b.classList.toggle("on", b.dataset.mode === m);
    b.setAttribute("aria-selected", String(b.dataset.mode === m));
  }
  for (const p of document.querySelectorAll<HTMLElement>(".lb-panel")) p.classList.toggle("on", p.dataset.panel === m);
}
$("#modes").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("[data-mode]") as HTMLElement | null;
  if (!b) return;
  showMode(b.dataset.mode as Mode);
  if (mode === "friends") void refreshRooms();
});
showMode(mode);

// ------------------------------------------------------------------ maps

interface MapChoice {
  key: string;
  name: string;
  players: number;
  w: number;
  h: number;
  imported: boolean;
}

let maps: MapChoice[] = BUILTIN_MAPS.filter(([k]) => k !== "lab").map(([key, name, players]) => {
  const m = makeMap(key);
  return { key, name, players, w: m.w, h: m.h, imported: false };
});

/** Searchable map list with a preview. Read-only for room guests (the host picks). */
class MapPicker {
  private list: HTMLElement;
  private search: HTMLInputElement;
  private preview: HTMLElement;
  selected = "";
  minPlayers = 1;
  readonly = false;

  constructor(
    private el: HTMLElement,
    private onPick: (key: string) => void,
  ) {
    el.innerHTML = `<div class="lb-maplist"><input type="search" placeholder="Search maps…" aria-label="Search maps"><div class="lb-mapitems"></div></div><div class="lb-mappreview"></div>`;
    this.search = el.querySelector("input")!;
    this.list = el.querySelector(".lb-mapitems")!;
    this.preview = el.querySelector(".lb-mappreview")!;
    this.search.addEventListener("input", () => this.render());
    this.list.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("[data-key]") as HTMLButtonElement | null;
      if (!b || b.disabled || this.readonly) return;
      this.select(b.dataset.key!);
      this.onPick(this.selected);
    });
  }

  select(key: string) {
    this.selected = maps.some((m) => m.key === key) ? key : maps[0].key;
    this.render();
  }

  render() {
    this.el.classList.toggle("readonly", this.readonly);
    const q = this.search.value.trim().toLowerCase();
    const shown = maps.filter((m) => !q || m.name.toLowerCase().includes(q) || m.key === this.selected);
    const item = (m: MapChoice) =>
      `<button class="lb-mapitem${m.key === this.selected ? " on" : ""}" data-key="${m.key}" ${m.players < this.minPlayers ? "disabled title='Not enough start locations'" : ""}><span>${escapeHtml(m.name)}</span><small>${m.players}P</small></button>`;
    const builtin = shown.filter((m) => !m.imported);
    const imported = shown.filter((m) => m.imported);
    this.list.innerHTML =
      (builtin.length ? `<div class="lb-mapgroup">Built-in</div>${builtin.map(item).join("")}` : "") +
      (imported.length ? `<div class="lb-mapgroup">From StarCraft II</div>${imported.map(item).join("")}` : "") +
      (shown.length ? "" : `<div class="lb-mapempty">No maps match “${escapeHtml(q)}”</div>`);
    this.list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    const m = maps.find((x) => x.key === this.selected);
    if (!m) return;
    const src = m.imported ? `/assets/maps/${encodeURIComponent(m.key)}.png` : builtinMapPicture(m.key);
    this.preview.innerHTML = `<img src="${src}" alt="Overview of ${escapeHtml(m.name)}"><b>${escapeHtml(m.name)}</b><span>${m.players} players · ${m.w}×${m.h}</span><span>${m.imported ? "StarCraft II ladder map" : "Built into the game"}</span>`;
  }
}

const soloPicker = new MapPicker($('[data-picker="solo"]'), (key) => {
  store("sc2poke.map", key);
  updateAiCount();
});
const roomPicker = new MapPicker($('[data-picker="room"]'), (key) => setup({ map: key }));

async function loadMapList() {
  try {
    const r = await fetch("/api/maps");
    if (r.ok) {
      const list = (await r.json()) as MapIndexEntry[];
      maps = [...maps, ...list.map((m) => ({ key: m.key, name: m.name, players: m.players, w: m.w, h: m.h, imported: true }))];
    }
  } catch {
    /* no server-side maps */
  }
  soloPicker.select(store("sc2poke.map") || "pallet");
  updateAiCount();
}
void loadMapList();

/** Load an imported map (JSON + minimap image) and register it with the sim. Built-ins need nothing. */
async function loadMap(key: string): Promise<{ render: RenderData; minimap: HTMLImageElement | null }> {
  const empty: RenderData = { heights: null, doodads: [] };
  if (BUILTIN_MAPS.some(([k]) => k === key)) return { render: empty, minimap: null };
  const r = await fetch(`/assets/maps/${encodeURIComponent(key)}.json`);
  if (!r.ok) throw new Error(`the map "${key}" isn't available on this server`);
  const { def, render } = mapFromJson((await r.json()) as MapJson, "/assets/maps/");
  registerMap(def);
  let img: HTMLImageElement | null = null;
  if (render.minimap) {
    const im = new Image();
    img = await new Promise<HTMLImageElement | null>((resolve) => {
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = render.minimap!;
    });
  }
  return { render, minimap: img };
}

// ------------------------------------------------------------ start a game

let models: GltfModels | null = null;

async function startGame(setup: Omit<GameSetup, "root" | "render" | "minimap" | "models">) {
  showError("");
  $("#loading-text").textContent = "Loading the map…";
  loading.hidden = false;
  try {
    if (!models) {
      models = new GltfModels();
      await models.loadAll();
    }
    const m = await loadMap(setup.options.map);
    if (!hasMap(setup.options.map)) throw new Error("the map failed to load");
    $("#loading-text").textContent = "Building the world…";
    await new Promise((r) => setTimeout(r, 20)); // let the text paint before the heavy work
    lobby.hidden = true;
    gameRoot.hidden = false;
    const game = new Game({ ...setup, root: gameRoot, render: m.render, minimap: m.minimap, models });
    (window as unknown as { sc2: Game }).sc2 = game; // handy from the dev console
  } catch (x) {
    lobby.hidden = false;
    gameRoot.hidden = true;
    showError(`Couldn't start the game: ${(x as Error).message}`);
    console.error(x);
  } finally {
    loading.hidden = true;
  }
}

// --------------------------------------------------------- vs computer

let aiCount = Number(store("sc2poke.aicount") || "1");
let difficulty = (store("sc2poke.diff") as Difficulty) || "medium";
if (!(difficulty in DIFFICULTY_NAMES)) difficulty = "medium";
const DIFF_HELP: Record<Difficulty, string> = {
  supereasy: "Barely builds and only sends tiny attacks. For your very first games.",
  easy: "Slow builds and small attacks. Good for learning.",
  medium: "Expands, evolves and attacks in waves.",
  hard: "Fast economy, upgrades and big armies.",
};
function showDiff() {
  for (const b of document.querySelectorAll<HTMLElement>("#ai-diff button")) b.classList.toggle("on", b.dataset.d === difficulty);
  $("#ai-diff-help").textContent = DIFF_HELP[difficulty];
}
showDiff();
$("#ai-diff").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLElement | null;
  if (!b) return;
  difficulty = b.dataset.d as Difficulty;
  store("sc2poke.diff", difficulty);
  showDiff();
});

/** Opponent choices depend on how many start locations the map has. */
function updateAiCount() {
  const map = maps.find((m) => m.key === soloPicker.selected) ?? maps[0];
  const max = Math.max(1, map.players - 1);
  const shown = Math.min(aiCount, max);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#ai-count button")) {
    b.disabled = Number(b.dataset.n) > max;
    b.title = b.disabled ? `${map.name} only has ${map.players} start locations` : "";
    b.classList.toggle("on", Number(b.dataset.n) === shown);
  }
  $("#ai-count-help").textContent = max === 1 ? "This map is 1v1." : shown === 1 ? "A 1v1 duel." : `Free-for-all: everyone against everyone.`;
}
$("#ai-count").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b || b.disabled) return;
  aiCount = Number(b.dataset.n);
  store("sc2poke.aicount", String(aiCount));
  updateAiCount();
});

$("#btn-ai").onclick = () => {
  store("sc2poke.name", nameInput.value.trim());
  const map = maps.find((m) => m.key === soloPicker.selected) ?? maps[0];
  const count = Math.max(1, Math.min(map.players - 1, aiCount));
  const players = Array.from({ length: count + 1 }, (_, i) => i + 1);
  const factions: Record<number, number> = { 1: pickFaction(faction) };
  const names: Record<number, string> = { 1: trainerName() };
  for (const p of players.slice(1)) {
    factions[p] = Math.floor(Math.random() * FACTION_COUNT);
    names[p] = `${FACTION_NAMES[factions[p]]} AI (${DIFFICULTY_NAMES[difficulty].toLowerCase()})`;
  }
  const seed = (Math.random() * 0x7fffffff) | 0;
  void startGame({
    source: new SoloSource(1),
    options: { seed, map: map.key, players, factions, mode: "melee" },
    me: 1,
    names,
    bots: players.slice(1).map((id) => ({ id, difficulty })),
  });
};

// --------------------------------------------------------- practice lab

$("#btn-solo").onclick = () => {
  store("sc2poke.name", nameInput.value.trim());
  const seed = (Math.random() * 0x7fffffff) | 0;
  void startGame({
    source: new SoloSource(1),
    options: { seed, map: "lab", players: [1], dummyOpponent: true, factions: { 1: pickFaction(faction) } },
    me: 1,
    names: { 1: trainerName(), 7: "Dummy" },
    bots: [],
  });
};

// ---------------------------------------------------------------- replays

async function openReplay(file: File | undefined) {
  if (!file) return;
  try {
    const replay = JSON.parse(await file.text()) as Replay;
    if (replay.version !== 1 || !replay.options) throw new Error("that file isn't a PokéCraft replay");
    void startGame({ source: new ReplaySource(replay), options: replay.options, me: -1, names: replay.playerNames, bots: [] });
  } catch (x) {
    showError(`Couldn't open the replay: ${(x as Error).message}`);
  }
}
$<HTMLInputElement>("#replay-file").onchange = (e) => void openReplay((e.target as HTMLInputElement).files?.[0]);
const drop = $("#replay-drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  void openReplay(e.dataTransfer?.files[0]);
});

// ------------------------------------------------------------ multiplayer

/** The server's room-name rule, so what you type is exactly the room you join. */
const cleanRoom = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 16);
roomInput.value = cleanRoom(params.get("room") ?? store("sc2poke.room"));
roomInput.addEventListener("input", () => {
  const at = roomInput.selectionStart ?? roomInput.value.length;
  const before = roomInput.value;
  const clean = cleanRoom(before);
  if (clean === before) return;
  roomInput.value = clean;
  // Keep the caret where it was, minus the characters that were dropped.
  const pos = cleanRoom(before.slice(0, at)).length;
  roomInput.setSelectionRange(pos, pos);
});
let ws: WebSocket | null = null;
let myId = 0;
let roomPlayers: LobbyPlayer[] = [];

function setup(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "setup", ...msg }));
}

$("#room-factions").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b) return;
  faction = Number(b.dataset.f);
  store("sc2poke.faction", String(faction));
  showFaction("#factions", faction);
  setup({ faction });
});
$("#btn-add-ai").onclick = () => setup({ addAi: $<HTMLSelectElement>("#room-ai-diff").value });
$("#room-players").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("[data-kick]") as HTMLElement | null;
  if (b) setup({ removeAi: Number(b.dataset.kick) });
});
const linkInput = $<HTMLInputElement>("#room-link");
linkInput.addEventListener("focus", () => linkInput.select());
$("#btn-copy").onclick = async () => {
  const btn = $("#btn-copy");
  const label = btn.querySelector("span")!;
  try {
    await navigator.clipboard.writeText(linkInput.value);
    label.textContent = "Copied";
    btn.classList.add("done");
  } catch {
    linkInput.focus();
    label.textContent = "Press Ctrl+C";
  }
  setTimeout(() => {
    label.textContent = "Copy invite";
    btn.classList.remove("done");
  }, 1800);
};

function joinRoom() {
  roomInput.value = cleanRoom(roomInput.value);
  // No name: make up a fresh room ("pika-482") so creating a room is one click.
  if (!roomInput.value) {
    const words = ["pika", "char", "squirt", "bulba", "volt", "psy", "oddish", "growl"];
    roomInput.value = `${words[Math.floor(Math.random() * words.length)]}-${100 + Math.floor(Math.random() * 900)}`;
  }
  const room = roomInput.value;
  showError("");
  store("sc2poke.name", nameInput.value.trim());
  store("sc2poke.room", room);
  ws?.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  let started = false;
  $<HTMLButtonElement>("#btn-join").disabled = true;
  $("#btn-join").textContent = "Joining…";
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: "hello", name: trainerName(), room }));
    sock.send(JSON.stringify({ type: "setup", faction: pickFaction(faction) }));
  };
  sock.onerror = () => showError("Couldn't reach the game server. Is the host's server running?");
  sock.onclose = () => {
    $<HTMLButtonElement>("#btn-join").disabled = false;
    $("#btn-join").textContent = "Join room";
    if (!started) {
      $("#room-view").hidden = true;
      $("#lobby-form").hidden = false;
      $("#lobby-hero").hidden = false;
      void refreshRooms();
    }
  };
  const onMsg = (ev: MessageEvent) => {
    const m = JSON.parse(String(ev.data)) as ServerMsg;
    if (m.type === "error") {
      showError(m.msg);
      // Inside a room (e.g. "too many players for this map") the room stays open; joining errors close it.
      if ($("#room-view").hidden) sock.close();
    } else if (m.type === "lobby") {
      myId = m.you;
      roomPlayers = m.players;
      showRoom(m.room, m.host, m.map);
    } else if (m.type === "start") {
      started = true;
      if (m.you !== undefined) myId = m.you; // rejoining a running game skips the lobby
      sock.removeEventListener("message", onMsg);
      void startGame({ source: new NetSource(sock, { room, name: trainerName() }), options: m.options, me: myId, names: m.names, bots: m.host === myId ? m.ai : [] });
    }
  };
  sock.addEventListener("message", onMsg);
}
$("#btn-join").onclick = joinRoom;

/** Rooms waiting in the lobby on this server, refreshed while the With friends tab is open. */
async function refreshRooms() {
  if (mode !== "friends" || lobby.hidden || !$("#room-view").hidden || document.hidden) return;
  try {
    const r = await fetch("/api/rooms", { cache: "no-store" });
    if (!r.ok) return;
    const list = (await r.json()) as { code: string; host: string; players: number; max: number; map: string; inProgress?: boolean; missing?: string[] }[];
    $("#open-rooms").innerHTML = list.length
      ? list
          .map((o) => {
            if (o.inProgress) {
              const who = (o.missing ?? []).map(escapeHtml).join(", ");
              return `<li class="live"><span class="nm"><b>${escapeHtml(o.code)}</b><small>Game in progress · waiting for ${who}</small></span><button class="lb-btn lb-rejoin" data-room="${escapeHtml(o.code)}">Rejoin</button></li>`;
            }
            const full = o.players >= o.max;
            return `<li><span class="nm"><b>${escapeHtml(o.code)}</b><small>${escapeHtml(o.host)} · ${escapeHtml(o.map)}</small></span><span class="ct">${o.players}/${o.max}</span><button class="lb-btn" data-room="${escapeHtml(o.code)}" ${full ? "disabled" : ""}>${full ? "Full" : "Join"}</button></li>`;
          })
          .join("")
      : `<li class="lb-roomempty">No open rooms right now. Join with a new name to create one.</li>`;
  } catch {
    /* offline: keep the last list */
  }
}
$("#open-rooms").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("[data-room]") as HTMLButtonElement | null;
  if (!b || b.disabled) return;
  roomInput.value = b.dataset.room!;
  joinRoom();
});
setInterval(() => void refreshRooms(), 3000);
roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});

/** Same cache-busting version as this script (main.js?v=…), so the art matches the build. */
const BUILD = new URL(import.meta.url).search;
const FACTION_ART = ["img/charmander.png", "img/squirtle.png", "img/bulbasaur.png", "img/pichu.png"].map((u) => u + BUILD);

function showRoom(room: string, host: number, mapKey: string) {
  $("#lobby-form").hidden = true;
  $("#lobby-hero").hidden = true;
  $("#room-view").hidden = false;
  $("#room-code").textContent = room;
  const isHost = host === myId;
  const hostName = roomPlayers.find((p) => p.id === host)?.name ?? "the host";
  linkInput.value = `${location.origin}/?room=${encodeURIComponent(room)}`;
  const map = maps.find((m) => m.key === mapKey);
  const slots = Math.min(8, map?.players ?? 2);
  const free = slots - roomPlayers.length;
  $("#room-count").textContent = `${roomPlayers.length}/${slots}`;
  const rows = roomPlayers.map((p) => {
    const tags = [p.id === host ? `<span class="tag host">Host</span>` : "", p.id === myId ? `<span class="tag you">You</span>` : ""].join("");
    const kick = isHost && p.ai ? `<button class="lb-kick" data-kick="${p.id}" title="Remove this computer player" aria-label="Remove ${escapeHtml(p.name)}"><svg class="ic"><use href="#i-x"/></svg></button>` : "";
    const sub = p.ai ? `${FACTION_NAMES[p.faction] ?? ""} · Computer, ${DIFFICULTY_NAMES[p.ai]?.toLowerCase() ?? p.ai}` : FACTION_NAMES[p.faction] ?? "";
    return `<li style="--pc:${teamColor(p.id)}"><span class="av"><img src="${FACTION_ART[p.faction] ?? ""}" alt=""></span><span class="who"><b>${escapeHtml(p.name)}</b><small>${sub}</small></span><span class="tags">${tags}</span>${kick}</li>`;
  });
  for (let i = 0; i < free; i++) rows.push(`<li class="open">Open slot${i === 0 ? " · share the invite link" : ""}</li>`);
  $("#room-players").innerHTML = rows.join("");
  const me = roomPlayers.find((p) => p.id === myId);
  if (me) showFaction("#room-factions", me.faction);
  $("#room-host").hidden = !isHost;
  $<HTMLButtonElement>("#btn-add-ai").disabled = free <= 0;
  const full = $("#room-full");
  full.hidden = !isHost || free > 0;
  full.textContent = `${map?.name ?? "This map"} is full. Pick a map with more start locations to add computer players.`;
  $<HTMLButtonElement>("#btn-start").hidden = !isHost;
  roomPicker.readonly = !isHost;
  roomPicker.minPlayers = roomPlayers.length;
  roomPicker.select(mapKey);
  $("#room-map-who").textContent = isHost ? "You choose" : `Chosen by ${hostName}`;
  $("#room-hint").innerHTML = isHost
    ? roomPlayers.length === 1
      ? "Send the invite link to your friends or add computer players. You can also start alone to look around."
      : `Everyone's here? Press <b>Start game</b>.${free > 0 ? ` ${free} more can join on this map.` : ""}`
    : `<span class="lb-waiting">Waiting for <b>${escapeHtml(hostName)}</b> to start the game</span>`;
}

$("#btn-start").onclick = () => ws?.send(JSON.stringify({ type: "start" }));
$("#btn-leave").onclick = () => ws?.close();

if (params.has("room") && roomInput.value) {
  // Opened an invite link: the room is filled in, one click to join.
  $<HTMLButtonElement>("#btn-join").focus();
}

(window as unknown as { __lobbyReady: boolean }).__lobbyReady = true;
