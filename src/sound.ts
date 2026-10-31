/**
 * Game sounds this repository makes for itself, rendered at image build time.
 *
 * Why generated and not shipped as a recording: the repository stays text, the same tables produce the same
 * bytes on every build, and a real sample still wins at runtime - the plugin precaches
 * `cstrike/sound/freeze/ice_crack.wav`, so dropping a recording in that path replaces the sound with no code
 * change. The build stage that runs this is `infra/sounds/generate.ts`; the file it writes is copied into the
 * game image and from there into the `/hlds` volume by `infra/entrypoint.sh`.
 *
 * The one asset is the ice of `freeze_nades`. The event used to stand in for a flashbang and played
 * `weapons/flashbang-1.wav`, which is a flash, not ice: three layers here - a snap (high-passed noise with a
 * hard decay), a crystalline shimmer (detuned partials well above the snap) and a small low crack that keeps
 * it audible on a mix that is mostly gunfire.
 */
import { MUSIC_SAMPLE_RATE, mulberry32, toWav } from "./music.ts";

export const SOUND_SAMPLE_RATE = MUSIC_SAMPLE_RATE;

/** Every sound this build makes, and where it lands inside `cstrike/sound`. */
export const SOUND_FILES = {
  ice_crack: "freeze/ice_crack.wav",
} as const;

export type SoundCode = keyof typeof SOUND_FILES;

export const SOUND_CODES: readonly SoundCode[] = (Object.keys(SOUND_FILES) as SoundCode[]).sort();

/** Length of one sample, in seconds. Long enough for a tail, short enough to fire every pulse. */
export const ICE_CRACK_SECONDS = 0.9;

function addSnap(mix: Float32Array, atSec: number, gain: number, random: () => number): void {
  const durationSec = 0.05;
  const from = Math.max(0, Math.floor(atSec * SOUND_SAMPLE_RATE));
  const to = Math.min(mix.length, from + Math.floor(durationSec * SOUND_SAMPLE_RATE));
  let previous = 0;
  for (let index = from; index < to; index += 1) {
    const t = (index - from) / SOUND_SAMPLE_RATE;
    const noise = random() * 2 - 1;
    // A one-pole difference is a cheap high pass: the snap has to sit above the gunfire, not under it.
    const high = noise - previous * 0.92;
    previous = noise;
    mix[index] = (mix[index] ?? 0) + gain * Math.exp(-90 * t) * high;
  }
}

function addPartial(
  mix: Float32Array,
  atSec: number,
  durationSec: number,
  hz: number,
  gain: number,
  decay: number,
): void {
  const from = Math.max(0, Math.floor(atSec * SOUND_SAMPLE_RATE));
  const to = Math.min(mix.length, from + Math.floor(durationSec * SOUND_SAMPLE_RATE));
  const step = hz / SOUND_SAMPLE_RATE;
  let phase = 0;
  for (let index = from; index < to; index += 1) {
    const t = (index - from) / SOUND_SAMPLE_RATE;
    // 2 ms attack so the partial starts with the snap instead of clicking after it.
    const envelope = Math.min(1, t / 0.002) * Math.exp(-decay * t);
    mix[index] = (mix[index] ?? 0) + gain * envelope * Math.sin(2 * Math.PI * phase);
    phase += step;
    if (phase >= 1) phase -= 1;
  }
}

/** Scales the mix so the loudest sample sits at `peak`: the engine plays the file at VOL_NORM. */
function normalize(mix: Float32Array, peak = 0.85): void {
  let loudest = 0;
  for (const value of mix) loudest = Math.max(loudest, Math.abs(value));
  if (loudest <= 0) return;
  const scale = peak / loudest;
  for (let index = 0; index < mix.length; index += 1) mix[index] = (mix[index] ?? 0) * scale;
}

/**
 * The crack of ice: the snap of a sheet breaking, the shimmer of the pieces and a low body that survives a
 * stream mix. `seed` is derived from the code so the file is the same on every build.
 */
export function renderSound(code: SoundCode): Buffer {
  const seconds = ICE_CRACK_SECONDS;
  const mix = new Float32Array(Math.round(SOUND_SAMPLE_RATE * seconds));
  const random = mulberry32(
    code.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 17),
  );

  // The break itself.
  addSnap(mix, 0, 1.6, random);
  addSnap(mix, 0.006, 0.9, random);
  // The body of the sheet: two low partials, gone in a fifth of a second.
  addPartial(mix, 0, 0.2, 97, 0.55, 16);
  addPartial(mix, 0, 0.16, 143, 0.3, 20);
  // The pieces: detuned pairs, so one shard never sounds like a tone.
  const shards: readonly (readonly [number, number, number])[] = [
    [2_637, 0.34, 6],
    [3_951, 0.22, 8],
    [5_274, 0.14, 11],
  ];
  for (const [hz, gain, decay] of shards) {
    addPartial(mix, 0.008, 0.5, hz, gain, decay);
    addPartial(mix, 0.008, 0.5, hz * 1.004, gain * 0.7, decay * 1.1);
  }
  // A second, quieter crack a moment later: what makes it read as ice giving way and not as a gunshot.
  addSnap(mix, 0.17, 0.7, random);
  addPartial(mix, 0.17, 0.4, 3_130, 0.16, 12);
  addPartial(mix, 0.17, 0.4, 4_690, 0.1, 15);

  normalize(mix);
  return toWav(mix);
}
