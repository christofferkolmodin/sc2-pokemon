---
tags: [sc2-pokemon, game, readme]
updated: 2026-10-08
---

# SC2 Pokémon: start here

A browser RTS that plays like StarCraft 2, with starter Pokémon instead of SC2 units. **Private project for me and friends only. Not published, repo stays private.**

**Status:** milestones 1 and 2 are playable: a movement "feel lab" with SC2 controls, and 2–4 player lockstep multiplayer over Tailscale. No combat or economy yet.

## The goal, in priority order
1. **Feel like SC2.** Instant command feedback, SC2 group movement (balls, pushing, magic box), control groups, shift-queue, attack-move, hotkeys, 22.4 Hz pacing.
2. **Play with friends** over a private network, with replays.
3. **Look like SC2.** 3D units, SC2's tilted camera, cliffs, shadows and the SC2 console layout. The models are placeholders built from simple shapes; real models can replace them later because rendering is separate from game logic.

## Quick start
Requires Node.js 20.11 or newer and a browser with WebGL2 (any current Chrome, Edge, Firefox or Safari).

```bash
npm install
npm start            # builds the client and serves http://localhost:3000
```

- **Solo feel lab:** open the page, press *Solo feel lab*. You get a starter army plus an idle dummy army to bump into.
- **With friends:** everyone opens `http://<host-tailscale-name>:3000/?room=<name>`, presses *Join room*, the host presses *Start*. Starting alone in a room also works, which is handy for testing the netcode.
- **Replays:** *Save replay* downloads a JSON file. *Watch replay…* in the lobby plays it back and checks that it reproduces bit-for-bit.
- **Tuning:** press **F10** in a game. Sliders change movement constants live, for every player (they go through lockstep like any other command).
- **Best feel:** press *Fullscreen*. It locks the cursor to the window (so edge scrolling works like SC2) and, in Chrome/Edge, lets Ctrl+1–0 reach the game instead of switching browser tabs.

Other commands: `npm run dev` (rebuild client and restart server on change), `npm test` (determinism and movement tests), `npm run typecheck`.

## Architecture

```
src/sim/      Deterministic simulation. Pure TypeScript, integers only, no DOM.
src/client/   Browser: input, SC2 camera, WebGL2 3D renderer, HUD, minimap, replays.
src/client/gl/  Renderer internals: math, terrain mesh, primitive meshes, unit models.
src/server/   Node relay: rooms, 22.4 Hz turn clock, desync detection, static files.
src/net/      Message types shared by client and server.
test/         node:test suites (determinism, movement behaviour, purity rules).
```

**Commands → sim → render.** Input never touches game state directly. It produces commands (move, stop, hold, …). Solo, multiplayer and replays all feed the sim the same way: a *turn* per tick with that tick's commands. The renderer reads sim state and interpolates between the last two ticks, so 22.4 ticks/s still looks smooth at 144 Hz.

**Lockstep networking.** The server never simulates. Every 44.6 ms it broadcasts the commands it received since the last tick, stamped with player ids. Every client runs the same sim on the same turns. Clients send a state hash every 32 ticks and the server flags any mismatch as a desync. Players only exchange commands, so bandwidth is tiny and unit count doesn't matter.

**Instant feedback despite lockstep.** Like SC2, the click marker, selection and command card react immediately on your machine; units start moving one turn later (≈ 45 ms plus half your ping).

### Determinism rules (enforced by `test/purity.test.ts`)
JavaScript only guarantees identical results for basic arithmetic, not for `Math.sin`, `Math.atan2` and friends, so browsers can disagree. The sim therefore:
- Uses integers only. 1 tile = 4096 subunits (same precision as SC2).
- Divides with `idiv()`/`fdiv()`, never the bare `/` operator, and uses `isqrt()` instead of `Math.sqrt`.
- Takes all randomness from its seeded PRNG. No `Math.random`, `Date` or `performance`.
- Imports nothing from outside `src/sim`.
- Iterates units in id order and breaks ties deterministically.

Replays double as the main determinism test: a replay recorded in the browser is re-run and must match every stored hash.

### How movement works (the SC2 tricks)
- **Flow fields.** One Dijkstra field per command target, shared by every unit in that command. Units look ahead along the field and steer toward the farthest point they can reach in a straight line, which gives smooth paths instead of grid zig-zags.
- **Clearance classes.** Big units (Venusaur) get their own fields that avoid gaps they can't fit through.
- **Group arrival (the "ball").** A unit stops when it touches a group-mate that already arrived. This is why SC2 armies form tight balls instead of fighting over one point.
- **Magic box.** Clicking outside the selection's bounding box keeps the units' relative spacing (shrunk near walls). Clicking inside it makes them converge.
- **Pushing.** Moving units shove your idle units aside. Hold-position units are immovable. Enemy units block each other evenly.
- **Air units** stack while moving and slowly drift apart when idle.
- **Give up when stuck** after about 2 seconds of no progress.

Every constant above is a slider in the F10 panel. Once values feel right, bake them into `src/sim/tuning.ts`.

### Units (placeholder art)
Each Pokémon borrows the movement stats of an SC2 unit, so it can be compared side by side with SC2 footage:

| Pokémon | Moves like | Notes |
|---|---|---|
| Squirtle | Marine | small, 3.15 speed |
| Charmander | Zergling | small, fast (4.13) |
| Bulbasaur | Roach | medium |
| Venusaur | Thor | huge, slow, needs wide gaps |
| Charizard | Mutalisk | air, gliding acceleration |

Units are low-poly 3D Pokémon assembled from spheres, cones and cylinders (`src/client/gl/models.ts`), with a team-coloured scarf, a walk bob, flickering tail flames and flapping wings. Ripped models can replace them later; keep any such assets in `assets-private/` (git-ignored).

## Decisions (and what changed from the first draft)
- **Renderer: our own small WebGL2 3D renderer** (`src/client/render.ts`, no dependencies). It has:
  - SC2's camera: distance 34, pitch 56°, about a 31° field of view, panning only.
  - A heightfield terrain. Blocked tiles rise into rocky cliffs that start exactly at the tile edge, so what you see matches collision.
  - Sun lighting with a shadow map.
  - Instanced unit models, so hundreds of units cost about five draw calls.
  - Ground-decal selection circles.
  - Unit portraits rendered from the models.
- **Three.js later.** Switch to three.js when we import real animated (skinned glTF) models; the renderer only exposes `draw`, `pick`, `pickBox`, `onScreen` and `unitIcon`, so the swap is contained. Phaser is ruled out: its own game loop and physics fight a separate deterministic sim.
- **Multiplayer was moved forward**, from roadmap step 4 to step 2. Retrofitting determinism into a working single-player game is painful, so the architecture is lockstep from day one.
- **3D with SC2's camera** from the start (changed from the earlier "2D first" plan, because the look matters as much as the feel). Game logic is still 2D: the sim has no heights, and cliffs are just blocked tiles drawn tall.
- **1v1 first** (up to 4 players already works, which is useful for testing).
- **Tooling kept minimal:** TypeScript, esbuild, `ws`, `tsx`. No framework.

## Roadmap
1. ✅ **Movement lab:** map, camera, box select, control groups, shift-queue, magic box, pushing, group arrival, tuning panel.
2. ✅ **Lockstep multiplayer** over Tailscale, desync detection, replays.
3. **Combat:** HP, armor, attacks, attack-move target acquisition, death, health bars. Also unit turn rates, which matter once units shoot.
4. **Economy:** workers, mineral trips and saturation, buildings that train units, supply.
5. **Vertical slice:** one faction mirror (for example Fire vs Fire), ~5 units, 1v1. Play it with friends until it's fun.
6. **More factions and content,** then fog of war, AI opponent, real 3D models (three.js + glTF), high ground with vision rules, always-on hosting.

**Next feel work:** compare against SC2 footage (marines through a ramp, a zergling surround, a muta stack) and tune. Known gaps: no turn rate yet, and no "idle units walk back after being pushed" behaviour.

## Game design proposals
- **Factions = types.** Fire, Water, Grass, each drawing on *every* starter of that type across generations (Charmander, Cyndaquil, Torchic … Fuecoco). Nine lines × three stages is plenty of units. A single starter line per faction (three Pokémon) is too few for an RTS roster.
- **Evolution as tech.** Stage 1 is the basic unit; evolving works like a Zerg morph or a tech requirement.
- **Type effectiveness replaces SC2's armor attributes.** SC2 already has bonus damage vs Light/Armored/Biological. Use types instead: Fire gets bonus vs Grass-tagged units, and secondary types (Flying, Ground, Psychic) become cross-faction attributes so it isn't pure rock-paper-scissors.
- **Workers:** a non-starter mascot per faction.

## Hosting (private, friends only)
**Tailscale, with node sharing.** Share only the game machine with each friend from the Tailscale admin console (*Share…*). Don't invite friends into your tailnet: that gives them network access to all your devices unless you write ACLs, and the free Personal plan is capped at 6 users. Shared machines don't use up seats.

1. **Now:** run `npm start` on your PC. The server prints its Tailscale address (100.x.y.z). Friends open `http://<your-pc-name>:3000`.
2. **Later (when we want it always on):** move to a small VPS or Fly.io with Tailscale inside the container, no public IP, auto-stop off. Not worth setting up until there's a game worth leaving online.

Password protection inside the game code doesn't work (the files stay downloadable), and itch.io's rules don't allow other companies' IP.

## Legal reality check
Blizzard and Nintendo IP, and Nintendo enforces hard. Keeping it private among friends keeps the risk low, but it isn't "legal". Rules: private repo, no public URL, ripped assets never committed to git, no streaming or posting clips.

## Reference
- Unit stats: [Liquipedia SC2](https://liquipedia.net/starcraft2) and the SC2 Map Editor data.
- SC2 runs 22.4 game loops per second on Faster.
- Open-source RTS engines to learn from: OpenRA, OpenBW, 0 A.D., Beyond All Reason.

## Open questions
- Which Pokémon map to which roles (worker, early unit, tank, air, caster)?
- Faction design details: secondary types per unit, evolution costs.
- What should the first real map look like (main + natural + third)?
