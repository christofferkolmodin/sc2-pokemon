import type { Difficulty, LobbyPlayer, ServerMsg } from "../net/protocol.ts";
import type { Replay } from "../sim/replay.ts";
import { BUILTIN_MAPS, hasMap, makeMap, registerMap } from "../sim/map.ts";
import { FACTION_NAMES } from "../sim/units.ts";
import { type MapIndexEntry, type MapJson, type RenderData, mapFromJson } from "../maps/load.ts";
import { Game, type GameSetup } from "./game.ts";
import { GltfModels } from "./render/gltf.ts";
import { NetSource, ReplaySource, SoloSource } from "./sources.ts";
import { controlsHtml } from "./controls.ts";
import { FACTION_COLORS, teamColor } from "./style.ts";
import { builtinMapPicture, pokemonPicture } from "./lobbyArt.ts";

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

function showError(msg: string) {
  err.textContent = msg;
  if (msg) err.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

const trainerName = () => nameInput.value.trim() || "Trainer";

// ------------------------------------------------------------ step 1: name

nameInput.value = store("sc2poke.name");
nameInput.addEventListener("change", () => store("sc2poke.name", nameInput.value.trim()));

// --------------------------------------------------------- step 2: faction

let faction = Number(store("sc2poke.faction") || "0");
function showFaction(sel: string, f: number) {
  for (const b of document.querySelectorAll<HTMLButtonElement>(`${sel} button`)) b.classList.toggle("on", Number(b.dataset.f) === f);
}
showFaction("#factions", faction);
$("#factions").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null;
  if (!b) return;
  faction = Number(b.dataset.f);
  store("sc2poke.faction", String(faction));
  showFaction("#factions", faction);
});
const pickFaction = (f: number) => (f >= 0 ? f : Math.floor(Math.random() * 3));

// Evolution lines, drawn with the game's own models (after the page is up, it takes a moment).
setTimeout(() => {
  for (const el of document.querySelectorAll<HTMLElement>("[data-line]")) {
    const f = Number((el.closest("[data-f]") as HTMLElement).dataset.f);
    const keys = el.dataset.line!.split(",");
    el.innerHTML = keys.map((k) => `<img src="${pokemonPicture(k, FACTION_COLORS[f])}" alt="${k}" title="${k[0].toUpperCase() + k.slice(1)}">`).join("<i>›</i>");
  }
}, 30);

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
  if (b) showMode(b.dataset.mode as Mode);
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
      `<button class="lb-mapitem${m.key === this.selected ? " on" : ""}" data-key="${m.key}" ${m.players < this.minPlayers ? "disabled title='Not enough start locations'" : ""}><span>${escapeHtml(m.name)}</span><small>${m.players} players</small></button>`;
    const builtin = shown.filter((m) => !m.imported);
    const imported = shown.filter((m) => m.imported);
    this.list.innerHTML =
      (builtin.length ? `<div class="lb-mapgroup">Built-in</div>${builtin.map(item).join("")}` : "") +
      (imported.length ? `<div class="lb-mapgroup">From StarCraft II</div>${imported.map(item).join("")}` : "") +
      (shown.length ? "" : `<div class="lb-mapgroup">No maps match</div>`);
    this.list.querySelector(".on")?.scrollIntoView({ block: "nearest" });
    const m = maps.find((x) => x.key === this.selected);
    if (!m) return;
    const src = m.imported ? `/assets/maps/${encodeURIComponent(m.key)}.png` : builtinMapPicture(m.key);
    this.preview.innerHTML = `<img src="${src}" alt=""><b>${escapeHtml(m.name)}</b><span>${m.players} players · ${m.w}×${m.h}<br>${m.imported ? "Real SC2 ladder map" : "Built into the game"}</span>`;
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

const aiCount = $<HTMLSelectElement>("#ai-count");
aiCount.value = store("sc2poke.aicount") || "1";
let difficulty = (store("sc2poke.diff") as Difficulty) || "medium";
function showDiff() {
  for (const b of document.querySelectorAll<HTMLElement>("#ai-diff button")) b.classList.toggle("on", b.dataset.d === difficulty);
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
  for (const o of aiCount.options) o.disabled = Number(o.value) > max;
  if (Number(aiCount.value) > max) aiCount.value = String(max);
  $("#ai-count-help").textContent =
    map.players > 2 ? `${map.name} has ${map.players} start locations: up to ${max} opponents, everyone against everyone.` : `${map.name} is a 1v1 map.`;
}
aiCount.onchange = () => store("sc2poke.aicount", aiCount.value);

