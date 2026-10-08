/**
 * Fixed-point integer math for the simulation.
 *
 * DETERMINISM RULES (enforced by test/purity.test.ts):
 * - The sim only uses integers. 1 tile = FP subunits.
 * - Divide with idiv(), never with the bare `/` operator.
 * - No Math.random, Math.sin/cos/atan2/sqrt/pow, Date, performance in sim code.
 *   (isqrt below uses Math.sqrt only as a guess and then corrects it exactly,
 *   so the result is identical on every JS engine.)
 * - Keep every intermediate value below 2^53 (positions are < 2^20, so squares are safe).
 */

/** Subunits per tile. SC2 uses 1/4096 precision internally, so we do too. */
export const FP = 4096;

/** Simulation rate. SC2 "Faster" runs 22.4 game loops per real second. */
export const TICKS_PER_SECOND_X10 = 224;
export const TICK_MS = 10000 / TICKS_PER_SECOND_X10; // 44.642857... (client-side only, never used in sim math)

/** Integer division truncating toward zero. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** Integer division rounding toward negative infinity. */
export function fdiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Exact floor(sqrt(n)) for 0 <= n < 2^52. */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = Math.trunc(Math.sqrt(n)); // guess only
  while (x * x > n) x--;
  while ((x + 1) * (x + 1) <= n) x++;
  return x;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function abs(v: number): number {
  return v < 0 ? -v : v;
}

/** Speed given in tiles/second * 1000 (as listed on Liquipedia for Faster) to subunits per tick. */
export function speedPerTick(tilesPerSecMilli: number): number {
  return idiv(tilesPerSecMilli * FP, TICKS_PER_SECOND_X10 * 100);
}

/** Tile count * 1000 to subunits, e.g. milliTiles(375) = 0.375 tiles. */
export function milliTiles(m: number): number {
  return idiv(m * FP, 1000);
}

/** Scale v by a percentage. */
export function pct(v: number, percent: number): number {
  return idiv(v * percent, 100);
}
