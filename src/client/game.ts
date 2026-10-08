import { FP, TICK_MS } from "../sim/fixed.ts";
import { type Command, MODE_ATTACK, MODE_ATTACK_UNIT, MODE_GATHER, MODE_MOVE, MODE_PATROL, MODE_RETURN, type Turn } from "../sim/commands.ts";
import { footprintFree } from "../sim/map.ts";
import { KINDS, K_CENTER, K_EXTRACTOR, K_GEYSER, K_MINERAL, K_PIKACHU } from "../sim/units.ts";
import { type SimEvent, type Unit, World, type WorldOptions } from "../sim/world.ts";
import { HASH_INTERVAL, type Replay, ReplayRecorder } from "../sim/replay.ts";
import type { RenderData } from "../maps/load.ts";
import { Bot, type Difficulty } from "../ai/bot.ts";
import { Camera } from "./camera.ts";
import { type Placement, Renderer } from "./render/renderer.ts";
import type { GltfModels } from "./render/gltf.ts";
import { Minimap } from "./minimap.ts";
import { Selection } from "./selection.ts";
import { Pointer, type PointerEvt } from "./pointer.ts";
import { Hud } from "./hud.ts";
import { Audio } from "./audio.ts";
import { NetSource, ReplaySource, type TurnSource } from "./sources.ts";
import { SELECT_ENEMY, SELECT_NEUTRAL, SELECT_OWN } from "./style.ts";

export type Targeting = "move" | "attack" | "patrol" | "rally" | "gather" | null;
export type CardMode = "main" | "build" | "build2";

const EDGE_PX = 3;
const SCROLL_TILES_PER_SEC = 30;
const DRAG_THRESHOLD = 5;
const DOUBLE_TAP_MS = 350;

export interface GameSetup {
  root: HTMLElement;
  source: TurnSource;
  options: WorldOptions;
  /** Local player id (-1 = spectator). */
  me: number;
  names: Record<number, string>;
  render: RenderData;
  minimap: HTMLImageElement | null;
  /** Computer players this machine runs. */
  bots: { id: number; difficulty: Difficulty }[];
  /** Real models from assets-private/models, if any. */
  models: GltfModels | null;
}

/** One command-card button (built by the HUD, also used for hotkeys). */
export interface CardButton {
  key: string;
  hk: string;
  label: string;
  icon: string;
  img?: string;
  tip?: string;
  disabled?: boolean;
  active?: boolean;
  act: () => void;
}

interface Alert {
  x: number;
  y: number;
  t: number;
}

/**
 * Owns one running game: sim world, turn source, input and presentation.
 * The sim only changes through `source` turns; everything else here is
 * client-side presentation and can use floats freely.
 */
export class Game {
  readonly world: World;
  readonly cam: Camera;
  readonly renderer: Renderer;
  readonly minimap: Minimap;
  readonly selection: Selection;
  readonly pointer: Pointer;
  readonly hud: Hud;
  readonly audio = new Audio();
  readonly recorder: ReplayRecorder;
  readonly source: TurnSource;
  readonly options: WorldOptions;
  readonly me: number;
  readonly names: Record<number, string>;
  readonly root: HTMLElement;
  readonly bots: Bot[];

  targeting: Targeting = null;
  placing: number | null = null;
  placement: Placement | null = null;
  cardMode: CardMode = "main";
  /** Active subgroup (Tab cycles through unit kinds in the selection). */
  subgroup = 0;
  speed = 1;
  alpha = 0;
  fps = 0;
  fog = true;
  bars: "always" | "damaged" = "damaged";
  private frameMs = 16;
  simMs = 0;
  desynced = false;
  replayStatus = "";
  over: "victory" | "defeat" | null = null;

  private acc = 0;
  private last = performance.now();
  private running = true;
  private drag: { x0: number; y0: number; x1: number; y1: number; shift: boolean; ctrl: boolean } | null = null;
  private panDrag: { x: number; y: number } | null = null;
  private mmDrag = false;
  private held = new Set<string>();
  private shift = false;
  private lastTap = { g: -1, t: 0 };
  private lastClick = { id: -1, t: 0 };
  private hoverId = -1;
  private replayHashes: Map<number, number> | null = null;
  private alerts: Alert[] = [];
  private lastAlertSay = -1e9;
  private idleCycle = 0;
  private baseCycle = 0;

