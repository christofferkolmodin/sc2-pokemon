---
tags: [sc2-pokemon, game, readme]
updated: 2026-10-08
---

# SC2 Pokémon: start here

A browser RTS that plays like StarCraft 2, with starter Pokémon instead of SC2 units. **Private project for me and friends only. Not published, repo stays private.**

**Status:** full melee games work. Economy (mining, gas, supply), buildings, production, combat with type effectiveness, evolution as tech, upgrades, fog of war with high ground, watchtowers, win/lose, a computer opponent, 2–8 player lockstep multiplayer with AI slots, replays, and **real SC2 ladder maps imported from your own StarCraft II install**. The renderer is three.js with sculpted 3D Pokémon, SC2-style terrain, shadows, bloom and particle effects.

## The goal, in priority order
1. **Feel like SC2.** Instant command feedback, SC2 group movement (balls, pushing, magic box), control groups, shift-queue, smart right-click, hotkeys, 22.4 Hz pacing, SC2 economy numbers.
2. **Play with friends** over a private network, with replays.
3. **Look like SC2.** Tilted camera, cliffs and high ground, shadows, the SC2 console layout, real SC2 map layouts.

## Quick start
Requires Node.js 20.11+ and a browser with WebGL2. Importing SC2 maps also needs Python 3 (standard library only).

```bash
npm install
npm run import-maps   # optional: turns the SC2 maps in your Battle.net cache into game maps
npm start             # builds the client and serves http://localhost:3000
```

- **Play vs computer:** pick a faction and a map, choose 1–3 opponents and a difficulty, press *Play vs computer*.
- **Feel lab:** sandbox with starter armies, free resources, a spawn panel and live movement tuning (F9).
- **With friends:** everyone opens `http://<host-tailscale-name>:3000/?room=<name>` and presses *Join room*. Everyone picks a faction; the host picks the map, can add computer players, and presses *Start*.
- **Replays:** *Menu → Save replay* (or the end screen) downloads a JSON file. *Watch replay…* plays it back (fog toggle, 1–8× speed) and checks that it reproduces bit-for-bit.
- **Best feel:** press ⛶. Fullscreen locks the cursor to the window (edge scrolling works like SC2) and, in Chrome/Edge, lets Ctrl+1–0 reach the game.
- **Model viewer:** `/viewer.html` shows every model on a turntable (`?only=charizard`, `?walk=0`, `?spin=0`).

Other commands: `npm run dev` (rebuild client and restart server on change), `npm test` (determinism, movement, economy, combat and bot-vs-bot tests), `npm run typecheck`.

## How it plays
**Factions = types.** Every faction has the same buildings and the Pikachu worker; the Gym trains your starter and evolution does the rest.

| Faction | Stage 1 (Gym) | Stage 2 (needs Evolution Shrine) | Stage 3 (needs Elite Hall) |
|---|---|---|---|
| 🔥 Fire | Charmander: fast, short-range Ember (Zergling role) | Charmeleon: melee Fire Fang | Charizard: **flies**, Flamethrower splash, hits air (Mutalisk role) |
| 💧 Water | Squirtle: Water Gun, hits air (Marine role) | Wartortle: Bubble Beam | Blastoise: Hydro Pump artillery, range 9, splash (Siege Tank role) |
| 🌿 Grass | Bulbasaur: tanky Vine Whip (Roach role) | Ivysaur: Razor Leaf, hits air | Venusaur: huge, Solar Beam (Thor role) |

- **Type effectiveness** replaces SC2's armor attributes: super effective ×1.5, not very effective ×0.7 (fire > grass > water > fire; electric beats water and flying). Charizard is fire/flying, the Bulbasaur line grass/poison, so it isn't pure rock-paper-scissors.
- **Evolution** is a Zerg-style morph (E): the Pokémon glows white, can't act, and comes out evolved with its health scaled. It costs minerals, gas and the supply difference.
- **Buildings:** Pokémon Center (town hall, +15 supply, trains Pikachu), Poké Mart (+8 supply), Extractor (on geysers), Gym, Evolution Shrine and Elite Hall (tech and +1/+2/+3 attack and defense upgrades), Poké Turret (Thunderbolt, hits ground and air). Workers place them Protoss-style: they walk there and place it, then wait for orders (shift-queue a gather to send them back to mining). Esc cancels construction, the last item in a production queue, or an evolution.
- **Economy uses SC2's numbers:** 50 minerals and 12 workers at the start, 5 per trip from 1800/900 fields, 4 gas per trip, 3 workers saturate a geyser. 12 workers mine about 690 per minute, like SC2. Workers ghost through units while mining.
- **Fog of war** with SC2's high-ground rule: ground units can't see up cliffs. Enemy buildings stay as last-seen snapshots. A ground unit next to a watchtower shares its sight.
- You lose when all your buildings are destroyed.

