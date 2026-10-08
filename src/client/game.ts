import { FP, TICK_MS } from "../sim/fixed.ts";
import { MODE_ATTACK, MODE_MOVE, MODE_PATROL, type Turn } from "../sim/commands.ts";
import { World, type WorldOptions } from "../sim/world.ts";
import { HASH_INTERVAL, type Replay, ReplayRecorder } from "../sim/replay.ts";
import { Camera } from "./camera.ts";
import { Renderer } from "./render.ts";
import { Minimap } from "./minimap.ts";
import { Selection } from "./selection.ts";
import { Pointer, type PointerEvt } from "./pointer.ts";
import { Hud } from "./hud.ts";
import { NetSource, ReplaySource, type TurnSource } from "./sources.ts";
import { SELECT_ENEMY, SELECT_NEUTRAL, SELECT_OWN } from "./style.ts";

type Targeting = "move" | "attack" | "patrol" | null;

const EDGE_PX = 3;
const SCROLL_TILES_PER_SEC = 30;
const DRAG_THRESHOLD = 5;
const DOUBLE_TAP_MS = 350;

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
  readonly recorder: ReplayRecorder;

  targeting: Targeting = null;
  speed = 1;
  alpha = 0;
  fps = 0;
  private frameMs = 16;
  simMs = 0;
  desynced = false;
  replayStatus = "";

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

  constructor(
    readonly root: HTMLElement,
    readonly source: TurnSource,
    readonly options: WorldOptions,
    readonly me: number,
    readonly names: Record<number, string>,
  ) {
    this.world = new World(options);
    this.recorder = new ReplayRecorder(options, names);
    this.cam = new Camera(this.world.map.w, this.world.map.h);
    this.renderer = new Renderer(root.querySelector("#view")!, root.querySelector("#overlay")!, this.world, this.cam);
    this.minimap = new Minimap(root.querySelector("#minimap")!, this.world, this.cam);
    this.selection = new Selection(this.world, me);
    this.pointer = new Pointer(root, root.querySelector("#minimap")!);
    this.hud = new Hud(this);

    if (source instanceof ReplaySource) {
      this.replayHashes = new Map(source.replay.hashes);
      this.replayStatus = "verifying…";
    }
    if (source instanceof NetSource) {
      source.onDesync = (tick, hashes) => {
        this.desynced = true;
        const list = Object.entries(hashes)
          .map(([id, h]) => `${names[Number(id)] ?? id}: ${h.toString(16)}`)
          .join(" · ");
        this.hud.banner(`Desync at tick ${tick}. The simulations diverged (${list}). Save the replay and keep it for debugging.`);
      };
      source.onLeft = (name) => this.hud.toast(`${name} left the game`);
      source.onClosed = () => this.hud.banner("Disconnected from the server.");
    }

    this.pointer.onDown = (e) => this.mouseDown(e);
    this.pointer.onMove = (e) => this.mouseMove(e);
    this.pointer.onUp = (e) => this.mouseUp(e);
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    window.addEventListener("blur", () => {
      this.held.clear();
      this.shift = false;
    });
    window.addEventListener("resize", () => this.resize());

    this.resize();
    // Start looking at our own army.
    const mine = this.world.units.filter((u) => u.owner === me);
    const c = this.selection.centroid((mine.length ? mine : this.world.units).map((u) => u.id));
    if (c) this.cam.centerOn(c.x, c.y);
    requestAnimationFrame(this.frame);
  }

  get canCommand() {
    return this.source.kind !== "replay";
  }

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
  }

  // ------------------------------------------------------------------- loop

  private stepTurn(turn: Turn) {
    const t0 = performance.now();
    this.world.step(turn.cmds);
    this.simMs = this.simMs * 0.95 + (performance.now() - t0) * 0.05;
    this.recorder.record(turn, this.world);
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

    this.scroll(dt / 1000);
    this.updateHover();
    this.renderer.draw({
      alpha: this.alpha,
      now,
      selection: this.selection,
      hoverId: this.hoverId,
      dragBox: this.drag && this.isDragging() ? this.drag : null,
      showWaypoints: this.shift,
      cursor: this.pointer.locked ? { x: this.pointer.x, y: this.pointer.y, targeting: this.targeting } : null,
    });
    this.minimap.draw(now);
    this.hud.update(now);
    this.root.style.cursor = this.targeting && !this.pointer.locked ? "crosshair" : "";
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
      const speed = SCROLL_TILES_PER_SEC;
      this.cam.pan((dx / len) * speed * dt, (dy / len) * speed * dt);
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

  // ------------------------------------------------------------- commands

  issueMove(mode: number, wx: number, wy: number, queue: boolean) {
    const ids = this.selection.commandable();
    if (!this.canCommand || ids.length === 0) return;
    this.source.send({ t: "move", ids, x: Math.round(wx * FP), y: Math.round(wy * FP), q: queue, mode });
    // Instant local feedback: the units start moving ~1 turn later, but the click registers now.
    const color = mode === MODE_ATTACK ? SELECT_ENEMY : mode === MODE_PATROL ? SELECT_NEUTRAL : SELECT_OWN;
    this.renderer.markers.push({ x: wx, y: wy, color, t0: performance.now() });
  }

  issueStop(hold: boolean) {
    const ids = this.selection.commandable();
    if (!this.canCommand || ids.length === 0) return;
    this.source.send({ t: hold ? "hold" : "stop", ids });
  }

  setTargeting(t: Targeting) {
    if (t && this.selection.commandable().length === 0) return;
    this.targeting = t;
  }

  private targetClick(wx: number, wy: number, shift: boolean) {
    const mode = this.targeting === "attack" ? MODE_ATTACK : this.targeting === "patrol" ? MODE_PATROL : MODE_MOVE;
    this.issueMove(mode, wx, wy, shift);
    if (!shift) this.targeting = null;
  }

  // ---------------------------------------------------------------- mouse

  private isDragging() {
    const d = this.drag;
    return !!d && Math.hypot(d.x1 - d.x0, d.y1 - d.y0) >= DRAG_THRESHOLD;
  }

  private mouseDown(e: PointerEvt) {
    if (document.fullscreenElement && !this.pointer.locked) this.pointer.requestLock();
    if (e.zone === "minimap") {
      const w = this.minimap.toWorld(e.mx, e.my);
      if (e.button === 0) {
        if (this.targeting) this.targetClick(w.x, w.y, e.shift);
        else {
          this.mmDrag = true;
          this.cam.centerOn(w.x, w.y);
        }
      } else if (e.button === 2) {
        this.issueMove(MODE_MOVE, w.x, w.y, e.shift);
      }
      return;
    }
    if (e.button === 1) {
      this.panDrag = { x: e.x, y: e.y };
      return;
    }
    if (e.button === 2) {
      if (this.targeting) {
        this.targeting = null; // right click cancels targeting, like SC2
        return;
      }
      const w = this.cam.toWorld(e.x, e.y);
      this.issueMove(MODE_MOVE, w.x, w.y, e.shift);
      return;
    }
    if (e.button === 0) {
      if (this.targeting) {
        const w = this.cam.toWorld(e.x, e.y);
        this.targetClick(w.x, w.y, e.shift);
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
    if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) >= DRAG_THRESHOLD) {
      const hits = this.renderer.pickBox(d.x0, d.y0, d.x1, d.y1, this.alpha);
      const mine = hits.filter((u) => sel.isMine(u));
      if (mine.length > 0) {
        if (d.shift) sel.add(mine.map((u) => u.id));
        else sel.set(mine.map((u) => u.id));
      } else if (hits.length > 0 && !d.shift) {
        sel.set([hits[0].id], true);
      }
      return;
    }
    // Click.
    const u = this.renderer.pick(d.x0, d.y0, this.alpha);
    if (!u) return; // clicking empty ground keeps the selection (SC2)
    const now = performance.now();
    const double = this.lastClick.id === u.id && now - this.lastClick.t < 300;
    this.lastClick = { id: u.id, t: now };
    if (!sel.isMine(u)) {
      sel.set([u.id], true);
      return;
    }
    if (d.ctrl || double) {
      const same = this.world.units.filter((o) => o.owner === u.owner && o.kind === u.kind && this.renderer.onScreen(o, this.alpha));
      if (d.shift) sel.add(same.map((o) => o.id));
      else sel.set(same.map((o) => o.id));
    } else if (d.shift) sel.toggle(u.id);
    else sel.set([u.id]);
  }

  // ------------------------------------------------------------- keyboard

  private keyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
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
    switch (code) {
      case "KeyA":
        this.setTargeting("attack");
        break;
      case "KeyM":
        this.setTargeting("move");
        break;
      case "KeyP":
        this.setTargeting("patrol");
        break;
      case "KeyS":
        if (ctrl) break; // swallow Ctrl+S so the browser doesn't open "Save page"
        this.issueStop(false);
        this.targeting = null;
        break;
      case "KeyH":
        this.issueStop(true);
        this.targeting = null;
        break;
      case "Escape":
        this.targeting = null;
        break;
      case "F2":
        if (this.me !== -1) this.selection.set(this.world.units.filter((u) => u.owner === this.me).map((u) => u.id));
        break;
      case "F10":
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
