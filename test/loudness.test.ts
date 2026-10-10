import { test } from "node:test";
import assert from "node:assert/strict";
import { level, loudness } from "../src/client/audio.ts";

/** Just enough of an AudioBuffer for the loudness code. */
function buffer(sr: number, seconds: number, f: (t: number) => number): AudioBuffer {
  const data = Float32Array.from({ length: Math.round(sr * seconds) }, (_, i) => f(i / sr));
  return { sampleRate: sr, length: data.length, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer;
}
const sine = (hz: number, amp: number) => (t: number) => amp * Math.sin(2 * Math.PI * hz * t);

test("a 1 kHz tone at -20 dBFS measures about -23 LUFS, as in ITU-R BS.1770", () => {
  for (const sr of [11025, 24000, 44100, 48000]) {
    const l = loudness(buffer(sr, 1, sine(997, 0.1)));
    assert.ok(Math.abs(l - -23) < 0.6, `${sr} Hz: ${l.toFixed(2)} LUFS`);
  }
});

test("highs count for more and rumble for less than their raw level", () => {
  const mid = loudness(buffer(48000, 1, sine(1000, 0.1)));
  assert.ok(loudness(buffer(48000, 1, sine(4000, 0.1))) > mid + 2);
  assert.ok(loudness(buffer(48000, 1, sine(30, 0.1))) < mid - 3);
});

test("levelling makes different-sounding clips equally loud, ignoring the silence around them", () => {
  const short = buffer(24000, 1, (t) => (t > 0.4 && t < 0.6 ? sine(3000, 0.6)(t) : 0));
  const long = buffer(11025, 2, sine(400, 0.05));
  for (const b of [short, long]) level(b, -21);
  assert.ok(Math.abs(loudness(short) - -21) < 0.5, `short: ${loudness(short)}`);
  assert.ok(Math.abs(loudness(long) - -21) < 0.5, `long: ${loudness(long)}`);
});