**Controls** follow SC2 standard hotkeys; the full list is in the lobby and in-game (?). Highlights: smart right-click (move / attack / gather / return / rally), A-click attack, B / V build menus, E evolve, Tab subgroups, F1 idle worker, F2 army, Backspace bases, Space last alert, Enter chat, Alt+click minimap ping.

## Real SC2 maps, engine and models

**Can it use the real SC2 engine?** Not from a browser game. SC2's engine is closed, and the only supported way to run your own game on it is a custom mod or Arcade map made in the SC2 Editor (Galaxy script and XML data). That would mean rebuilding this whole project inside the editor and playing through Battle.net. It would look exactly like SC2, but it's a different project, and Pokémon models would still have to be imported by hand. Not done here; worth considering separately if "looks exactly like SC2" ever matters more than owning the code.

**Real SC2 maps: yes, done.** `tools/import-sc2maps.py` reads the `.s2ma` maps cached by Battle.net when you play (or any `.SC2Map` you pass it) and writes `assets-private/maps/<map>.json` + `.png`:
- pathing from SC2's cliff flags and painted "no pathing" layer, cliff levels (high ground) and ramps, unbuildable areas;
- mineral fields (incl. small and rich), geysers, destructible rocks, Xel'Naga towers, start locations;
- the real heightmap (2 tiles per cliff level), doodad positions (trees, rocks, bushes, crystals, props), and the map's own minimap image, which the renderer uses as the ground colour.

On my install it found 52 melee maps (Alcyone, Site Delta, Oceanborn, Ghost River, Goldenaura, Post-Youth, Fear and Faith, …). Textures and real doodad meshes live in SC2's CASC game data, not in the maps, so the renderer recreates them procedurally.

**Real Pokémon models: drop-in.** Put `<pokemon>.glb` files (e.g. `charizard.glb`, `pikachu.glb`) in `assets-private/models/`. They replace the sculpted models in game and in the portrait, with animations picked by clip name (idle/stand, walk/run, attack). An optional `assets-private/models/models.json` tunes each one: `{ "charizard": { "scale": 1.2, "yaw": 90, "y": 0.1 } }`. The models are fitted to the unit's height automatically and get a team-colored ring.

## Architecture

```
src/sim/      Deterministic simulation. Pure TypeScript, integers only, no DOM.
src/ai/       Computer opponent: reads the world, issues commands like a player.
src/maps/     Loads imported SC2 maps (JSON) into sim maps + render data.
src/client/   Browser: input, SC2 camera, HUD, minimap, audio, replays, lobby.
src/client/render/  three.js renderer: terrain, sculpted models (SDF), effects, fog.
src/server/   Node relay: rooms, 22.4 Hz turn clock, desync detection, static files, imported maps.
src/net/      Message types shared by client and server.
tools/        Build scripts and the SC2 map importer.
test/         node:test suites (determinism, movement, melee, imported maps, purity rules).
```

**Commands → sim → render.** Input never touches game state directly. It produces commands (move, target, build, train, evolve, research, …). Solo, multiplayer, computer players and replays all feed the sim the same way: a *turn* per tick with that tick's commands. The renderer reads sim state and interpolates between ticks, so 22.4 ticks/s looks smooth at 144 Hz. The sim emits per-tick events (attacks, hits, deaths, evolutions, errors) that drive effects, sound and messages.

**Lockstep networking.** The server never simulates. Every 44.6 ms it broadcasts the commands it received since the last tick, stamped with player ids. Clients send a state hash every 32 ticks and the server flags mismatches as a desync. Computer players run in the host's browser, which sends their commands tagged with the AI's id (the server only accepts that from the host).

**Instant feedback despite lockstep.** Like SC2, click markers, selection, the command card and Pokémon "cries" react immediately; units start one turn later (≈ 45 ms plus half your ping).

### Determinism rules (enforced by `test/purity.test.ts`)
JavaScript only guarantees identical results for basic arithmetic, so the sim:
- Uses integers only. 1 tile = 4096 subunits (same precision as SC2).
- Divides with `idiv()`/`fdiv()`, never the bare `/`, and uses `isqrt()` instead of `Math.sqrt`.
- Takes all randomness from its seeded PRNG. No `Math.random`, `Date` or `performance`.
- Imports nothing from outside `src/sim`, iterates units in id order and breaks ties deterministically.

Replays double as the main determinism test, and `test/melee.test.ts` plays a full 9-minute bot-vs-bot game and checks that its replay is bit-identical.

