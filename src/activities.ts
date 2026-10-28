import { readFileSync } from "node:fs";

/**
 * Activity catalogue: what a donation buys.
 *
 * Rules enforced here (see docs/runbook.md):
 * - price >= config.minAmount (50 RUB minimum donation);
 * - "rounds" duration lasts at most MAX_ROUNDS (1) round;
 * - "seconds" duration carries its own length (`seconds`), 1..MAX_SECONDS: a clock, not a round;
 * - "until_map_change" and "instant" carry no round budget and no clock: they end on map change only;
 * - `announce` must be printable ASCII, GoldSrc game chat renders nothing else;
 * - codes are unique and stable, the Pawn plugin registers handlers by code.
 */
export const MAX_ROUNDS = 1;
/** Longest clock an activity may declare; anything longer belongs to `until_map_change`. */
export const MAX_SECONDS = 600;

export type ActivityDuration = "rounds" | "seconds" | "until_map_change" | "instant";

export type ParamValue = string | number | boolean | string[];
export type Params = Record<string, ParamValue>;

export interface Activity {
  code: string;
  title: string;
  announce: string;
  price: number;
  priority: number;
  duration: ActivityDuration;
  rounds: number | null;
  /** Declared length of a "seconds" activity, null for every other duration. */
  seconds: number | null;
  cooldownSec: number;
  globalCooldownSec: number;
  enabled: boolean;
  params: Params;
}

export interface ActivitiesConfig {
  version: number;
  currency: string;
  minAmount: number;
  defaultCooldownSec: number;
  activities: Activity[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const CODE_RE = /^[a-z][a-z0-9_]{2,31}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const ASCII_RE = /^[\x20-\x7E]+$/;
const DURATIONS: readonly ActivityDuration[] = ["rounds", "seconds", "until_map_change", "instant"];
const ANNOUNCE_MAX = 64;

function fail(where: string, message: string): never {
  throw new ConfigError(`${where}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intField(raw: Record<string, unknown>, key: string, where: string, fallback?: number): number {
  const value = raw[key];
  if (value === undefined) {
    if (fallback === undefined) fail(where, `"${key}" is required`);
    return fallback as number;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(where, `"${key}" must be an integer`);
  }
  return value;
}

function parseParams(value: unknown, where: string): Params {
  if (value === undefined) return {};
  if (!isObject(value)) fail(where, `"params" must be an object`);
  const params: Params = {};
  for (const [key, item] of Object.entries(value)) {
    const okScalar = typeof item === "string" || typeof item === "number" || typeof item === "boolean";
    const okList = Array.isArray(item) && item.every((entry) => typeof entry === "string");
    if (!okScalar && !okList) fail(where, `"params.${key}" must be a string, number, boolean or list of strings`);
    params[key] = item as ParamValue;
  }
  return params;
}


function parseActivity(raw: unknown, index: number, config: ActivitiesConfig): Activity {
  const where = `activities[${index}]`;
  if (!isObject(raw)) fail(where, "must be an object");

  const code = raw.code;
  if (typeof code !== "string" || !CODE_RE.test(code)) {
    fail(where, `"code" must match ${CODE_RE.source}`);
  }

  const title = raw.title;
  if (typeof title !== "string" || title.trim() === "") fail(where, `"title" is required`);

  const announce = raw.announce;
  if (typeof announce !== "string" || !ASCII_RE.test(announce)) {
    fail(where, `"announce" must be printable ASCII (game chat cannot render other charsets)`);
  }
  if (announce.length > ANNOUNCE_MAX) fail(where, `"announce" must be at most ${ANNOUNCE_MAX} chars`);

  const price = intField(raw, "price", where);
  if (price < config.minAmount) fail(where, `"price" must be >= minAmount (${config.minAmount})`);

  const priority = intField(raw, "priority", where, 0);

  const duration = raw.duration;
  if (typeof duration !== "string" || !DURATIONS.includes(duration as ActivityDuration)) {
    fail(where, `"duration" must be one of ${DURATIONS.join(", ")}`);
  }

  let rounds: number | null = null;
  if (duration === "rounds") {
    rounds = intField(raw, "rounds", where);
    if (rounds < 1 || rounds > MAX_ROUNDS) fail(where, `"rounds" must be between 1 and ${MAX_ROUNDS}`);
  } else if (raw.rounds !== undefined && raw.rounds !== null) {
    fail(where, `"rounds" must be null when duration is "${duration}"`);
  }

  // A clock instead of a round: the two are exclusive, because a viewer pays for one or the other and
  // the admin table prints exactly one of them.
  let seconds: number | null = null;
  if (duration === "seconds") {
    seconds = intField(raw, "seconds", where);
    if (seconds < 1 || seconds > MAX_SECONDS) {
      fail(where, `"seconds" must be between 1 and ${MAX_SECONDS}`);
    }
  } else if (raw.seconds !== undefined && raw.seconds !== null) {
    fail(where, `"seconds" must be null when duration is "${duration}"`);
  }

  const cooldownSec = intField(raw, "cooldownSec", where, config.defaultCooldownSec);
  if (cooldownSec < 0) fail(where, `"cooldownSec" must be >= 0`);

  const globalCooldownSec = intField(raw, "globalCooldownSec", where, 0);
  if (globalCooldownSec < 0) fail(where, `"globalCooldownSec" must be >= 0`);

  const enabled = raw.enabled ?? true;
  if (typeof enabled !== "boolean") fail(where, `"enabled" must be a boolean`);

  return {
    code: code as string,
    title: title as string,
    announce: announce as string,
    price,
    priority,
    duration: duration as ActivityDuration,
    rounds,
    seconds,
    cooldownSec,
    globalCooldownSec,
    enabled,
    params: parseParams(raw.params, where),
  };
}


/** Validates a decoded JSON document and returns the normalized catalogue. */
export function parseActivities(raw: unknown): ActivitiesConfig {
  if (!isObject(raw)) fail("config", "must be a JSON object");

  if (raw.version !== 1) fail("config", `"version" must be 1`);

  const currency = raw.currency;
  if (typeof currency !== "string" || !CURRENCY_RE.test(currency)) {
    fail("config", `"currency" must be an uppercase ISO code such as RUB`);
  }

  const minAmount = intField(raw, "minAmount", "config");
  if (minAmount < 50) fail("config", `"minAmount" must be >= 50`);

  const defaultCooldownSec = intField(raw, "defaultCooldownSec", "config", 60);
  if (defaultCooldownSec < 0) fail("config", `"defaultCooldownSec" must be >= 0`);

  if (!Array.isArray(raw.activities) || raw.activities.length === 0) {
    fail("config", `"activities" must be a non-empty array`);
  }

  const config: ActivitiesConfig = {
    version: 1,
    currency: currency as string,
    minAmount,
    defaultCooldownSec,
    activities: [],
  };

  const seen = new Set<string>();
  raw.activities.forEach((item, index) => {
    const activity = parseActivity(item, index, config);
    if (seen.has(activity.code)) fail(`activities[${index}]`, `duplicate code "${activity.code}"`);
    seen.add(activity.code);
    config.activities.push(activity);
  });

  return config;
}

/** Reads and validates the catalogue from disk. Accepts a path or a file URL. */
export function loadActivities(path: string | URL): ActivitiesConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read ${String(path)}: ${(error as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${String(path)} is not valid JSON: ${(error as Error).message}`);
  }

  return parseActivities(raw);
}

export function findActivity(config: ActivitiesConfig, code: string): Activity | undefined {
  return config.activities.find((activity) => activity.code === code);
}
