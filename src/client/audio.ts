import { KINDS, type WeaponFx } from "../sim/units.ts";

/** What a Pokémon is reacting to: being selected, a move order, an attack order. */
export type CryMood = "select" | "move" | "attack";

/** A synthesized creature sound, for Pokémon that roar, bark or buzz instead of talking. */
type Beast = "roar" | "growl" | "bark" | "buzz";

interface Voice {
  /** Spoken lines per mood, Pokémon-anime style; "-" splits syllables, CAPS are shouted. */
  select: string[];
  move: string[];
  attack: string[];
  /** Speech pitch (0..2) and rate. */
  pitch: number;
  rate: number;
  /** Synthesized instead of spoken. */
  beast?: Beast;
  /** Base frequency of the beast sound (Hz). */
  low?: number;
}

const V = (select: string[], move: string[], attack: string[], pitch: number, rate: number, beast?: Beast, low?: number): Voice => ({ select, move, attack, pitch, rate, beast, low });
const BEAST = (beast: Beast, low: number): Voice => V([], [], [], 1, 1, beast, low);

const VOICES: Record<string, Voice> = {
  // Workers.
  growlithe: BEAST("bark", 520),
  psyduck: V(["Psy-duck?", "Psy-yi-yi..."], ["Psy-duck!", "Psy?", "Duck-duck!"], ["PSY-YI-YI!", "Psy-DUCK!"], 1.6, 1.25),
  oddish: V(["Odd-ish!", "Odd-ish?"], ["Odd-ish!", "Odd-odd!", "Ish!"], ["ODD-ISH!", "Odd-ISH!"], 2, 1.5),
  voltorb: BEAST("buzz", 140),
  // Fire.
  charmander: V(["Char-man-der!", "Char?"], ["Char!", "Char-char!", "Char-man!"], ["CHAR-MAN-DER!", "Char-CHAR!"], 1.8, 1.45),
  charmeleon: V(["Char-mee-leon.", "Meleon?"], ["Char!", "Meleon!"], ["CHAR-MEE-LEON!", "CHAAR!"], 0.9, 1.15),
  charizard: BEAST("roar", 95),
  // Water.
  squirtle: V(["Squir-tle!", "Squirtle?"], ["Squirt-squirt!", "Squir-tle!", "Squirt!"], ["SQUIR-TLE!", "Squirt-SQUIRT!"], 1.85, 1.45),
  wartortle: V(["War-tor-tle.", "Wartor?"], ["War-tor!", "Tortle!"], ["WAR-TOR-TLE!", "Tor-TLE!"], 1.1, 1.2),
  blastoise: BEAST("roar", 75),
  // Grass.
  bulbasaur: V(["Bul-ba-saur!", "Bulba?"], ["Bulba!", "Bulba-bulba!", "Saur!"], ["BUL-BA-SAUR!", "Bulba-SAUR!"], 1.6, 1.4),
  ivysaur: V(["I-vy-saur.", "Ivy?"], ["I-vy!", "Ivy-saur!"], ["I-VY-SAUR!", "SAUR!"], 1.05, 1.2),
  venusaur: BEAST("roar", 62),
  // Lightning.
  pichu: V(["Pi-chu!", "Pi?"], ["Pi-pi!", "Pi-chu!", "Chu!"], ["PI-CHUUU!", "Pi-CHU!"], 2, 1.6),
  pikachu: V(["Pi-ka-chu!", "Pi-ka?"], ["Pi-ka-pi-ka!", "Pi-ka!", "Chu!"], ["PI-KA-CHUUU!", "Pi-ka-CHU!"], 1.75, 1.45),
  raichu: V(["Rai-chu.", "Rai?"], ["Rai-rai!", "Rai-chu!"], ["RAI-CHUUU!", "Rai-CHU!"], 1.05, 1.2),
};

/** Small type-flavoured sound layered under spoken lines. */
const FLAVOUR: Record<string, "static" | "ember" | "bubble" | "rustle"> = {
  pichu: "static", pikachu: "static", raichu: "static",
  charmander: "ember", charmeleon: "ember",
  squirtle: "bubble", wartortle: "bubble", psyduck: "bubble",
  bulbasaur: "rustle", ivysaur: "rustle", oddish: "rustle",
};

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

/**
 * How loud sound files sound once they've loaded (LUFS, see `loudness`). Every
 * cry, whatever game or recording it's from, ends up equally loud, a little under
 * the advisor, who has to be heard over the battle.
 */
