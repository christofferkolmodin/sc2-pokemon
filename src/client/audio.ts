import type { WeaponFx } from "../sim/units.ts";

/**
 * Sound, all synthesized with WebAudio (no audio files): move sounds by type,
 * impacts, faint chimes, UI blips, short Pokémon "cries", and the SC2
 * advisor ("Not enough minerals") through the browser's speech synthesis.
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.5;
  voice = true;
  private lastPlay = new Map<string, number>();
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
    if (!ctx || !this.master || this.volume <= 0) return;
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

  private hiss(freq: number, q: number, dur: number, gain: number, type: BiquadFilterType = "bandpass", sweep = 1) {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noise || this.volume <= 0) return;
    const t = ctx.currentTime;
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

  attack(fx: WeaponFx, near: number) {
    if (near <= 0 || !this.gate("atk:" + fx, 70)) return;
    const v = 0.12 * near;
    switch (fx) {
      case "ember":
      case "flame":
        this.hiss(900, 0.8, fx === "flame" ? 0.45 : 0.22, v * 1.4, "lowpass", 0.5);
        break;
      case "water":
      case "hydro":
        this.hiss(2400, 1.2, fx === "hydro" ? 0.5 : 0.18, v * (fx === "hydro" ? 1.6 : 1), "bandpass", 0.4);
        break;
      case "bubble":
        for (let i = 0; i < 3; i++) this.tone("sine", 500 + i * 180, 900 + i * 200, 0.08, v * 0.8, i * 0.05);
        break;
      case "leaf":
      case "vine":
        this.hiss(3000, 3, 0.15, v, "bandpass", 0.6);
        break;
      case "solar":
        this.tone("sawtooth", 180, 900, 0.5, v * 0.7);
        this.tone("sine", 880, 1760, 0.4, v * 0.5, 0.05);
        break;
      case "spark":
      case "bolt":
        this.tone("square", 1400, 300, 0.12, v * 0.6);
        this.hiss(5000, 2, 0.1, v * 0.7, "highpass");
        break;
      case "bite":
        this.hiss(600, 2, 0.08, v * 1.4, "bandpass", 0.5);
        break;
    }
  }

  hit(near: number) {
    if (near > 0 && this.gate("hit", 50)) this.hiss(300, 1, 0.08, 0.06 * near, "lowpass", 0.5);
  }

  faint(near: number) {
    if (near <= 0 || !this.gate("faint", 90)) return;
    this.tone("triangle", 880, 220, 0.35, 0.12 * near);
    this.tone("sine", 660, 165, 0.4, 0.07 * near, 0.05);
  }

  explosion(near: number) {
    if (near <= 0 || !this.gate("boom", 120)) return;
    this.hiss(400, 0.5, 0.9, 0.35 * near, "lowpass", 0.15);
    this.tone("sine", 90, 35, 0.7, 0.3 * near);
  }

  /** Short synthesized cry when selecting or ordering a Pokémon. Each species has its own contour. */
  cry(kind: number) {
    if (!this.gate("cry", 260)) return;
    const base = 300 + ((kind * 97) % 500);
    const shape = kind % 4;
    const notes = shape === 0 ? [1, 1.5, 1.25] : shape === 1 ? [1.3, 1, 1.6] : shape === 2 ? [1, 1.2, 0.9, 1.4] : [1.5, 1.1];
    notes.forEach((n, i) => this.tone(i % 2 ? "triangle" : "square", base * n, base * n * 1.08, 0.07, 0.035, i * 0.065));
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

  /** The advisor. Uses the browser's built-in speech synthesis, rate-limited per line. */
  say(text: string, minGapMs = 4000) {
    if (!this.voice || this.volume <= 0) return;
    const now = performance.now();
    if (now - (this.lastSpeech.get(text) ?? -1e9) < minGapMs) return;
    this.lastSpeech.set(text, now);
    try {
      const s = window.speechSynthesis;
      if (!s || s.speaking) return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.pitch = 0.85;
      u.volume = Math.min(1, this.volume * 1.6);
      s.speak(u);
    } catch {
      /* no speech: fine */
    }
  }
}
