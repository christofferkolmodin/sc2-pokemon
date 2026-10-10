import { idiv, milliTiles, speedPerTick } from "./fixed.ts";

/**
 * Unit, structure and resource kinds. Combat numbers start from the SC2 unit
 * each Pokémon stands in for (Liquipedia, Faster) and are adjusted for the
 * evolution-as-tech design. Everything is an integer:
 * distances in subunits, times in ticks (22.4 per second).
 */

// ------------------------------------------------------------------ types

export const TY_NORMAL = 0;
export const TY_FIRE = 1;
export const TY_WATER = 2;
export const TY_GRASS = 3;
export const TY_ELECTRIC = 4;
export const TY_FLYING = 5;
export const TY_POISON = 6;
export const TYPE_NAMES = ["normal", "fire", "water", "grass", "electric", "flying", "poison"];

const SUPER = 150;
const WEAK = 70;

// Only non-neutral matchups are listed (main-series chart, softened for an RTS: 1.5x / 0.7x).
const EFFECT: Record<number, Record<number, number>> = {
  [TY_FIRE]: { [TY_GRASS]: SUPER, [TY_FIRE]: WEAK, [TY_WATER]: WEAK },
  [TY_WATER]: { [TY_FIRE]: SUPER, [TY_WATER]: WEAK, [TY_GRASS]: WEAK },
  [TY_GRASS]: { [TY_WATER]: SUPER, [TY_FIRE]: WEAK, [TY_GRASS]: WEAK, [TY_FLYING]: WEAK, [TY_POISON]: WEAK },
  [TY_ELECTRIC]: { [TY_WATER]: SUPER, [TY_FLYING]: SUPER, [TY_GRASS]: WEAK, [TY_ELECTRIC]: WEAK },
};

/** Damage multiplier in percent for attack type `atk` against a defender with `def` types. */
export function typeMult(atk: number, def: readonly number[]): number {
  let m = 100;
  for (const d of def) {
    const e = EFFECT[atk]?.[d];
    if (e) m = idiv(m * e, 100);
  }
  return m;
}

// --------------------------------------------------------------- factions

export const F_FIRE = 0;
export const F_WATER = 1;
export const F_GRASS = 2;
export const F_ELECTRIC = 3;
export const FACTION_NAMES = ["Fire", "Water", "Grass", "Lightning"];
export const FACTION_COUNT = FACTION_NAMES.length;

// ------------------------------------------------------------------ kinds

export type WeaponFx = "ember" | "bite" | "fang" | "scratch" | "absorb" | "water" | "bubble" | "hydro" | "vine" | "leaf" | "solar" | "flame" | "spark" | "bolt" | "thunder";

export interface Weapon {
  name: string;
  /** Edge-to-edge range in subunits. */
  range: number;
  damage: number;
  /** Extra damage per attack upgrade level. */
  upgrade: number;
  cooldown: number;
  /** Ticks from the start of an attack to the hit (instant) or launch (projectile). */
  point: number;
  ground: boolean;
  air: boolean;
  /** Splash radius in subunits (0 = single target). */
  splash: number;
  /** Projectile speed in subunits per tick (0 = instant hit). */
  speed: number;
  /** Pokémon type of the move, for type effectiveness. */
  type: number;
  /** Visual style for the renderer. */
  fx: WeaponFx;
}

export interface Evolve {
  to: number;
  m: number;
  g: number;
  time: number;
  requires: number;
}

export interface UnitKind {
  id: number;
  key: string;
  name: string;
  /** SC2 unit used as the reference for movement and combat. */
  ref: string;
  types: number[];
  /** Faction that can make it (-1 = everyone, -2 = neutral map object). */
  faction: number;
  /** Evolution stage (1-3), 0 for workers and structures. */
  stage: number;
  air: boolean;
  structure: boolean;
  worker: boolean;
  /** 1 = mineral field, 2 = vespene geyser, 3 = destructible rock, 4 = watchtower. */
  resource: number;
  radius: number;
  speed: number;
  accel: number;
  hp: number;
  armor: number;
  /** Sight radius in tiles. */
  sight: number;
  supply: number;
  /** Supply this kind provides when finished. */
  provides: number;
  /** Footprint in tiles (structures and resources). */
  w: number;
  h: number;
  m: number;
  g: number;
  /** Build/train time in ticks. */
  time: number;
  weapon: Weapon | null;
  /** Structure kind that must exist (finished) before this can be made, or -1. */
  requires: number;
  /** Units this structure trains (the Gym trains the owner's faction units instead). */
  trains: number[];
  evolve: Evolve | null;
  dropoff: boolean;
  /** Can research attack/armor upgrades. */
  research: boolean;
  /** Visual height in milli-tiles (picking, health bars). */
  height: number;
  /** Flying height in milli-tiles (air units). */
  fly: number;
}

