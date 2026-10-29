import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities, parseActivities } from "../src/activities.ts";
import {
  DEFAULT_CURRENCY_RATES,
  MAX_UNITS,
  parseCurrencyRates,
  planActivities,
  resolveDonation,
} from "../src/mapping.ts";

const config = loadActivities(new URL("../config/activities.json", import.meta.url));
/** The only effect on sale in the shipped catalogue: every 50 RUB step buys one of it. */
const ON_SALE = "he_party";

type ResolveInput = { amount: number | string; currency?: string };

function resolve(input: ResolveInput, rates?: Record<string, number>) {
  return resolveDonation(
    { amount: input.amount, currency: input.currency ?? "RUB" },
    config,
    rates === undefined ? {} : { rates },
  );
}

/** "reject:reason" or "code xN @seconds" for every line the donation would send. */
function shape(input: ResolveInput, rates?: Record<string, number>): string {
  const result = resolve(input, rates);
  if (result.kind === "reject") return `reject:${result.reason}`;
  const lines = result.activities.map((activity) => `${activity.code}@${activity.seconds ?? "-"}`).join(" + ");
  return `${result.units}u ${lines}`;
}

test("49.99 RUB is below the 50 RUB minimum", () => {
  assert.equal(shape({ amount: 49.99 }), "reject:below_minimum");
  assert.equal(shape({ amount: 49 }), "reject:below_minimum");
});

test("one 50 RUB step buys one effect, and the price is the catalogue minimum", () => {
  const result = resolve({ amount: 50 });
  assert.equal(result.kind, "activate");
  if (result.kind !== "activate") return;

  assert.equal(result.unitPrice, 50);
  assert.equal(result.units, 1);
  assert.equal(result.droppedUnits, 0);
  assert.equal(result.amount, 50);
  assert.deepEqual(result.activities.map((activity) => activity.code), [ON_SALE]);
  assert.equal(result.activities[0]?.seconds, 60);
  assert.equal(result.activities[0]?.params["seconds"], 60);
});

test("every full 50 RUB buys another step, and the clock grows with the steps", () => {
  const cases: [amount: number, units: number, seconds: number][] = [
    [50, 1, 60],
    [99, 1, 60],
    [100, 2, 120],
    [149, 2, 120],
    [150, 3, 180],
    [260, 5, 300],
    [500, 10, 600],
  ];

  for (const [amount, units, seconds] of cases) {
    const result = resolve({ amount });
    assert.equal(result.kind, "activate");
    if (result.kind !== "activate") return;
    assert.equal(result.units, units, `${amount} RUB must buy ${units} steps`);
    assert.equal(result.activities.length, 1, "a repeated clock effect is merged into one line");
    assert.equal(result.activities[0]?.seconds, seconds, `${amount} RUB must run for ${seconds} s`);
  }
});

test("steps are counted after the currency conversion, so foreign money is not rounded away", () => {
  // 1 USD = 90 RUB = 1 step, 0.6 USD = 54 RUB = 1 step, 2 USD = 180 RUB = 3 steps.
  assert.equal(shape({ amount: 1, currency: "USD" }), "1u he_party@60");
  assert.equal(shape({ amount: 0.6, currency: "usd" }), "1u he_party@60");
  assert.equal(shape({ amount: 2, currency: "USD" }), "3u he_party@180");
  // 500 KZT * 0.18 = 90 RUB.
  assert.equal(shape({ amount: 500, currency: "KZT" }), "1u he_party@60");
  // 4 BYN * 27 = 108 RUB, 50 UAH * 2.2 = 110 RUB, 2.5 EUR * 100 = 250 RUB.
  assert.equal(shape({ amount: 4, currency: "BYN" }), "2u he_party@120");
  assert.equal(shape({ amount: 50, currency: "UAH" }), "2u he_party@120");
  assert.equal(shape({ amount: 2.5, currency: "EUR" }), "5u he_party@300");
  // 23 UAH * 2.2 = 50.6 -> 50 RUB: exactly one step.
  assert.equal(shape({ amount: 23, currency: "UAH" }), "1u he_party@60");
});

test("the converted amount is floored, so rounding never buys one step more", () => {
  // 0.99 USD = 89.1 RUB -> 89 RUB: one step, not two.
  assert.equal(shape({ amount: 0.99, currency: "USD" }), "1u he_party@60");
  const result = resolve({ amount: 0.99, currency: "USD" });
  assert.equal(result.kind === "activate" && result.amount, 89);
});

test("a currency without a rate is still rejected", () => {
  assert.equal(shape({ amount: 5000, currency: "JPY" }), "reject:unsupported_currency");
  assert.equal(shape({ amount: 5000, currency: "BTC" }), "reject:unsupported_currency");
});

test("a configured rate overrides the built-in table and still counts whole steps", () => {
  assert.equal(shape({ amount: 1, currency: "USD" }, { USD: 100 }), "2u he_party@120");
  assert.equal(shape({ amount: 1, currency: "USD" }, { USD: 5 }), "reject:below_minimum");
  // Overrides merge, they do not replace: EUR keeps its default rate.
  assert.equal(shape({ amount: 2.5, currency: "EUR" }, { USD: 100 }), "5u he_party@300");
});

