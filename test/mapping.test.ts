import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities, parseActivities } from "../src/activities.ts";
import { resolveDonation } from "../src/mapping.ts";

const config = loadActivities(new URL("../config/activities.json", import.meta.url));

type Case = [amount: number, expected: string];

function code(donation: { amount: number | string; currency?: string }): string {
  const result = resolveDonation({ amount: donation.amount, currency: donation.currency ?? "RUB" }, config);
  return result.kind === "activate" ? result.activity.code : `reject:${result.reason}`;
}

test("49.99 RUB is below the 50 RUB minimum", () => {
  assert.equal(code({ amount: 49.99 }), "reject:below_minimum");
  assert.equal(code({ amount: 49 }), "reject:below_minimum");
});

test("the minimum donation buys the cheapest activity", () => {
  assert.equal(code({ amount: 50 }), "bot_nick");
  assert.equal(code({ amount: "50" }), "bot_nick");
});

test("amount buys the most expensive activity it can afford", () => {
  const cases: Case[] = [
    [59, "bot_nick"],
    [60, "meat_round"],
    [74, "meat_round"],
    [75, "knives_only"],
    [90, "moon_gravity"],
    [100, "awp_only"],
    [119, "awp_only"],
    [120, "bot_rain"],
    [150, "terminators"],
    [175, "zombie_round"],
    [199, "zombie_round"],
    [200, "terminator_one"],
    [249, "terminator_one"],
    [250, "map_change"],
    [1000, "map_change"],
  ];

  for (const [amount, expected] of cases) {
    assert.equal(code({ amount }), expected, `${amount} RUB must buy ${expected}`);
  }
});

test("leftover money is not banked and does not pick a second activity", () => {
  const result = resolveDonation({ amount: 260, currency: "RUB" }, config);
  assert.equal(result.kind, "activate");
  assert.equal(result.kind === "activate" && result.amount, 260);
  assert.equal(result.kind === "activate" && result.activity.price, 250);
});

test("non RUB donations are rejected instead of converted", () => {
  assert.equal(code({ amount: 500, currency: "USD" }), "reject:unsupported_currency");
  assert.equal(code({ amount: 500, currency: "eur" }), "reject:unsupported_currency");
});

test("currency is case insensitive", () => {
  assert.equal(code({ amount: 500, currency: "rub" }), "map_change");
});

test("broken amounts are rejected", () => {
  assert.equal(code({ amount: "abc" }), "reject:invalid_amount");
  assert.equal(code({ amount: "" }), "reject:invalid_amount");
  assert.equal(code({ amount: -100 }), "reject:invalid_amount");
  assert.equal(code({ amount: Number.NaN }), "reject:invalid_amount");
  assert.equal(code({ amount: Number.POSITIVE_INFINITY }), "reject:invalid_amount");
});

test("comma decimal separator is accepted", () => {
  assert.equal(code({ amount: "199,50" }), "zombie_round");
});

test("disabled activities are skipped", () => {
  const doc = {
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [
      { code: "aaa_first", title: "A", announce: "A", price: 50, duration: "rounds", rounds: 1 },
      { code: "bbb_second", title: "B", announce: "B", price: 50, duration: "rounds", rounds: 1, enabled: false },
    ],
  };
  const parsed = parseActivities(doc);
  const result = resolveDonation({ amount: 50, currency: "RUB" }, parsed);
  assert.equal(result.kind === "activate" && result.activity.code, "aaa_first");
});

test("equal prices are broken by priority, then by code", () => {
  const parsed = parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [
      { code: "bbb_low", title: "B", announce: "B", price: 50, duration: "rounds", rounds: 1 },
      { code: "ccc_high", title: "C", announce: "C", price: 50, duration: "rounds", rounds: 1, priority: 5 },
      { code: "aaa_tie", title: "A", announce: "A", price: 50, duration: "rounds", rounds: 1 },
    ],
  });

  const withPriority = resolveDonation({ amount: 50, currency: "RUB" }, parsed);
  assert.equal(withPriority.kind === "activate" && withPriority.activity.code, "ccc_high");

  const noPriority = parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [
      { code: "bbb_low", title: "B", announce: "B", price: 50, duration: "rounds", rounds: 1 },
      { code: "aaa_tie", title: "A", announce: "A", price: 50, duration: "rounds", rounds: 1 },
    ],
  });
  const tie = resolveDonation({ amount: 50, currency: "RUB" }, noPriority);
  assert.equal(tie.kind === "activate" && tie.activity.code, "aaa_tie");
});

test("nothing affordable outside the minimum is reported explicitly", () => {
  const parsed = parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [{ code: "pricey", title: "P", announce: "P", price: 500, duration: "rounds", rounds: 1 }],
  });
  const result = resolveDonation({ amount: 100, currency: "RUB" }, parsed);
  assert.equal(result.kind, "reject");
  assert.equal(result.kind === "reject" && result.reason, "no_activity");
});
