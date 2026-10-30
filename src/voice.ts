import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Activity } from "./activities.ts";

/**
 * The announcement voice.
 *
 * Why not `emit_sound`: a GoldSrc sound reaches a client only if it was precached, so any new line of
 * speech would need a file inside the game client. The capture container already owns the audio the
 * broadcast carries - ffmpeg records the PulseAudio null sink - so a line of text is handed over as a
 * request file and spoken there with espeak-ng (`infra/stream/voice.sh`). A request may name a file
 * instead of text, which is how music and sound effects are played with no game asset either.
 */
export const VOICE_DIR_NAME = "voice";

/**
 * The paid events are all one length, and the bed follows it: the player cuts the music when this
 * window expires, so a 15-second event can never leave a three-minute track playing into the next
 * donation's event.
 */
export const DEFAULT_EVENT_SECONDS = 15;

/**
 * Voices espeak-ng ships, split by language: a Russian line read by `en+m3` is noise, not an
 * announcement, so the pick depends on the text. Several accents per language keep the bots from
 * sounding identical - "random bots, different voices" was the request.
 */
export const VOICES_RU: readonly string[] = ["ru+m3", "ru+m4", "ru+f3", "ru+m7"];
export const VOICES_EN: readonly string[] = ["en+m3", "en+f4"];
export const VOICES: readonly string[] = [...VOICES_RU, ...VOICES_EN];

const CYRILLIC = /[\u0400-\u04FF]/u;

export interface VoiceRequest {
  /** espeak-ng voice name, `-` for its default. */
  voice?: string;
  /** Text to synthesise. Cyrillic is fine: it never goes through RCON. */
  text?: string;
  /** Path inside the capture container, played once (a cue, an effect). */
  file?: string;
  /**
   * Bed music: an activity code (`glass_cannon`) or an absolute path inside the capture container.
   * A code resolves to `<overlay>/music/<code>.wav` first, then to the copy baked into the image.
   */
  music?: string;
  /** Playback window of the bed. The player cuts it here, so the music ends with the event. */
  seconds?: number;
  /** Silence everything - the panel's Stop button. */
  stop?: boolean;
  /**
   * Cut the bed and leave everything else alone.
   *
   * A phase event (`red_light`) writes no announcement, so nothing replaced the previous event's
   * bed: the duel's music kept playing under the Squid Game cues for the rest of its window. One
   * request with this flag at the start of such an event is what keeps "one event in the frame means
   * one bed" true for every event, not only for the ones that start a bed of their own.
   */
  musicStop?: boolean;
}

/** `<overlay>/voice`: written by the API, read by the capture container through the shared volume. */
export function voiceDir(overlayDir: string): string {
  return join(overlayDir, VOICE_DIR_NAME);
}

/**
 * How long an unplayed request may stay on disk.
 *
 * The capture container mounts the overlay volume read-only, so it cannot delete what it played: it
 * keeps a marker instead (see `infra/stream/voice.sh`). That leaves the pruning to the writer, and a
 * request older than this is stale by definition - a restart must not replay a line from an hour ago.
 */
export const VOICE_MAX_AGE_MS = 120_000;

function pruneRequests(dir: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of names) {
    if (!name.endsWith(".req")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > VOICE_MAX_AGE_MS) unlinkSync(path);
    } catch {
      // Already taken or gone: nothing to do.
    }
  }
}

/**
 * Writes one request and returns its path, or null when there is nothing to say.
 *
 * The write is a temporary file plus a rename: the player polls the directory, and a half-written
 * request would be read as a request with no text. Newlines are collapsed because the format is
 * line-based.
 */
