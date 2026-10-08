/**
 * Mouse handling with optional pointer lock.
 *
 * SC2 confines the cursor to the game window, which is what makes edge
 * scrolling usable. Browsers can only do that with the Pointer Lock API, which
 * hides the real cursor, so in locked mode we track a virtual cursor ourselves
 * and route clicks to the HUD with elementFromPoint().
 */

export type Zone = "world" | "minimap" | "ui";

export interface PointerEvt {
  x: number;
  y: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  zone: Zone;
  /** For "minimap" zone: position relative to the minimap canvas. */
  mx: number;
  my: number;
}

export class Pointer {
  x = -1;
  y = -1;
  inside = false;
  locked = false;
  onDown: (e: PointerEvt) => void = () => {};
  onMove: (e: PointerEvt) => void = () => {};
  onUp: (e: PointerEvt) => void = () => {};
  onLockChange: (locked: boolean) => void = () => {};
  /** Zone the current press started in, so a drag keeps going where it began. */
  private pressZone: Zone | null = null;
  private pressEl: Element | null = null;

  constructor(
    private root: HTMLElement,
    private minimap: HTMLCanvasElement,
  ) {
    window.addEventListener("mousemove", (e) => this.move(e));
    window.addEventListener("mousedown", (e) => this.down(e));
    window.addEventListener("mouseup", (e) => this.up(e));
    window.addEventListener("contextmenu", (e) => {
      if (!root.hidden) e.preventDefault();
    });
    document.documentElement.addEventListener("mouseleave", () => (this.inside = false));
    document.documentElement.addEventListener("mouseenter", () => (this.inside = true));
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.root;
      this.root.classList.toggle("locked", this.locked);
      this.onLockChange(this.locked);
    });
    // Middle-click autoscroll would fight drag-panning.
    window.addEventListener("auxclick", (e) => e.preventDefault());
  }

  requestLock() {
    if (!this.locked) this.root.requestPointerLock?.()?.catch?.(() => {});
  }

  private zoneAt(x: number, y: number): { zone: Zone; el: Element | null } {
    const el = document.elementFromPoint(x, y);
    if (!el) return { zone: "world", el };
    if (el.closest("[data-minimap]")) return { zone: "minimap", el };
    if (el.closest("button, input, select, label, aside, #console, #topbar .left, [data-ui]")) return { zone: "ui", el };
    return { zone: "world", el };
  }

  private evt(e: MouseEvent, zone: Zone): PointerEvt {
    const r = this.minimap.getBoundingClientRect();
    return {
      x: this.x,
      y: this.y,
      button: e.button,
      shift: e.shiftKey,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      zone,
      mx: this.x - r.left,
      my: this.y - r.top,
    };
  }

  private move(e: MouseEvent) {
    if (this.root.hidden) return;
    this.inside = true;
    if (this.locked) {
      this.x = Math.max(0, Math.min(window.innerWidth - 1, this.x + e.movementX));
      this.y = Math.max(0, Math.min(window.innerHeight - 1, this.y + e.movementY));
    } else {
      this.x = e.clientX;
      this.y = e.clientY;
    }
    const zone = this.pressZone ?? this.zoneAt(this.x, this.y).zone;
    this.onMove(this.evt(e, zone));
  }

  private down(e: MouseEvent) {
    if (this.root.hidden) return;
    if (!this.locked) {
      this.x = e.clientX;
      this.y = e.clientY;
    }
    const { zone, el } = this.zoneAt(this.x, this.y);
    this.pressZone = zone;
    this.pressEl = el;
    if (zone === "ui") {
      if (this.locked && el instanceof HTMLInputElement && el.type === "range") this.setRange(el);
      return; // native handling (or synthetic click on mouseup when locked)
    }
    if (e.button === 1) e.preventDefault();
    this.onDown(this.evt(e, zone));
  }

  private up(e: MouseEvent) {
    if (this.root.hidden) return;
    const zone = this.pressZone ?? "world";
    const el = this.pressEl;
    this.pressZone = null;
    this.pressEl = null;
    if (zone === "ui") {
      // Locked cursor: the real click lands on the locked element, so forward it.
      if (this.locked && el) {
        const target = el.closest("button, label, [data-ui]") as HTMLElement | null;
        if (target && this.zoneAt(this.x, this.y).el === el) target.click();
      }
      return;
    }
    this.onUp(this.evt(e, zone));
  }

  private setRange(el: HTMLInputElement) {
    const r = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (this.x - r.left) / r.width));
    const min = Number(el.min);
    const max = Number(el.max);
    const step = Number(el.step) || 1;
    el.value = String(Math.round((min + t * (max - min)) / step) * step);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
