import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActivities } from "../src/activities.ts";
import { buildActivityCommand } from "../src/command.ts";
import { announcementFor, botSpeech, countdownCues, donationAnnouncement, phaseCues, quoteRequest, silenceRequest, VOICE_MAX_AGE_MS, VOICES, writeVoiceRequest } from "../src/voice.ts";

/**
 * The announcement voice is a request file spoken by the capture container (`infra/stream/voice.sh`).
 * These tests pin the format the shell script parses and the rule that a spoken line never reaches
 * RCON, where spaces and Cyrillic would break the command.
 *
 * The spring 2026 cut removed the narrator: a paid event and a donation no longer schedule speech, only
 * their bed (`announcementFor`), because espeak-ng over a gunfight was the worst thing on the stream.
 * The paid lines that remain are the viewer's own: `quotes_pack` and the bot chatter.
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));

test("a paid event schedules its music and no narrator", () => {
  const cannon = catalog.activities.find((activity) => activity.code === "glass_cannon");
  assert.ok(cannon);

  const request = announcementFor(cannon);
  assert.equal(request.text, undefined, "the spoken announcement is back");
  assert.equal(request.voice, undefined, "no espeak voice is scheduled for an event");
  assert.equal(request.music, "glass_cannon", "the bed is what is left, and it is kept");
  assert.equal(request.seconds, cannon.seconds ?? 15, "the bed still ends with the event");
});

test("a request file is line based, and newlines inside the text are collapsed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-voice-"));
  try {
    const path = writeVoiceRequest(dir, { voice: "ru+m3", text: "ПРИВЕТ\nМИР" }, 1, () => 0);
    assert.ok(path !== null && path.endsWith(".req"));

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.deepEqual(lines, ["voice=ru+m3", "text=ПРИВЕТ МИР"]);
    assert.deepEqual(
      readdirSync(join(dir, "voice")).filter((name) => name.endsWith(".tmp")),
      [],
      "the player must never see a half-written request",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing to say means no request at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-voice-"));
  try {
    assert.equal(writeVoiceRequest(dir, { voice: "ru" }), null);
    assert.equal(writeVoiceRequest(dir, {}), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bot line carries the bot name and a voice of its own", () => {
  const speech = botSpeech("Vasya", "привет", () => 0.99);
  assert.equal(speech.text, "Vasya говорит: привет");
  assert.ok(VOICES.includes(String(speech.voice)));
});

test("a spoken line is dropped from the RCON command", () => {
  const red = catalog.activities.find((activity) => activity.code === "red_light");
  assert.ok(red);
  assert.equal(typeof red.params.say, "string", "red_light has a spoken line");

  const command = buildActivityCommand(red);
  assert.equal(command.includes("say="), false, "RCON cannot carry spaces or Cyrillic");
  assert.equal(command, "amx_de red_light maxNameLength=16 seconds=15 stock=0");
});

test("a Cyrillic line is never read by an English voice", () => {
  // espeak-ng with an English voice spells Cyrillic out letter by letter: that is not a sentence. The paid
  // `quotes_pack` line is the one spoken request left, so that is the one this pins.
  for (const roll of [0, 0.25, 0.5, 0.75, 0.99]) {
    const request = quoteRequest("привет", () => roll);
    assert.match(String(request.text), /[\u0400-\u04FF]/u, "the line is Russian");
    assert.match(String(request.voice), /^ru/u, `${request.voice} cannot read Cyrillic`);
  }
});

test("a paid event writes no voice line into its request", () => {
  const cannon = catalog.activities.find((activity) => activity.code === "glass_cannon");
  assert.ok(cannon);

  const dir = mkdtempSync(join(tmpdir(), "cs16-voice-"));
  try {
    const path = writeVoiceRequest(dir, announcementFor(cannon));
    assert.ok(path !== null, "the bed alone is still a request");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.equal(
      lines.some((line) => line.startsWith("voice=") || line.startsWith("text=")),
      false,
      `the narrator is back in the request: ${lines.join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an event carries its own bed and the window the player must cut it at", () => {
  const cannon = catalog.activities.find((activity) => activity.code === "glass_cannon");
  assert.ok(cannon);

  const request = announcementFor(cannon);
  assert.equal(request.music, "glass_cannon", "the code names the bed");
  assert.equal(request.seconds, cannon.seconds ?? 15, "the music ends with the event");

  const lines = (() => {
    const dir = mkdtempSync(join(tmpdir(), "cs16-voice-"));
    try {
      const path = writeVoiceRequest(dir, request, 1, () => 0);
      assert.ok(path !== null);
      return readFileSync(path, "utf8").trimEnd().split("\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
  assert.ok(lines.includes("music=glass_cannon"), `no music line in ${lines.join(" | ")}`);
  assert.ok(lines.includes("seconds=15"), `no window in ${lines.join(" | ")}`);
});

test("params.music replaces the bed with a real track, and never reaches RCON", () => {
  const saber = catalog.activities.find((activity) => activity.code === "lightsaber_duel");
  assert.ok(saber);

  const patched = { ...saber, params: { ...saber.params, music: "/overlay/music/duel.wav" } };
  assert.equal(announcementFor(patched).music, "/overlay/music/duel.wav");
  assert.equal(
    buildActivityCommand(patched).includes("music="),
    false,
    "a file name is not a game parameter",
  );
});

test("params.onlyMusic keeps the bed and drops the voice, and the duel runs for 30 s", () => {
  const saber = catalog.activities.find((activity) => activity.code === "lightsaber_duel");
  assert.ok(saber);

  const request = announcementFor(saber);
  assert.equal(request.text, undefined, "music only: no spoken line over the orchestra");
  assert.equal(request.music, "/game/cstrike/sound/ambience/Opera.wav", "the bed is the game's opera");
  assert.equal(request.seconds, 30, "a 72 second track is cut when the 30 second event ends");
  assert.equal(
    buildActivityCommand(saber),
    "amx_de lightsaber_duel health=25 maxNameLength=16 seconds=30 stock=0",
    "music, onlyMusic and say never reach RCON",
  );

  const dir = mkdtempSync(join(tmpdir(), "cs16-voice-"));
  try {
    const path = writeVoiceRequest(dir, request, 1, () => 0);
    assert.ok(path !== null, "a music-only request still has to be written");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.ok(lines.includes("music=/game/cstrike/sound/ambience/Opera.wav"), lines.join(" | "));
    assert.ok(lines.includes("seconds=30"), lines.join(" | "));
    assert.equal(
      lines.some((line) => line.startsWith("text=")),
      false,
      `a music-only request carries no text line: ${lines.join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a per-run patch of seconds moves the bed with the game clock", () => {
  const saber = catalog.activities.find((activity) => activity.code === "lightsaber_duel");
  assert.ok(saber);

  // The panel may run the duel with its own length. The plugin then stops the event at the patched
  // clock, so the bed has to follow it - it used to follow the catalogue and sang on for the rest.
  const patched = { ...saber, params: { ...saber.params, seconds: 15 } };
  assert.equal(announcementFor(patched).seconds, 15, "the bed is cut with the event, not with the catalogue");
  assert.equal(announcementFor(saber).seconds, 30, "the shipped clock still comes from the catalogue");
  assert.equal(
    buildActivityCommand(patched).includes("seconds=15"),
    true,
    "the patch is what the game is told, so it is what the music must obey",
  );
});

test("a batch of events gets one bed and the longest clock, and no spoken credit", () => {
  const meteor = catalog.activities.find((activity) => activity.code === "meteor_shower");
  const duel = catalog.activities.find((activity) => activity.code === "lightsaber_duel");
  assert.ok(meteor && duel);

  const request = donationAnnouncement([meteor, duel]);
  assert.equal(request.music, "meteor_shower", "one bed for the whole batch, from the first effect");
  assert.equal(request.seconds, 30, "the music follows the longest effect, not the first one");
  assert.equal(request.text, undefined, "the donation monologue is back");
  assert.equal(request.voice, undefined, "no voice is scheduled for a donation");
});

test("a batch of phase events has no bed of its own: the cues are the soundtrack", () => {
  const red = catalog.activities.find((activity) => activity.code === "red_light");
  assert.ok(red);
  assert.deepEqual(donationAnnouncement([red]), {});
});

test("the bed is cut by its own request, so a phase event cannot inherit the previous music", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-voice-"));
  try {
    const path = writeVoiceRequest(dir, { musicStop: true }, 1, () => 0);
    assert.ok(path !== null, "a bed-stop request must be written even with no text");
    assert.deepEqual(readFileSync(path, "utf8").trimEnd().split("\n"), ["musicStop=1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop is a request of its own, so the Stop button cannot be swallowed as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-voice-"));
  try {
    const path = writeVoiceRequest(dir, silenceRequest(), 1, () => 0);
    assert.ok(path !== null, "a stop request must be written even with no text");
    assert.deepEqual(readFileSync(path, "utf8").trimEnd().split("\n"), ["stop=1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a phase event schedules one cue per phase", () => {
  const red = catalog.activities.find((activity) => activity.code === "red_light");
  assert.ok(red);

  const cues = phaseCues(red, 0);
  assert.ok(cues.length >= 7, `only ${cues.length} cues for a 15 second event`);
  assert.deepEqual(
    cues.slice(0, 2).map((cue) => [cue.at, cue.request.file]),
    [
      [0, "/usr/share/cs16/sounds/red.wav"],
      [1_500, "/usr/share/cs16/sounds/green.wav"],
    ],
    "RED opens the event, GREEN follows 1.5 s later",
  );
  assert.ok(cues.every((cue) => cue.at < 15_000), "no cue after the clock");
  // Two sources on top of each other is noise: the catalogue mutes the plugin's alarm and chime.
  assert.equal(red.params.stock, 0, "the stock cues are muted when the stream plays its own");

  assert.equal(
    buildActivityCommand(red),
    "amx_de red_light maxNameLength=16 seconds=15 stock=0",
    "file paths never reach RCON",
  );
  assert.deepEqual(phaseCues({ ...red, params: {} }, 0), [], "without custom files the plugin keeps its own cues");
});

test("the countdown speaks 3-2-1-fight on the game's own seconds", () => {
  const countdown = catalog.activities.find((activity) => activity.code === "announcer_countdown");
  assert.ok(countdown);

  const cues = countdownCues(countdown, 1_000);
  assert.equal(cues.length, 4, "three numbers and FIGHT");
  assert.deepEqual(
    cues.map((cue) => cue.at),
    [1_000, 2_000, 3_000, 4_000],
    "the cues do not land on the plugin's one second ticks",
  );
  assert.deepEqual(
    cues.map((cue) => cue.request.text),
    ["Три", "Два", "Один", "В бой!"],
  );
  for (const cue of cues) {
    assert.ok(String(cue.request.voice).startsWith("ru"), "a Cyrillic line needs a Russian voice");
  }

  const cannon = catalog.activities.find((activity) => activity.code === "glass_cannon");
  assert.ok(cannon);
  assert.deepEqual(countdownCues(cannon, 0), [], "only the countdown schedules countdown cues");
});

test("a quote is spoken in the same ASCII form the chat shows", () => {
  const request = quoteRequest("  hello \n world  ", () => 0);
  assert.equal(request.text, "hello world", "whitespace is collapsed for the line-based request");
  assert.ok(VOICES.includes(String(request.voice)), `${request.voice} is not a shipped voice`);

  // The RCON token has underscores where the spaces were; the voice must not read them out.
  assert.equal(quoteRequest("HELLO_WORLD", () => 0).text, "HELLO WORLD");

  // The donation arrives in Cyrillic and the chat shows a transliteration; the voice must read the
  // transliteration too, or the subtitle and the speech disagree.
  const cyrillic = quoteRequest("привет", () => 0);
  assert.ok(String(cyrillic.voice).startsWith("ru"));
});