const CRY_DB = -21;
const ADVISOR_DB = -16;

/** Coefficients [b0, b1, b2, a1, a2] of an RBJ high shelf or high-pass biquad. */
function biquad(type: "shelf" | "highpass", sr: number, f0: number, q: number, db = 0): number[] {
  const w = (2 * Math.PI * f0) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b: number[], a: number[];
  if (type === "shelf") {
    const A = 10 ** (db / 40);
    const s = 2 * Math.sqrt(A) * alpha;
    b = [A * (A + 1 + (A - 1) * cos + s), -2 * A * (A - 1 + (A + 1) * cos), A * (A + 1 + (A - 1) * cos - s)];
    a = [A + 1 - (A - 1) * cos + s, 2 * (A - 1 - (A + 1) * cos), A + 1 - (A - 1) * cos - s];
  } else {
    b = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
    a = [1 + alpha, -2 * cos, 1 - alpha];
  }
  return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]];
}

/**
 * How loud a clip sounds, roughly in LUFS: ITU-R BS.1770 K-weighting (ears hear
 * the highs louder and barely hear rumble), over the louder half of 100 ms
 * windows so short cries aren't judged by the silence around them.
 */
export function loudness(buf: AudioBuffer): number {
  const sr = buf.sampleRate;
  const filters = [biquad("shelf", sr, 1500, Math.SQRT1_2, 4), biquad("highpass", sr, 38, 0.5)];
  const win = Math.max(1, Math.min(buf.length, Math.floor(sr / 10)));
  const energy = new Float64Array(Math.max(1, Math.floor(buf.length / win)));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const x = Float64Array.from(buf.getChannelData(ch));
    for (const [b0, b1, b2, a1, a2] of filters) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
        x[i] = y;
      }
    }
    for (let w = 0; w < energy.length; w++) {
      let sum = 0;
      for (let i = w * win; i < (w + 1) * win; i++) sum += x[i] * x[i];
      energy[w] += sum / win;
    }
  }
  const loud = Array.from(energy).sort((a, b) => a - b).slice(energy.length >> 1);
  return -0.691 + 10 * Math.log10(loud.reduce((a, b) => a + b, 0) / loud.length + 1e-12);
}

/** Scales a clip in place so it sounds as loud as `lufs`. */
export function level(buf: AudioBuffer, lufs: number) {
  const now = loudness(buf);
  if (now < -70) return; // silence
  const gain = Math.min(8, 10 ** ((lufs - now) / 20));
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const c = buf.getChannelData(ch);
    for (let i = 0; i < c.length; i++) c[i] *= gain;
  }
}