/** Milliseconds on Faster to ticks, rounded. */
export const ticks = (ms: number) => idiv(ms * 224 + 5000, 10000);

interface WeaponSpec {
  name: string;
  range: number; // milli-tiles
  damage: number;
  upgrade?: number;
  cooldown: number; // ms
  point?: number; // ms
  ground?: boolean;
  air?: boolean;
  splash?: number; // milli-tiles
  speed?: number; // milli-tiles per second, 0 = instant
  type: number;
  fx: WeaponFx;
}

function weapon(s: WeaponSpec): Weapon {
  return {
    name: s.name,
    range: milliTiles(s.range),
    damage: s.damage,
    upgrade: s.upgrade ?? 1,
    cooldown: Math.max(1, ticks(s.cooldown)),
    point: ticks(s.point ?? 100),
    ground: s.ground ?? true,
    air: s.air ?? false,
    splash: milliTiles(s.splash ?? 0),
    speed: s.speed ? speedPerTick(s.speed) : 0,
    type: s.type,
    fx: s.fx,
  };
}

type Spec = Partial<Omit<UnitKind, "id" | "radius" | "speed" | "accel" | "time">> & {
  key: string;
  name: string;
  radius: number; // milli-tiles
  speed?: number; // milli-tiles per second
  ticksToFull?: number;
  time?: number; // ms
};

export const KINDS: UnitKind[] = [];

function def(s: Spec): number {
  const speed = s.speed ? speedPerTick(s.speed) : 0;
  const k: UnitKind = {
    id: KINDS.length,
    key: s.key,
    name: s.name,
    ref: s.ref ?? "",
    types: s.types ?? [TY_NORMAL],
    faction: s.faction ?? -1,
    stage: s.stage ?? 0,
    air: s.air ?? false,
    structure: s.structure ?? false,
    worker: s.worker ?? false,
    resource: s.resource ?? 0,
    radius: milliTiles(s.radius),
    speed,
    accel: speed ? Math.max(1, idiv(speed, s.ticksToFull ?? 2)) : 0,
    hp: s.hp ?? 100,
    armor: s.armor ?? 0,
    sight: s.sight ?? 9,
    supply: s.supply ?? 0,
    provides: s.provides ?? 0,
    w: s.w ?? 0,
    h: s.h ?? 0,
    m: s.m ?? 0,
    g: s.g ?? 0,
    time: ticks(s.time ?? 0),
    weapon: s.weapon ?? null,
    requires: s.requires ?? -1,
    trains: s.trains ?? [],
    evolve: s.evolve ?? null,
    dropoff: s.dropoff ?? false,
    research: s.research ?? false,
    height: s.height ?? 1000,
    fly: s.fly ?? 0,
  };
  KINDS.push(k);
  return k.id;
}