  constructor(s: GameSetup) {
    this.root = s.root;
    this.source = s.source;
    this.options = s.options;
    this.me = s.me;
    this.names = s.names;
    this.world = new World(s.options);
    this.recorder = new ReplayRecorder(s.options, s.names);
    this.cam = new Camera(this.world.map.w, this.world.map.h);
    this.renderer = new Renderer(s.root.querySelector("#view")!, s.root.querySelector("#overlay")!, this.world, this.cam, s.render, s.minimap, s.models);
    this.minimap = new Minimap(s.root.querySelector("#minimap")!, this.world, this.cam, s.minimap, this.renderer);
    this.selection = new Selection(this.world, this.me);
    this.pointer = new Pointer(s.root, s.root.querySelector("#minimap")!);
    this.bots = s.bots.map((b) => new Bot(this.world, b.id, b.difficulty));
    this.hud = new Hud(this);

    if (this.source instanceof ReplaySource) {
      this.replayHashes = new Map(this.source.replay.hashes);
      this.replayStatus = "verifying…";
      this.fog = false;
    }
    if (this.source instanceof NetSource) {
      const src = this.source;
      src.onDesync = (tick, hashes) => {
        this.desynced = true;
        const list = Object.entries(hashes)
          .map(([id, h]) => `${this.names[Number(id)] ?? id}: ${h.toString(16)}`)
          .join(" · ");
        this.hud.banner(`Desync at tick ${tick}. The simulations diverged (${list}). Save the replay and keep it for debugging.`);
      };
      src.onLeft = (name) => this.hud.toast(`${name} left the game`);
      src.onClosed = () => this.hud.banner("Disconnected from the server.");
      src.onChat = (from, name, text) => this.hud.chatLine(name, text, from);
      src.onPing = (from, x, y) => {
        if (this.me === -1 || this.world.allied(from, this.me)) {
          this.minimap.ping(x, y, "#ffd23c");
          this.audio.ui();
        }
      };
    }

    this.pointer.onDown = (e) => this.mouseDown(e);
    this.pointer.onMove = (e) => this.mouseMove(e);
    this.pointer.onUp = (e) => this.mouseUp(e);
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    window.addEventListener("blur", this.blur);
    window.addEventListener("resize", this.onResize);

    this.resize();
    // Start looking at our own base.
    const mine = this.world.units.filter((u) => u.owner === this.me);
    const hall = mine.find((u) => u.kind === K_CENTER);
    const c = hall ? { x: hall.x / FP, y: hall.y / FP } : this.selection.centroid((mine.length ? mine : this.world.units.filter((u) => !KINDS[u.kind].resource)).map((u) => u.id));
    if (c) {
      this.cam.centerOn(c.x, c.y);
      this.cam.th = this.renderer.heightAt(c.x, c.y);
      this.cam.update();
    }
    requestAnimationFrame(this.frame);
  }

  get canCommand() {
    return this.source.kind !== "replay" && !this.over;
  }

  private blur = () => {
    this.held.clear();
    this.shift = false;
  };

