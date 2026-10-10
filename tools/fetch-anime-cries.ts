/**
 * Downloads anime-style Pokémon voices (Pokémon saying their names: "Pika-pika!")
 * into assets-private/sounds/cries/anime/<key>/<select|move|attack>-<n>.mp3 for
 * the lobby's "Anime" cries. The clips are the anime voice actors as used in
 * N64 / Smash Bros. games, hand-picked from fan soundboards and sorted by mood:
 * select is calm or a question, move a single call, attack shouted or repeated.
 * Blastoise has no clean anime clip and keeps its game cry.
 *
 *   npm run fetch-anime-cries            (skips files you already have)
 *   npm run fetch-anime-cries -- --force (downloads everything again)
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets-private", "sounds", "cries", "anime");
const force = process.argv.includes("--force");

type Moods = { select?: string[]; move?: string[]; attack?: string[] };
/** Realm of Darkness soundboard clips: game/character folder and clip numbers. */
const rod = (path: string, ...n: number[]) => n.map((i) => `https://www.realmofdarkness.net/audio/vg/${path}/${i}.mp3`);
/** 101soundboards clips (the original uploads, without the site's voice tag). */
const sb = (...ids: string[]) => ids.map((id) => `https://hoovers.101soundboards.com/sb/board_sounds/${id}.mp3`);
const sbr = (...ids: string[]) => ids.map((id) => `https://hoovers.101soundboards.com/sb/board_sounds_rendered/${id}.mp3`);
const st = (...names: string[]) => names.map((n) => `https://www.101soundboards.com/storage/sounds_rendered/${n}.mp3`);

const CLIPS: Record<string, Moods> = {
  // Lightning.
  pichu: { select: rod("ssb/ssbm/pichu", 12, 11), move: rod("ssb/ssbm/pichu", 21, 13, 2), attack: rod("ssb/ssbm/pichu", 1, 4, 5) },
  pikachu: {
    select: [...rod("pokemon/hyp/pikachu", 29, 28, 31, 36, 11), ...rod("pokemon/ppl/pikachu", 4)],
    move: [...rod("pokemon/ppl/pikachu", 1, 2, 3, 5, 6, 7, 9, 10), ...rod("pokemon/hyp/pikachu", 5, 33)],
    attack: [...rod("pokemon/hyp/pikachu", 13, 25, 24, 17, 19), ...rod("pokemon/snap/pikachu", 7)],
  },
  raichu: { select: rod("pokemon/ppl/raichu", 1), move: rod("pokemon/ppl/raichu", 3), attack: rod("pokemon/ppl/raichu", 2, 4) },
  voltorb: { select: rod("pokemon/ppl/voltorb", 1), move: rod("pokemon/ppl/voltorb", 3, 2), attack: rod("pokemon/ppl/voltorb", 4, 5) },
  // Fire.
  charmander: {
    select: rod("pokemon/snap/charmander", 2),
    move: [...rod("pokemon/snap/charmander", 1, 5), ...rod("pokemon/ppl/zippo", 1, 3)],
    attack: [...rod("pokemon/ppl/zippo", 2, 4), ...rod("pokemon/snap/charmander", 4)],
  },
  charmeleon: {
    select: rod("pokemon/ppl/charmeleon", 4, 6),
    move: [...rod("pokemon/ppl/charmeleon", 2, 3), ...rod("pokemon/snap/charmeleon", 2)],
    attack: [...rod("pokemon/ppl/charmeleon", 7), ...rod("pokemon/snap/charmeleon", 1, 4)],
  },
  charizard: { select: rod("ssb/ssbb/charizard", 8, 9), move: rod("ssb/ssbb/charizard", 10, 7), attack: rod("ssb/ssbb/charizard", 5, 31, 24) },
  growlithe: {
    select: rod("pokemon/ppl/growlithe", 4),
    move: rod("pokemon/ppl/growlithe", 1, 5, 6),
    attack: [...rod("pokemon/ppl/growlithe", 2), ...rod("pokemon/snap/growlithe", 2, 4)],
  },
  // Water.
  squirtle: {
    select: [...rod("pokemon/ppl/squirtle", 5), ...rod("pokemon/hyp/squirtle", 5), ...rod("pokemon/snap/squirtle", 7, 10)],
    move: [...rod("pokemon/ppl/squirtle", 1, 2, 3, 4), ...rod("pokemon/hyp/squirtle", 2, 4), ...rod("pokemon/snap/squirtle", 1, 2, 6, 8)],
    attack: [...rod("pokemon/hyp/squirtle", 1), ...rod("pokemon/snap/squirtle", 5), ...rod("pokemon/ppl/squirtle", 8, 10)],
  },
  wartortle: { move: st("asjdz5o2ieil42hw-wartortle-freakout-wartortle-freakout-anime") },
  psyduck: { select: [...sbr("gnkyzaao", "gnkyzabk")], move: sb("xpgzdelz") },
  // Grass.
  bulbasaur: {
    select: rod("pokemon/ppl/bulbasaur", 3),
    move: [...rod("pokemon/ppl/bulbasaur", 2, 7, 9, 4), ...rod("pokemon/hyp/bulbasaur", 4)],
    attack: [...rod("pokemon/hyp/bulbasaur", 8, 6, 2), ...rod("pokemon/ppl/bulbasaur", 10)],
  },
  ivysaur: { select: [...sb("kbdxbgab"), ...sbr("xpgwpzwp")], move: sb("bjzojokd", "kbdxbjkk", "vblxbkel"), attack: sb("gnkonyya", "dazoaoww", "ovgpvpzb") },
  venusaur: { move: st("hieswe5rpkrf9v6n-venusaur", "ztdtpqtdje6vtwyj-venusaur") },
  oddish: { select: rod("pokemon/hyp/oddish", 3), move: rod("pokemon/hyp/oddish", 2, 4), attack: rod("pokemon/hyp/oddish", 1) },
};

let got = 0;
let failed = 0;
for (const [key, moods] of Object.entries(CLIPS)) {
  mkdirSync(join(OUT, key), { recursive: true });
  for (const [mood, urls] of Object.entries(moods) as [string, string[]][]) {
    for (const [i, url] of urls.entries()) {
      const file = join(OUT, key, `${mood}-${i + 1}.mp3`);
      if (!force && existsSync(file)) continue;
      try {
        const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
        if (!r.ok) throw new Error(String(r.status));
        writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        got++;
      } catch (e) {
        failed++;
        console.log(`  ${key} ${mood}-${i + 1}: failed (${(e as Error).message}) ${url}`);
      }
    }
  }
  console.log(`  ${key}: ok`);
}
console.log(`${got} anime cries downloaded to ${OUT}${failed ? `, ${failed} failed` : ""}.`);
if (failed) process.exitCode = 1;
