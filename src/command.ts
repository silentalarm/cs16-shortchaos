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
 * GoldSrc shows only a narrow ASCII range in player names and we send it over RCON,
 * so cyrillic is transliterated and everything else outside `[A-Za-z0-9_.-]` is dropped.
 */
export function sanitizeNick(raw: string, maxLength = DEFAULT_NICK_LENGTH): string {
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

  return cleaned === "" ? DEFAULT_NICK : cleaned;
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
    parts.push(`${key}=${formatValue(key, value)}`);
  }

  if (options.nick !== undefined) {
    const rawLimit = activity.params["maxNameLength"];
    const limit = typeof rawLimit === "number" ? rawLimit : DEFAULT_NICK_LENGTH;
    parts.push(`nick=${sanitizeNick(options.nick, limit)}`);
  }

  const command = parts.join(" ");
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new CommandError(`command is longer than ${MAX_COMMAND_LENGTH} chars`);
  }
  return command;
}
