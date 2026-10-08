import { idiv, milliTiles, speedPerTick } from "./fixed.ts";

/**
 * Unit kinds. Stats are borrowed from the SC2 unit whose role each Pokémon
 * stands in for (Liquipedia, Faster speed), so movement can be compared
 * side by side with real SC2 footage while tuning.
 */
export interface UnitKind {
  name: string;
  /** SC2 unit used as the movement reference. */
  ref: string;
  /** Pokémon type, used for colour now and type effectiveness later. */
  type: "water" | "fire" | "grass" | "flying";
  air: boolean;
  radius: number; // subunits
  speed: number; // subunits per tick
  /** Max change in velocity per tick (acceleration, braking and turning). */
  accel: number;
  supply: number;
}

function kind(
  name: string,
  ref: string,
  type: UnitKind["type"],
  air: boolean,
  radiusMilli: number,
  speedMilli: number,
  ticksToFullSpeed: number,
  supply: number,
): UnitKind {
  const speed = speedPerTick(speedMilli);
  return {
    name,
    ref,
    type,
    air,
    radius: milliTiles(radiusMilli),
    speed,
    accel: Math.max(1, idiv(speed, ticksToFullSpeed)),
    supply,
  };
}

// Ground units in SC2 accelerate almost instantly (1-2 game loops). Air units glide.
export const KINDS: readonly UnitKind[] = [
  kind("Squirtle", "Marine", "water", false, 375, 3150, 2, 1),
  kind("Charmander", "Zergling", "fire", false, 375, 4130, 2, 1),
  kind("Bulbasaur", "Roach", "grass", false, 625, 3150, 2, 2),
  kind("Venusaur", "Thor", "grass", false, 1250, 2620, 4, 6),
  kind("Charizard", "Mutalisk", "flying", true, 500, 5600, 10, 2),
];

export const KIND_SQUIRTLE = 0;
export const KIND_CHARMANDER = 1;
export const KIND_BULBASAUR = 2;
export const KIND_VENUSAUR = 3;
export const KIND_CHARIZARD = 4;
