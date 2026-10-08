import type { Unit, World } from "../sim/world.ts";
import { FP } from "../sim/fixed.ts";

const MAX_SELECTION = 500; // same cap as SC2 (Legacy of the Void)

/**
 * Selection and control groups. Purely client-side (other players never see
 * your selection), so this code doesn't need to be deterministic.
 */
export class Selection {
  ids: number[] = [];
  groups: number[][] = Array.from({ length: 10 }, () => []);
  /** Viewing someone else's unit: can't command it. */
  foreign = false;

  constructor(
    private world: World,
    /** Local player id. -1 = spectator (replays). */
    public me: number,
  ) {}

  isMine(u: Unit) {
    return this.me === -1 || u.owner === this.me;
  }

  /** Remove dead or missing units and keep SC2-style ordering (by kind, then id). */
  clean() {
    this.ids = this.ids.filter((id) => this.world.byId.has(id));
    for (let g = 0; g < 10; g++) this.groups[g] = this.groups[g].filter((id) => this.world.byId.has(id));
  }

  private sort(ids: number[]) {
    const w = this.world;
    return [...new Set(ids)]
      .filter((id) => w.byId.has(id))
      .sort((a, b) => w.byId.get(a)!.kind - w.byId.get(b)!.kind || a - b)
      .slice(0, MAX_SELECTION);
  }

  set(ids: number[], foreign = false) {
    this.ids = this.sort(ids);
    this.foreign = foreign;
  }

  add(ids: number[]) {
    if (this.foreign) return this.set(ids);
    this.set([...this.ids, ...ids]);
  }

  toggle(id: number) {
    if (this.foreign) return this.set([id]);
    if (this.ids.includes(id)) this.ids = this.ids.filter((x) => x !== id);
    else this.set([...this.ids, id]);
  }

  has(id: number) {
    return this.ids.includes(id);
  }

  /** Ids that can be commanded right now. */
  commandable(): number[] {
    if (this.foreign || this.me === -1) return [];
    return this.ids.filter((id) => this.world.byId.get(id)?.owner === this.me);
  }

  units(): Unit[] {
    return this.ids.map((id) => this.world.byId.get(id)!).filter(Boolean);
  }

  setGroup(g: number) {
    if (this.foreign) return;
    this.groups[g] = [...this.ids];
  }
  addToGroup(g: number) {
    if (this.foreign) return;
    this.groups[g] = this.sort([...this.groups[g], ...this.ids]);
  }
  /** Alt+number in SC2: move units into this group and out of every other group. */
  stealToGroup(g: number) {
    if (this.foreign) return;
    const set = new Set(this.ids);
    for (let i = 0; i < 10; i++) if (i !== g) this.groups[i] = this.groups[i].filter((id) => !set.has(id));
    this.groups[g] = [...this.ids];
  }
  recallGroup(g: number, additive: boolean): boolean {
    const ids = this.groups[g].filter((id) => this.world.byId.has(id));
    if (ids.length === 0) return false;
    if (additive) this.add(ids);
    else this.set(ids);
    return true;
  }

  /** Centre of a set of units, in tiles. */
  centroid(ids: number[]): { x: number; y: number } | null {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const id of ids) {
      const u = this.world.byId.get(id);
      if (!u) continue;
      x += u.x;
      y += u.y;
      n++;
    }
    return n ? { x: x / n / FP, y: y / n / FP } : null;
  }
}