// Structures first so units can reference them in `requires`.
export const K_CENTER = def({
  key: "center", name: "Pokémon Center", ref: "Command Center", structure: true, radius: 2500,
  hp: 1500, armor: 1, sight: 11, w: 5, h: 5, m: 400, time: 71000, provides: 15, dropoff: true, height: 3000,
});
export const K_MART = def({
  key: "mart", name: "Poké Mart", ref: "Supply Depot", structure: true, radius: 1000,
  hp: 400, armor: 1, w: 2, h: 2, m: 100, time: 21000, provides: 8, height: 2000, requires: K_CENTER,
});
export const K_EXTRACTOR = def({
  key: "extractor", name: "Extractor", ref: "Refinery", structure: true, radius: 1500,
  hp: 500, armor: 1, w: 3, h: 3, m: 75, time: 21000, height: 2000,
});
export const K_GYM = def({
  key: "gym", name: "Gym", ref: "Barracks", structure: true, radius: 1500,
  hp: 1000, armor: 1, w: 3, h: 3, m: 150, time: 46000, height: 2500, requires: K_CENTER,
});
export const K_SHRINE = def({
  key: "shrine", name: "Evolution Shrine", ref: "Engineering Bay", structure: true, radius: 1500,
  hp: 750, armor: 1, w: 3, h: 3, m: 150, g: 100, time: 50000, height: 3000, requires: K_GYM, research: true,
});
export const K_ELITE = def({
  key: "elite", name: "Elite Hall", ref: "Fusion Core", structure: true, radius: 1500,
  hp: 1000, armor: 1, w: 3, h: 3, m: 150, g: 150, time: 60000, height: 3000, requires: K_SHRINE, research: true,
});
export const K_TURRET = def({
  key: "turret", name: "Poké Turret", ref: "Photon Cannon", structure: true, radius: 1000,
  hp: 350, armor: 1, sight: 11, w: 2, h: 2, m: 150, time: 29000, height: 2500, requires: K_GYM,
  weapon: weapon({ name: "Thunderbolt", range: 7000, damage: 20, upgrade: 0, cooldown: 1250, air: true, speed: 18000, type: TY_ELECTRIC, fx: "bolt" }),
});

// Neutral map objects.
export const K_MINERAL = def({ key: "mineral", name: "Mineral Field", structure: true, resource: 1, faction: -2, radius: 500, hp: 1, w: 2, h: 1, height: 1000, sight: 0 });
export const K_GEYSER = def({ key: "geyser", name: "Vespene Geyser", structure: true, resource: 2, faction: -2, radius: 1500, hp: 1, w: 3, h: 3, height: 1000, sight: 0 });
export const K_ROCK = def({ key: "rock", name: "Destructible Rocks", structure: true, resource: 3, faction: -2, radius: 3000, hp: 2000, armor: 1, w: 6, h: 6, height: 2500, sight: 0 });
export const K_ROCK_SMALL = def({ key: "rock2", name: "Destructible Debris", structure: true, resource: 3, faction: -2, radius: 1000, hp: 1000, armor: 1, w: 2, h: 2, height: 1200, sight: 0 });

/** Xel'Naga watchtower: a ground unit next to it gives its team vision of a wide area. */
export const K_TOWER = def({ key: "tower", name: "Watchtower", structure: true, resource: 4, faction: -2, radius: 1000, hp: 1, w: 2, h: 2, height: 3500, sight: 22 });

// Workers: one per faction, identical stats (SCV / Probe / Drone are the same economically).
function worker(key: string, name: string, faction: number, type: number, move: string, fx: WeaponFx): number {
  return def({
    key, name, ref: "SCV", types: [type], faction, worker: true, radius: 375, speed: 3940,
    hp: 45, sight: 8, supply: 1, m: 50, time: 12000, height: 800,
    weapon: weapon({ name: move, range: 100, damage: 5, upgrade: 0, cooldown: 1070, type, fx }),
  });
}
export const K_WORKER_FIRE = worker("growlithe", "Growlithe", F_FIRE, TY_FIRE, "Bite", "bite");
export const K_WORKER_WATER = worker("psyduck", "Psyduck", F_WATER, TY_WATER, "Scratch", "scratch");
export const K_WORKER_GRASS = worker("oddish", "Oddish", F_GRASS, TY_GRASS, "Absorb", "absorb");
export const K_WORKER_ELECTRIC = worker("voltorb", "Voltorb", F_ELECTRIC, TY_ELECTRIC, "Spark", "spark");
/** Worker kind of each faction. */
export const FACTION_WORKERS = [K_WORKER_FIRE, K_WORKER_WATER, K_WORKER_GRASS, K_WORKER_ELECTRIC];
/** Fire's worker, for code and tests that just need "a worker". */
export const K_WORKER = K_WORKER_FIRE;

