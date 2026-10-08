/**
 * Movement tuning knobs. Changed live from the client's tuning panel (F10) via
 * a "tune" command, so all players stay in sync. Once values feel right,
 * bake them in as the defaults here.
 */
export interface TuneDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  help: string;
}

export const TUNE_DEFS: readonly TuneDef[] = [
  { key: "speedPct", label: "Unit speed %", min: 25, max: 300, step: 5, def: 100, help: "Global multiplier on unit move speed." },
  { key: "accelPct", label: "Acceleration %", min: 10, max: 500, step: 10, def: 100, help: "Lower = floatier starts, stops and turns." },
  { key: "pushIdle", label: "Moving units push idle units", min: 0, max: 1, step: 1, def: 1, help: "SC2: your moving units shove your idle units aside." },
  { key: "pushStrength", label: "Collision stiffness ‰", min: 100, max: 1000, step: 50, def: 1000, help: "Share of overlap resolved per pass. Lower = squishier blobs." },
  { key: "collisionIters", label: "Collision passes", min: 1, max: 4, step: 1, def: 2, help: "More passes = less overlap in dense blobs, more CPU." },
  { key: "arriveDist", label: "Arrive distance (mTiles)", min: 20, max: 1000, step: 10, def: 120, help: "How close to the goal counts as arrived." },
  { key: "clumpArrive", label: "Group arrival (clumping)", min: 0, max: 1, step: 1, def: 1, help: "Unit stops when it touches a group-mate that already arrived. This is what makes SC2 balls." },
  { key: "clumpMaxDist", label: "Clump max distance (mTiles)", min: 1000, max: 20000, step: 500, def: 6000, help: "Group arrival only counts this close to the goal." },
  { key: "magicBox", label: "Magic box (keep formation)", min: 0, max: 1, step: 1, def: 1, help: "Click outside the selection's bounding box = units keep their spacing." },
  { key: "magicBoxMax", label: "Magic box max size (mTiles)", min: 2000, max: 40000, step: 1000, def: 16000, help: "Selections spread wider than this converge instead." },
  { key: "airSpread", label: "Idle air spread ‰/tick", min: 0, max: 300, step: 10, def: 40, help: "How fast stacked idle air units drift apart." },
  { key: "repathTicks", label: "Re-steer every N ticks", min: 1, max: 16, step: 1, def: 3, help: "How often units re-pick their steering waypoint." },
  { key: "giveUpTicks", label: "Give up when stuck (ticks)", min: 10, max: 200, step: 5, def: 45, help: "A unit that makes no progress for this long stops (45 ticks ≈ 2 s)." },
];

export type Tuning = Record<string, number>;

export function defaultTuning(): Tuning {
  const t: Tuning = {};
  for (const d of TUNE_DEFS) t[d.key] = d.def;
  return t;
}

export function tuneDef(key: string): TuneDef | undefined {
  return TUNE_DEFS.find((d) => d.key === key);
}
