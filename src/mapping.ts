import { MAX_SECONDS } from "./activities.ts";
import type { ActivitiesConfig, Activity } from "./activities.ts";

/**
 * Donation -> activity resolution.
 *
 * Every full `minAmount` rubles buys one activity, drawn at random from the enabled catalogue:
 * 50 RUB buys one effect, 150 RUB buys three. The old "most expensive thing you can afford" ladder
 * had a silent loser - a viewer who paid 240 RUB for a 250 RUB effect watched a cheaper one and the
 * rest of the money evaporated. Counting units means every rouble changes something on screen, and
 * not knowing which effect is next is what makes a viewer pay again.
 *
 * Foreign currency is converted, not rejected: the stream is watched from Kazakhstan, Belarus,
 * Ukraine and the EU, and "your money does not count" is a refund request. The rates below are
 * deliberately conservative (below the market) and every conversion rounds down, so an error in the
 * table costs the owner nothing; `CURRENCY_RATES` in the environment replaces them without a deploy.
 */
export type RejectReason =
  | "invalid_amount"
  | "below_minimum"
  | "unsupported_currency"
  | "no_activity";

export interface DonationInput {
  amount: number | string;
  currency: string;
}

export type Resolution =
  | {
      kind: "activate";
      /** One entry per command to send: repeats of a clock activity are already merged. */
      activities: Activity[];
      /** How many `minAmount` steps the donation paid for. */
      units: number;
      /** Steps the `MAX_UNITS` guard refused, so the caller can log money it cannot honour. */
      droppedUnits: number;
      /** Price of one step; the viewer buys whole steps only. */
      unitPrice: number;
      amount: number;
    }
  | { kind: "reject"; reason: RejectReason; amount: number | null; currency: string | null };

/**
 * RUB per one unit of the currency. Rounded down on purpose: USD near 90 and EUR near 100 rather
 * than the live rate, so a falling rouble can never make the catalogue cheaper than the price list.
 */
export const DEFAULT_CURRENCY_RATES: Readonly<Record<string, number>> = {
  USD: 90,
  EUR: 100,
  KZT: 0.18,
  BYN: 27,
  UAH: 2.2,
};

export interface ResolveOptions {
  /** Overrides merged over `DEFAULT_CURRENCY_RATES`; comes from `CURRENCY_RATES` in the environment. */
  rates?: Record<string, number>;
  /** Which effect one step buys; injectable so a test can pin the draw. Defaults to `Math.random`. */
  random?: () => number;
}

const CURRENCY_CODE_RE = /^[A-Z]{3}$/u;

/**
 * Parses `{"USD":92,"EUR":101}` into a rate table merged over the built-in one.
 *
 * Rejects loudly at startup instead of silently ignoring a typo: a rate of `"90"` (a string) or a
 * currency code like `usd` would otherwise either be ignored or never match a donation.
 */
export function parseCurrencyRates(raw: string | undefined, base: Readonly<Record<string, number>> = DEFAULT_CURRENCY_RATES): Record<string, number> {
  const rates: Record<string, number> = { ...base };
  if (raw === undefined || raw.trim() === "") return rates;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CURRENCY_RATES must be a JSON object such as {\"USD\":92}");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CURRENCY_RATES must be a JSON object such as {\"USD\":92}");
  }

  for (const [key, value] of Object.entries(parsed)) {
    const code = key.trim().toUpperCase();
    if (!CURRENCY_CODE_RE.test(code)) {
      throw new Error(`CURRENCY_RATES: "${key}" is not a three letter currency code`);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`CURRENCY_RATES.${code} must be a positive number`);
    }
    rates[code] = value;
  }

  return rates;
}

function parseAmount(value: number | string): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const trimmed = value.trim().replace(",", ".");
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Safety stop for a mistyped amount: 200 steps is 10 000 RUB, more than a stream takes in a day, and
 * without it `1e9` would roll twenty million effects in one tick.
 */
export const MAX_UNITS = 200;

function enabledPool(config: ActivitiesConfig): Activity[] {
  return config.activities.filter((activity) => activity.enabled);
}

function draw(pool: readonly Activity[], random: () => number): Activity {
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index] as Activity;
}

/** Same activity with a different clock, `params.seconds` kept in step for the Pawn handler. */
function withClock(activity: Activity, seconds: number): Activity {
  const params = Object.hasOwn(activity.params, "seconds") ? { ...activity.params, seconds } : activity.params;
  return { ...activity, seconds, params };
}

/**
 * Turns the steps a donation bought into the commands that will run.
 *
 * Repeats of an activity that carries a clock are merged into one longer application instead of being
 * sent twice: the plugin re-arms its timer on every command, so two `he_party` lines would buy the
 * same 60 seconds twice over and the second would be wasted. A merged clock longer than the schema
 * allows is split into chunks, which the Pawn handler stacks (`EffectHeParty` adds to the running
 * clock instead of restarting it).
 */
export function planActivities(activities: readonly Activity[]): Activity[] {
  const counts = new Map<string, { activity: Activity; count: number }>();
  for (const activity of activities) {
    const entry = counts.get(activity.code);
    if (entry === undefined) counts.set(activity.code, { activity, count: 1 });
    else entry.count += 1;
  }

  const plan: Activity[] = [];
  for (const { activity, count } of counts.values()) {
    const declared = activity.seconds;
    if (activity.duration !== "seconds" || declared === null) {
      // No clock to extend: every step is its own instant, so it keeps its own line.
      for (let left = count; left > 0; left -= 1) plan.push(activity);
      continue;
    }

    let left = declared * count;
    while (left > 0) {
      const chunk = Math.min(left, MAX_SECONDS);
      left -= chunk;
      plan.push(withClock(activity, chunk));
    }
  }

  return plan;
}

export function resolveDonation(donation: DonationInput, config: ActivitiesConfig, options: ResolveOptions = {}): Resolution {
  const amount = parseAmount(donation.amount);
  const currency = typeof donation.currency === "string" ? donation.currency.trim().toUpperCase() : null;

  if (amount === null || amount <= 0) {
    return { kind: "reject", reason: "invalid_amount", amount, currency };
  }

  let rub = amount;
  if (currency !== config.currency) {
    const rate = currency === null ? undefined : (options.rates?.[currency] ?? DEFAULT_CURRENCY_RATES[currency]);
    // An exotic currency still has no rate: guessing one would either give away activities or
    // silently halve what a viewer paid for.
    if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
      return { kind: "reject", reason: "unsupported_currency", amount, currency };
    }
    rub = Math.floor(amount * rate);
  }

  const unitPrice = config.minAmount;
  if (rub < unitPrice) {
    return { kind: "reject", reason: "below_minimum", amount: rub, currency };
  }

  const pool = enabledPool(config);
  if (pool.length === 0) {
    return { kind: "reject", reason: "no_activity", amount: rub, currency };
  }

  const paid = Math.floor(rub / unitPrice);
  const units = Math.min(paid, MAX_UNITS);
  const random = options.random ?? Math.random;

  const rolled: Activity[] = [];
  for (let step = 0; step < units; step += 1) rolled.push(draw(pool, random));

  return {
    kind: "activate",
    activities: planActivities(rolled),
    units,
    droppedUnits: paid - units,
    unitPrice,
    amount: rub,
  };
}