  private onResize = () => this.resize();

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.cam.consoleH = (this.root.querySelector("#console") as HTMLElement).offsetHeight;
    this.cam.resize(w, h);
    this.renderer.resize(w, h);
    this.minimap.layout();
  }

  stop() {
    this.running = false;
    this.source.close();
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    window.removeEventListener("blur", this.blur);
    window.removeEventListener("resize", this.onResize);
  }

  // ------------------------------------------------------------------- loop

  private stepTurn(turn: Turn) {
    const t0 = performance.now();
    this.world.step(turn.cmds);
    this.simMs = this.simMs * 0.95 + (performance.now() - t0) * 0.05;
    this.recorder.record(turn, this.world);
    this.handleEvents(this.world.events);
    // Computer players think after each tick; their commands run next tick, like a human's.
    if (this.source.kind !== "replay") for (const b of this.bots) for (const c of b.think()) this.source.sendAs(b.pid, c);
    if (this.world.tick % HASH_INTERVAL === 0) {
      if (this.source instanceof NetSource) this.source.sendHash(this.world.tick, this.world.hash());
      if (this.replayHashes) {
        const want = this.replayHashes.get(this.world.tick);
        if (want !== undefined && want !== this.world.hash() && !this.desynced) {
          this.desynced = true;
          this.replayStatus = `mismatch at tick ${this.world.tick}`;
          this.hud.banner(`Replay diverged at tick ${this.world.tick}: the sim code changed since it was recorded.`);
        }
      }
    }
    if (this.source instanceof ReplaySource && !this.desynced && this.world.tick >= this.source.replay.endTick) {
      this.replayStatus = "verified ✓ (bit-identical)";
    }
  }

  private frame = () => {
    if (!this.running) return;
    // performance.now() rather than the rAF timestamp: some browsers hand out
    // vsync-aligned timestamps that drift from wall time when frames are slow.
    const now = performance.now();
    const raw = now - this.last;
    const dt = Math.min(250, raw);
    this.last = now;
    this.frameMs = this.frameMs * 0.9 + raw * 0.1;
    this.fps = 1000 / Math.max(1, this.frameMs);

    this.acc += dt * this.speed;
    let steps = 0;
    while (this.acc >= TICK_MS) {
      const turn = this.source.next(this.world.tick + 1);
      if (!turn) {
        this.acc = Math.min(this.acc, TICK_MS); // waiting for the network: hold the last frame
        break;
      }
      this.stepTurn(turn);
      this.acc -= TICK_MS;
      if (++steps > 16) {
        this.acc = 0;
        break;
      }
    }
    // Multiplayer: if turns piled up (tab was in background, hiccup), catch up quickly.
    if (this.source.kind === "net") {
      let extra = this.source.buffered() - 3;
      while (extra-- > 0) {
        const turn = this.source.next(this.world.tick + 1);
        if (!turn) break;
        this.stepTurn(turn);
      }
    }
    this.alpha = Math.max(0, Math.min(1, this.acc / TICK_MS));
    this.selection.clean();
    if (this.subgroup >= this.subgroups().length) this.subgroup = 0;

    this.scroll(dt / 1000);
    this.updateHover();
    this.updatePlacement();
    this.renderer.draw({
      alpha: this.alpha,
      now,
      dt: dt / 1000,
      selection: this.selection,
      hoverId: this.hoverId,
      dragBox: this.drag && this.isDragging() ? this.drag : null,
      showWaypoints: this.shift || this.selection.ids.some((id) => KINDS[this.world.byId.get(id)?.kind ?? 0].structure),
      cursor: this.pointer.locked ? { x: this.pointer.x, y: this.pointer.y, targeting: this.targeting ?? (this.placing !== null ? "move" : null) } : null,
      me: this.me,
      placement: this.placement,
      fog: this.fog,
      bars: this.bars,
    });
    this.minimap.draw(now, this.me, this.fog);
    this.hud.update(now);
    this.root.style.cursor = (this.targeting || this.placing !== null) && !this.pointer.locked ? "crosshair" : "";
    requestAnimationFrame(this.frame);
  };

  private scroll(dt: number) {
    let dx = 0;
    let dy = 0;
    if (this.held.has("ArrowLeft")) dx--;
    if (this.held.has("ArrowRight")) dx++;
    if (this.held.has("ArrowUp")) dy--;
    if (this.held.has("ArrowDown")) dy++;
    // Edge scrolling: always when the cursor is locked, and in fullscreen.
    const p = this.pointer;
    const edgeOk = p.inside && (p.locked || document.fullscreenElement) && !this.panDrag;
    if (edgeOk) {
      if (p.x <= EDGE_PX) dx--;
      if (p.x >= window.innerWidth - 1 - EDGE_PX) dx++;
      if (p.y <= EDGE_PX) dy--;
      if (p.y >= window.innerHeight - 1 - EDGE_PX) dy++;
    }
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      this.cam.pan((dx / len) * SCROLL_TILES_PER_SEC * dt, (dy / len) * SCROLL_TILES_PER_SEC * dt);
    }
  }

  private updateHover() {
    const p = this.pointer;
    if (!p.inside || this.zoneUnderCursor() !== "world") {
      this.hoverId = -1;
      return;
    }
    this.hoverId = this.renderer.pick(p.x, p.y, this.alpha)?.id ?? -1;
  }

  private zoneUnderCursor() {
    const el = document.elementFromPoint(this.pointer.x, this.pointer.y);
    if (!el || el.id === "view" || el.id === "game") return "world";
    return "other";
  }

  // ------------------------------------------------------------ selection

  /** Kinds in the current selection, in SC2 order (the selection is sorted by kind). */
  subgroups(): number[] {
    const out: number[] = [];
    for (const id of this.selection.ids) {
      const k = this.world.byId.get(id)?.kind;
      if (k !== undefined && !out.includes(k)) out.push(k);
    }
    return out;
  }

  /** Kind of the active subgroup (whose commands the card shows). */
  activeKind(): number {
    const g = this.subgroups();
    return g[this.subgroup % Math.max(1, g.length)] ?? -1;
  }

  /** Commandable ids of the active subgroup. */
  activeIds(): number[] {
    const k = this.activeKind();
    return this.selection.commandable().filter((id) => this.world.byId.get(id)?.kind === k);
  }

  private mine(): Unit[] {
    return this.selection.commandable().map((id) => this.world.byId.get(id)!).filter(Boolean);
  }

  // ------------------------------------------------------------- commands

  send(c: Command) {
    if (!this.canCommand) return;
    this.source.send(c);
  }

  private marker(x: number, y: number, color: string) {
    this.renderer.markers.push({ x, y, color, t0: performance.now() });
  }

  /** Units that take movement orders (not structures, not evolving). */
  private movers(): number[] {
    return this.mine()
      .filter((u) => !KINDS[u.kind].structure && u.morphTo < 0)
      .map((u) => u.id);
  }

  issueMove(mode: number, wx: number, wy: number, queue: boolean) {
    const ids = this.movers();
    if (!this.canCommand || ids.length === 0) return;
    this.send({ t: "move", ids, x: Math.round(wx * FP), y: Math.round(wy * FP), q: queue, mode });
    // Instant local feedback: the units start moving ~1 turn later, but the click registers now.
    this.marker(wx, wy, mode === MODE_ATTACK ? SELECT_ENEMY : mode === MODE_PATROL ? SELECT_NEUTRAL : SELECT_OWN);
    this.cry(ids);
  }

  issueStop(hold: boolean) {
    const ids = this.movers();
    if (!this.canCommand || ids.length === 0) return;
    this.send({ t: hold ? "hold" : "stop", ids });
  }

  private cry(ids: number[]) {
    const u = this.world.byId.get(ids[0]);
    if (u) this.audio.cry(u.kind);
  }

  /** SC2 smart command (right click). */
  smart(wx: number, wy: number, target: Unit | null, queue: boolean) {
    if (!this.canCommand) return;
    const units = this.mine();
    if (units.length === 0) return;
    const structures = units.filter((u) => KINDS[u.kind].structure);
    const movers = units.filter((u) => !KINDS[u.kind].structure && u.morphTo < 0);
    if (movers.length === 0 && structures.length > 0) {
      this.send({ t: "rally", ids: structures.map((u) => u.id), x: Math.round(wx * FP), y: Math.round(wy * FP), id: target && target.owner !== this.me ? (KINDS[target.kind].resource ? target.id : 0) : target?.id ?? 0 });
      this.marker(wx, wy, SELECT_OWN);
      return;
    }
    if (target) {
      const tk = KINDS[target.kind];
      const enemy = target.owner !== 0 && !this.world.allied(this.me, target.owner);
      if (enemy || tk.resource === 3) {
        this.send({ t: "target", ids: movers.map((u) => u.id), id: target.id, q: queue, mode: MODE_ATTACK_UNIT });
        this.marker(target.x / FP, target.y / FP, SELECT_ENEMY);
        this.cry(movers.map((u) => u.id));
        return;
      }
      const workers = movers.filter((u) => KINDS[u.kind].worker);
      const others = movers.filter((u) => !KINDS[u.kind].worker);
      const gatherable = target.kind === K_MINERAL || (target.kind === K_EXTRACTOR && target.owner === this.me);
      const dropoff = target.owner === this.me && KINDS[target.kind].dropoff;
      if (workers.length && (gatherable || (dropoff && workers.some((u) => u.carry > 0)))) {
        this.send({ t: "target", ids: workers.map((u) => u.id), id: target.id, q: queue, mode: gatherable ? MODE_GATHER : MODE_RETURN });
        if (others.length) this.send({ t: "move", ids: others.map((u) => u.id), x: target.x, y: target.y, q: queue, mode: MODE_MOVE });
        this.marker(target.x / FP, target.y / FP, SELECT_OWN);
        return;
      }
      if (target.kind === K_GEYSER) {
        this.marker(wx, wy, SELECT_OWN);
        this.issueMove(MODE_MOVE, wx, wy, queue);
        return;
      }
    }
    this.issueMove(MODE_MOVE, wx, wy, queue);
  }

  setTargeting(t: Targeting) {
    if (t && this.selection.commandable().length === 0) return;
    this.targeting = t;
    this.placing = null;
  }

  startPlacing(kind: number) {
    if (!this.canCommand) return;
    this.placing = kind;
    this.targeting = null;
  }

  cancelModes() {
    this.targeting = null;
    this.placing = null;
    this.cardMode = "main";
  }

  private targetClick(wx: number, wy: number, target: Unit | null, shift: boolean) {
    const t = this.targeting;
    if (t === "attack") {
      // SC2: A-click on any unit attacks it, your own included (friendly fire).
      if (target && (target.owner !== 0 || KINDS[target.kind].resource === 3) && !this.selection.ids.every((id) => id === target.id)) {
        this.send({ t: "target", ids: this.movers(), id: target.id, q: shift, mode: MODE_ATTACK_UNIT });
        this.marker(target.x / FP, target.y / FP, SELECT_ENEMY);
      } else this.issueMove(MODE_ATTACK, wx, wy, shift);
    } else if (t === "patrol") this.issueMove(MODE_PATROL, wx, wy, shift);
    else if (t === "rally") {
      const ids = this.mine().filter((u) => KINDS[u.kind].structure).map((u) => u.id);
      this.send({ t: "rally", ids, x: Math.round(wx * FP), y: Math.round(wy * FP), id: target?.id ?? 0 });
      this.marker(wx, wy, SELECT_OWN);
    } else if (t === "gather") {
      if (target) this.smart(wx, wy, target, shift);
    } else this.issueMove(MODE_MOVE, wx, wy, shift);
    if (!shift) this.targeting = null;
  }

  // ------------------------------------------------------------ placement

  /** Footprint top-left for a structure centred under the cursor (extractors snap to geysers). */
  private updatePlacement() {
    if (this.placing === null || !this.pointer.inside || this.zoneUnderCursor() !== "world") {
      this.placement = null;
      return;
    }
    const k = KINDS[this.placing];
    const w = this.cam.toWorld(this.pointer.x, this.pointer.y);
    let tx = Math.round(w.x - k.w / 2);
    let ty = Math.round(w.y - k.h / 2);
    if (this.placing === K_EXTRACTOR) {
      let best: Unit | null = null;
      let bd = 4;
      for (const u of this.world.units) {
        if (u.kind !== K_GEYSER || u.link) continue;
        const d = Math.hypot(u.x / FP - w.x, u.y / FP - w.y);
        if (d < bd) {
          bd = d;
          best = u;
        }
      }
      if (best) {
        tx = best.tx;
        ty = best.ty;
      }
    }
    const m = this.world.map;
    const tiles = new Uint8Array(k.w * k.h);
    for (let j = 0; j < k.h; j++)
      for (let i = 0; i < k.w; i++) {
        const x = tx + i;
        const y = ty + j;
        const explored = this.me === -1 || (this.world.explored.get(this.world.teamOf(this.me))?.[y * m.w + x] ?? 0);
        tiles[j * k.w + i] = this.placing === K_EXTRACTOR ? 1 : footprintFree(m, x, y, 1, 1) && explored ? 1 : 0;
      }
    const builder = this.mine().find((u) => KINDS[u.kind].worker) ?? null;
    const err = this.world.placeError(this.me, this.placing, tx, ty, builder);
    this.placement = { kind: this.placing, tx, ty, tiles, ok: err === null && tiles.every((v) => v === 1) };
  }

  private placeClick(shift: boolean) {
    const pl = this.placement;
    if (!pl || this.placing === null) return;
    if (!pl.ok) {
      this.hud.error("Can't build there.");
      return;
    }
    const workers = this.mine().filter((u) => KINDS[u.kind].worker);
    if (!workers.length) return;
    this.send({ t: "build", ids: workers.map((u) => u.id), kind: pl.kind, tx: pl.tx, ty: pl.ty, q: shift });
    this.marker(pl.tx + KINDS[pl.kind].w / 2, pl.ty + KINDS[pl.kind].h / 2, SELECT_OWN);
    if (!shift) {
      this.placing = null;
      this.cardMode = "main";
    }
  }

  // ---------------------------------------------------------------- mouse

  private isDragging() {
    const d = this.drag;
    return !!d && Math.hypot(d.x1 - d.x0, d.y1 - d.y0) >= DRAG_THRESHOLD;
  }

  private mouseDown(e: PointerEvt) {
    this.audio.resume();
    if (document.fullscreenElement && !this.pointer.locked) this.pointer.requestLock();
    if (e.zone === "minimap") {
      const w = this.minimap.toWorld(e.mx, e.my);
      if (e.button === 0) {
        if (e.alt && this.source instanceof NetSource) {
          this.source.ping(Math.round(w.x), Math.round(w.y));
          this.minimap.ping(w.x, w.y, "#ffd23c");
        } else if (this.targeting) this.targetClick(w.x, w.y, null, e.shift);
        else {
          this.mmDrag = true;
          this.cam.centerOn(w.x, w.y);
        }
      } else if (e.button === 2) {
        this.smart(w.x, w.y, null, e.shift);
      }
      return;
    }
    if (e.button === 1) {
      this.panDrag = { x: e.x, y: e.y };
      return;
    }
    if (e.button === 2) {
      if (this.targeting || this.placing !== null) {
        this.cancelModes(); // right click cancels targeting / placement, like SC2
        return;
      }
      const w = this.cam.toWorld(e.x, e.y);
      this.smart(w.x, w.y, this.renderer.pick(e.x, e.y, this.alpha), e.shift);
      return;
    }
    if (e.button === 0) {
      if (this.placing !== null) {
        this.placeClick(e.shift);
        return;
      }
      if (this.targeting) {
        const w = this.cam.toWorld(e.x, e.y);
        this.targetClick(w.x, w.y, this.renderer.pick(e.x, e.y, this.alpha), e.shift);
        return;
      }
      this.drag = { x0: e.x, y0: e.y, x1: e.x, y1: e.y, shift: e.shift, ctrl: e.ctrl };
    }
  }

  private mouseMove(e: PointerEvt) {
    if (this.drag) {
      this.drag.x1 = e.x;
      this.drag.y1 = e.y;
    }
    if (this.panDrag) {
      this.cam.pan(-(e.x - this.panDrag.x) / this.cam.ppt, -(e.y - this.panDrag.y) / this.cam.ppt);
      this.panDrag = { x: e.x, y: e.y };
    }
    if (this.mmDrag) {
      const w = this.minimap.toWorld(e.mx, e.my);
      this.cam.centerOn(w.x, w.y);
    }
  }

  private mouseUp(e: PointerEvt) {
    if (e.button === 1) this.panDrag = null;
    if (e.button !== 0) return;
    this.mmDrag = false;
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const sel = this.selection;
    const before = sel.ids.join(",");
    if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) >= DRAG_THRESHOLD) {
      const hits = this.renderer.pickBox(d.x0, d.y0, d.x1, d.y1, this.alpha);
      // SC2 box select prefers units over structures, and your own over anyone else's.
      const mine = hits.filter((u) => sel.isMine(u));
      const mobile = mine.filter((u) => !KINDS[u.kind].structure);
      const pick = mobile.length ? mobile : mine;
      if (pick.length > 0) {
        if (d.shift) sel.add(pick.map((u) => u.id));
        else sel.set(pick.map((u) => u.id));
      } else if (hits.length > 0 && !d.shift) {
        sel.set([hits[0].id], true);
      }
    } else {
      // Click.
      const u = this.renderer.pick(d.x0, d.y0, this.alpha);
      if (!u) return; // clicking empty ground keeps the selection (SC2)
      const now = performance.now();
      const double = this.lastClick.id === u.id && now - this.lastClick.t < 300;
      this.lastClick = { id: u.id, t: now };
      if (!sel.isMine(u)) sel.set([u.id], true);
      else if (d.ctrl || double) {
        const same = this.world.units.filter((o) => o.owner === u.owner && o.kind === u.kind && this.renderer.onScreen(o, this.alpha));
        if (d.shift) sel.add(same.map((o) => o.id));
        else sel.set(same.map((o) => o.id));
      } else if (d.shift) sel.toggle(u.id);
      else sel.set([u.id]);
    }
    if (sel.ids.join(",") !== before) {
      this.subgroup = 0;
      this.cardMode = "main";
      const first = this.world.byId.get(sel.ids[0]);
      if (first && sel.isMine(first) && !KINDS[first.kind].structure) this.audio.cry(first.kind);
    }
  }

  // ------------------------------------------------------------- keyboard

  private keyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target?.tagName === "INPUT" && (target as HTMLInputElement).type !== "range") return;
    this.audio.resume();
    const code = e.code;
    if (code === "ShiftLeft" || code === "ShiftRight") this.shift = true;
    if (code.startsWith("Arrow")) {
      this.held.add(code);
      e.preventDefault();
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    // Control groups: Digit1..Digit0.
    const dm = /^Digit(\d)$/.exec(code);
    if (dm) {
      e.preventDefault();
      const g = Number(dm[1]);
      const sel = this.selection;
      if (ctrl) sel.setGroup(g);
      else if (e.shiftKey) sel.addToGroup(g);
      else if (e.altKey) sel.stealToGroup(g);
      else if (!e.repeat && sel.recallGroup(g, false)) {
        this.subgroup = 0;
        this.cardMode = "main";
        const now = performance.now();
        if (this.lastTap.g === g && now - this.lastTap.t < DOUBLE_TAP_MS) {
          const c = sel.centroid(sel.ids);
          if (c) this.cam.centerOn(c.x, c.y);
        }
        this.lastTap = { g, t: now };
      }
      return;
    }
    const fk = /^F([5-8])$/.exec(code);
    if (fk) {
      e.preventDefault();
      const i = Number(fk[1]) - 5;
      if (ctrl) {
        this.cam.saved[i] = { x: this.cam.x, y: this.cam.y };
        this.hud.toast(`Camera location ${i + 1} saved`);
      } else if (this.cam.saved[i]) {
        this.cam.x = this.cam.saved[i]!.x;
        this.cam.y = this.cam.saved[i]!.y;
        this.cam.clamp();
      }
      return;
    }
    if (e.repeat) return;
    // Command card hotkeys first (SC2: the grid follows the active subgroup).
    const letter = /^Key([A-Z])$/.exec(code)?.[1];
    if (letter && !ctrl && !e.altKey) {
      const b = this.hud.buttons.find((x) => x.hk === letter && !x.disabled);
      if (b) {
        e.preventDefault();
        this.audio.ui();
        b.act();
        this.hud.refreshCard();
        return;
      }
    }
    switch (code) {
      case "KeyS":
        if (ctrl) break; // swallow Ctrl+S so the browser doesn't open "Save page"
        return;
      case "Escape":
        if (this.cardMode !== "main" || this.targeting || this.placing !== null) this.cancelModes();
        else if (!this.cancelWork()) this.hud.closePanels();
        this.hud.refreshCard();
        break;
      case "Tab":
        this.subgroup = (this.subgroup + (e.shiftKey ? -1 + this.subgroups().length : 1)) % Math.max(1, this.subgroups().length);
        this.cardMode = "main";
        break;
      case "F1":
        this.selectIdleWorker(ctrl);
        break;
      case "F2":
        if (this.me !== -1) this.selection.set(this.world.units.filter((u) => u.owner === this.me && !KINDS[u.kind].structure && !KINDS[u.kind].worker).map((u) => u.id));
        this.subgroup = 0;
        break;
      case "Backspace":
        this.cycleBase();
        break;
      case "Space":
        this.jumpToAlert();
        break;
      case "Enter":
        if (this.source instanceof NetSource) this.hud.openChat();
        break;
      case "F10":
        this.hud.toggleMenu();
        break;
      case "F9":
        this.hud.toggleTuning();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  private keyUp = (e: KeyboardEvent) => {
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.shift = false;
    this.held.delete(e.code);
  };

  /**
   * Esc with nothing else to cancel, like SC2: cancel construction of the selected
   * buildings, else the last item in a production queue, else evolutions in progress.
   * Returns false if there was nothing to cancel.
   */
  cancelWork(): boolean {
    if (!this.canCommand) return false;
    const units = this.activeIds().map((id) => this.world.byId.get(id)!).filter(Boolean);
    const building = units.filter((u) => KINDS[u.kind].structure && !this.world.isDone(u));
    if (building.length) {
      for (const u of building) this.send({ t: "cancel", id: u.id, slot: -1 });
      return true;
    }
    const busy = units.filter((u) => KINDS[u.kind].structure && u.queue.length > 0).sort((a, b) => b.queue.length - a.queue.length)[0];
    if (busy) {
      this.send({ t: "cancel", id: busy.id, slot: busy.queue.length - 1 });
      return true;
    }
    const morphing = units.filter((u) => u.morphTo >= 0);
    for (const u of morphing) this.send({ t: "cancel", id: u.id, slot: -1 });
    return morphing.length > 0;
  }

  idleWorkers(): Unit[] {
    return this.world.units.filter((u) => u.owner === this.me && KINDS[u.kind].worker && u.orders.length === 0 && !u.hidden && u.morphTo < 0);
  }

  selectIdleWorker(all: boolean) {
    const idle = this.idleWorkers();
    if (!idle.length) return;
    if (all) this.selection.set(idle.map((u) => u.id));
    else {
      const u = idle[this.idleCycle++ % idle.length];
      this.selection.set([u.id]);
      this.cam.centerOn(u.x / FP, u.y / FP);
    }
    this.subgroup = 0;
    this.cardMode = "main";
  }

  private cycleBase() {
    const halls = this.world.units.filter((u) => u.owner === this.me && u.kind === K_CENTER);
    if (!halls.length) return;
    const h = halls[this.baseCycle++ % halls.length];
    this.cam.centerOn(h.x / FP, h.y / FP);
  }

  private jumpToAlert() {
    const a = this.alerts[this.alerts.length - 1];
    if (a) this.cam.centerOn(a.x, a.y);
  }

  // --------------------------------------------------------------- events

  /** 0..1: how close a world point is to what the player is looking at (for sound). */
  private near(x: number, y: number): number {
    const fp = this.cam.footprint();
    const cx = fp.reduce((s, p) => s + p.x, 0) / 4;
    const cy = fp.reduce((s, p) => s + p.y, 0) / 4;
    const d = Math.hypot(x - cx, y - cy);
    return Math.max(0, Math.min(1, 1.4 - d / 22)) * (this.renderer.seen(x, y) ? 1 : 0);
  }

  private handleEvents(events: SimEvent[]) {
    const now = performance.now();
    this.renderer.onEvents(events, now);
    const w = this.world;
    for (const e of events) {
      switch (e.e) {
        case "attack": {
          const u = w.byId.get(e.id);
          if (u) this.audio.attack(KINDS[u.kind].weapon!.fx, this.near(u.x / FP, u.y / FP));
          break;
        }
        case "hit":
          this.audio.hit(this.near(e.x / FP, e.y / FP) * 0.6);
          break;
        case "death": {
          const k = KINDS[e.kind];
          const n = this.near(e.x / FP, e.y / FP);
          if (k.structure && !k.resource) this.audio.explosion(n);
          else if (!k.resource) this.audio.faint(n);
          break;
        }
        case "error":
          if (e.p === this.me) this.hud.simError(e.msg);
          break;
        case "attacked": {
          if (e.p !== this.me) break;
          const x = e.x / FP;
          const y = e.y / FP;
          const recent = this.alerts.find((a) => now - a.t < 15000 && Math.hypot(a.x - x, a.y - y) < 18);
          if (recent) break;
          this.alerts.push({ x, y, t: now });
          if (this.alerts.length > 8) this.alerts.shift();
          this.minimap.ping(x, y, "#ff3b30");
          const u = w.byId.get(e.id);
          const base = u && (KINDS[u.kind].structure || KINDS[u.kind].worker);
          if (now - this.lastAlertSay > 8000) {
            this.lastAlertSay = now;
            this.audio.say(base ? "Your base is under attack" : "Your forces are under attack", 8000);
          }
          this.hud.toast(base ? "Your base is under attack" : "Your forces are under attack", "#ff6a5c");
          break;
        }
        case "built":
          if (e.owner === this.me) {
            this.audio.ready();
            const k = KINDS[e.kind];
            if (k.research || k.id === K_CENTER) this.hud.toast(`${k.name} complete`);
          }
          break;
        case "trained":
          if (e.owner === this.me && KINDS[e.kind].worker === false) this.audio.ui();
          break;
        case "evolved":
          if (e.owner === this.me) {
            this.audio.evolve();
            this.hud.toast(`Your Pokémon evolved into ${KINDS[e.kind].name}!`, "#ffffff");
          }
          break;
        case "research":
          if (e.owner === this.me) {
            this.audio.say("Research complete");
            this.hud.toast(`${["Attack", "Defense"][e.up]} level ${e.lvl} complete`);
          }
          break;
        case "defeat":
          if (e.p === this.me) {
            this.over = "defeat";
            this.hud.gameOver(false);
          } else this.hud.toast(`${this.names[e.p] ?? "A player"} has been defeated`);
          break;
        case "victory":
          if (this.me !== -1 && e.team === w.teamOf(this.me)) {
            this.over = "victory";
            this.hud.gameOver(true);
          } else if (this.me === -1) this.hud.toast("Game over");
          break;
      }
    }
  }

  // ----------------------------------------------------------------- misc

  async goFullscreen() {
    try {
      await document.documentElement.requestFullscreen();
      // Lets Ctrl+1..0, Ctrl+W, Esc etc. reach the game instead of the browser (Chromium only).
      await (navigator as unknown as { keyboard?: { lock?: () => Promise<void> } }).keyboard?.lock?.();
    } catch {
      /* not supported: fine */
    }
    this.pointer.requestLock();
  }

  replay(): Replay {
    return this.recorder.replay;
  }
}

void K_PIKACHU;