/**
 * Sound, mostly synthesized with WebAudio: a sound per move, impacts by type,
 * faint chimes, UI blips. Pokémon play their real game cries when they've been
 * downloaded (npm run fetch-cries), else spoken anime-style lines or synthesized
 * roars, barks and buzzes. The advisor ("We need more minerals") plays recorded
 * lines if there are any (npm run gen-advisor), else the browser's speech synthesis.
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.5;
  /** Silences everything (while fast-forwarding through a rejoined game). */
  muted = false;
  voice = true;
  /** Who gives advice ("We need more minerals"): a calm professor or an excited young trainer. */
  advisor: Advisor = "professor";
  /** Which cries play: the modern game remasters, the classic ones (npm run fetch-cries) or anime voices. */
  cries: CrySet = "anime";
  /** Unit cries are switched on with the voice option too. */
  private lastPlay = new Map<string, number>();
  private lastCry = 0;
  private cryUtterance: SpeechSynthesisUtterance | null = null;
  private profVoice: SpeechSynthesisVoice | null = null;
  private cuteVoice: SpeechSynthesisVoice | null = null;
  /**
   * Sound files from assets-private/sounds, decoded once, by path without extension:
   * your own recordings (<key>.mp3, <key>-faint.mp3), the game cries
   * (cries/latest/<key>.ogg, cries/legacy/<key>.ogg) and advisor lines
   * (advisor/<professor|trainer>/<line>-<n>.mp3).
   */
  private clips = new Map<string, AudioBuffer>();
  private clipsLoading = false;
  /** When the current cry / advisor clip ends (AudioContext time), so they don't pile up. */
  private cryEnd = 0;
  private advisorEnd = 0;

  /** Load the drop-in sound files, if there are any. Missing files are fine. */
  async loadClips() {
    if (this.clipsLoading) return;
    this.clipsLoading = true;
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      const r = await fetch("/api/sounds");
      if (!r.ok) return;
      const files = (await r.json()) as string[];
      await Promise.all(
        files.map(async (f) => {
          try {
            const url = f.split("/").map(encodeURIComponent).join("/");
            const data = await (await fetch(`/assets/sounds/${url}`)).arrayBuffer();
            const name = f.replace(/\.[a-z0-9]+$/i, "").toLowerCase();
            const buf = await ctx.decodeAudioData(data);
            level(buf, name.startsWith("advisor/") ? ADVISOR_DB : CRY_DB);
            this.clips.set(name, buf);
          } catch {
            /* skip files the browser can't decode */
          }
        }),
      );
    } catch {
      /* no sounds folder: fine */
    }
  }

  private playClip(name: string, rate = 1, gain = 1): boolean {
    return this.playBuffer(this.clips.get(name), rate, gain) > 0;
  }

  /** Plays a decoded clip; returns when it ends (AudioContext time), or 0 if it couldn't play. */
  private playBuffer(buf: AudioBuffer | undefined, rate = 1, gain = 1): number {
    const ctx = this.ctx;
    if (!buf || !ctx || !this.master || this.volume <= 0 || this.muted) return 0;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start();
    return ctx.currentTime + buf.duration / rate;
  }

  /**
   * A Pokémon's real cry: your own recording first, then the chosen set. Anime
   * voices have takes per mood (cries/anime/<key>/<mood>-<n>, npm run
   * fetch-anime-cries) and play as recorded; Pokémon without them use the game
   * cry. Like SC2 unit voices, a new cry waits for the last one to finish (true
   * is returned so nothing else plays instead).
   */
  private gameCry(key: string, mood: CryMood | "faint", rate: number, gain = 1, interrupt = false): boolean {
    let buf = this.clips.get(key);
    if (!buf && this.cries === "anime") {
      const takes = (m: string) => [...this.clips.keys()].filter((k) => k.startsWith(`cries/anime/${key}/${m}-`));
      const exact = takes(mood);
      // No take for this mood: any select/move take, slowed for a faint.
      const any = exact.length ? exact : [...takes("select"), ...takes("move")];
      if (any.length) {
        buf = this.clips.get(pick(any));
        rate = exact.length ? 0.98 + Math.random() * 0.04 : mood === "faint" ? 0.8 : 1;
      }
    }
    const order: CrySet[] = this.cries === "legacy" ? ["legacy", "latest"] : ["latest", "legacy"];
    for (const set of order) buf ??= this.clips.get(`cries/${set}/${key}`);
    if (!buf || !this.ctx) return false;
    if (!interrupt && this.ctx.currentTime < this.cryEnd) return true;
    this.cryEnd = this.playBuffer(buf, rate, gain) || this.cryEnd;
    return true;
  }
  private lastSpeech = new Map<string, number>();

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(this.ctx.destination);
      const n = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, n, n);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  /** Call from a user gesture (browsers start audio suspended). */
  resume() {
    this.ensure()?.resume().catch(() => {});
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /** Rate-limit by key: many units firing at once shouldn't stack into noise. */
  private gate(key: string, ms: number): boolean {
    const now = performance.now();
    if (now - (this.lastPlay.get(key) ?? 0) < ms) return false;
    this.lastPlay.set(key, now);
    return true;
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.volume <= 0 || this.muted) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private hiss(freq: number, q: number, dur: number, gain: number, type: BiquadFilterType = "bandpass", sweep = 1, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noise || this.volume <= 0 || this.muted) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  /** An oscillator whose pitch wobbles (LFO), optionally through a resonant lowpass: buzz, growls. */
  private buzz(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, lfoRate: number, lfoDepth: number, delay = 0, filter = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.volume <= 0 || this.muted) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    lfo.frequency.value = lfoRate;
    depth.gain.value = lfoDepth;
    lfo.connect(depth).connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.04, dur * 0.2));
    g.gain.setValueAtTime(gain, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out: AudioNode = o;
    if (filter > 0) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = filter;
      f.Q.value = 4;
      out = o.connect(f);
    }
    out.connect(g).connect(this.master);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  /** Filtered noise with a tremolo: flamethrower roar, rolling thunder, rushing water. */
  private rumble(freq: number, dur: number, gain: number, tremolo: number, type: BiquadFilterType = "lowpass", sweep = 1, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noise || this.volume <= 0 || this.muted) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const trem = ctx.createGain();
    trem.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.frequency.value = tremolo;
    lfoG.gain.value = 0.4;
    lfo.connect(lfoG).connect(trem.gain);
    src.connect(f).connect(trem).connect(g).connect(this.master);
    src.start(t, Math.random());
    lfo.start(t);
    src.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  /** Random little pops spread over `dur`: fire crackle, static. */
  private crackle(n: number, dur: number, gain: number, freq = 3000, delay = 0) {
    for (let i = 0; i < n; i++) this.hiss(freq * (0.6 + Math.random() * 0.8), 1.5, 0.012 + Math.random() * 0.02, gain * (0.5 + Math.random() * 0.5), "bandpass", 1, delay + Math.random() * dur);
  }

  /** A bubble: a sine that chirps upward very fast. */
  private bloop(f: number, gain: number, delay = 0) {
    this.tone("sine", f, f * 2.6, 0.06, gain, delay);
  }

  attack(fx: WeaponFx, near: number) {
    if (near <= 0 || !this.gate("atk:" + fx, 70)) return;
    const v = 0.12 * near;
    switch (fx) {
      case "ember":
        // A puff of flame and a few embers popping.
        this.hiss(700, 0.7, 0.22, v * 1.3, "lowpass", 0.5);
        this.crackle(5, 0.3, v * 0.9, 2500);
        break;
      case "flame":
        // Flamethrower: a fluttering roar with crackle all through it.
        this.rumble(1400, 0.75, v * 2, 17, "lowpass", 0.4);
        this.hiss(3500, 0.8, 0.5, v * 0.5, "bandpass", 0.5);
        this.crackle(14, 0.7, v, 2600);
        break;
      case "bite":
        // Two quick jaw clacks.
        for (const d of [0, 0.075]) {
          this.hiss(3200, 2, 0.025, v * 1.6, "highpass", 1, d);
          this.tone("triangle", 220, 70, 0.07, v * 1.1, d);
        }
        break;
      case "fang":
        // Fire Fang: a crunch wrapped in a burst of flame.
        this.hiss(3200, 2, 0.03, v * 1.8, "highpass");
        this.tone("triangle", 200, 60, 0.09, v * 1.3);
        this.hiss(900, 0.7, 0.3, v * 1.2, "lowpass", 0.4, 0.03);
        this.crackle(7, 0.3, v * 0.9, 2500, 0.03);
        break;
      case "scratch":
        // Three quick claw swipes.
        for (let i = 0; i < 3; i++) this.hiss(2600, 2.5, 0.06, v * 1.2, "bandpass", 2.2, i * 0.055);
        break;
      case "absorb":
        // A soft rising drain with little sparkles.
        this.buzz("sine", 300, 1100, 0.45, v * 0.7, 9, 40);
        [0.1, 0.2, 0.3].forEach((d, i) => this.tone("sine", 1500 + i * 300, 1900 + i * 300, 0.07, v * 0.4, d));
        break;
      case "water":
        // Water Gun: a pressurised squirt that gurgles.
        this.rumble(2600, 0.28, v * 1.4, 38, "bandpass", 0.45);
        this.bloop(380, v * 0.6, 0.02);
        break;
      case "bubble":
        for (let i = 0; i < 6; i++) this.bloop(300 + Math.random() * 600, v * 0.7, i * 0.045 + Math.random() * 0.02);
        break;
      case "hydro":
        // Hydro Pump: a heavy blast of water and spray.
        this.tone("sine", 110, 40, 0.3, v * 1.8);
        this.rumble(1600, 0.75, v * 2.2, 22, "lowpass", 0.25);
        this.hiss(4200, 0.7, 0.6, v * 0.7, "bandpass", 0.6, 0.05);
        break;
      case "leaf":
        // Razor Leaf: spinning blades swishing past, with a metallic edge.
        for (let i = 0; i < 3; i++) this.hiss(3500, 3, 0.09, v * 0.9, "bandpass", 1.8, i * 0.06);
        this.tone("triangle", 3200, 2600, 0.12, v * 0.25, 0.02);
        break;
      case "vine":
        // A swish, then the crack of the whip.
        this.hiss(1200, 1.5, 0.18, v * 0.7, "bandpass", 3);
        this.hiss(4200, 0.8, 0.05, v * 2.2, "highpass", 1, 0.14);
        break;
      case "solar":
        // Solar Beam: gathers light (rising shimmer) during the wind-up, then fires.
        this.buzz("sine", 220, 1400, 0.32, v * 0.6, 14, 30);
        this.tone("triangle", 660, 1980, 0.32, v * 0.3);
        this.tone("sawtooth", 140, 70, 0.55, v * 0.9, 0.3);
        this.rumble(2000, 0.55, v * 1.6, 30, "lowpass", 0.3, 0.3);
        this.tone("sine", 1760, 1320, 0.4, v * 0.4, 0.3);
        break;
      case "spark":
        // Electric crackle with a zap.
        this.buzz("square", 90, 70, 0.16, v * 0.35, 60, 40, 0, 2500);
        this.tone("sawtooth", 2400, 500, 0.08, v * 0.5, 0.02);
        this.crackle(8, 0.16, v * 1.1, 5000);
        break;
      case "bolt":
        // Thunderbolt: a sharp zap and a buzzing discharge.
        this.tone("sawtooth", 1800, 160, 0.16, v * 0.7);
        this.buzz("square", 110, 80, 0.3, v * 0.4, 50, 50, 0.04, 3000);
        this.crackle(12, 0.3, v * 1.2, 5500);
        break;
      case "thunder":
        // A crack of thunder that rolls away (lands with the strike, after the wind-up).
        this.hiss(5000, 0.7, 0.06, v * 3, "highpass", 1, 0.2);
        this.crackle(10, 0.15, v * 1.6, 6000, 0.2);
        this.rumble(700, 1.8, v * 2.6, 7, "lowpass", 0.15, 0.22);
        this.tone("sine", 70, 30, 1.2, v * 1.4, 0.22);
        break;
    }
  }

  /** Impact sound, flavoured by the attack that landed. */
  hit(near: number, fx?: WeaponFx) {
    if (near <= 0 || !this.gate("hit:" + (fx ?? ""), 50)) return;
    const v = 0.06 * near;
    switch (fx) {
      case "water":
      case "bubble":
      case "hydro":
        this.hiss(1400, 1.2, 0.12, v * 1.4, "bandpass", 0.5);
        break;
      case "ember":
      case "flame":
      case "fang":
        // A sizzle on top of the thud.
        this.hiss(5000, 0.8, 0.18, v * 0.8, "highpass", 0.6);
        this.hiss(300, 1, 0.08, v, "lowpass", 0.5);
        break;
      case "spark":
      case "bolt":
      case "thunder":
        this.crackle(4, 0.08, v * 1.5, 5000);
        this.hiss(300, 1, 0.06, v, "lowpass", 0.5);
        break;
      default:
        this.hiss(300, 1, 0.08, v, "lowpass", 0.5);
    }
  }

  faint(near: number, kind = -1, mine = false) {
    if (near <= 0 || !this.gate("faint", 90)) return;
    this.tone("triangle", 880, 220, 0.35, 0.12 * near);
    this.tone("sine", 660, 165, 0.4, 0.07 * near, 0.05);
    // Your own Pokémon on screen let out a weak, drawn-out cry as they faint.
    if (!(mine && near > 0.5 && kind >= 0 && this.gate("faintcry", 1500))) return;
    const key = KINDS[kind].key;
    // Your own "-faint" recording, or the cry slowed down and lowered like in the games.
    if (this.playClip(`${key}-faint`) || this.gameCry(key, "faint", 0.75, 0.9, true)) return;
    const voice = VOICES[key];
    if (!voice) return;
    if (voice.beast) this.beast(voice, "select", true);
    else this.speakCry(voice.select[0], voice, kind, true);
  }

  explosion(near: number) {
    if (near <= 0 || !this.gate("boom", 120)) return;
    this.hiss(400, 0.5, 0.9, 0.35 * near, "lowpass", 0.15);
    this.tone("sine", 90, 35, 0.7, 0.3 * near);
  }

  /**
   * Voice when selecting or ordering a Pokémon: a line for the mood ("Pi-ka-pi-ka!"
   * on a move order, "PI-KA-CHUUU!" on an attack order), or its roar / bark / buzz.
   * Real cries win: your own <key>-<mood>.mp3 or <key>.mp3, then the game cry
   * (a touch faster and louder on attack orders).
   */
  cry(kind: number, mood: CryMood = "select") {
    if (!this.gate("cry", 260)) return;
    const key = KINDS[kind]?.key ?? "";
    const attack = mood === "attack";
    if (this.playClip(`${key}-${mood}`) || this.gameCry(key, mood, (attack ? 1.06 : 0.97) + Math.random() * 0.06, attack ? 1.15 : 1)) return;
    const voice = VOICES[key];
    if (!voice) return;
    if (voice.beast) {
      const now = performance.now();
      if (now - this.lastCry < 700) return;
      this.lastCry = now;
      this.beast(voice, mood, false);
      return;
    }
    this.speakCry(pick(voice[mood]), voice, kind, false);
  }

  /** Synthesized roars, growls, barks and buzzes; attack orders are louder and longer. */
  private beast(voice: Voice, mood: CryMood, fainting: boolean) {
    const f = voice.low ?? 100;
    const big = mood === "attack" ? 1.35 : mood === "move" ? 0.75 : 1;
    const g = 0.1 * (fainting ? 0.7 : 1);
    switch (voice.beast) {
      case "roar": {
        // A throaty rise and fall: detuned saws through a resonant filter, plus breath.
        const dur = (fainting ? 1.1 : 0.7) * big;
        const up = fainting ? 0.7 : 1.5;
        this.buzz("sawtooth", f, f * up, dur * 0.4, g * 1.2, 22, f * 0.08, 0, f * 9);
        this.buzz("sawtooth", f * up, f * 0.7, dur * 0.6, g * 1.2, 18, f * 0.1, dur * 0.4, f * 8);
        this.buzz("sawtooth", f * 1.01, f * 0.75, dur, g * 0.7, 27, f * 0.12, 0, f * 6);
        this.rumble(900, dur, g * 1.2, 30, "bandpass", 0.6);
        break;
      }
      case "growl":
        this.buzz("sawtooth", f, f * (fainting ? 0.6 : 1.25), 0.45 * big, g, 28, f * 0.12, 0, f * 8);
        this.rumble(1200, 0.4 * big, g * 0.6, 32, "bandpass", 0.7);
        break;
      case "bark": {
        // Growlithe: "Arf!" when moving, "Arf! Arf!" when selected, a snarl and two barks when attacking.
        const n = fainting || mood === "move" ? 1 : 2;
        const at = mood === "attack" ? 0.28 : 0;
        if (mood === "attack") this.buzz("sawtooth", 180, 160, 0.3, g * 0.8, 30, 25, 0, 1400);
        for (let i = 0; i < n; i++) {
          const d = at + i * 0.2;
          this.tone("sawtooth", f * (fainting ? 0.8 : 1.1), f * (fainting ? 0.4 : 0.7), fainting ? 0.4 : 0.11, g * 0.9, d);
          this.tone("square", f * 2, f * 1.3, 0.06, g * 0.3, d);
          this.hiss(1600, 1.5, 0.09, g * 0.8, "bandpass", 0.6, d);
        }
        break;
      }
      case "buzz":
        // Voltorb: an electric whirr and a couple of bleeps.
        this.buzz("square", f, fainting ? f * 0.4 : f * 1.3, 0.35 * big, g * 0.5, 40, 25, 0, 2200);
        this.crackle(mood === "attack" ? 10 : 4, 0.3, g * 0.8, 5000);
        if (!fainting) [0, 1].forEach((i) => this.tone("square", (mood === "attack" ? 1100 : 880) * (1 + i * 0.25), 900 * (1 + i * 0.25), 0.05, g * 0.35, 0.08 + i * 0.08));
        break;
    }
  }

  /** A little type-flavoured sound under spoken lines, so cries aren't just a voice. */
  private flavour(key: string) {
    const g = 0.03;
    switch (FLAVOUR[key]) {
      case "static":
        this.crackle(5, 0.25, g * 1.2, 5000);
        break;
      case "ember":
        this.crackle(4, 0.2, g, 2500);
        break;
      case "bubble":
        this.bloop(500 + Math.random() * 300, g);
        this.bloop(600 + Math.random() * 300, g, 0.06);
        break;
      case "rustle":
        this.hiss(3500, 2, 0.15, g, "bandpass", 0.7);
        break;
    }
  }

  ui() {
    if (this.gate("ui", 40)) this.tone("sine", 1200, 1500, 0.04, 0.04);
  }

  ready() {
    this.tone("sine", 660, 660, 0.09, 0.07);
    this.tone("sine", 990, 990, 0.12, 0.07, 0.09);
  }

  evolve() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone("triangle", f, f * 1.01, 0.16, 0.06, i * 0.07));
  }

  /**
   * Speaks a line one syllable at a time in a bright voice, climbing to the last
   * one ("pi-ka-CHU!"). Questions lift, "..." lines and fainting fall. Never talks
   * over the Professor.
   */
  private speakCry(text: string, voice: Voice, kind: number, fainting: boolean): boolean {
    if (!this.voice || this.volume <= 0 || this.muted) return false;
    const now = performance.now();
    if (!fainting && now - this.lastCry < 700) return true;
    try {
      const s = window.speechSynthesis;
      if (!s || (s.speaking && !this.cryUtterance)) return false;
      s.cancel();
      const question = text.endsWith("?");
      const sleepy = text.endsWith("...");
      const syl = text.replace(/[.!?]/g, "").split("-");
      const tts = this.cutieVoice();
      let last: SpeechSynthesisUtterance | null = null;
      syl.forEach((raw, i) => {
        const shout = raw.length > 1 && raw === raw.toUpperCase();
        const t = syl.length > 1 ? i / (syl.length - 1) : 1;
        const end = i === syl.length - 1 ? (question ? "?" : "!") : "";
        const u = new SpeechSynthesisUtterance(fainting ? raw.toLowerCase() + "..." : raw.toLowerCase() + end);
        if (tts) u.voice = tts;
        const lift = fainting || sleepy ? -0.25 - t * 0.5 : question ? t * 0.35 : -0.25 + t * 0.3;
        u.pitch = Math.max(0.1, Math.min(2, voice.pitch + lift + (shout ? 0.15 : 0)));
        u.rate = fainting ? 0.6 : sleepy ? voice.rate * 0.7 : voice.rate;
        u.volume = Math.min(1, this.volume * (shout ? 1.4 : 1.2));
        s.speak(u);
        last = u;
      });
      const end = last as SpeechSynthesisUtterance | null;
      if (end) {
        end.onend = end.onerror = () => {
          if (this.cryUtterance === end) this.cryUtterance = null;
        };
        this.cryUtterance = end;
      }
      this.chirp(KINDS[kind].stage, fainting);
      if (!fainting) this.flavour(KINDS[kind].key);
      this.lastCry = now;
      return true;
    } catch {
      return false;
    }
  }

  /** A soft two-note squeak layered under spoken cries (rising when happy, sliding down when fainting). */
  private chirp(stage: number, fainting: boolean) {
    const base = stage <= 1 ? 1300 : stage === 2 ? 1000 : 620;
    if (fainting) {
      this.tone("sine", base, base * 0.45, 0.5, 0.05);
      return;
    }
    this.tone("sine", base, base * 1.25, 0.07, 0.045);
    this.tone("triangle", base * 1.2, base * 1.6, 0.09, 0.04, 0.09);
  }

  /**
   * Best available voice from a ranked list of name patterns. Neural voices
   * (Edge's "Online (Natural)") and Google's online voices sound far more
   * human than the old local SAPI ones, so they come first.
   */
  private bestVoice(ranked: RegExp[]): SpeechSynthesisVoice | null {
    const voices = (window.speechSynthesis?.getVoices() ?? []).filter((v) => v.lang.startsWith("en"));
    if (!voices.length) return null;
    for (const re of ranked) {
      const v = voices.find((x) => re.test(x.name));
      if (v) return v;
    }
    return voices[0];
  }

  /** A bright, young voice for Pokémon cries. */
  private cutieVoice(): SpeechSynthesisVoice | null {
    if (!this.cuteVoice) this.cuteVoice = this.bestVoice(TRAINER_VOICES);
    return this.cuteVoice;
  }

  /** Voice for the advisor, depending on who's advising. */
  private advisorVoice(): SpeechSynthesisVoice | null {
    if (this.advisor === "trainer") return this.cutieVoice();
    if (!this.profVoice) this.profVoice = this.bestVoice(PROFESSOR_VOICES);
    return this.profVoice;
  }

  /**
   * The advisor speaks a line ("minerals", "attack", "victory"…) in the chosen
   * personality, picking one of a few phrasings. Rate-limited per line.
   */
  say(line: AdvisorLine, minGapMs = 4000) {
    if (!this.voice || this.volume <= 0 || this.muted) return;
    const now = performance.now();
    if (now - (this.lastSpeech.get(line) ?? -1e9) < minGapMs) return;
    // Recorded lines (advisor/<who>/<line>-<n>) beat the browser's voice.
    const prefix = `advisor/${this.advisor}/${line}`;
    const takes = [...this.clips.keys()].filter((k) => k === prefix || k.startsWith(prefix + "-"));
    if (takes.length && this.ctx) {
      if (this.ctx.currentTime < this.advisorEnd) return; // still talking
      this.lastSpeech.set(line, now);
      this.advisorEnd = this.playBuffer(this.clips.get(pick(takes)), 1, 1.3) || this.advisorEnd;
      return;
    }
    try {
      const s = window.speechSynthesis;
      if (!s) return;
      if (s.speaking) {
        if (!this.cryUtterance) return; // the advisor is already talking
        s.cancel(); // the advisor talks over cries
        this.cryUtterance = null;
      }
      this.lastSpeech.set(line, now);
      const u = new SpeechSynthesisUtterance(pick(ADVISOR_LINES[line][this.advisor]));
      const v = this.advisorVoice();
      if (v) u.voice = v;
      // Natural voices sound best untouched; pitching them makes them robotic.
      // The old local voices get a nudge toward the character instead.
      const natural = !!v && /Natural|Google/i.test(v.name);
      if (this.advisor === "trainer") {
        u.rate = natural ? 1.08 : 1.12;
        u.pitch = natural ? 1.05 : 1.3;
      } else {
        u.rate = natural ? 0.98 : 0.95;
        u.pitch = natural ? 1 : 0.9;
      }
      u.volume = Math.min(1, this.volume * 1.6);
      s.speak(u);
    } catch {
      /* no speech: fine */
    }
  }
}

