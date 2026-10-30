// Prints the loudness of 16-bit PCM WAV files, 100 ms at a time.
//
// Written for the red/green phase cues: "the green one is not heard" is either a quiet file next to a
// loud one, or a file that never played, and guessing between the two is how a cue gets tuned by ear
// over a live stream.
//
//   node scripts/wav-levels.ts out/sounds/red.wav            level of one file
//   node scripts/wav-levels.ts capture.wav --windows         level per window of a capture
//   node scripts/wav-levels.ts capture.wav --find=cue.wav    where in the capture that cue landed
//
// `--find` compares 10 ms loudness envelopes instead of raw samples: a cue is mixed with gunfire, so
// the waveform is gone but its shape (a quiet intro, then a rise) survives.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  data: Buffer;
}

/** Minimal RIFF reader: enough for the files this project produces (ffmpeg `pcm_s16le`). */
export function readWav(path: string): WavInfo {
  const buffer = readFileSync(path);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      return { sampleRate, channels, bitsPerSample, data: buffer.subarray(body, body + size) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}

/** dBFS for one window of samples; -Infinity for digital silence. */
function levelDb(samples: Int16Array): number {
  let sum = 0;
  for (const value of samples) sum += value * value;
  const rms = Math.sqrt(sum / Math.max(1, samples.length)) / 32768;
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

function framesOf(info: WavInfo, fromSec: number, toSec: number): Int16Array {
  const frameSize = (info.bitsPerSample / 8) * info.channels;
  const start = Math.floor(fromSec * info.sampleRate) * frameSize;
  const end = Math.min(info.data.length, Math.floor(toSec * info.sampleRate) * frameSize);
  const raw = info.data.subarray(start, end);
  const out = new Int16Array(Math.floor(raw.length / frameSize));
  for (let index = 0; index < out.length; index += 1) out[index] = raw.readInt16LE(index * frameSize);
  return out;
}

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith("--"));
if (path === undefined) {
  console.error("usage: node scripts/wav-levels.ts <file.wav> [--windows] [--window=0.1] [--find=<cue.wav>]");
  process.exit(2);
}
const perWindow = Number(args.find((arg) => arg.startsWith("--window="))?.slice("--window=".length) ?? 0.1);
const windows = args.includes("--windows");
const findWith = args.find((arg) => arg.startsWith("--find="))?.slice("--find=".length);
const scanDir = args.find((arg) => arg.startsWith("--scan="))?.slice("--scan=".length);

/** 10 ms loudness envelope, in dBFS, clamped so silence is a real value and not -Infinity. */
function envelope(info: WavInfo): Float32Array {
  const frameSize = (info.bitsPerSample / 8) * info.channels;
  const perWindow = Math.max(1, Math.floor(info.sampleRate * 0.01));
  const frames = Math.floor(info.data.length / frameSize);
  const out = new Float32Array(Math.floor(frames / perWindow));
  for (let window = 0; window < out.length; window += 1) {
    let sum = 0;
    for (let index = 0; index < perWindow; index += 1) {
      const sample = info.data.readInt16LE((window * perWindow + index) * frameSize) / 32768;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / perWindow);
    out[window] = Math.max(-90, 20 * Math.log10(Math.max(rms, 1e-6)));
  }
  return out;
}

/** Pearson correlation of one envelope window against a longer one, best first. */
function findCue(capture: Float32Array, cue: Float32Array): { at: number; score: number }[] {
  const scores: { at: number; score: number }[] = [];
  for (let offset = 0; offset + cue.length <= capture.length; offset += 1) {
    let sumA = 0;
    let sumB = 0;
    let sumAB = 0;
    let sumAA = 0;
    let sumBB = 0;
    for (let index = 0; index < cue.length; index += 1) {
      const a = capture[offset + index] ?? -90;
      const b = cue[index] ?? -90;
      sumA += a;
      sumB += b;
      sumAB += a * b;
      sumAA += a * a;
      sumBB += b * b;
    }
    const count = cue.length;
    const covariance = sumAB - (sumA * sumB) / count;
    const variance = Math.sqrt((sumAA - (sumA * sumA) / count) * (sumBB - (sumB * sumB) / count));
    scores.push({ at: offset / 100, score: variance === 0 ? 0 : covariance / variance });
  }
  return scores.sort((left, right) => right.score - left.score).slice(0, 3);
}

/** Every `.wav` under a directory, as (name, absolute path). */
function forNamedWavs(dir: string, visit: (name: string, file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) forNamedWavs(full, visit);
    else if (entry.name.toLowerCase().endsWith(".wav")) visit(full, full);
  }
}

const info = readWav(path);
const seconds = info.data.length / ((info.bitsPerSample / 8) * info.channels) / info.sampleRate;
const whole = levelDb(framesOf(info, 0, seconds));
let peak = 0;
for (const value of framesOf(info, 0, seconds)) peak = Math.max(peak, Math.abs(value));

console.log(
  `${path}: ${seconds.toFixed(2)}s, ${info.sampleRate} Hz, ${info.channels} ch, ${info.bitsPerSample} bit, ` +
    `mean ${whole === -Infinity ? "-inf" : whole.toFixed(1)} dBFS, peak ${(peak / 32768).toFixed(3)}`,
);

if (windows) {
  for (let at = 0; at < seconds; at += perWindow) {
    const level = levelDb(framesOf(info, at, Math.min(seconds, at + perWindow)));
    console.log(`${at.toFixed(2)}s ${(level === -Infinity ? "-inf" : level.toFixed(1)).padStart(6)} dBFS`);
  }
}

if (findWith !== undefined) {
  const cue = readWav(findWith);
  console.log(`${findWith}: best matches (envelope correlation, 1.00 is a perfect copy)`);
  for (const hit of findCue(envelope(info), envelope(cue))) {
    console.log(`  ${hit.at.toFixed(2)}s score ${hit.score.toFixed(2)}`);
  }
}

if (scanDir !== undefined) {
  const capture = envelope(info);
  const hits: { name: string; at: number; score: number }[] = [];
  forNamedWavs(scanDir, (name, file) => {
    let cue: Float32Array;
    try {
      cue = envelope(readWav(file));
    } catch {
      return;
    }
    // A match shorter than a fifth of a second is a coincidence, not a sound.
    if (cue.length < 20) return;
    const best = findCue(capture, cue)[0];
    if (best !== undefined) hits.push({ name, at: best.at, score: best.score });
  });
  console.log(`${scanDir}: which stock sounds are audible in the capture`);
  for (const hit of hits.sort((left, right) => right.score - left.score).slice(0, 15)) {
    console.log(`  ${hit.score.toFixed(2)} at ${hit.at.toFixed(2)}s  ${hit.name}`);
  }
}