test("the rate table is parsed strictly, because a silent typo costs money", () => {
  assert.deepEqual(parseCurrencyRates(undefined), { ...DEFAULT_CURRENCY_RATES });
  assert.equal(parseCurrencyRates('{"usd":95}')["USD"], 95, "lowercase keys are normalized");
  assert.equal(parseCurrencyRates('{"USD":95}')["EUR"], 100, "the built-in table is kept");
  assert.throws(() => parseCurrencyRates("USD=95"), /must be a JSON object/);
  assert.throws(() => parseCurrencyRates('["USD"]'), /must be a JSON object/);
  assert.throws(() => parseCurrencyRates('{"dollar":95}'), /not a three letter currency code/);
  assert.throws(() => parseCurrencyRates('{"USD":"95"}'), /positive number/);
  assert.throws(() => parseCurrencyRates('{"USD":0}'), /positive number/);
});

test("currency is case insensitive", () => {
  assert.equal(shape({ amount: 500, currency: "rub" }), "10u he_party@600");
});

test("broken amounts are rejected", () => {
  assert.equal(shape({ amount: "abc" }), "reject:invalid_amount");
  assert.equal(shape({ amount: "" }), "reject:invalid_amount");
  assert.equal(shape({ amount: -100 }), "reject:invalid_amount");
  assert.equal(shape({ amount: Number.NaN }), "reject:invalid_amount");
  assert.equal(shape({ amount: Number.POSITIVE_INFINITY }), "reject:invalid_amount");
});

test("comma decimal separator is accepted", () => {
  assert.equal(shape({ amount: "199,50" }), "3u he_party@180");
});

function twoActivities(extra: Record<string, unknown>[] = []) {
  return parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [
      { code: "aaa_first", title: "A", announce: "A", price: 50, duration: "rounds", rounds: 1 },
      { code: "bbb_second", title: "B", announce: "B", price: 50, duration: "rounds", rounds: 1 },
      ...extra,
    ],
  });
}

test("the draw only ever picks an enabled activity", () => {
  const parsed = parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [
      { code: "aaa_first", title: "A", announce: "A", price: 50, duration: "rounds", rounds: 1 },
      {
        code: "bbb_second",
        title: "B",
        announce: "B",
        price: 50,
        duration: "rounds",
        rounds: 1,
        enabled: false,
      },
    ],
  });

  for (let seed = 0; seed < 20; seed += 1) {
    const result = resolveDonation({ amount: 50, currency: "RUB" }, parsed, { random: () => seed / 20 });
    assert.equal(result.kind, "activate");
    if (result.kind !== "activate") return;
    assert.deepEqual(result.activities.map((activity) => activity.code), ["aaa_first"]);
  }
});

test("the whole enabled pool is reachable: the roll is what picks the effect", () => {
  const parsed = twoActivities();

  const low = resolveDonation({ amount: 50, currency: "RUB" }, parsed, { random: () => 0 });
  const high = resolveDonation({ amount: 50, currency: "RUB" }, parsed, { random: () => 0.99 });

  assert.equal(low.kind === "activate" && low.activities[0]?.code, "aaa_first");
  assert.equal(high.kind === "activate" && high.activities[0]?.code, "bbb_second");
});

test("each step is drawn on its own, so one donation can buy two different effects", () => {
  const parsed = twoActivities();
  // 0.99 -> bbb_second, 0.0 -> aaa_first: a queue of rolls, not one roll reused.
  const rolls = [0.99, 0];
  let index = 0;
  const result = resolveDonation({ amount: 100, currency: "RUB" }, parsed, { random: () => rolls[index++] ?? 0 });

  assert.equal(result.kind, "activate");
  if (result.kind !== "activate") return;
  assert.equal(result.units, 2);
  assert.deepEqual(result.activities.map((activity) => activity.code), ["bbb_second", "aaa_first"]);
});

test("a catalogue with nothing on sale is reported explicitly", () => {
  const parsed = parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [{ code: "pricey", title: "P", announce: "P", price: 500, duration: "rounds", rounds: 1, enabled: false }],
  });
  const result = resolveDonation({ amount: 100, currency: "RUB" }, parsed);
  assert.equal(result.kind, "reject");
  assert.equal(result.kind === "reject" && result.reason, "no_activity");
});

test("repeats of a clock effect merge into one longer line instead of firing twice", () => {
  const heParty = config.activities.find((activity) => activity.code === ON_SALE);
  assert.ok(heParty);

  const plan = planActivities([heParty, heParty, heParty]);
  assert.equal(plan.length, 1, "three steps must not send three lines");
  assert.equal(plan[0]?.seconds, 180);
  assert.equal(plan[0]?.params["seconds"], 180, "params.seconds has to follow, the plugin reads it");
});

test("a clock longer than the schema allows is split, and the plugin stacks the chunks", () => {
  const heParty = config.activities.find((activity) => activity.code === ON_SALE);
  assert.ok(heParty);

  const plan = planActivities(Array.from({ length: 20 }, () => heParty));
  assert.deepEqual(plan.map((activity) => activity.seconds), [600, 600]);
});

test("an instant effect keeps one line per step", () => {
  const id = config.activities.find((activity) => activity.code === "chaos_burst");
  assert.ok(id);
  assert.equal(id.duration, "instant");
  assert.equal(planActivities([id, id]).length, 2);
});

test("a mistyped amount cannot roll forever", () => {
  const result = resolve({ amount: 1_000_000_000 });
  assert.equal(result.kind, "activate");
  if (result.kind !== "activate") return;
  assert.equal(result.units, MAX_UNITS);
  assert.ok(result.droppedUnits > 0, "the steps the cap refused are reported");
});
