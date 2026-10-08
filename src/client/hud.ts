import { FP, TICKS_PER_SECOND_X10 } from "../sim/fixed.ts";
import {
  BUILD_ADVANCED,
  BUILD_BASIC,
  FACTION_NAMES,
  KINDS,
  K_CENTER,
  K_ELITE,
  K_EXTRACTOR,
  K_GYM,
  K_MART,
  K_SHRINE,
  K_TURRET,
  MAX_UPGRADE,
  TYPE_NAMES,
  UPGRADE_NAMES,
  UP_ARMOR,
  UP_ATTACK,
  upgradeCost,
} from "../sim/units.ts";
import { TUNE_DEFS } from "../sim/tuning.ts";
import { G_MINE, type Unit } from "../sim/world.ts";
import { MODE_ATTACK, MODE_ATTACK_UNIT, MODE_BUILD, MODE_GATHER, MODE_PATROL, MODE_RETURN } from "../sim/commands.ts";
import type { CardButton, Game } from "./game.ts";
import { controlsHtml } from "./controls.ts";
import { NetSource, ReplaySource } from "./sources.ts";
import { Portrait } from "./render/renderer.ts";
import { FACTION_COLORS, teamColor } from "./style.ts";

type Slotted = CardButton & { slot: number };

const ICON = { move: "➜", stop: "■", hold: "⛊", patrol: "⇄", attack: "⚔", gather: "⛏", ret: "⤺", build: "🔨", adv: "⚒", rally: "⚑", cancel: "✕", evolve: "✦", back: "↩" };

const ERRORS: Record<string, [string, string]> = {
  minerals: ["Not enough minerals.", "Not enough minerals"],
  gas: ["Not enough Vespene gas.", "You require more vespene gas"],
  supply: ["Not enough supply. Build a Poké Mart.", "Additional supply required"],
  max: ["Supply limit reached.", "Supply limit reached"],
  place: ["Can't build there.", ""],
  tech: ["Requires more tech.", ""],
  queue: ["Queue is full.", ""],
};

