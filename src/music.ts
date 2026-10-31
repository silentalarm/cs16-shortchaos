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
  /**
   * Length of the bed in seconds. Defaults to `MUSIC_SECONDS`; a hero mode runs for a minute and its
   * bed has to cover the whole event, because the player cuts playback on the event clock.
   */
  seconds?: number;
  /** One note per eighth note, `-` for a rest. */
  lead: readonly string[];
  /** One note per quarter note, `-` for a rest. */
  bass: readonly string[];
  /** Drum channel level, 0 disables it. */
  drums?: number;
  /**
   * Output trim, linear gain, default 1. The mix gains are fixed, so a track with no bass and no
   * drums (the siren) measures ~8 dB under its neighbours; `wav-levels` is what catches it.
   */
  gain?: number;
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
  // The hero modes are a minute long, so their beds are too (`seconds`): a 15 second loop under a 60
  // second round leaves 45 seconds of silence, and the silence is what the viewer remembers.
  nemesis: {
    bpm: 150,
    wave: "saw",
    seconds: 60,
    lead: "D3 D3 F3 D3 A3 - G3 F3 E3 E3 G3 E3 Bb3 - A3 G3 D3 D3 F3 D3 A3 - C4 Bb3 A3 - G3 - F3 - E3 -".split(" "),
    bass: "D2 D2 D2 D2 Bb1 Bb1 C2 C2 D2 D2 D2 D2 Bb1 Bb1 A1 A1".split(" "),
    drums: 1,
  },
  survivor: {
    bpm: 128,
    wave: "square",
    duty: 0.375,
    seconds: 60,
    lead: "A4 C5 E5 A5 - G5 E5 C5 B4 D5 F5 B5 - A5 F5 D5 A4 C5 E5 A5 - E5 C5 A4 G4 B4 D5 G5 - F5 D5 B4".split(" "),
    bass: "A2 A2 F2 F2 C3 C3 G2 G2 A2 A2 F2 F2 G2 G2 E2 E2".split(" "),
    drums: 0.85,
  },
  juggernaut: {
    // A slow, heavy march: the mode is about one bot walking through a field of rifles.
    bpm: 104,
    wave: "saw",
    seconds: 60,
    lead: "E3 - E3 - G3 - E3 - A3 - G3 - E3 - D3 - E3 - - - E3 - E3 - G3 - B3 - A3 - G3 - F3 - E3 - - -".split(" "),
    bass: "E2 E2 E2 E2 C2 C2 C2 C2 D2 D2 D2 D2 B1 B1 B1 B1".split(" "),
    drums: 1,
  },
  sniper: {
    // Faster and thinner: one bot is being hunted by twenty, and the round is shorter.
    bpm: 164,
    wave: "square",
    duty: 0.125,
    seconds: 45,
    lead: "A4 - C5 - E5 - D5 - C5 - A4 - G4 - A4 - C5 - E5 - G5 - E5 - D5 - - -".split(" "),
    bass: "A2 - A2 - F2 - F2 - G2 - G2 - A2 - A2".split(" "),
    drums: 0.7,
  },
  outbreak: {
    // A rising figure that never resolves: the infection is the story, and it spreads.
    bpm: 140,
    wave: "tri",
    seconds: 60,
    lead: "E4 F4 G4 A4 B4 C5 D5 E5 D5 C5 B4 A4 G4 F4 E4 F4 G4 A4 B4 C5 B4 A4 G4 F4 E4 D4 E4 F4 G4 A4 B4".split(" "),
    bass: "E2 E2 E2 E2 F2 F2 F2 F2 G2 G2 G2 G2 A1 A1 A1 A1".split(" "),
    drums: 0.8,
  },
  chaos_plague: {
    // Everything at once, so the bed is deliberately unstable: a tritone and a wandering bass.
    bpm: 172,
    wave: "saw",
    seconds: 60,
    lead: "D4 Ab4 D4 F4 C4 Gb4 C4 E4 Bb3 E4 Bb3 D4 A3 Eb4 A3 A3 Eb4 A3 C4 G3 Db4 G3 Bb3 F3 B3 F3 A3".split(" "),
    bass: "D2 Ab1 D2 F1 C2 Gb1 C2 E1 Bb1 E1 Bb1 D2 A1 Eb2 A1 D2".split(" "),
    drums: 1,
  },
  // The S2 classes run 45 seconds (`jumpers` 30), and each one is a movement change, so the bed is the
  // metronome: the viewer hears how the field moves before they read a single bot.
  raptors: {
    // Quick, predatory, and it never settles on the tonic.
    bpm: 176,
    wave: "saw",
    seconds: 45,
    lead: "A4 - A4 C5 A4 - G4 A4 E5 - D5 C5 A4 - A4 C5 A4 - G4 E4 D4 E4 G4 A4 - - -".split(" "),
    bass: "A2 A2 A2 A2 F2 F2 F2 F2 G2 G2 G2 G2 A2 A2 A2 A2".split(" "),
    drums: 0.95,
  },
  brutes: {
    // Half the tempo and an octave down: four bots that walk through rifle fire.
    bpm: 92,
    wave: "square",
    duty: 0.375,
    seconds: 45,
    lead: "E3 - - - E3 - G3 - F3 - - - E3 - C3 -".split(" "),
    bass: "E1 E1 E1 E1 C1 C1 C1 C1 F1 F1 F1 F1 E1 E1 E1 E1".split(" "),
    drums: 1,
  },
  runners: {
    // A ticking sixteenth-note figure: everybody is already running.
    bpm: 180,
    wave: "square",
    duty: 0.125,
    seconds: 45,
    lead: "C5 D5 E5 G5 E5 D5 C5 D5 E5 F5 G5 A5 G5 F5 E5 D5".split(" "),
    bass: "C2 C2 G1 G1 A1 A1 F1 F1".split(" "),
    drums: 0.9,
  },
  jumpers: {
    // Sparse and high, with holes in it: the field is in the air more than on the ground.
    bpm: 108,
    wave: "tri",
    seconds: 30,
    lead: "G4 - - - B4 - - - D5 - - - G5 - - - F5 - - - D5 - - - B4 - - - G4 - - -".split(" "),
    bass: "G2 - - - E2 - - - C2 - - - D2 - - -".split(" "),
    drums: 0.35,
  },
  regenerators: {
    // A pulse that keeps coming back, which is what regeneration sounds like.
    bpm: 124,
    wave: "saw",
    seconds: 45,
    lead: "D4 F4 A4 D5 - A4 - F4 E4 G4 B4 E5 - B4 - G4".split(" "),
    bass: "D2 D2 D2 D2 E2 E2 E2 E2".split(" "),
    drums: 0.8,
  },
  // S8 sound. The air-raid siren is synthesised here instead of shipped as `infra/sounds/siren.mp3`:
  // a note table cannot sweep, but alternating A5/E5 every two seconds reads as wee-woo on a phone
  // speaker, and the repository stays free of audio binaries and licences (docs/activities/assets.md).
  siren: {
    bpm: 60,
    wave: "saw",
    seconds: 15,
    gain: 2.5,
    lead: "A5 A5 A5 A5 E5 E5 E5 E5".split(" "),
    bass: "- - - - - - - -".split(" "),
    drums: 0,
  },
  // A second, obviously different song: `music_swap` is the listener noticing the bed changed.
  music_swap: {
    bpm: 96,
    wave: "square",
    duty: 0.5,
    seconds: 20,
    lead: "C4 E4 G4 B4 C5 B4 G4 E4 A3 C4 E4 A4 C5 A4 E4 C4".split(" "),
    bass: "C2 C2 A1 A1 F1 F1 G1 G1".split(" "),
    drums: 0.7,
  },
};

