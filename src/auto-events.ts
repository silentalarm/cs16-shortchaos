import { readFileSync } from "node:fs";
import { ConfigError, type ActivitiesConfig, type Activity } from "./activities.ts";
import { buildActivityCommand } from "./command.ts";

/**
 * The free rotation: an activity that runs on a clock instead of on a donation.
 *
 * Why it exists: a donation-driven stream is silent until somebody pays, and a viewer who arrives
 * during a quiet minute has nothing to watch and no reason to stay. One effect every few minutes
 * costs nothing, keeps the picture moving, and advertises the paid modes by showing them.
 *
 * The rotation never touches the paid catalogue: a free code is a short, self-explanatory effect
 * (`config/auto-events.json`), and the hero modes a viewer pays for - `nemesis`, `survivor`,
 * `juggernaut`, `sniper`, `outbreak`, `chaos_plague` and the class waves - stay donation-only, or
 * there would be nothing left to buy.
 *
 * The list is *ranked*: slot 0 runs first, then 1, and the rotation wraps around, so the two best
 * hooks (`he_party`, `meteor_shower`) also appear first on a fresh database.
 *
 * The `chaos` list is the subset that reads as chaos - a thing that happens to everybody at once,
 * on screen, without a rule to learn. A chaos burst from the meter therefore never fires a hero
 * mode: `he_party`, `meteor_shower`, `jumpers`, `bazooka_drop` and `one_bullet` fit, `nemesis` and
 * `chaos_plague` do not (the second one runs `amx_chaos force` itself, which would recurse).
 */
export const AUTO_EVENTS_VERSION = 1;
export const DEFAULT_INTERVAL_SEC = 180;
export const MIN_INTERVAL_SEC = 30;
export const MAX_INTERVAL_SEC = 3600;
export const MAX_QUIET_AFTER_PAID_SEC = 600;

export interface AutoEventsConfig {
  version: number;
  /** false turns the clock off: the bottom line falls back to the cheapest paid activity. */
  enabled: boolean;
  /** Seconds between two free events; 180 is three minutes. */
  intervalSec: number;
  /** A paid effect that just started keeps the screen to itself for this long. */
  quietAfterPaidSec: number;
  /** Ranked free rotation, slot 0 first; every code must be a `seconds` clock that fits the interval. */
  free: readonly string[];
  /** Codes a chaos burst may fire; a subset of `free`, only the effects that read as chaos. */
  chaos: readonly string[];
}

