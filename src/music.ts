/**
 * Event music, synthesised at image build time.
 *
 * Why synthesised and not shipped as audio: the repository stays text, the same note tables produce
 * the same bytes on every build, and a real track still wins at runtime - the player looks for
 * `<overlay>/music/<code>.wav` before the copy baked into the image (`/usr/share/cs16/music`), so
 * replacing a bed needs no rebuild and no code change.
 *
 * Every bed lasts exactly one paid event (`MUSIC_SECONDS`): the player cuts playback when the event
 * clock runs out, so the music ends with the event and not with the file.
 */
export const MUSIC_SAMPLE_RATE = 22_050;
export const MUSIC_SECONDS = 15;
/** Used for any code without a bed of its own, so a new event is never silent. */
export const DEFAULT_TRACK = "default";

export type Wave = "square" | "saw" | "tri";

export interface TrackSpec {
  bpm: number;
  wave: Wave;
  /** Pulse width of the square wave; 0.125 is the thin, "8-bit" timbre. */
  duty?: number;
  /** One note per eighth note, `-` for a rest. */
  lead: readonly string[];
  /** One note per quarter note, `-` for a rest. */
  bass: readonly string[];
  /** Drum channel level, 0 disables it. */
  drums?: number;
}

const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** `C#4`, `Bb3` or `-` (rest) to a MIDI number. */
export function midi(name: string): number {
  if (name === "-") return -1;
  const match = /^([A-G])([#b]?)(-?\d)$/u.exec(name);
  if (match === null) return -1;
  const [, letter = "C", accidental = "", octave = "4"] = match;
  const shift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
  return 12 * (Number(octave) + 1) + (SEMITONE[letter] ?? 0) + shift;
}

export function frequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

/**
 * One bed per event. The mood is the point: a berserk cannon, an air raid, a nursery rhyme that
 * should not be comforting, a duel, and the silence around a single bullet.
 */
export const TRACKS: Record<string, TrackSpec> = {
  default: {
    bpm: 120,
    wave: "square",
    duty: 0.25,
    lead: "A3 C4 E4 C4 A3 C4 F4 C4".split(" "),
    bass: "A2 - A2 - F2 - G2 -".split(" "),
    drums: 0.6,
  },
  glass_cannon: {
    bpm: 168,
    wave: "square",
    duty: 0.25,
    lead: "D4 D4 F4 D4 A4 - G4 F4 D4 D4 F4 D4 Bb4 A4 G4 F4".split(" "),
    bass: "D2 D2 D2 D2 Bb1 Bb1 C2 C2".split(" "),
    drums: 0.9,
  },
  meteor_shower: {
    bpm: 88,
    wave: "tri",
    lead: "A4 - G4 - F4 - E4 - D4 - - - C4 - - -".split(" "),
    bass: "D2 - D2 - A1 - A1 - Bb1 - Bb1 - C2 - C2 -".split(" "),
    drums: 0.4,
  },
  red_light: {
    bpm: 132,
    wave: "square",
    duty: 0.125,
    lead: "B4 - A4 - G4 - A4 - B4 - C5 - B4 - - -".split(" "),
    bass: "E2 E2 E2 E2 C2 C2 D2 D2".split(" "),
    drums: 0.5,
  },
  lightsaber_duel: {
    bpm: 152,
    wave: "saw",
    lead: "A3 C4 E4 A4 C5 E5 A5 - G5 - E5 - C5 - A4 -".split(" "),
    bass: "A2 A2 F2 F2 C3 C3 G2 G2".split(" "),
    drums: 0.8,
  },
  one_bullet: {
    bpm: 112,
    wave: "tri",
    lead: "E4 - - - - - - - B3 - - - - - - -".split(" "),
    bass: "E2 - - - C2 - - -".split(" "),
    drums: 0.7,
  },
};

export const MUSIC_CODES: readonly string[] = Object.keys(TRACKS).sort();


/** Deterministic noise, so the same build produces byte-identical tracks. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function waveAt(wave: Wave, phase: number, duty: number): number {
  if (wave === "square") return phase < duty ? 1 : -1;
  if (wave === "saw") return 2 * phase - 1;
  return 1 - 4 * Math.abs(phase - 0.5);
}

function addTone(
  mix: Float32Array,
  startSec: number,
  durationSec: number,
  hz: number,
  wave: Wave,
  duty: number,
  gain: number,
): void {
  const from = Math.max(0, Math.floor(startSec * MUSIC_SAMPLE_RATE));
  const to = Math.min(mix.length, from + Math.floor(durationSec * MUSIC_SAMPLE_RATE));
  const step = hz / MUSIC_SAMPLE_RATE;
  let phase = 0;
  for (let index = from; index < to; index += 1) {
    const t = (index - from) / MUSIC_SAMPLE_RATE;
    // 5 ms attack kills the click, the exponential decay gives every note its own shape.
    const envelope = Math.min(1, t / 0.005) * Math.exp(-3 * (t / durationSec));
    mix[index] = (mix[index] ?? 0) + gain * envelope * waveAt(wave, phase, duty);
    phase += step;
    if (phase >= 1) phase -= 1;
  }
}

function addKick(mix: Float32Array, startSec: number, gain: number): void {
  const durationSec = 0.14;
  const from = Math.max(0, Math.floor(startSec * MUSIC_SAMPLE_RATE));
  const to = Math.min(mix.length, from + Math.floor(durationSec * MUSIC_SAMPLE_RATE));
  let phase = 0;
  for (let index = from; index < to; index += 1) {
    const t = (index - from) / MUSIC_SAMPLE_RATE;
    const hz = 120 - 75 * (t / durationSec);
    const envelope = Math.exp(-9 * t);
    mix[index] = (mix[index] ?? 0) + gain * envelope * Math.sin(2 * Math.PI * phase);
    phase += hz / MUSIC_SAMPLE_RATE;
  }
}

function addNoise(mix: Float32Array, startSec: number, durationSec: number, gain: number, random: () => number): void {
  const from = Math.max(0, Math.floor(startSec * MUSIC_SAMPLE_RATE));
  const to = Math.min(mix.length, from + Math.floor(durationSec * MUSIC_SAMPLE_RATE));
  for (let index = from; index < to; index += 1) {
    const t = (index - from) / MUSIC_SAMPLE_RATE;
    mix[index] = (mix[index] ?? 0) + gain * Math.exp(-28 * t) * (random() * 2 - 1);
  }
}

/** 16-bit mono PCM in a RIFF container: the format the null-sink player always takes. */
function toWav(mix: Float32Array): Buffer {
  const samples = mix.length;
  const buffer = Buffer.alloc(44 + samples * 2);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(MUSIC_SAMPLE_RATE, 24);
  buffer.writeUInt32LE(MUSIC_SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples * 2, 40);

  for (let index = 0; index < samples; index += 1) {
    // 50 ms fade out: the player kills the stream at the end of the event, a hard cut would click.
    const fade = Math.min(1, (samples - index) / (MUSIC_SAMPLE_RATE * 0.05));
    const value = Math.max(-1, Math.min(1, (mix[index] ?? 0) * fade));
    buffer.writeInt16LE(Math.round(value * 32_767), 44 + index * 2);
  }
  return buffer;
}

/**
 * Renders one bed. A code without a bed of its own falls back to `default`, so a newly added event
 * still gets music instead of silence.
 */
export function renderTrack(code: string): Buffer {
  const spec = TRACKS[code] ?? TRACKS[DEFAULT_TRACK];
  if (spec === undefined) throw new Error(`no music track for ${code}`);

  const mix = new Float32Array(MUSIC_SAMPLE_RATE * MUSIC_SECONDS);
  const random = mulberry32(code.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7));
  const eighth = 60 / spec.bpm / 2;
  const quarter = eighth * 2;
  const duty = spec.duty ?? 0.5;

  const lead = spec.lead.map(midi);
  if (lead.length > 0) {
    for (let step = 0; step * eighth < MUSIC_SECONDS; step += 1) {
      const note = lead[step % lead.length] ?? -1;
      if (note >= 0) addTone(mix, step * eighth, eighth * 0.92, frequency(note), spec.wave, duty, 0.22);
    }
  }

  const bass = spec.bass.map(midi);
  if (bass.length > 0) {
    for (let step = 0; step * quarter < MUSIC_SECONDS; step += 1) {
      const note = bass[step % bass.length] ?? -1;
      if (note >= 0) addTone(mix, step * quarter, quarter * 0.92, frequency(note), "tri", 0.5, 0.3);
    }
  }

  const drums = spec.drums ?? 0;
  if (drums > 0) {
    for (let beat = 0; beat * quarter < MUSIC_SECONDS; beat += 1) {
      addKick(mix, beat * quarter, 0.32 * drums);
      if (beat % 2 === 1) addNoise(mix, beat * quarter, 0.12, 0.1 * drums, random);
      addNoise(mix, beat * quarter + eighth, 0.03, 0.035 * drums, random);
    }
  }

  return toWav(mix);
}
