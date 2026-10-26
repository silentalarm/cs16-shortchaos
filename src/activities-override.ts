import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, parseActivities } from "./activities.ts";
import type { ActivitiesConfig, Params } from "./activities.ts";

/**
 * Runtime tweaks made from the admin panel.
 *
 * They live in a separate file instead of in config/activities.json for two reasons: the catalogue
 * is versioned and asserted by tests (unique prices, sorted order), and "reset to default" has to
 * stay possible after a bad edit. Load order is always defaults -> overrides.
 */
export interface ActivityPatch {
  price?: number;
  cooldownSec?: number;
  globalCooldownSec?: number;
  enabled?: boolean;
  params?: Params;
}

export interface OverrideDocument {
  version: 1;
  minAmount?: number;
  defaultCooldownSec?: number;
  activities: Record<string, ActivityPatch>;
}

export function emptyOverrides(): OverrideDocument {
  return { version: 1, activities: {} };
}

export class OverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverrideError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses an override document; unknown fields are dropped instead of silently kept. */
export function parseOverrides(raw: unknown): OverrideDocument {
  if (!isObject(raw)) throw new OverrideError("override must be a JSON object");
  if (raw.version !== 1) throw new OverrideError('override "version" must be 1');

  const document = emptyOverrides();
  if (raw.minAmount !== undefined) {
    if (typeof raw.minAmount !== "number" || !Number.isInteger(raw.minAmount)) throw new OverrideError('"minAmount" must be an integer');
    document.minAmount = raw.minAmount;
  }
  if (raw.defaultCooldownSec !== undefined) {
    if (typeof raw.defaultCooldownSec !== "number" || !Number.isInteger(raw.defaultCooldownSec)) {
      throw new OverrideError('"defaultCooldownSec" must be an integer');
    }
    document.defaultCooldownSec = raw.defaultCooldownSec;
  }

  const activities = raw.activities ?? {};
  if (!isObject(activities)) throw new OverrideError('"activities" must be an object keyed by activity code');

  for (const [code, value] of Object.entries(activities)) {
    if (!isObject(value)) throw new OverrideError(`activities.${code} must be an object`);
    const patch: ActivityPatch = {};
    for (const key of ["price", "cooldownSec", "globalCooldownSec"] as const) {
      const item = value[key];
      if (item === undefined) continue;
      if (typeof item !== "number" || !Number.isInteger(item)) throw new OverrideError(`activities.${code}.${key} must be an integer`);
      patch[key] = item;
    }
    if (value.enabled !== undefined) {
      if (typeof value.enabled !== "boolean") throw new OverrideError(`activities.${code}.enabled must be a boolean`);
      patch.enabled = value.enabled;
    }
    if (value.params !== undefined) {
      if (!isObject(value.params)) throw new OverrideError(`activities.${code}.params must be an object`);
      patch.params = value.params as Params;
    }
    document.activities[code] = patch;
  }

  return document;
}

/**
 * Applies overrides and re-validates the result with the same parser the file goes through, so an
 * override cannot create a catalogue the game would reject (price below the minimum, duplicate
 * prices are still allowed by design, but types and bounds are not negotiable).
 */
export function applyOverrides(base: ActivitiesConfig, overrides: OverrideDocument): ActivitiesConfig {
  const activities = base.activities.map((activity) => {
    const patch = overrides.activities[activity.code];
    if (!patch) return activity;
    return {
      ...activity,
      price: patch.price ?? activity.price,
      cooldownSec: patch.cooldownSec ?? activity.cooldownSec,
      globalCooldownSec: patch.globalCooldownSec ?? activity.globalCooldownSec,
      enabled: patch.enabled ?? activity.enabled,
      params: patch.params === undefined ? activity.params : { ...activity.params, ...patch.params },
    };
  });

  try {
    return parseActivities({
      version: base.version,
      currency: base.currency,
      minAmount: overrides.minAmount ?? base.minAmount,
      defaultCooldownSec: overrides.defaultCooldownSec ?? base.defaultCooldownSec,
      activities,
    });
  } catch (error) {
    if (error instanceof ConfigError) throw new OverrideError(error.message);
    throw error;
  }
}

/** Codes that differ from the shipped defaults, for the "changed" badge in the UI. */
export function overriddenCodes(overrides: OverrideDocument): string[] {
  return Object.keys(overrides.activities).sort();
}

/** File-backed store with atomic writes: a crash mid-save must not leave half a JSON document. */
export class OverrideStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  read(): OverrideDocument {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch {
      return emptyOverrides();
    }
    try {
      return parseOverrides(JSON.parse(text) as unknown);
    } catch (error) {
      throw new OverrideError(`${this.#path}: ${(error as Error).message}`);
    }
  }

  write(document: OverrideDocument): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporary, this.#path);
  }
}
