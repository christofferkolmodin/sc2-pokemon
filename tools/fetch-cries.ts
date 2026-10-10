/**
 * Downloads the official Pokémon cries from PokeAPI into
 * assets-private/sounds/cries/{latest,legacy}/<key>.ogg, one per Pokémon in
 * the game. "latest" are the modern remastered cries, "legacy" the classic
 * Game Boy / DS ones; the lobby picks which set plays.
 *
 *   npm run fetch-cries            (skips files you already have)
 *   npm run fetch-cries -- --force (downloads everything again)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KINDS } from "../src/sim/units.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets-private", "sounds", "cries");
const SETS = ["latest", "legacy"] as const;
const force = process.argv.includes("--force");

const keys = [...new Set(KINDS.filter((k) => !k.structure && k.faction >= 0).map((k) => k.key))];
let got = 0;
let failed = 0;
for (const key of keys) {
  const want = SETS.filter((set) => force || !existsSync(join(OUT, set, `${key}.ogg`)));
  if (!want.length) continue;
  try {
    const r = await fetch(`https://pokeapi.co/api/v2/pokemon/${key}`);
    if (!r.ok) throw new Error(`PokeAPI ${r.status}`);
    const cries = ((await r.json()) as { cries?: Partial<Record<(typeof SETS)[number], string | null>> }).cries ?? {};
    for (const set of want) {
      const url = cries[set];
      if (!url) {
        console.log(`  ${key}: no ${set} cry`);
        continue;
      }
      const a = await fetch(url);
      if (!a.ok) throw new Error(`${set} cry ${a.status}`);
      mkdirSync(join(OUT, set), { recursive: true });
      writeFileSync(join(OUT, set, `${key}.ogg`), Buffer.from(await a.arrayBuffer()));
      got++;
    }
    console.log(`  ${key}: ok`);
  } catch (e) {
    failed++;
    console.log(`  ${key}: failed (${(e as Error).message})`);
  }
}
console.log(`${got} cries downloaded to ${OUT}${failed ? `, ${failed} Pokémon failed` : ""}.`);
if (failed) process.exitCode = 1;