// Fire.
export const K_CHARMANDER = def({
  key: "charmander", name: "Charmander", ref: "Zergling", types: [TY_FIRE], faction: F_FIRE, stage: 1,
  radius: 375, speed: 4130, hp: 55, sight: 8, supply: 1, m: 50, time: 17000, requires: K_GYM, height: 850,
  weapon: weapon({ name: "Ember", range: 1000, damage: 6, cooldown: 700, point: 150, speed: 14000, type: TY_FIRE, fx: "ember" }),
});
export const K_CHARMELEON = def({
  key: "charmeleon", name: "Charmeleon", ref: "Zergling (adrenal)", types: [TY_FIRE], faction: F_FIRE, stage: 2,
  radius: 500, speed: 4130, hp: 120, armor: 1, sight: 9, supply: 2, height: 1150,
  weapon: weapon({ name: "Fire Fang", range: 150, damage: 12, cooldown: 600, type: TY_FIRE, fx: "fang" }),
});
export const K_CHARIZARD = def({
  key: "charizard", name: "Charizard", ref: "Mutalisk", types: [TY_FIRE, TY_FLYING], faction: F_FIRE, stage: 3,
  air: true, radius: 750, speed: 4400, ticksToFull: 10, hp: 240, armor: 1, sight: 11, supply: 4, fly: 3200, height: 1600,
  weapon: weapon({ name: "Flamethrower", range: 4000, damage: 15, upgrade: 2, cooldown: 1340, point: 200, air: true, splash: 1000, speed: 16000, type: TY_FIRE, fx: "flame" }),
});

// Water.
export const K_SQUIRTLE = def({
  key: "squirtle", name: "Squirtle", ref: "Marine", types: [TY_WATER], faction: F_WATER, stage: 1,
  radius: 375, speed: 3150, hp: 55, sight: 9, supply: 1, m: 50, time: 18000, requires: K_GYM, height: 850,
  weapon: weapon({ name: "Water Gun", range: 5000, damage: 6, cooldown: 610, air: true, speed: 20000, type: TY_WATER, fx: "water" }),
});
export const K_WARTORTLE = def({
  key: "wartortle", name: "Wartortle", ref: "Marauder", types: [TY_WATER], faction: F_WATER, stage: 2,
  radius: 500, speed: 3150, hp: 125, armor: 1, sight: 10, supply: 2, height: 1150,
  weapon: weapon({ name: "Bubble Beam", range: 6000, damage: 14, cooldown: 1070, air: true, speed: 15000, type: TY_WATER, fx: "bubble" }),
});
export const K_BLASTOISE = def({
  key: "blastoise", name: "Blastoise", ref: "Siege Tank", types: [TY_WATER], faction: F_WATER, stage: 3,
  radius: 875, speed: 2620, ticksToFull: 4, hp: 360, armor: 2, sight: 11, supply: 4, height: 1700,
  weapon: weapon({ name: "Hydro Pump", range: 9000, damage: 35, upgrade: 3, cooldown: 2140, point: 250, splash: 1250, speed: 22000, type: TY_WATER, fx: "hydro" }),
});

// Grass.
export const K_BULBASAUR = def({
  key: "bulbasaur", name: "Bulbasaur", ref: "Roach", types: [TY_GRASS, TY_POISON], faction: F_GRASS, stage: 1,
  radius: 625, speed: 3150, hp: 120, armor: 1, sight: 9, supply: 2, m: 75, g: 25, time: 19000, requires: K_GYM, height: 950,
  weapon: weapon({ name: "Vine Whip", range: 4000, damage: 15, upgrade: 2, cooldown: 1430, point: 150, type: TY_GRASS, fx: "vine" }),
});
export const K_IVYSAUR = def({
  key: "ivysaur", name: "Ivysaur", ref: "Hydralisk", types: [TY_GRASS, TY_POISON], faction: F_GRASS, stage: 2,
  radius: 750, speed: 3150, hp: 210, armor: 1, sight: 10, supply: 3, height: 1250,
  weapon: weapon({ name: "Razor Leaf", range: 5500, damage: 11, cooldown: 900, air: true, speed: 15000, type: TY_GRASS, fx: "leaf" }),
});
export const K_VENUSAUR = def({
  key: "venusaur", name: "Venusaur", ref: "Thor", types: [TY_GRASS, TY_POISON], faction: F_GRASS, stage: 3,
  radius: 1250, speed: 2620, ticksToFull: 4, hp: 520, armor: 2, sight: 11, supply: 6, height: 1900,
  weapon: weapon({ name: "Solar Beam", range: 7000, damage: 40, upgrade: 3, cooldown: 1800, point: 300, air: true, splash: 750, type: TY_GRASS, fx: "solar" }),
});