### Movement (the SC2 tricks)
Flow fields shared per command target (a bucket-queue Dijkstra; when buildings change the map, stale fields are rebuilt a few per tick so there are no hitches), steering toward the farthest visible point, clearance classes for big units, SC2 group arrival ("the ball"), the magic box, pushing idle units, air stacking, and giving up when stuck. Every constant is a slider in the lab panel (F9).

### Rendering
- **Terrain:** heightfield from the map's real heights (imported) or generated from cliff levels (built-in); cliff bands become steep rock with triplanar shading; ground colour from the minimap image or a procedural palette; fine detail texture in the shader.
- **Pokémon:** sculpted from signed-distance shapes (ellipsoids, capsules, smooth blending, painted eyes and markings) and meshed with surface nets at load time, then drawn instanced: hundreds of units cost a few dozen draw calls. Legs, arms, tails and wings are separate parts so they animate; tail flames are particles; team colour is a scarf.
- **Buildings, resources, doodads:** procedural low-poly models, team and faction colored.
- **Effects:** particle pools and beams per move type, faint recall beams, explosions, evolution glow; bloom on High graphics.
- **Fog of war** is a per-tile texture sampled by every material.

## Decisions
- **three.js renderer** (replaced the hand-written WebGL2 one), because it brings glTF + skinned animation, shadows and post-processing. The public renderer surface (`draw`, `pick`, `pickBox`, `onScreen`, `unitIcon`) stayed the same.
- **Sculpted models instead of ripped assets** in the repo: they ship with the code and look consistent. Real models are a drop-in in `assets-private/`.
- **Python for the map importer:** SC2 maps are bzip2-compressed MPQ archives; Python's standard library reads them, Node can't without extra packages. Only the host needs it.
- **Protoss-style building** (worker places, building warps in) keeps workers mining; Zerg-style morphs for evolution.
- **Computer opponent is a command producer**, so its games replay and work in multiplayer for free. It knows where enemy buildings are (no scouting yet).

## Roadmap
1. ✅ Movement lab. 2. ✅ Lockstep multiplayer. 3. ✅ Combat. 4. ✅ Economy, buildings, production, supply. 5. ✅ Factions, evolution, upgrades, fog of war, AI, real SC2 maps, 3D renderer.
6. **Next:** play it with friends and balance. Ideas: abilities (one signature move per stage-3 Pokémon), more starters per type (Cyndaquil, Totodile, Chikorita lines), turn rates, a smarter AI that scouts, transports, a ranked-style matchmaking room list, always-on hosting.

## Hosting (private, friends only)
**Tailscale, with node sharing.** Share only the game machine with each friend from the Tailscale admin console (*Share…*). Don't invite friends into your tailnet: that gives them network access to all your devices unless you write ACLs. Shared machines don't use up seats.

1. **Now:** run `npm start` on your PC. The server prints its Tailscale address (100.x.y.z). Friends open `http://<your-pc-name>:3000`. Imported maps are served by the host, so friends don't need SC2.
2. **Later:** a small VPS or Fly.io with Tailscale inside the container, no public IP. Copy `assets-private/maps` along.

### On a website (pokecraft.win)
The site runs from this PC through a **Cloudflare Tunnel** (no port forwarding; config in `~/.cloudflared/config.yml`, tunnel `pokecraft`, `pokecraft.win` → `http://localhost:3000`).

1. Put the shared password on the first line of `.game-password` in the repo root (git-ignored), or set `GAME_PASSWORD`. Without one, the site is open to anyone.
2. `npm start` (it prints "password required for visitors").
3. `cloudflared tunnel run pokecraft` in a second terminal.

Friends open `https://pokecraft.win`, enter the password once (a cookie keeps them logged in for 30 days) and play. Changing the password logs everyone out. Playing on this PC via `localhost:3000` skips the password.

## Legal reality check
Blizzard and Nintendo IP, and Nintendo enforces hard. Keeping it private among friends keeps the risk low, but it isn't "legal". Rules: private repo, no public URL, **imported maps and any ripped models stay in `assets-private/` (git-ignored) and are never committed**, no streaming or posting clips.

## Reference
- Unit stats: [Liquipedia SC2](https://liquipedia.net/starcraft2) and the SC2 Map Editor data. SC2 runs 22.4 game loops per second on Faster.
- Open-source RTS engines to learn from: OpenRA, OpenBW, 0 A.D., Beyond All Reason.

## Open questions
- Balance: the numbers are first guesses. Playtest Fire vs Water vs Grass.
- One signature ability per final evolution?
- More Pokémon per faction (other starter lines of the same type) vs keeping it at three per faction?
