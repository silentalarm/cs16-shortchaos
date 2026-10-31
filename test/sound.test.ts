import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSound, SOUND_CODES, SOUND_FILES, SOUND_SAMPLE_RATE } from "../src/sound.ts";

/**
 * The freeze sample (`src/sound.ts`, rendered by `infra/sounds/generate.ts` at image build time).
 *
 * Why the container is checked here: a .wav the engine cannot parse is a silent blast at runtime and nothing
 * in the game log says why - the plugin precaches a name, and the engine happily caches bytes it cannot play.
 * The format is the one the music already uses (22 050 Hz, mono, 16-bit PCM), which is what the null-sink
 * player and the game both take without a resample.
 */
const ice = renderSound("ice_crack");

function pcm(wav: Buffer): Int16Array {
  assert.equal(wav.toString("latin1", 0, 4), "RIFF", "not a RIFF container");
  assert.equal(wav.toString("latin1", 8, 12), "WAVE", "not a wave file");
  const data = wav.indexOf("data", 0, "latin1");
  assert.ok(data > 0, "no data chunk");
  const bytes = wav.subarray(data + 8);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
}

test("the ice sample is a 22 kHz mono 16-bit wave file", () => {
  assert.equal(ice.toString("latin1", 12, 16), "fmt ", "no fmt chunk");
  assert.equal(ice.readUInt16LE(20), 1, "not PCM");
  assert.equal(ice.readUInt16LE(22), 1, "not mono");
  assert.equal(ice.readUInt32LE(24), SOUND_SAMPLE_RATE, "the sample rate does not match the rest of the audio");
  assert.equal(ice.readUInt16LE(34), 16, "not 16-bit");
  assert.ok(ice.length < 96 * 1024, `ice_crack.wav is ${ice.length} bytes - too long for a bang`);
});

test("the ice sample is a crack and not silence: it opens loud and dies away", () => {
  const samples = pcm(ice);
  const window = (from: number, to: number): number => {
    let peak = 0;
    for (let index = from; index < Math.min(samples.length, to); index += 1) {
      peak = Math.max(peak, Math.abs(samples[index] ?? 0));
    }
    return peak;
  };

  const head = window(0, Math.round(0.05 * SOUND_SAMPLE_RATE));
  const tail = window(samples.length - Math.round(0.1 * SOUND_SAMPLE_RATE), samples.length);
  assert.ok(head > 8_000, `the crack peaks at ${head}, which is a whisper`);
  assert.ok(tail < head * 0.2, `the tail (${tail}) is as loud as the crack (${head})`);
});

test("the same code renders the same bytes, and every code has a path in cstrike/sound", () => {
  assert.equal(renderSound("ice_crack").equals(ice), true, "the build is not reproducible");
  assert.deepEqual(SOUND_CODES, ["ice_crack"]);
  assert.equal(SOUND_FILES.ice_crack, "freeze/ice_crack.wav", "the plugin precaches freeze/ice_crack.wav");
});