export function writeVoiceRequest(
  overlayDir: string,
  request: VoiceRequest,
  now = Date.now(),
  random = Math.random,
): string | null {
  const text = (request.text ?? "").replace(/[\r\n]+/gu, " ").trim();
  const music = (request.music ?? "").replace(/[\r\n]+/gu, "").trim();
  const hasMusic = music !== "";
  const hasSeconds = typeof request.seconds === "number" && Number.isFinite(request.seconds) && request.seconds > 0;
  if (request.stop !== true && request.file === undefined && !hasMusic && text === "" && request.musicStop !== true) {
    return null;
  }

  const dir = voiceDir(overlayDir);
  mkdirSync(dir, { recursive: true });
  pruneRequests(dir, now);

  const lines: string[] = [];
  if (request.stop === true) {
    lines.push("stop=1");
  } else {
    if (request.musicStop === true) lines.push("musicStop=1");
    // A pure "cut the bed" request says nothing else: no voice line to ignore, no clock to keep.
    const bedOnly = request.musicStop === true && !hasMusic && text === "" && request.file === undefined;
    if (!bedOnly) lines.push(`voice=${request.voice ?? "-"}`);
    if (hasMusic) lines.push(`music=${music}`);
    if (hasMusic || hasSeconds) {
      // The bed is cut by the clock the player keeps: the music must end with the event.
      lines.push(`seconds=${String(Math.round(hasSeconds ? (request.seconds as number) : DEFAULT_EVENT_SECONDS))}`);
    }
    if (request.file !== undefined) lines.push(`file=${request.file}`);
    if (text !== "") lines.push(`text=${text}`);
  }

  const name = `${String(now).padStart(13, "0")}-${Math.floor(random() * 1_000_000).toString(36)}.req`;
  const path = join(dir, name);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${lines.join("\n")}\n`, "utf8");
  renameSync(temporary, path);
  return path;
}

/**
 * What the viewer hears when a paid event starts: a bed for the whole event and, over it, the
 * announcement. Before this existed the request could only carry one of the two, so music either
 * did not start at all or never stopped - the panel's own countdown is what the cut follows now.
 */
/**
 * The length the event really runs.
 *
 * `params.seconds` is what reaches RCON, so it wins over the top-level field: the panel can patch
 * parameters for a single run (`/api/trigger`), and a 15-second duel under a 30-second bed kept the
 * opera playing after the knives were gone - the game followed the patched clock, the music did not.
 */
export function eventSeconds(activity: Activity): number {
  const patched = activity.params["seconds"];
  if (typeof patched === "number" && Number.isFinite(patched) && patched > 0) return patched;
  return activity.seconds ?? DEFAULT_EVENT_SECONDS;
}

/**
 * The bed of one activity: an absolute path from `params.music`, or the activity code, which the
 * player resolves as `<overlay>/music/<code>.wav` first and `/usr/share/cs16/music/<code>.wav` second.
 */
function musicFor(activity: Activity): string {
  const explicit = activity.params["music"];
  return typeof explicit === "string" && explicit.trim() !== "" ? explicit.trim() : activity.code;
}

/** What the event is called out loud: the catalogue's Russian line, or the English title. */
function sayFor(activity: Activity): string {
  const spoken = activity.params["say"];
  return typeof spoken === "string" && spoken.trim() !== "" ? spoken.trim() : activity.title;
}

export function announcementFor(activity: Activity, random = Math.random): VoiceRequest {
  const seconds = eventSeconds(activity);
  const music = musicFor(activity);

  // `params.onlyMusic` keeps the bed and drops the voice. The duel's soundtrack is its music - a spoken
  // line over the opera is a second narrator nobody asked for - and the same flag keeps the plugin's
  // stock cues off the mix (`params.stock: 0`).
  if (activity.params["onlyMusic"] === true) {
    return { music, seconds };
  }

  // A ready-made cue wins over speech: that is how the series cues are used, and it needs no rebuild.
  const file = activity.params["sound"];
  if (typeof file === "string" && file.trim() !== "") {
    return { voice: pickVoice(activity.title, random), file: file.trim(), music, seconds };
  }

  const spoken = activity.params["say"];
  const text = typeof spoken === "string" && spoken.trim() !== "" ? spoken.trim() : activity.title;
  return { voice: pickVoice(text, random), text, music, seconds };
}

/** Stop the bed and any cue: the panel's Stop button must leave the broadcast silent. */
export function silenceRequest(): VoiceRequest {
  return { stop: true };
}

/**
 * What a paid donation sounds like: one bed for the whole batch, one line naming every effect.
 *
 * A donation can buy several activities at once - a big sum rolls many units - and announcing each
 * one separately put six beds and six spoken lines on top of each other inside a second. Measured in
 * the stream log: five `music stopped` lines and a pile of phase cues in the same tick. The batch is
 * announced once now: the bed of its first effect, the clock of its longest one, so the music ends
 * with the last effect instead of outliving it.
 */
export function donationAnnouncement(
  activities: readonly Activity[],
  donor: { username: string; amount: number; currency: string },
  random = Math.random,
): VoiceRequest {
  const withBed = activities.filter((activity) => phaseCues(activity).length === 0);
  // A batch of phase events has no soundtrack of its own: the cues are it.
  if (withBed.length === 0) return {};

  const first = withBed[0] as Activity;
  const seconds = activities.reduce((max, activity) => Math.max(max, eventSeconds(activity)), DEFAULT_EVENT_SECONDS);
  const bed: VoiceRequest = { music: musicFor(first), seconds };

  // A music-only batch keeps its soundtrack: a spoken line over the opera is what that flag forbids.
  if (withBed.every((activity) => activity.params["onlyMusic"] === true)) return bed;

  const nick = donor.username.replace(/\s+/gu, " ").trim() || "Аноним";
  const sum = Math.round(donor.amount);
  const money = donor.currency === "RUB" ? `${sum} рублей` : `${sum} ${donor.currency}`;
  const names = activities.map((activity) => sayFor(activity));
  // A batch of five read out in full is a fifteen second monologue over the next cue: three names and
  // "и другие" say the same thing without taking the whole event's sound.
  const spoken = names.length > 3 ? `${names.slice(0, 3).join(", ")}, и другие` : names.join(", ");
  const text = `${nick}, ${money}. Выпало: ${spoken}`;
  return { voice: pickVoice(text, random), text, ...bed };
}

/** The meter is full: `chaos_core` is about to force an effect on everyone. */
export function chaosRequest(random = Math.random): VoiceRequest {
  return { voice: pickVoice("хаос", random), text: "Копилка полна. ХАОС!" };
}

/**
 * Cue schedule for an event whose sound belongs to a phase rather than to the whole event.
 *
 * `red_light` alternates: 1.5 s frozen (RED), 2 s moving (GREEN), and so on up to the clock. The game
 * side can only play files it precached at map load, so a custom cue is played here instead: the API
 * schedules one request per phase, mirroring the plugin's own timing. The catalogue ships the two
 * files as `infra/sounds/*.mp3`, converted into the capture image at `/usr/share/cs16/sounds`; without
 * `soundRed`/`soundGreen` this returns nothing and the plugin keeps its built-in alarm and chime.
 */
export function phaseCues(activity: Activity, now = Date.now()): { at: number; request: VoiceRequest }[] {
  const red = activity.params["soundRed"];
  const green = activity.params["soundGreen"];
  if (typeof red !== "string" || typeof green !== "string") return [];
  if (red.trim() === "" || green.trim() === "") return [];

  const totalMs = eventSeconds(activity) * 1000;
  const cues: { at: number; request: VoiceRequest }[] = [];
  // RED opens the event; GREEN follows after 1.5 s; then the pair repeats every 3.5 s.
  let at = 0;
  let isRed = true;
  while (at < totalMs) {
    cues.push({ at: now + at, request: { file: isRed ? red.trim() : green.trim() } });
    at += isRed ? 1_500 : 2_000;
    isRed = !isRed;
  }
  return cues;
}

export function botSpeech(bot: string, text: string, random = Math.random): VoiceRequest {
  const line = `${bot} говорит: ${text}`;
  return { voice: pickVoice(line, random), text: line };
}

function pickVoice(text: string, random: () => number): string {
  // A Cyrillic line must be read by a Russian voice: espeak-ng would otherwise spell it out letter by
  // letter in an English accent, which sounds like a broken stream rather than an announcement.
  const pool = CYRILLIC.test(text) ? VOICES_RU : VOICES;
  const index = Math.floor(random() * pool.length);
  return pool[Math.min(pool.length - 1, Math.max(0, index))] ?? pool[0] ?? "ru";
}
