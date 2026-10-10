/**
 * Records every advisor line ("Not enough minerals, I'm afraid.") into
 * assets-private/sounds/advisor/<professor|trainer>/<line>-<n>.wav|mp3, so the
 * advisor stops sounding like the browser's robot voice.
 *
 * Local voice cloning with F5-TTS (default, needs an NVIDIA GPU):
 *   1. Put a clean 5-12 s clip of the voice (no music: run it through Ultimate
 *      Vocal Remover first) in assets-private/voices/professor/ and/or
 *      assets-private/voices/trainer/, any name, .wav/.mp3/.flac/.ogg/.m4a.
 *   2. Next to it, a .txt with exactly what's said in the clip (same name). Without
 *      one, F5-TTS transcribes the clip itself with Whisper (a big download).
 *   3. npm run gen-advisor
 *   One-time setup (already done on the dev PC): python -m venv .venv-tts, then in it
 *   pip install f5-tts, then pip install torch==2.7.1 torchaudio==2.7.1 --index-url
 *   https://download.pytorch.org/whl/cu126 and pip uninstall torchcodec (newer
 *   torchaudio needs FFmpeg DLLs; cu126 still supports older cards like the GTX 1060).
 *   On Windows, set TMP to a short folder while installing if a wheel fails to build.
 *   About 15-20 s per line on a GTX 1060.
 *
 * Or ElevenLabs, with voices made in Voice Design (no cloning of real people there):
 *   $env:ELEVENLABS_API_KEY="..."; $env:VOICE_PROFESSOR="..."; $env:VOICE_TRAINER="..."
 *   npm run gen-advisor -- --elevenlabs
 *
 * Lines you already have are skipped; --force redoes them. Edit the lines in
 * src/client/audio.ts (ADVISOR_LINES), --force, and reload the game.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { ADVISOR_LINES, type Advisor } from "../src/client/audio.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets-private", "sounds", "advisor");
const VOICES = join(ROOT, "assets-private", "voices");
const WHO: Advisor[] = ["professor", "trainer"];
const force = process.argv.includes("--force");
const eleven = process.argv.includes("--elevenlabs");
const ext = eleven ? "mp3" : "wav";

/** Every line to record for one advisor, minus the ones already there. */
function todo(who: Advisor) {
  mkdirSync(join(OUT, who), { recursive: true });
  const have = new Set(readdirSync(join(OUT, who)).map((f) => parse(f).name));
  return Object.entries(ADVISOR_LINES).flatMap(([line, byWho]) =>
    byWho[who]
      .map((text, i) => ({ name: `${line}-${i + 1}`, text }))
      .filter((l) => force || !have.has(l.name))
      .map((l) => {
        // A new recording replaces the old one in any format.
        for (const e of ["wav", "mp3"]) rmSync(join(OUT, who, `${l.name}.${e}`), { force: true });
        return { ...l, out: join(OUT, who, `${l.name}.${ext}`) };
      }),
  );
}

let made = 0;
if (eleven) {
  const key = process.env.ELEVENLABS_API_KEY;
  const ids: Record<Advisor, string | undefined> = { professor: process.env.VOICE_PROFESSOR, trainer: process.env.VOICE_TRAINER };
  if (!key || (!ids.professor && !ids.trainer)) {
    console.error("Set ELEVENLABS_API_KEY and VOICE_PROFESSOR and/or VOICE_TRAINER (see the top of tools/gen-advisor.ts).");
    process.exit(1);
  }
  for (const who of WHO) {
    if (!ids[who]) continue;
    for (const l of todo(who)) {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ids[who]}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({ text: l.text, model_id: "eleven_multilingual_v2" }),
      });
      if (!r.ok) {
        console.error(`${who} ${l.name}: ElevenLabs ${r.status} ${await r.text()}`);
        process.exit(1);
      }
      writeFileSync(l.out, Buffer.from(await r.arrayBuffer()));
      console.log(`  ${who} ${l.name}: "${l.text}"`);
      made++;
    }
  }
} else {
  const python = [join(ROOT, ".venv-tts", "Scripts", "python.exe"), join(ROOT, ".venv-tts", "bin", "python")].find(existsSync);
  if (!python) {
    console.error("F5-TTS isn't installed: see the top of tools/gen-advisor.ts.");
    process.exit(1);
  }
  const jobs = [];
  for (const who of WHO) {
    const dir = join(VOICES, who);
    const clip = existsSync(dir) ? readdirSync(dir).find((f) => /\.(wav|mp3|flac|ogg|m4a)$/i.test(f)) : undefined;
    if (!clip) {
      console.log(`  ${who}: no voice clip in ${dir}, skipped`);
      continue;
    }
    const txt = join(dir, `${parse(clip).name}.txt`);
    const refText = existsSync(txt) ? readFileSync(txt, "utf8").trim() : "";
    for (const l of todo(who)) jobs.push({ ref: join(dir, clip), refText, text: l.text, out: l.out });
  }
  if (jobs.length) {
    console.log(`Recording ${jobs.length} lines with F5-TTS (the first run downloads the model)...`);
    const r = spawnSync(python, [join(ROOT, "tools", "f5_advisor.py")], { input: JSON.stringify(jobs), stdio: ["pipe", "inherit", "inherit"] });
    if (r.status !== 0) process.exit(r.status ?? 1);
    made = jobs.length;
  }
}
console.log(`${made} advisor lines recorded to ${OUT}.`);