function fail(where: string, message: string): never {
  throw new ConfigError(`${where}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInt(raw: unknown, key: string, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw)) fail("auto-events", `"${key}" must be an integer`);
  if (raw < min || raw > max) fail("auto-events", `"${key}" must be between ${min} and ${max}`);
  return raw;
}

function codeList(raw: unknown, key: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("auto-events", `"${key}" must be a list of activity codes`);
  const codes: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      fail("auto-events", `"${key}[${index}]" must be an activity code`);
    }
    if (codes.includes(item)) fail("auto-events", `"${key}[${index}]" repeats ${item}`);
    codes.push(item);
  }
  return codes;
}


/**
 * Validates the rotation against the catalogue.
 *
 * Fails fast on purpose, like `activities.ts`: a code that left the catalogue (or a 60 second effect
 * in a 30 second slot) would otherwise show up on the stream as an event that never fires.
 */
export function parseAutoEvents(raw: unknown, catalog: ActivitiesConfig): AutoEventsConfig {
  if (!isObject(raw)) fail("auto-events", "must be an object");
  if (raw.version !== AUTO_EVENTS_VERSION) {
    fail("auto-events", `"version" must be ${AUTO_EVENTS_VERSION}`);
  }

  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof enabled !== "boolean") fail("auto-events", `"enabled" must be a boolean`);

  const intervalSec = boundedInt(raw.intervalSec, "intervalSec", MIN_INTERVAL_SEC, MAX_INTERVAL_SEC, DEFAULT_INTERVAL_SEC);
  const quietAfterPaidSec = boundedInt(raw.quietAfterPaidSec, "quietAfterPaidSec", 0, MAX_QUIET_AFTER_PAID_SEC, 60);
  const free = codeList(raw.free, "free");
  const chaos = codeList(raw.chaos, "chaos");

  const byCode = new Map<string, Activity>(catalog.activities.map((activity) => [activity.code, activity]));
  for (const code of free) {
    const activity = byCode.get(code);
    if (activity === undefined) fail("auto-events", `"free" lists ${code}, which the catalogue does not have`);
    // A rotation slot has to be over before the next one starts, and a round or map-long mode cannot
    // promise that: the panel would announce the next event over an effect that is still running.
    if (activity.duration !== "seconds" || activity.seconds === null) {
      fail("auto-events", `"free" lists ${code}, which is a ${activity.duration} activity, not a clock`);
    }
    if (activity.seconds > intervalSec) {
      fail("auto-events", `"free" lists ${code} (${activity.seconds} s), longer than intervalSec ${intervalSec}`);
    }
  }
  for (const code of chaos) {
    if (!free.includes(code)) {
      fail("auto-events", `"chaos" lists ${code}, which is not in the free rotation`);
    }
  }
  if (enabled && free.length === 0) fail("auto-events", `"free" is empty: an enabled rotation needs at least one code`);

  return { version: AUTO_EVENTS_VERSION, enabled, intervalSec, quietAfterPaidSec, free, chaos };
}

export function loadAutoEvents(path: string | URL, catalog: ActivitiesConfig): AutoEventsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`cannot read ${String(path)}: ${(error as Error).message}`);
  }
  return parseAutoEvents(raw, catalog);
}

/** The cursor: which free code runs next, and when (epoch ms). */
export interface AutoCursor {
  slot: number;
  nextAt: number;
}

/** What the panel announces for the next free event. */
export interface NextAutoEvent {
  code: string;
  title: string;
  /** Whole seconds until it starts, never negative. */
  secondsLeft: number;
}

/** `2:31`: a three minute rotation never needs an hours field, and `0:04` reads as a countdown. */
export function formatCountdown(secondsLeft: number): string {
  const total = Number.isFinite(secondsLeft) ? Math.max(0, Math.ceil(secondsLeft)) : 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export interface AutoTickOptions {
  /** Epoch ms of the last paid command that reached the game, or null when nothing was bought yet. */
  lastPaidAt?: number | null;
  now?: number;
  run: (command: string) => Promise<string>;
}

export type AutoTickResult =
  | { kind: "idle" }
  /** The slot came due right after a paid effect: the free event steps aside, the cadence stays. */
  | { kind: "deferred"; code: string; title: string; paidAgoSec: number }
  | { kind: "ran"; code: string; title: string; command: string; reply: string }
  | { kind: "failed"; code: string; title: string; command: string; error: string };

/**
 * The rotation itself: it holds the cursor and nothing else, so the caller keeps that cursor in
 * SQLite and a restart neither resets the three minute clock nor re-fires the event that just ran.
 *
 * `activities` is an accessor, not a snapshot: the operator panel rewrites prices, params and
 * `enabled` at runtime (`activities-override.ts`), and a free event must send the command the
 * catalogue holds at the moment it fires.
 */
export class AutoRotation {
  readonly #config: AutoEventsConfig;
  readonly #activities: () => ActivitiesConfig;
  #cursor: AutoCursor;

  constructor(options: { config: AutoEventsConfig; activities: () => ActivitiesConfig; cursor: AutoCursor }) {
    this.#config = options.config;
    this.#activities = options.activities;
    this.#cursor = { ...options.cursor };
  }

  get cursor(): AutoCursor {
    return { ...this.#cursor };
  }

  /** What the picture announces; null when the rotation is off. */
  next(now = Date.now()): NextAutoEvent | null {
    const code = freeCodeAt(this.#config, this.#cursor.slot);
    if (code === null) return null;
    return {
      code,
      title: this.#titleOf(code),
      secondsLeft: Math.max(0, Math.ceil((this.#cursor.nextAt - now) / 1000)),
    };
  }

  /**
   * Fires the event of the current slot when it is due.
   *
   * The cursor moves *before* the command is sent: a dead RCON socket would otherwise retry the same
   * slot every second, and a host that slept through three slots would fire three effects at once -
   * only the first slot is late enough to run, the rest fold into one interval from now.
   */
  async tick(options: AutoTickOptions): Promise<AutoTickResult> {
    const now = options.now ?? Date.now();
    const code = freeCodeAt(this.#config, this.#cursor.slot);
    if (code === null || now < this.#cursor.nextAt) return { kind: "idle" };

    const intervalMs = this.#config.intervalSec * 1000;
    let nextAt = this.#cursor.nextAt + intervalMs;
    if (nextAt <= now) nextAt = now + intervalMs;
    this.#cursor = { slot: this.#cursor.slot + 1, nextAt };

    const title = this.#titleOf(code);
    const quietMs = this.#config.quietAfterPaidSec * 1000;
    const lastPaidAt = options.lastPaidAt ?? null;
    if (lastPaidAt !== null && quietMs > 0 && now - lastPaidAt < quietMs) {
      return { kind: "deferred", code, title, paidAgoSec: Math.floor((now - lastPaidAt) / 1000) };
    }

    const activity = this.#activityOf(code);
    if (activity === undefined) {
      return { kind: "failed", code, title, command: "", error: "the code is not in the catalogue any more" };
    }

    const command = buildActivityCommand(activity);
    try {
      const reply = await options.run(command);
      return { kind: "ran", code, title, command, reply };
    } catch (error) {
      return { kind: "failed", code, title, command, error: (error as Error).message };
    }
  }

  #activityOf(code: string): Activity | undefined {
    return this.#activities().activities.find((activity) => activity.code === code);
  }

  #titleOf(code: string): string {
    return this.#activityOf(code)?.title ?? code;
  }
}

/** The free code of a slot; the rotation wraps, so slot 8 is slot 0 again. */
export function freeCodeAt(config: AutoEventsConfig, slot: number): string | null {
  if (!config.enabled || config.free.length === 0) return null;
  const index = Number.isFinite(slot) ? Math.abs(Math.trunc(slot)) : 0;
  return config.free[index % config.free.length] ?? null;
}

/** The chaos code of a burst; null when the list is empty, and the caller keeps `amx_chaos force`. */
export function chaosCodeAt(config: AutoEventsConfig, index: number): string | null {
  if (config.chaos.length === 0) return null;
  const safe = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return config.chaos[safe % config.chaos.length] ?? null;
}