/** Build-menu hotkeys follow SC2's standard keys where there's an equivalent. */
const BUILD_KEYS: Record<number, string> = { [K_CENTER]: "C", [K_MART]: "S", [K_EXTRACTOR]: "R", [K_GYM]: "B", [K_TURRET]: "T", [K_SHRINE]: "E", [K_ELITE]: "F" };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class Hud {
  buttons: Slotted[] = [];
  private $ = (s: string) => this.g.root.querySelector(s) as HTMLElement;
  private selSig = "";
  private grpSig = "";
  private cmdSig = "";
  private lastStats = 0;
  private lastPanel = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private errTimer: ReturnType<typeof setTimeout> | null = null;
  private portrait: Portrait;
  private chatLog: { el: HTMLElement; t: number }[] = [];

  constructor(private g: Game) {
    this.portrait = new Portrait(this.$("#portrait canvas") as HTMLCanvasElement, g.renderer.gltf);
    this.buildTuning();
    this.buildMenu();
    this.$("#help-list").innerHTML = controlsHtml();
    this.$("#btn-tuning").onclick = () => this.toggleTuning();
    this.$("#btn-help").onclick = () => this.$("#help").toggleAttribute("hidden");
    this.$("#btn-menu").onclick = () => this.toggleMenu();
    this.$("#btn-menu-full").onclick = () => g.goFullscreen();
    this.$("#btn-idle").onclick = (e) => g.selectIdleWorker((e as MouseEvent).ctrlKey);
    const replay = g.source instanceof ReplaySource;
    this.$("#replay-controls").hidden = !replay;
    this.$("#btn-tuning").hidden = !g.world.sandbox || replay;
    for (const b of g.root.querySelectorAll<HTMLButtonElement>("#replay-controls button[data-speed]")) {
      b.onclick = () => (g.speed = Number(b.dataset.speed));
    }
    this.$("#btn-fog").onclick = () => {
      g.fog = !g.fog;
      this.$("#btn-fog").textContent = g.fog ? "Fog: on" : "Fog: off";
    };

    // Selection panel clicks (event delegation).
    this.$("#selpanel").addEventListener("click", (e) => {
      const q = (e.target as HTMLElement).closest("[data-q]") as HTMLElement | null;
      if (q) {
        g.send({ t: "cancel", id: Number(q.dataset.id), slot: Number(q.dataset.q) });
        return;
      }
      const el = (e.target as HTMLElement).closest("[data-id]") as HTMLElement | null;
      if (!el) return;
      const id = Number(el.dataset.id);
      const u = g.world.byId.get(id);
      if (!u) return;
      const sel = g.selection;
      const me = e as MouseEvent;
      if (me.ctrlKey && me.shiftKey) sel.set(sel.ids.filter((i) => g.world.byId.get(i)?.kind !== u.kind), sel.foreign);
      else if (me.ctrlKey) sel.set(sel.ids.filter((i) => g.world.byId.get(i)?.kind === u.kind), sel.foreign);
      else if (me.shiftKey) sel.set(sel.ids.filter((i) => i !== id), sel.foreign);
      else sel.set([id], sel.foreign);
      g.subgroup = 0;
    });
    this.$("#groups").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-g]") as HTMLElement | null;
      if (el) g.selection.recallGroup(Number(el.dataset.g), false);
    });
    this.$("#cmdcard").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-cmd]") as HTMLElement | null;
      const b = this.buttons.find((x) => x.key === el?.dataset.cmd);
      if (b && !b.disabled) {
        g.audio.ui();
        b.act();
        this.refreshCard();
      }
    });
    // Tooltips for the command card.
    this.$("#cmdcard").addEventListener("mouseover", (e) => {
      const el = (e.target as HTMLElement).closest("[data-cmd]") as HTMLElement | null;
      const b = this.buttons.find((x) => x.key === el?.dataset.cmd);
      const tip = this.$("#tooltip");
      if (!b) {
        tip.hidden = true;
        return;
      }
      tip.innerHTML = `<b>${esc(b.label)}</b> <kbd>${b.hk}</kbd>${b.tip ? `<div>${b.tip}</div>` : ""}`;
      tip.hidden = false;
    });
    this.$("#cmdcard").addEventListener("mouseout", (e) => {
      const to = (e as MouseEvent).relatedTarget as Node | null;
      if (!to || !this.$("#cmdcard").contains(to)) this.$("#tooltip").hidden = true;
    });

    // Chat.
    const input = this.$("#chat-input") as HTMLInputElement;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const text = input.value.trim();
        if (text && g.source instanceof NetSource) g.source.chat(text);
        input.value = "";
        input.hidden = true;
        input.blur();
        e.preventDefault();
      } else if (e.key === "Escape") {
        input.value = "";
        input.hidden = true;
        input.blur();
      }
      e.stopPropagation();
    });

    this.$("#btn-over-replay").onclick = () => this.downloadReplay();
    this.$("#btn-over-stay").onclick = () => (this.$("#gameover").hidden = true);
    this.$("#btn-over-leave").onclick = () => this.leave();
  }

  private leave() {
    this.g.stop();
    location.reload();
  }

  // ------------------------------------------------------------- panels

  toggleTuning() {
    if (!this.g.world.sandbox || this.g.source instanceof ReplaySource) return;
    this.$("#tuning").toggleAttribute("hidden");
  }

  toggleMenu() {
    this.$("#menu").toggleAttribute("hidden");
  }

  closePanels() {
    for (const id of ["#menu", "#help", "#tuning"]) this.$(id).hidden = true;
  }

  private buildMenu() {
    const g = this.g;
    const q = this.$("#opt-quality") as HTMLSelectElement;
    const bars = this.$("#opt-bars") as HTMLSelectElement;
    const vol = this.$("#opt-volume") as HTMLInputElement;
    const voice = this.$("#opt-voice") as HTMLInputElement;
    const load = (k: string, d: string) => {
      try {
        return localStorage.getItem(k) ?? d;
      } catch {
        return d;
      }
    };
    const save = (k: string, v: string) => {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* private mode */
      }
    };
    q.value = load("sc2poke.quality", "high");
    bars.value = load("sc2poke.bars", "damaged");
    vol.value = load("sc2poke.volume", "50");
    voice.checked = load("sc2poke.voice", "1") === "1";
    const apply = () => {
      g.renderer.quality = q.value as "high" | "low";
      g.bars = bars.value as "always" | "damaged";
      g.audio.setVolume(Number(vol.value) / 100);
      g.audio.voice = voice.checked;
      save("sc2poke.quality", q.value);
      save("sc2poke.bars", bars.value);
      save("sc2poke.volume", vol.value);
      save("sc2poke.voice", voice.checked ? "1" : "0");
      g.resize();
    };
    for (const el of [q, bars, vol, voice]) el.addEventListener("change", apply);
    apply();
    this.$("#btn-replay").onclick = () => this.downloadReplay();
    this.$("#btn-surrender").hidden = g.world.mode !== "melee" || !g.canCommand;
    this.$("#btn-surrender").onclick = () => {
      if (confirm("Surrender this game?")) g.send({ t: "surrender" });
    };
    this.$("#btn-quit").onclick = () => this.leave();
  }

  private buildTuning() {
    const list = this.$("#tune-list");
    list.innerHTML = TUNE_DEFS.map(
      (d) => `<div class="tune" title="${d.help}">
        <div class="lbl"><span>${d.label}</span><span data-val="${d.key}"></span></div>
        <input type="range" data-tune="${d.key}" min="${d.min}" max="${d.max}" step="${d.step}">
        <div class="help">${d.help}</div></div>`,
    ).join("");
    list.addEventListener("change", (e) => {
      const el = e.target as HTMLInputElement;
      if (!el.dataset.tune) return;
      this.g.send({ t: "tune", key: el.dataset.tune, value: Number(el.value) });
    });
    // Live label while dragging (the value is only sent on release).
    list.addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement;
      const v = list.querySelector(`[data-val="${el.dataset.tune}"]`);
      if (v) v.textContent = el.value;
    });

    const spawn = this.$("#spawn-list");
    const solo = this.g.source.kind === "solo";
    spawn.innerHTML = KINDS.filter((k) => !k.resource && !k.structure)
      .map(
        (k) =>
          `<button data-ui data-spawn="${k.id}">+5 ${k.name}</button>` +
          (solo ? `<button data-ui data-spawn="${k.id}" data-owner="7">+5 enemy ${k.name}</button>` : ""),
      )
      .join("");
    spawn.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-spawn]") as HTMLElement | null;
      if (!el) return;
      const c = this.g.cam;
      const at = c.toWorld(c.w / 2, (c.h - c.consoleH) / 2);
      const owner = el.dataset.owner ? Number(el.dataset.owner) : undefined;
      this.g.send({
        t: "spawn",
        kind: Number(el.dataset.spawn),
        x: Math.round(at.x * FP),
        y: Math.round(at.y * FP),
        n: 5,
        ...(owner !== undefined ? { owner } : {}),
      });
    });
  }

  private syncTuning() {
    if (this.$("#tuning").hidden) return;
    for (const d of TUNE_DEFS) {
      const v = this.g.world.tune[d.key];
      const input = this.g.root.querySelector(`[data-tune="${d.key}"]`) as HTMLInputElement;
      if (document.activeElement !== input && input.value !== String(v)) input.value = String(v);
      const lbl = this.g.root.querySelector(`[data-val="${d.key}"]`)!;
      if (document.activeElement !== input) lbl.textContent = String(v);
    }
  }

  // ------------------------------------------------------------ messages

  banner(text: string) {
    const b = this.$("#banner");
    b.textContent = text;
    b.hidden = false;
  }

  toast(text: string, color = "#ffe39a") {
    const t = this.$("#toast");
    t.textContent = text;
    t.style.color = color;
    t.classList.add("show");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  error(text: string) {
    const t = this.$("#errmsg");
    t.textContent = text;
    t.classList.add("show");
    if (this.errTimer) clearTimeout(this.errTimer);
    this.errTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  simError(msg: string) {
    const [text, voice] = ERRORS[msg] ?? [msg, ""];
    this.error(text);
    if (voice) this.g.audio.say(voice, 2500);
  }

  openChat() {
    const input = this.$("#chat-input") as HTMLInputElement;
    input.hidden = false;
    input.focus();
  }

  chatLine(name: string, text: string, from: number) {
    const log = this.$("#chat-log");
    const el = document.createElement("div");
    el.innerHTML = `<b style="color:${teamColor(from)}">${esc(name)}:</b> ${esc(text)}`;
    log.appendChild(el);
    this.chatLog.push({ el, t: performance.now() });
    while (this.chatLog.length > 8) this.chatLog.shift()!.el.remove();
    this.g.audio.ui();
  }

  gameOver(victory: boolean) {
    const w = this.g.world;
    const el = this.$("#gameover");
    el.hidden = false;
    this.$("#over-title").textContent = victory ? "Victory!" : "Defeat";
    this.$("#over-title").className = victory ? "win" : "lose";
    const mins = (w.tick * 10) / TICKS_PER_SECOND_X10 / 60;
    const rows = [...w.players.values()]
      .map(
        (p) => `<tr><td style="color:${teamColor(p.id)}">${esc(this.g.names[p.id] ?? `Player ${p.id}`)}</td><td>${FACTION_NAMES[p.faction]}</td>
        <td>${p.stats.mined}</td><td>${p.stats.gas}</td><td>${p.stats.made}</td><td>${p.stats.killed}</td><td>${p.stats.lost}</td><td>${p.alive ? "✓" : "✗"}</td></tr>`,
      )
      .join("");
    this.$("#over-stats").innerHTML = `<p>Game length ${Math.floor(mins)}:${String(Math.floor((mins % 1) * 60)).padStart(2, "0")}</p>
      <table><tr><th>Player</th><th>Faction</th><th>Minerals</th><th>Gas</th><th>Made</th><th>Kills</th><th>Lost</th><th></th></tr>${rows}</table>`;
    this.g.audio.say(victory ? "Victory" : "You have been defeated", 0);
  }

  private downloadReplay() {
    const blob = new Blob([JSON.stringify(this.g.replay())], { type: "application/json" });
    const a = document.createElement("a");
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    a.download = `sc2poke-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.toast("Replay saved");
  }

  // -------------------------------------------------------------- per frame

  update(now: number) {
    this.updateCommandCard();
    this.updateSelection(now);
    this.updateGroups();
    const first = this.g.world.byId.get(this.g.selection.ids[0]);
    const lead = this.g.world.byId.get(this.g.activeIds()[0] ?? this.g.selection.ids[0]) ?? first;
    this.portrait.show(lead ? lead.kind : -1, lead?.owner ?? 0, FACTION_COLORS[this.g.world.players.get(lead?.owner ?? 0)?.faction ?? 0]);
    this.portrait.render(now);
    if (now - this.lastStats > 200) {
      this.lastStats = now;
      this.updateStats();
      this.syncTuning();
      for (const c of this.chatLog) if (now - c.t > 12000) c.el.classList.add("old");
    }
  }

  private cost(m: number, g: number, supply = 0): string {
    const pl = this.g.world.players.get(this.g.me);
    const cls = (ok: boolean) => (ok ? "" : " class='short'");
    return `<span class="cost"><i class="ico min"></i><span${cls((pl?.m ?? 0) >= m)}>${m}</span>${g ? ` <i class="ico gas"></i><span${cls((pl?.g ?? 0) >= g)}>${g}</span>` : ""}${supply ? ` <i class="ico sup"></i>${supply}` : ""}</span>`;
  }

  /** Command card for the active subgroup. Layout slots follow SC2's 5x3 grid. */
  private card(): Slotted[] {
    const g = this.g;
    const w = g.world;
    if (!g.canCommand) return [];
    const ids = g.activeIds();
    if (!ids.length) return [];
    const kind = g.activeKind();
    const k = KINDS[kind];
    const units = ids.map((id) => w.byId.get(id)!).filter(Boolean);
    const out: Slotted[] = [];
    const add = (b: CardButton, slot: number) => out.push({ ...b, slot });
    const cancel: CardButton = { key: "cancel", hk: "Escape", label: "Cancel", icon: ICON.cancel, act: () => g.cancelModes() };
    if (g.placing !== null || g.targeting) {
      add({ ...cancel, hk: "" }, 14);
      return out;
    }
    if (g.cardMode === "build" || g.cardMode === "build2") {
      const list = g.cardMode === "build" ? BUILD_BASIC : BUILD_ADVANCED;
      list.forEach((bk, i) => {
        const bkind = KINDS[bk];
        const tech = w.hasStructure(g.me, bkind.requires);
        add(
          {
            key: `build:${bk}`,
            hk: BUILD_KEYS[bk],
            label: bkind.name,
            icon: "",
            img: g.renderer.unitIcon(bk, g.me, 40),
            tip: `${this.cost(bkind.m, bkind.g)} · ${Math.round(bkind.time / 22.4)}s${bkind.provides ? ` · +${bkind.provides} supply` : ""}${tech ? "" : `<br><span class="short">Requires ${KINDS[bkind.requires].name}</span>`}<br>${this.describe(bk)}`,
            disabled: !tech,
            act: () => g.startPlacing(bk),
          },
          i < 5 ? i : i,
        );
      });
      add({ key: "back", hk: "Escape", label: "Back", icon: ICON.back, act: () => (g.cardMode = "main") }, 14);
      return out;
    }
    if (k.structure) {
      const building = units.some((u) => !w.isDone(u));
      if (building) {
        add({ key: "cancelb", hk: "Escape", label: "Cancel construction (Esc, 75% refund)", icon: ICON.cancel, act: () => g.cancelWork() }, 14);
        return out;
      }
      const trains = w.trainable(g.me, kind);
      trains.forEach((tk, i) => {
        const t = KINDS[tk];
        const tech = w.hasStructure(g.me, t.requires);
        add(
          {
            key: `train:${tk}`,
            hk: kind === K_CENTER ? "S" : "A",
            label: `Train ${t.name}`,
            icon: "",
            img: g.renderer.unitIcon(tk, g.me, 40),
            tip: `${this.cost(t.m, t.g, t.supply)} · ${Math.round(t.time / 22.4)}s<br>${this.describe(tk)}`,
            disabled: !tech,
            act: () => g.send({ t: "train", ids, kind: tk }),
          },
          i,
        );
      });
      if (k.research) {
        const pl = w.players.get(g.me)!;
        [UP_ATTACK, UP_ARMOR].forEach((up, i) => {
          const lvl = pl.up[up] + 1;
          if (lvl > MAX_UPGRADE) return;
          const c = upgradeCost(lvl);
          const tech = w.hasStructure(g.me, c.requires);
          add(
            {
              key: `up:${up}`,
              hk: up === UP_ATTACK ? "A" : "D",
              label: `${UPGRADE_NAMES[up]} level ${lvl}`,
              icon: up === UP_ATTACK ? "⚔" : "⛨",
              tip: `${this.cost(c.m, c.g)} · ${Math.round(c.time / 22.4)}s<br>${up === UP_ATTACK ? "All your Pokémon hit harder." : "All your Pokémon take less damage."}${tech ? "" : `<br><span class="short">Requires ${KINDS[c.requires].name}</span>`}${pl.researching[up] ? "<br>Researching…" : ""}`,
              disabled: !tech || !!pl.researching[up],
              act: () => g.send({ t: "research", ids, up }),
            },
            i,
          );
        });
      }
      if (trains.length) add({ key: "rally", hk: "Y", label: "Set rally point", icon: ICON.rally, act: () => g.setTargeting("rally") }, 9);
      if (units.some((u) => u.queue.length > 0)) add({ key: "cancelq", hk: "Escape", label: "Cancel last in queue (Esc)", icon: ICON.cancel, act: () => g.cancelWork() }, 14);
      return out;
    }
    // Units.
    add({ key: "move", hk: "M", label: "Move", icon: ICON.move, active: g.targeting === "move", act: () => g.setTargeting("move") }, 0);
    add({ key: "stop", hk: "S", label: "Stop", icon: ICON.stop, act: () => g.issueStop(false) }, 1);
    add({ key: "hold", hk: "H", label: "Hold position", icon: ICON.hold, act: () => g.issueStop(true) }, 2);
    add({ key: "patrol", hk: "P", label: "Patrol", icon: ICON.patrol, act: () => g.setTargeting("patrol") }, 3);
    add({ key: "attack", hk: "A", label: "Attack", icon: ICON.attack, act: () => g.setTargeting("attack") }, 4);
    if (k.worker) {
      add({ key: "gather", hk: "G", label: "Gather", icon: ICON.gather, act: () => g.setTargeting("gather") }, 5);
      if (units.some((u) => u.carry > 0))
        add(
          {
            key: "return",
            hk: "C",
            label: "Return cargo",
            icon: ICON.ret,
            act: () => {
              const hall = w.nearestDropoff(g.me, units[0].x, units[0].y);
              if (hall) g.send({ t: "target", ids, id: hall.id, q: false, mode: MODE_RETURN });
            },
          },
          6,
        );
      add({ key: "build", hk: "B", label: "Build structure", icon: ICON.build, act: () => (g.cardMode = "build") }, 10);
      add({ key: "build2", hk: "V", label: "Build advanced structure", icon: ICON.adv, act: () => (g.cardMode = "build2") }, 11);
    }
    if (units.some((u) => u.morphTo >= 0)) {
      add({ key: "cancelm", hk: "Escape", label: "Cancel evolution (Esc, 75% refund)", icon: ICON.cancel, act: () => g.cancelWork() }, 14);
    }
    const e = k.evolve;
    if (e) {
      const to = KINDS[e.to];
      const tech = w.hasStructure(g.me, e.requires);
      add(
        {
          key: "evolve",
          hk: "E",
          label: `Evolve into ${to.name}`,
          icon: "",
          img: g.renderer.unitIcon(e.to, g.me, 40),
          tip: `${this.cost(e.m, e.g, to.supply - k.supply)} · ${Math.round(e.time / 22.4)}s<br>${this.describe(e.to)}${tech ? "" : `<br><span class="short">Requires ${KINDS[e.requires].name}</span>`}`,
          disabled: !tech,
          act: () => g.send({ t: "evolve", ids }),
        },
        10,
      );
    }
    return out;
  }

  private describe(kind: number): string {
    const k = KINDS[kind];
    const w = k.weapon;
    const parts = [`${k.hp} HP`, `armor ${k.armor}`];
    if (w) parts.push(`${w.name}: ${w.damage} ${TYPE_NAMES[w.type]} dmg, range ${(w.range / FP).toFixed(1)}${w.air ? ", hits air" : ""}${w.splash ? ", splash" : ""}`);
    if (!k.structure) parts.push(`type ${k.types.map((t) => TYPE_NAMES[t]).join("/")}`, `moves like ${k.ref}`);
    return parts.join(" · ");
  }

  /** Rebuild the card right away (after a card action, so a fast second key press sees the new card). */
  refreshCard() {
    this.cmdSig = "";
    this.updateCommandCard();
  }

  private updateCommandCard() {
    const g = this.g;
    const pl = g.world.players.get(g.me);
    const sig = `${g.canCommand}|${g.targeting}|${g.placing}|${g.cardMode}|${g.activeKind()}|${g.activeIds().length}|${g.selection.ids.join(",")}|${pl?.m}|${pl?.g}|${pl?.up}|${pl?.researching}|${g.world.tick >> 4}`;
    if (sig === this.cmdSig) return;
    this.cmdSig = sig;
    this.buttons = this.card();
    const cells: string[] = [];
    for (let i = 0; i < 15; i++) {
      const c = this.buttons.find((b) => b.slot === i);
      if (!c) cells.push(`<button class="cmd empty" tabindex="-1"></button>`);
      else
        cells.push(
          `<button class="cmd${c.active || (c.key === g.targeting) ? " active" : ""}${c.disabled ? " disabled" : ""}" data-ui data-cmd="${c.key}" tabindex="-1">${c.hk && c.hk.length === 1 ? `<span class="hk">${c.hk}</span>` : ""}${c.img ? `<img src="${c.img}" alt="">` : c.icon}</button>`,
        );
    }
    this.$("#cmdcard").innerHTML = cells.join("");
  }

  private orderText(u: Unit): string {
    const k = KINDS[u.kind];
    if (u.morphTo >= 0) return `Evolving into ${KINDS[u.morphTo].name}… ${Math.floor((u.morphT / u.morphTotal) * 100)}%`;
    if (k.structure) {
      if (u.progress < k.time) return `Under construction ${Math.floor((u.progress / k.time) * 100)}%`;
      return u.queue.length ? "Working" : "Idle";
    }
    const o = u.orders[0];
    if (u.holding && !o) return "Holding position";
    if (!o) return u.target ? "Fighting" : "Idle";
    const extra = u.orders.length > 1 ? ` (+${u.orders.length - 1} queued)` : "";
    switch (o.mode) {
      case MODE_GATHER:
        return (u.gState === G_MINE ? "Gathering" : u.carry ? "Returning cargo" : "Moving to gather") + extra;
      case MODE_RETURN:
        return "Returning cargo" + extra;
      case MODE_BUILD:
        return `Building ${KINDS[o.kind].name}` + extra;
      case MODE_ATTACK:
      case MODE_ATTACK_UNIT:
        return "Attacking" + extra;
      case MODE_PATROL:
        return "Patrolling" + extra;
      default:
        return "Moving" + extra;
    }
  }

  private updateSelection(now: number) {
    const g = this.g;
    const ids = g.selection.ids;
    const sig = ids.join(",") + (g.selection.foreign ? "f" : "") + "|" + g.subgroup;
    if (sig === this.selSig && now - this.lastPanel < 250) return;
    this.selSig = sig;
    this.lastPanel = now;
    const panel = this.$("#selpanel");
    if (ids.length === 0) {
      panel.innerHTML = `<div class="empty-sel">No selection</div>`;
      return;
    }
    if (ids.length === 1) {
      panel.innerHTML = this.single(g.world.byId.get(ids[0])!);
      return;
    }
    const MAX = 48;
    const active = g.activeKind();
    const units = ids.slice(0, MAX).map((id) => g.world.byId.get(id)!) as Unit[];
    panel.innerHTML =
      `<div class="wire">${units
        .map((u) => {
          const k = KINDS[u.kind];
          const f = u.hp / k.hp;
          const col = f > 0.5 ? "#3be04b" : f > 0.25 ? "#f2d22e" : "#f0402e";
          return `<div class="u${u.kind === active ? " act" : ""}" data-id="${u.id}" title="${k.name}" style="border-color:${col}"><img src="${g.renderer.unitIcon(u.kind, u.owner, 40)}" alt=""></div>`;
        })
        .join("")}</div>` + (ids.length > MAX ? `<div class="sel-more">+${ids.length - MAX} more (${ids.length} selected)</div>` : "");
  }

  private single(u: Unit): string {
    const g = this.g;
    const w = g.world;
    const k = KINDS[u.kind];
    const owner = u.owner === 0 ? "Neutral" : (g.names[u.owner] ?? (u.owner === 7 ? "Dummy" : `Player ${u.owner}`));
    const pl = w.players.get(u.owner);
    const lines: string[] = [];
    if (k.resource === 1 || k.resource === 2) {
      lines.push(`<div class="meta">${k.resource === 1 ? "Minerals" : "Vespene gas"}: <b>${u.amount}</b></div>`);
    } else {
      const f = u.hp / k.hp;
      lines.push(`<div class="hp" style="color:${f > 0.5 ? "#6dff7e" : f > 0.25 ? "#ffe04a" : "#ff5a4a"}">${Math.max(0, u.hp)} / ${k.hp}</div>`);
      if (k.weapon) {
        const up = pl?.up[UP_ATTACK] ?? 0;
        lines.push(`<div class="meta">${k.weapon.name}: <b>${k.weapon.damage}${up && k.weapon.upgrade ? ` (+${up * k.weapon.upgrade})` : ""}</b> ${TYPE_NAMES[k.weapon.type]} · range <b>${(k.weapon.range / FP).toFixed(1)}</b>${k.weapon.air ? " · hits air" : ""}</div>`);
      }
      const arm = (pl?.up[UP_ARMOR] ?? 0) * (k.structure ? 0 : 1);
      lines.push(`<div class="meta">Armor <b>${k.armor}${arm ? ` (+${arm})` : ""}</b>${!k.structure ? ` · ${k.types.map((t) => `<span class="type t${t}">${TYPE_NAMES[t]}</span>`).join(" ")}` : ""}${k.worker && u.carry ? ` · carrying <b>${u.carry}</b> ${u.carryGas ? "gas" : "minerals"}` : ""}</div>`);
      lines.push(`<div class="meta">${owner}${pl ? ` · ${FACTION_NAMES[pl.faction]}` : ""} · ${this.orderText(u)}</div>`);
    }
    let queue = "";
    if (k.structure && u.queue.length && g.selection.isMine(u)) {
      queue = `<div class="queue">${u.queue
        .map((q, i) => {
          const pct = i === 0 ? Math.floor((q.t / q.total) * 100) : 0;
          const icon = q.kind >= 0 ? `<img src="${g.renderer.unitIcon(q.kind, u.owner, 36)}" alt="">` : `<span class="upg">${q.up === UP_ATTACK ? "⚔" : "⛨"}</span>`;
          return `<div class="slot${i === 0 ? " first" : ""}" data-q="${i}" data-id="${u.id}" title="Click to cancel">${icon}${i === 0 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ""}</div>`;
        })
        .join("")}</div>`;
    }
    let progress = "";
    if (k.structure && u.progress < k.time) progress = `<div class="bigbar"><i style="width:${(u.progress / k.time) * 100}%"></i></div>`;
    if (u.morphTo >= 0) progress = `<div class="bigbar evo"><i style="width:${(u.morphT / u.morphTotal) * 100}%"></i></div>`;
    return `<div class="single" data-single="${u.id}">
      <div class="big"><img src="${g.renderer.unitIcon(u.kind, u.owner, 72)}" alt=""></div>
      <div class="info"><h4>${k.name}</h4>${lines.join("")}${progress}${queue}</div></div>`;
  }

  private updateGroups() {
    const s = this.g.selection;
    const cur = s.ids.join(",");
    const sig = s.groups.map((gr) => gr.join(",")).join("|") + "#" + cur;
    if (sig === this.grpSig) return;
    this.grpSig = sig;
    const order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
    this.$("#groups").innerHTML = order
      .filter((i) => s.groups[i].length > 0)
      .map((i) => `<div class="grp${s.groups[i].join(",") === cur ? " active" : ""}" data-g="${i}" data-ui><span>${i}</span><b>${s.groups[i].length}</b></div>`)
      .join("");
  }

  private updateStats() {
    const g = this.g;
    const w = g.world;
    const secs = Math.floor((w.tick * 10) / TICKS_PER_SECOND_X10);
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    const lines = [`<b>${time}</b>  ${Math.round(g.fps)} fps`];
    const src = g.source;
    if (src.kind === "net") {
      const rtt = (src as unknown as { rtt: number }).rtt;
      lines.push(`ping ${Math.round(rtt)} ms  buffer ${src.buffered()}`);
    } else if (src.kind === "replay") {
      lines.push(`replay ${g.speed}×  ${g.replayStatus}`);
    }
    lines.push(`${w.units.length} units  sim ${g.simMs.toFixed(2)} ms`);
    this.$("#stats").innerHTML = lines.join("\n");
    const pl = w.players.get(g.me);
    if (pl) {
      this.$("#res-min").textContent = String(pl.m);
      this.$("#res-gas").textContent = String(pl.g);
      const cap = w.cap(g.me);
      const sup = this.$("#res-sup");
      sup.textContent = w.sandbox ? `${pl.supply}` : `${pl.supply}/${cap}`;
      sup.classList.toggle("capped", !w.sandbox && pl.supply >= cap && cap < 200);
      let workers = 0;
      for (const u of w.units) if (u.owner === g.me && KINDS[u.kind].worker) workers++;
      this.$("#res-wrk").textContent = String(workers);
      const idle = g.idleWorkers().length;
      const btn = this.$("#btn-idle");
      btn.hidden = idle === 0;
      btn.querySelector("b")!.textContent = String(idle);
    } else {
      // Spectating: everyone's resources.
      this.$("#resources").innerHTML = [...w.players.values()]
        .map((p) => `<span class="res" style="color:${teamColor(p.id)}">${esc(g.names[p.id] ?? `P${p.id}`)}</span><span class="res"><i class="ico min"></i>${p.m}</span><span class="res"><i class="ico gas"></i>${p.g}</span><span class="res"><i class="ico sup"></i>${p.supply}/${w.cap(p.id)}</span>`)
        .join("<span class='sep'></span>");
    }
  }
}
