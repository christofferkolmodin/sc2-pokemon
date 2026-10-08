import { FP, TICKS_PER_SECOND_X10 } from "../sim/fixed.ts";
import { KINDS } from "../sim/units.ts";
import { TUNE_DEFS } from "../sim/tuning.ts";
import type { Unit } from "../sim/world.ts";
import type { Game } from "./game.ts";
import { controlsHtml } from "./controls.ts";
import { ReplaySource } from "./sources.ts";

const COMMANDS: { key: string; hk: string; label: string; icon: string; act: (g: Game) => void; targeting?: string }[] = [
  { key: "move", hk: "M", label: "Move", icon: "➜", act: (g) => g.setTargeting("move"), targeting: "move" },
  { key: "stop", hk: "S", label: "Stop", icon: "■", act: (g) => g.issueStop(false) },
  { key: "hold", hk: "H", label: "Hold position", icon: "⛊", act: (g) => g.issueStop(true) },
  { key: "patrol", hk: "P", label: "Patrol", icon: "⇄", act: (g) => g.setTargeting("patrol"), targeting: "patrol" },
  { key: "attack", hk: "A", label: "Attack-move (moves until combat lands)", icon: "⚔", act: (g) => g.setTargeting("attack"), targeting: "attack" },
];

export class Hud {
  private $ = (s: string) => this.g.root.querySelector(s) as HTMLElement;
  private selSig = "";
  private singleHtml = "";
  private grpSig = "";
  private cmdSig = "";
  private lastStats = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private g: Game) {
    this.buildTuning();
    this.$("#help-list").innerHTML = controlsHtml();
    this.$("#btn-tuning").onclick = () => this.toggleTuning();
    this.$("#btn-help").onclick = () => this.$("#help").toggleAttribute("hidden");
    this.$("#btn-menu-full").onclick = () => g.goFullscreen();
    this.$("#btn-replay").onclick = () => this.downloadReplay();
    this.$("#btn-quit").onclick = () => {
      g.stop();
      location.reload();
    };
    const replay = g.source instanceof ReplaySource;
    this.$("#replay-controls").hidden = !replay;
    this.$("#btn-replay").hidden = replay;
    this.$("#btn-tuning").hidden = replay;
    for (const b of this.g.root.querySelectorAll<HTMLButtonElement>("#replay-controls button")) {
      b.onclick = () => (g.speed = Number(b.dataset.speed));
    }

    // Selection panel clicks (event delegation).
    this.$("#selpanel").addEventListener("click", (e) => {
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
    });
    this.$("#groups").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-g]") as HTMLElement | null;
      if (el) g.selection.recallGroup(Number(el.dataset.g), false);
    });
    this.$("#cmdcard").addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-cmd]") as HTMLElement | null;
      COMMANDS.find((c) => c.key === el?.dataset.cmd)?.act(g);
    });
  }

  // ---------------------------------------------------------------- tuning

  toggleTuning() {
    if (this.g.source instanceof ReplaySource) return;
    this.$("#tuning").toggleAttribute("hidden");
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
      this.g.source.send({ t: "tune", key: el.dataset.tune, value: Number(el.value) });
    });
    // Live label while dragging (the value is only sent on release).
    list.addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement;
      const v = list.querySelector(`[data-val="${el.dataset.tune}"]`);
      if (v) v.textContent = el.value;
    });

    const spawn = this.$("#spawn-list");
    const solo = this.g.source.kind === "solo";
    spawn.innerHTML = KINDS.map(
      (k, i) =>
        `<button data-ui data-spawn="${i}">+10 ${k.name}</button>` +
        (solo ? `<button data-ui data-spawn="${i}" data-owner="7">+10 enemy ${k.name}</button>` : ""),
    ).join("");
    spawn.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-spawn]") as HTMLElement | null;
      if (!el) return;
      const c = this.g.cam;
      const at = c.toWorld(c.w / 2, (c.h - c.consoleH) / 2);
      const owner = el.dataset.owner ? Number(el.dataset.owner) : undefined;
      this.g.source.send({
        t: "spawn",
        kind: Number(el.dataset.spawn),
        x: Math.round(at.x * FP),
        y: Math.round(at.y * FP),
        n: 10,
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

  toast(text: string) {
    const t = this.$("#toast");
    t.textContent = text;
    t.classList.add("show");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
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
    this.updateSelection();
    this.updateGroups();
    this.updateCommandCard();
    if (now - this.lastStats > 250) {
      this.lastStats = now;
      this.updateStats();
      this.syncTuning();
    }
  }

  private updateSelection() {
    const g = this.g;
    const ids = g.selection.ids;
    const sig = ids.join(",") + (g.selection.foreign ? "f" : "");
    if (sig !== this.selSig) {
      this.selSig = sig;
      this.singleHtml = "";
    } else if (ids.length !== 1) return;
    const panel = this.$("#selpanel");
    this.updatePortrait(ids[0]);
    if (ids.length === 0) {
      panel.innerHTML = `<div class="empty-sel">No selection</div>`;
      return;
    }
    if (ids.length === 1) {
      const u = g.world.byId.get(ids[0])!;
      const k = KINDS[u.kind];
      const order = u.holding ? "Holding position" : u.orders.length ? `${["Moving", "Attack-moving", "Patrolling"][u.orders[0].mode]}${u.orders.length > 1 ? ` (+${u.orders.length - 1} queued)` : ""}` : "Idle";
      const owner = g.names[u.owner] ?? (u.owner === 7 ? "Dummy" : `Player ${u.owner}`);
      const html = `<div class="single" data-single="${u.id}">
        <div class="big"><img src="${this.g.renderer.unitIcon(u.kind, u.owner, 72)}" alt=""></div>
        <div><h4>${k.name}</h4>
          <div class="meta">${owner} · <b>${k.type}</b>${k.air ? " · <b>air</b>" : ""} · supply <b>${k.supply}</b></div>
          <div class="meta">Moves like an SC2 <span class="ref">${k.ref}</span> · speed <b>${((k.speed * 22.4) / FP).toFixed(2)}</b> · radius <b>${(k.radius / FP).toFixed(3)}</b></div>
          <div class="meta">${order}</div></div></div>`;
      if (this.singleHtml !== html) panel.innerHTML = this.singleHtml = html;
      return;
    }
    const MAX = 48;
    const units = ids.slice(0, MAX).map((id) => g.world.byId.get(id)!) as Unit[];
    panel.innerHTML =
      `<div class="wire">${units.map((u) => `<div class="u" data-id="${u.id}" title="${KINDS[u.kind].name}"><img src="${this.g.renderer.unitIcon(u.kind, u.owner, 40)}" alt=""></div>`).join("")}</div>` +
      (ids.length > MAX ? `<div class="sel-more">+${ids.length - MAX} more (${ids.length} selected)</div>` : "");
  }

  private portraitKey = "";

  /** SC2 shows the first selected unit's portrait between the info panel and the command card. */
  private updatePortrait(id: number | undefined) {
    const u = id === undefined ? undefined : this.g.world.byId.get(id);
    const key = u ? `${u.kind}:${u.owner}` : "";
    if (key === this.portraitKey) return;
    this.portraitKey = key;
    this.$("#portrait .pframe").innerHTML = u ? `<img src="${this.g.renderer.unitIcon(u.kind, u.owner, 140)}" alt="">` : "";
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

  private updateCommandCard() {
    const g = this.g;
    const can = g.canCommand && g.selection.commandable().length > 0;
    const sig = `${can}|${g.targeting}`;
    if (sig === this.cmdSig) return;
    this.cmdSig = sig;
    const cells: string[] = [];
    for (let i = 0; i < 15; i++) {
      const c = COMMANDS[i];
      if (!c || !can) cells.push(`<button class="cmd empty" tabindex="-1"></button>`);
      else
        cells.push(
          `<button class="cmd${c.targeting && g.targeting === c.targeting ? " active" : ""}" data-ui data-cmd="${c.key}" title="${c.label} (${c.hk})" tabindex="-1"><span class="hk">${c.hk}</span>${c.icon}</button>`,
        );
    }
    this.$("#cmdcard").innerHTML = cells.join("");
  }

  private updateStats() {
    const g = this.g;
    const secs = Math.floor((g.world.tick * 10) / TICKS_PER_SECOND_X10);
    const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    const lines = [`<b>${time}</b>  tick ${g.world.tick}  ${Math.round(g.fps)} fps`];
    const src = g.source;
    if (src.kind === "net") {
      const rtt = (src as unknown as { rtt: number }).rtt;
      lines.push(`ping ${Math.round(rtt)} ms  buffer ${src.buffered()}`);
    } else if (src.kind === "replay") {
      lines.push(`replay ${g.speed}×  ${g.replayStatus}`);
    } else lines.push("solo lab");
    lines.push(`${g.world.units.length} units  sim ${g.simMs.toFixed(2)} ms/tick  hash ${g.world.hash().toString(16).padStart(8, "0")}`);
    this.$("#stats").innerHTML = lines.join("\n");
    if (g.me !== -1) {
      let used = 0;
      for (const u of g.world.units) if (u.owner === g.me) used += KINDS[u.kind].supply;
      this.$("#supply").textContent = `${used}/200`;
    } else this.$("#resources").hidden = true;
  }
}