$("#btn-ai").onclick = () => {
  store("sc2poke.name", nameInput.value.trim());
  const map = maps.find((m) => m.key === soloPicker.selected) ?? maps[0];
  const count = Math.max(1, Math.min(map.players - 1, Number(aiCount.value)));
  const players = Array.from({ length: count + 1 }, (_, i) => i + 1);
  const factions: Record<number, number> = { 1: pickFaction(faction) };
  const names: Record<number, string> = { 1: trainerName() };
  for (const p of players.slice(1)) {
    factions[p] = Math.floor(Math.random() * 3);
    names[p] = `${FACTION_NAMES[factions[p]]} AI (${difficulty})`;
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

roomInput.value = params.get("room") ?? store("sc2poke.room");
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
$("#btn-copy").onclick = async () => {
  const link = $("#room-link").textContent ?? "";
  try {
    await navigator.clipboard.writeText(link);
    $("#btn-copy").textContent = "Copied!";
  } catch {
    $("#btn-copy").textContent = "Select and copy it";
  }
  setTimeout(() => ($("#btn-copy").textContent = "Copy"), 1800);
};

function joinRoom() {
  const room = roomInput.value.trim();
  if (!room) {
    showError("Type a room name first. Your friends type the same name to join you.");
    roomInput.focus();
    return;
  }
  showError("");
  store("sc2poke.name", nameInput.value.trim());
  store("sc2poke.room", room);
  ws?.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  let started = false;
  $<HTMLButtonElement>("#btn-join").disabled = true;
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: "hello", name: trainerName(), room }));
    sock.send(JSON.stringify({ type: "setup", faction: pickFaction(faction) }));
  };
  sock.onerror = () => showError("Couldn't reach the game server. Is the host's server running?");
  sock.onclose = () => {
    $<HTMLButtonElement>("#btn-join").disabled = false;
    if (!started) {
      $("#room-view").hidden = true;
      $("#lobby-form").hidden = false;
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
      sock.removeEventListener("message", onMsg);
      void startGame({ source: new NetSource(sock), options: m.options, me: myId, names: m.names, bots: m.host === myId ? m.ai : [] });
    }
  };
  sock.addEventListener("message", onMsg);
}
$("#btn-join").onclick = joinRoom;
roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinRoom();
});

function showRoom(room: string, host: number, mapKey: string) {
  $("#lobby-form").hidden = true;
  $("#room-view").hidden = false;
  $("#room-code").textContent = room;
  const isHost = host === myId;
  const hostName = roomPlayers.find((p) => p.id === host)?.name ?? "the host";
  const link = `${location.origin}/?room=${encodeURIComponent(room)}`;
  $("#room-link").textContent = link;
  $("#room-players").innerHTML = roomPlayers
    .map((p) => {
      const tags = [p.id === host ? `<span class="tag">host</span>` : "", p.id === myId ? `<span class="tag">you</span>` : "", p.ai ? `<span class="tag ai">computer · ${p.ai}</span>` : ""].join("");
      const kick = isHost && p.ai ? `<button data-kick="${p.id}" title="Remove this computer player">✕</button>` : "";
      return `<li style="border-color:${teamColor(p.id)}"><span class="who">${escapeHtml(p.name)}</span>${tags}<span class="fac">${FACTION_NAMES[p.faction] ?? ""}</span>${kick}</li>`;
    })
    .join("");
  const me = roomPlayers.find((p) => p.id === myId);
  if (me) showFaction("#room-factions", me.faction);
  $("#room-host").hidden = !isHost;
  $<HTMLButtonElement>("#btn-start").hidden = !isHost;
  roomPicker.readonly = !isHost;
  roomPicker.minPlayers = roomPlayers.length;
  roomPicker.select(mapKey);
  $("#room-map-who").textContent = isHost ? "(you choose)" : `(chosen by ${hostName})`;
  const map = maps.find((m) => m.key === mapKey);
  const free = (map?.players ?? 2) - roomPlayers.length;
  $("#room-hint").innerHTML = isHost
    ? roomPlayers.length === 1
      ? "You're the host. Send the invite link to your friends, or add computer players. You can also start alone to look around."
      : `You're the host. Press <b>Start game</b> when everyone is here${free > 0 ? ` (${free} more can join this map)` : ""}.`
    : `Waiting for <b>${escapeHtml(hostName)}</b> to start the game. Pick your faction meanwhile.`;
}

$("#btn-start").onclick = () => ws?.send(JSON.stringify({ type: "start" }));
$("#btn-leave").onclick = () => ws?.close();

if (params.has("room") && roomInput.value) {
  // Opened an invite link: the room is filled in, one click to join.
  $<HTMLButtonElement>("#btn-join").focus();
}