// Lightning: fast hit-and-run (Adept → Stalker → Archon), hits air and ground.
export const K_PICHU = def({
  key: "pichu", name: "Pichu", ref: "Adept", types: [TY_ELECTRIC], faction: F_ELECTRIC, stage: 1,
  radius: 375, speed: 4720, hp: 50, sight: 9, supply: 1, m: 50, g: 25, time: 18000, requires: K_GYM, height: 800,
  weapon: weapon({ name: "Thunder Shock", range: 4000, damage: 7, cooldown: 1000, point: 120, air: true, type: TY_ELECTRIC, fx: "spark" }),
});
export const K_PIKACHU = def({
  key: "pikachu", name: "Pikachu", ref: "Stalker", types: [TY_ELECTRIC], faction: F_ELECTRIC, stage: 2,
  radius: 550, speed: 4130, hp: 140, armor: 1, sight: 10, supply: 2, height: 1100,
  weapon: weapon({ name: "Thunderbolt", range: 6000, damage: 13, cooldown: 1340, point: 150, air: true, type: TY_ELECTRIC, fx: "bolt" }),
});
export const K_RAICHU = def({
  key: "raichu", name: "Raichu", ref: "Archon", types: [TY_ELECTRIC], faction: F_ELECTRIC, stage: 3,
  radius: 900, speed: 3940, ticksToFull: 4, hp: 380, armor: 1, sight: 11, supply: 4, height: 1600,
  weapon: weapon({ name: "Thunder", range: 3000, damage: 25, upgrade: 3, cooldown: 1250, point: 200, air: true, splash: 1000, type: TY_ELECTRIC, fx: "thunder" }),
});

// Evolution lines (evolving is a morph that needs the given tech structure).
function evo(from: number, to: number, m: number, g: number, ms: number, requires: number) {
  KINDS[from].evolve = { to, m, g, time: ticks(ms), requires };
}
evo(K_CHARMANDER, K_CHARMELEON, 25, 25, 12000, K_SHRINE);
evo(K_CHARMELEON, K_CHARIZARD, 100, 100, 25000, K_ELITE);
evo(K_SQUIRTLE, K_WARTORTLE, 50, 25, 15000, K_SHRINE);
evo(K_WARTORTLE, K_BLASTOISE, 150, 125, 30000, K_ELITE);
evo(K_BULBASAUR, K_IVYSAUR, 50, 50, 17000, K_SHRINE);
evo(K_IVYSAUR, K_VENUSAUR, 150, 150, 35000, K_ELITE);
evo(K_PICHU, K_PIKACHU, 50, 50, 15000, K_SHRINE);
evo(K_PIKACHU, K_RAICHU, 125, 125, 30000, K_ELITE);

/** Stage-1 unit each faction's Gym trains (the Pokémon Center trains the faction's worker). */
export const FACTION_UNITS: number[][] = [[K_CHARMANDER], [K_SQUIRTLE], [K_BULBASAUR], [K_PICHU]];

/** Structures a worker can build, in command card order. */
export const BUILD_BASIC = [K_CENTER, K_MART, K_EXTRACTOR, K_GYM, K_TURRET];
export const BUILD_ADVANCED = [K_SHRINE, K_ELITE];

export function kindByKey(key: string): UnitKind | undefined {
  return KINDS.find((k) => k.key === key);
}

// ------------------------------------------------------------- upgrades

export const UP_ATTACK = 0;
export const UP_ARMOR = 1;
export const UPGRADE_NAMES = ["Attack", "Defense"];
export const MAX_UPGRADE = 3;

/** Cost of researching level `lvl` (1-3) of an upgrade, and the structure it needs. */
export function upgradeCost(lvl: number): { m: number; g: number; time: number; requires: number } {
  return {
    m: 50 + lvl * 50,
    g: 50 + lvl * 50,
    time: ticks(50000 + lvl * 15000),
    requires: lvl >= 2 ? K_ELITE : K_SHRINE,
  };
}

// ---------------------------------------------------------------- economy

export const MINE_TICKS = ticks(2786);
export const GAS_TICKS = ticks(1430);
export const MINERAL_CARRY = 5;
export const GAS_CARRY = 4;
export const MAX_SUPPLY = 200;
export const MAX_QUEUE = 5;
export const START_MINERALS = 50;
export const START_WORKERS = 12;
