import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities } from "../src/activities.ts";
import { DEFAULT_TRACK, MUSIC_SAMPLE_RATE, MUSIC_SECONDS, renderTrack, TRACKS } from "../src/music.ts";

/**
 * Event music is synthesised at image build time (`infra/music/generate.ts`) and played by the capture
 * container. These tests pin the two things a broken build would break silently: the file has to be a
 * real WAV of the event's length, and every event on sale has to resolve to a bed (its own, or the
 * default one).
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));
const onSale = catalog.activities.filter((activity) => activity.enabled);

test("a bed is a mono 16-bit WAV exactly as long as an event", () => {
  const wav = renderTrack("glass_cannon");

  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.subarray(36, 40).toString("ascii"), "data");
  assert.equal(wav.readUInt16LE(20), 1, "PCM");
  assert.equal(wav.readUInt16LE(22), 1, "mono: the null sink is mono in this setup");
  assert.equal(wav.readUInt32LE(24), MUSIC_SAMPLE_RATE);
  assert.equal(wav.readUInt16LE(34), 16, "16-bit samples");

  const samples = wav.readUInt32LE(40) / 2;
  assert.equal(samples, MUSIC_SAMPLE_RATE * MUSIC_SECONDS, "the bed ends with the event");
  assert.equal(wav.length, 44 + samples * 2);
});

test("a bed is audible, not silence, and stays inside the WAV range", () => {
  const wav = renderTrack("meteor_shower");
  let peak = 0;
  for (let offset = 44; offset + 1 < wav.length; offset += 2) {
    peak = Math.max(peak, Math.abs(wav.readInt16LE(offset)));
  }
  assert.ok(peak > 3_000, `peak ${peak} is too quiet to hear over the game`);
  assert.ok(peak <= 32_767);
});

test("the same build produces the same bytes", () => {
  assert.deepEqual(renderTrack("red_light"), renderTrack("red_light"));
  assert.notDeepEqual(renderTrack("red_light"), renderTrack("one_bullet"), "every event sounds different");
});

test("every event on sale has a bed of its own", () => {
  assert.ok(onSale.length > 0, "the catalogue has events on sale");
  for (const activity of onSale) {
    assert.ok(
      TRACKS[activity.code] !== undefined,
      `${activity.code} would fall back to ${DEFAULT_TRACK}, add its notes to src/music.ts`,
    );
  }
});

test("every bed is exactly as long as the event it belongs to", () => {
  // The player cuts playback on the event clock, so a bed shorter than its event leaves silence and a
  // longer one is cut mid-phrase. Checked against the catalogue, not against a constant. An event that
  // brings its own game-side track (`params.music`, like the lightsaber opera) has no generated bed to
  // measure: the file in the game's sound folder is the whole soundtrack.
  for (const activity of onSale) {
    if (activity.params.music !== undefined) continue;

    const declared = activity.seconds ?? MUSIC_SECONDS;
    const wav = renderTrack(activity.code);
    const samples = wav.readUInt32LE(40) / 2;
    assert.equal(samples, MUSIC_SAMPLE_RATE * declared, `${activity.code} has a bed of another length`);
  }
});

test("an unknown code falls back instead of throwing", () => {
  const wav = renderTrack("something_added_next_week");
  assert.equal(wav.readUInt32LE(40) / 2, MUSIC_SAMPLE_RATE * MUSIC_SECONDS);
});