export const MUSIC_CODES: readonly string[] = Object.keys(TRACKS).sort();


/** Deterministic noise, so the same build produces byte-identical tracks. */
export function mulberry32(seed: number): () => number {
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
export function toWav(mix: Float32Array): Buffer {
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

  // Per-track length: a 60 second hero mode with a 15 second bed is 45 seconds of silence.
  const seconds = spec.seconds ?? MUSIC_SECONDS;
  const mix = new Float32Array(MUSIC_SAMPLE_RATE * seconds);
  const random = mulberry32(code.split("").reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7));
  const eighth = 60 / spec.bpm / 2;
  const quarter = eighth * 2;
  const duty = spec.duty ?? 0.5;

  const lead = spec.lead.map(midi);
  if (lead.length > 0) {
    for (let step = 0; step * eighth < seconds; step += 1) {
      const note = lead[step % lead.length] ?? -1;
      if (note >= 0) addTone(mix, step * eighth, eighth * 0.92, frequency(note), spec.wave, duty, 0.22);
    }
  }

  const bass = spec.bass.map(midi);
  if (bass.length > 0) {
    for (let step = 0; step * quarter < seconds; step += 1) {
      const note = bass[step % bass.length] ?? -1;
      if (note >= 0) addTone(mix, step * quarter, quarter * 0.92, frequency(note), "tri", 0.5, 0.3);
    }
  }

  const drums = spec.drums ?? 0;
  if (drums > 0) {
    for (let beat = 0; beat * quarter < seconds; beat += 1) {
      addKick(mix, beat * quarter, 0.32 * drums);
      if (beat % 2 === 1) addNoise(mix, beat * quarter, 0.12, 0.1 * drums, random);
      addNoise(mix, beat * quarter + eighth, 0.03, 0.035 * drums, random);
    }
  }

  // Output trim after the mix: a level change is not a composition change, and the renderer clamps in
  // `toWav`, so a trim that would clip is a bug the level check sees.
  const gain = Math.max(0.1, Math.min(4, spec.gain ?? 1));
  if (gain !== 1) {
    for (let index = 0; index < mix.length; index += 1) mix[index] = (mix[index] ?? 0) * gain;
  }

  return toWav(mix);
}