/** Advisor voices, best first: a calm, warm older man. */
const PROFESSOR_VOICES = [
  /Ryan.*Natural/i, /Guy.*Natural/i, /Christopher.*Natural/i, /Davis.*Natural/i, /Brian.*Natural/i, /Andrew.*Natural/i,
  /Google UK English Male/i, /Daniel/i, /Arthur/i, /George/i, /David/i, /Mark/i, /Male/i,
];
/** A young, bright voice: the trainer advisor and Pokémon cries. */
const TRAINER_VOICES = [
  /Ana.*Natural/i, /Ava.*Natural/i, /Jenny.*Natural/i, /Aria.*Natural/i, /Emma.*Natural/i, /Michelle.*Natural/i,
  /Google US English/i, /Samantha/i, /Karen/i, /Google UK English Female/i, /Hazel/i, /Zira/i, /Susan/i, /Female/i,
];

export type Advisor = "professor" | "trainer";
export type CrySet = "latest" | "legacy" | "anime";
export type AdvisorLine = "minerals" | "gas" | "supply" | "max" | "baseAttack" | "unitsAttack" | "research" | "victory" | "defeat";

/** What the advisor says, per personality: a calm professor or an excited young trainer. */
export const ADVISOR_LINES: Record<AdvisorLine, Record<Advisor, string[]>> = {
  minerals: {
    professor: ["You'll need more minerals for that, trainer.", "Not enough minerals, I'm afraid.", "We require more minerals."],
    trainer: ["Aw man, not enough minerals!", "We need more minerals!", "Hold on, we're out of minerals!"],
  },
  gas: {
    professor: ["Not enough vespene gas, I'm afraid.", "You'll need more vespene gas."],
    trainer: ["We're out of gas!", "Not enough gas! Let's get those extractors going!"],
  },
  supply: {
    professor: ["Your team has no room to grow. Build a Poké Mart.", "You'll need another Poké Mart first."],
    trainer: ["Our team's full! We need a Poké Mart!", "No more room! Let's build a Poké Mart!"],
  },
  max: {
    professor: ["That is the largest team a trainer may have."],
    trainer: ["That's as big as our team can get!"],
  },
  baseAttack: {
    professor: ["Trainer! Your base is under attack!", "Your base is being attacked!"],
    trainer: ["Hey! They're attacking our base!", "Our base is under attack! Let's go!"],
  },
  unitsAttack: {
    professor: ["Your Pokémon are under attack!", "Your Pokémon need help!"],
    trainer: ["Our Pokémon are under attack!", "Hang in there, everyone!"],
  },
  research: {
    professor: ["Excellent! Research complete.", "Splendid. The research is finished."],
    trainer: ["Alright! Research is done!", "Yes! We're even stronger now!"],
  },
  victory: {
    professor: ["Splendid! You are the champion!", "Remarkable! A true Pokémon champion!"],
    trainer: ["We did it! We're the champions!", "Yeah! We won!"],
  },
  defeat: {
    professor: ["You've been defeated. Every great trainer loses sometimes."],
    trainer: ["We lost... but we'll train harder and win next time!"],
  },
};
