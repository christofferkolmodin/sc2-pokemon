import type { ServerMsg } from "../net/protocol.ts";
import type { Replay } from "../sim/replay.ts";
import { Game } from "./game.ts";
import { NetSource, ReplaySource, SoloSource } from "./sources.ts";
import { controlsHtml } from "./controls.ts";
import { teamColor } from "./style.ts";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const lobby = $("#lobby");
const gameRoot = $("#game");
const nameInput = $<HTMLInputElement>("#name");
const roomInput = $<HTMLInputElement>("#room");
const err = $("#lobby-error");

$("#controls-list").innerHTML = controlsHtml();

function store(key: string, value?: string): string {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
nameInput.value = store("sc2poke.name") || "Trainer";
roomInput.value = new URLSearchParams(location.search).get("room") ?? (store("sc2poke.room") || "lobby");

function startGame(make: () => Game) {
  lobby.hidden = true;
  gameRoot.hidden = false;
  const game = make();
  (window as unknown as { game: Game }).game = game; // handy from the dev console
}

$("#btn-solo").onclick = () => {
  store("sc2poke.name", nameInput.value);
  const seed = (Math.random() * 0x7fffffff) | 0;
  startGame(
    () =>
      new Game(gameRoot, new SoloSource(1), { seed, map: "lab", players: [1], dummyOpponent: true }, 1, {
        1: nameInput.value || "Trainer",
        7: "Dummy",
      }),
  );
};

$<HTMLInputElement>("#replay-file").onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const replay = JSON.parse(await file.text()) as Replay;
    if (replay.version !== 1 || !replay.options) throw new Error("not a replay file");
    startGame(() => new Game(gameRoot, new ReplaySource(replay), replay.options, -1, replay.playerNames));
  } catch (x) {
    err.textContent = `Couldn't load replay: ${(x as Error).message}`;
  }
};

let ws: WebSocket | null = null;
let myId = 0;

$("#btn-join").onclick = () => {
  err.textContent = "";
  store("sc2poke.name", nameInput.value);
  store("sc2poke.room", roomInput.value);
  ws?.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  let started = false;
  sock.onopen = () => sock.send(JSON.stringify({ type: "hello", name: nameInput.value, room: roomInput.value }));
  sock.onerror = () => (err.textContent = "Couldn't reach the game server. Is `npm start` running on the host?");
  sock.onclose = () => {
    if (!started) {
      $("#room-view").hidden = true;
      $("#lobby-form").hidden = false;
    }
  };
  const onMsg = (ev: MessageEvent) => {
    const m = JSON.parse(String(ev.data)) as ServerMsg;
    if (m.type === "error") {
      err.textContent = m.msg;
      sock.close();
    } else if (m.type === "lobby") {
      myId = m.you;
      $("#lobby-form").hidden = true;
      $("#room-view").hidden = false;
      $("#room-code").textContent = m.room;
      $("#room-players").innerHTML = m.players
        .map((p) => `<li style="border-color:${teamColor(p.id)}">${escapeHtml(p.name)}${p.id === m.host ? " · host" : ""}${p.id === m.you ? " (you)" : ""}</li>`)
        .join("");
      const isHost = m.host === m.you;
      $<HTMLButtonElement>("#btn-start").hidden = !isHost;
      const link = `${location.origin}/?room=${encodeURIComponent(m.room)}`;
      $("#room-hint").textContent = isHost
        ? `Friends join with: ${link}  (start alone to test netcode against a dummy army)`
        : "Waiting for the host to start…";
    } else if (m.type === "start") {
      started = true;
      sock.removeEventListener("message", onMsg);
      startGame(() => new Game(gameRoot, new NetSource(sock), m.options, myId, m.names));
    }
  };
  sock.addEventListener("message", onMsg);
};

$("#btn-start").onclick = () => ws?.send(JSON.stringify({ type: "start" }));
$("#btn-leave").onclick = () => ws?.close();

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
