import type { Activity, ParamValue } from "./activities.ts";

/**
 * Builds the RCON command line for an activity.
 *
 * Everything sent to the game server goes through this module: the donor nickname is
 * untrusted, and a raw newline or space inside an RCON command is command injection.
 * Values are restricted to `[A-Za-z0-9_.-]`, lists are comma separated, spaces never
 * leave this file.
 */
export const CODES_PROBE = "amx_de codes";
export const VERSION_PROBE = "amx_de version";

const TOKEN_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const MAX_COMMAND_LENGTH = 200;
const DEFAULT_NICK = "DONATOR";
const DEFAULT_NICK_LENGTH = 16;
const DEFAULT_PHRASE_LENGTH = 40;

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g",
};

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

/**
 * Advertising and abuse that a donation nickname must never carry into the game chat.
 *
 * The nickname is printed to every viewer of the stream, so a link in it is free advertising bought
 * for 50 RUB, and the banned roots are what a bored viewer types to get a slur on camera. Matching
 * happens after transliteration and cleaning, so the patterns are ASCII: `t.me` arrives as `t_me`
 * (the dot survives, the slash does not) and `https://x.ru` as `https_x_ru`.
 */
const NICK_LINK_PATTERNS: readonly RegExp[] = [
  // Links: the scheme, the www prefix, a shortener, or a top level domain stuck to a token.
  /(?:^|[_\-. ])(?:https?|www|t[._]me|telegram|discord|vk)(?:[_\-. ]|$)/u,
  /[_.\-](?:ru|com|net|org|io|me)(?:[_.\-]|$)/u,
];
/**
 * Banned roots, matched anywhere in the cleaned token: "pizdec" carries the root "pizd" and a
 * separator-anchored list would let it through. The roots are deliberately specific ("bet" is not
 * one of them: it hides inside "elizaveta").
 */
const NICK_BANNED_ROOTS: readonly string[] = [
  "huy", "hui", "huylo", "pizd", "pidor", "ebal", "ebat", "suka", "suchka", "blya", "blyad",
  "mudak", "gandon", "govno", "zalupa", "seks", "porn", "xxx", "sex",
  "kredit", "zarabot", "casino", "stavki",
];
export const FALLBACK_NICK = "Anonim_Bot";

function hasStopword(token: string): boolean {
  if (NICK_LINK_PATTERNS.some((pattern) => pattern.test(token))) return true;
  return NICK_BANNED_ROOTS.some((root) => token.includes(root));
}

/**
 * GoldSrc shows only a narrow ASCII range in player names and we send it over RCON,
 * so cyrillic is transliterated and everything else outside `[A-Za-z0-9_.-]` is dropped.
 */
function cleanToken(raw: string, maxLength: number, fallback: string): string {
  const limit = Math.max(1, Math.min(31, Math.trunc(maxLength)));
  const transliterated = [...raw.toLowerCase()]
    .map((char) => TRANSLIT[char] ?? char)
    .join("");

  const cleaned = transliterated
    .replace(/[^a-z0-9_.-]+/gi, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_.-]+|[_.-]+$/g, "")
    .slice(0, limit)
    .replace(/[_.-]+$/, "");

  return cleaned === "" ? fallback : cleaned;
}

export function sanitizeNick(raw: string, maxLength = DEFAULT_NICK_LENGTH): string {
  const token = cleanToken(raw, maxLength, DEFAULT_NICK);
  // Viewer phrases are left alone: a phrase is paid for and the plugin prints it once, while a
  // nickname sticks to the scoreboard for the whole map.
  return hasStopword(token) ? FALLBACK_NICK : token;
}

/**
 * A viewer's message as a single RCON token: underscores stand for spaces and the plugin turns
 * them back into spaces before printing. Returns an empty string when nothing survives, which the
 * callers treat as "send no phrase at all".
 */
export function sanitizePhrase(raw: string, maxLength = DEFAULT_PHRASE_LENGTH): string {
  return cleanToken(raw, maxLength, "");
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) throw new CommandError(`non-finite number in params`);
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function assertToken(value: string, key: string): string {
  if (!TOKEN_RE.test(value)) {
    throw new CommandError(`params.${key} contains characters that are not allowed in an RCON command`);
  }
  return value;
}

function formatValue(key: string, value: ParamValue): string {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new CommandError(`params.${key} is an empty list`);
    return value.map((entry) => assertToken(entry, key)).join(",");
  }
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return assertToken(value, key);
}

export interface CommandOptions {
  /** Raw donor nickname, only used by activities that accept a nickname. */
  nick?: string;
  /** Raw donor message, only used by activities that accept a phrase. */
  message?: string;
}

/**
 * `amx_de <code> key=value ...` in a stable (sorted) order, so logs and tests are comparable.
 * The nickname is passed as `nick=`, never as a bare argument.
 */
export function buildActivityCommand(activity: Activity, options: CommandOptions = {}): string {
  const parts = ["amx_de", assertToken(activity.code, "code")];

  const entries = Object.entries(activity.params).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [key, value] of entries) {
    assertToken(key, "params key");
    if (key === "maxNameLength" && options.nick !== undefined) continue;
    // not a game parameter: it only tells this module that a viewer phrase is welcome
    if (key === "maxPhraseLength") continue;
    // spoken by the announcement voice, never sent to the game: RCON cannot carry spaces or Cyrillic
    if (key === "say") continue;
    // a ready-made audio file for the announcement voice, also not a game parameter
    if (key === "sound") continue;
    // the music bed of an activity: a file name for the player in the capture container, not a game
    // parameter either (the game would echo it as an unknown argument)
    if (key === "music") continue;
    if (key === "soundRed") continue;
    if (key === "soundGreen") continue;
    // a playback instruction for the stream player (music without a spoken line), not a game parameter
    if (key === "onlyMusic") continue;
    // the short label the panel prints when a donation buys several events, not a game parameter
    if (key === "short") continue;
    parts.push(`${key}=${formatValue(key, value)}`);
  }

  if (options.nick !== undefined) {
    const rawLimit = activity.params["maxNameLength"];
    const limit = typeof rawLimit === "number" ? rawLimit : DEFAULT_NICK_LENGTH;
    parts.push(`nick=${sanitizeNick(options.nick, limit)}`);
  }

  // A message with nothing printable left is dropped instead of sent as an empty token: the plugin
  // then keeps its own default phrase.
  if (options.message !== undefined) {
    const rawLimit = activity.params["maxPhraseLength"];
    if (typeof rawLimit === "number") {
      const phrase = sanitizePhrase(options.message, rawLimit);
      if (phrase !== "") parts.push(`text=${phrase}`);
    }
  }

  const command = parts.join(" ");
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new CommandError(`command is longer than ${MAX_COMMAND_LENGTH} chars`);
  }
  return command;
}
