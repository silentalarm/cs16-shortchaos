import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, MAX_ROUNDS, loadActivities, parseActivities } from "../src/activities.ts";

const shippedConfig = new URL("../config/activities.json", import.meta.url);

function act(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "knives_only",
    title: "Knives only",
    announce: "KNIVES ONLY!",
    price: 75,
    duration: "rounds",
    rounds: 1,
    ...overrides,
  };
}

function doc(activities: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, currency: "RUB", minAmount: 50, defaultCooldownSec: 60, activities, ...extra };
}

test("shipped catalogue is valid and matches the agreed deal", () => {
  const config = loadActivities(shippedConfig);

  assert.equal(config.currency, "RUB");
  assert.equal(config.minAmount, 50);
  // Eight survivors of the 2026-10 reset: the five 2025-10 events, `he_party` (kept off sale) and the
  // two hero modes of S1. The rest of the plan is in docs/activities/catalogue.md.
  assert.equal(config.activities.length, 8, "five 2025-10 events, he_party and the two hero modes");

  const codes = config.activities.map((activity) => activity.code);
  assert.equal(new Set(codes).size, codes.length, "codes are unique");
  assert.equal(codes.includes("bot_nick"), false, "the 17 disabled codes are gone for good");
  assert.equal(codes.includes("map_change"), false, "the 17 disabled codes are gone for good");

  // The 2025-10 deal: eight events, one price, one length. A 50 RUB step rolls one of them at random,
  // so an entry that is not enabled can never be drawn and every enabled entry has to cost exactly
  // one step. `lightsaber_duel` is one agreed exception to the 15 second length: the opera bed is the
  // event's whole soundtrack, so the clock is 30 seconds and the track is cut by it. The hero modes are
  // the second exception: a round needs a minute to have a story, and 15 seconds of Nemesis is the
  // "nothing happened" the old `terminator_one` was rejected for.
  const longer: Record<string, number> = { lightsaber_duel: 30, nemesis: 60, survivor: 60 };
  const onSale = config.activities.filter((activity) => activity.enabled);
  assert.deepEqual(
    onSale.map((activity) => activity.code).sort(),
    [
      "glass_cannon",
      "lightsaber_duel",
      "meteor_shower",
      "nemesis",
      "one_bullet",
      "red_light",
      "survivor",
    ],
    "seven events on sale",
  );
  for (const activity of onSale) {
    const seconds = longer[activity.code] ?? 15;
    assert.equal(activity.price, config.minAmount, `${activity.code} must cost exactly one 50 RUB step`);
    assert.equal(activity.duration, "seconds", `${activity.code} must be a clock, not a round`);
    assert.equal(activity.seconds, seconds, `${activity.code} must last the agreed ${seconds} seconds`);
    assert.equal(activity.params.seconds, seconds, `${activity.code} must pass its clock to the plugin`);
    assert.equal(activity.params.maxNameLength, 16, `${activity.code} must accept a nickname`);
  }

  const prices = config.activities.map((activity) => activity.price);
  assert.equal(Math.min(...prices), config.minAmount, "nothing costs less than one step");
  assert.deepEqual([...prices].sort((a, b) => a - b), prices, "the catalogue file stays sorted by price");

  for (const activity of config.activities) {
    if (activity.duration === "rounds") {
      assert.equal(activity.rounds, 1, `${activity.code} must last at most ${MAX_ROUNDS} round`);
    }
  }

  const byDuration = new Map(config.activities.map((activity) => [activity.code, activity.duration]));
  assert.equal(byDuration.get("he_party"), "seconds");
  assert.equal([...byDuration.values()].every((duration) => duration === "seconds"), true, "every survivor is a clock");
});

test("every effect on a clock carries that clock in its params as well", () => {
  const config = loadActivities(shippedConfig);
  const timed = config.activities.filter((activity) => activity.duration === "seconds");
  assert.equal(timed.length, 8, "every shipped code is a clock");

  for (const activity of timed) {
    // The plugin reads the length from the command the control API builds, so both places must agree.
    assert.equal(activity.params.seconds, activity.seconds, `${activity.code} sends a different length`);
    assert.ok(activity.seconds !== null && activity.seconds >= 1 && activity.seconds <= 600);
  }
});

test("the HE party is the whole shop: one step, sixty seconds, no cooldown", () => {
  const config = loadActivities(shippedConfig);
  const party = config.activities.find((activity) => activity.code === "he_party");

  assert.ok(party, "he_party is not in the catalogue");
  assert.equal(party.duration, "seconds");
  assert.equal(party.seconds, 60);
  // The plugin reads the length from the command the control API builds, so both places must agree.
  assert.equal(party.params.seconds, party.seconds);
  // One fixed step: a viewer pays 50 RUB, gets 60 seconds, and can buy as many steps as they like.
  assert.equal(party.price, config.minAmount);
  // No cooldown: a paid step must show up on screen at once, or the viewer sees nothing for their money.
  assert.equal(party.cooldownSec, 0);
  assert.equal(party.globalCooldownSec, 0);
  // The buyer's name goes on a bot, so the effect has somebody to point at.
  assert.equal(party.params.maxNameLength, 16);
});

test("the catalogue is exactly the eight codes the plugin still registers", () => {
  const config = loadActivities(shippedConfig);
  assert.deepEqual(
    config.activities.map((activity) => activity.code).sort(),
    [
      "glass_cannon",
      "he_party",
      "lightsaber_duel",
      "meteor_shower",
      "nemesis",
      "one_bullet",
      "red_light",
      "survivor",
    ],
  );

  const byCode = new Map(config.activities.map((activity) => [activity.code, activity]));
  // Every survivor is a clock that passes its length to the plugin and accepts the buyer's name: the
  // donor tag is attached to whichever bot the effect touched.
  for (const code of ["glass_cannon", "lightsaber_duel", "meteor_shower", "one_bullet", "red_light"]) {
    const activity = byCode.get(code);
    assert.ok(activity, `${code} is missing`);
    assert.equal(activity.enabled, true, `${code} must be on sale`);
    assert.equal(activity.params.maxNameLength, 16, `${code} must accept a nickname`);
  }

  const party = byCode.get("he_party");
  assert.ok(party);
  assert.equal(party.enabled, false, "he_party stays off sale but stays in the plugin");

  // The hero modes carry the numbers the plugin reads; a typo here is a hero with the default health.
  const nemesis = byCode.get("nemesis");
  assert.ok(nemesis);
  assert.equal(nemesis.params.baseHealth, 1500);
  assert.equal(nemesis.params.perBot, 600);
  assert.equal(nemesis.params.knife, 250);

  const survivor = byCode.get("survivor");
  assert.ok(survivor);
  assert.equal(survivor.params.weapon, "weapon_m249");
  assert.equal(survivor.params.baseHealth, 1200);
});

test("price below the minimum donation is rejected", () => {
  assert.throws(() => parseActivities(doc([act({ price: 40 })])), /"price" must be >= minAmount \(50\)/);
});

test("minimum donation itself cannot be lowered below 50", () => {
  assert.throws(() => parseActivities(doc([act()], { minAmount: 30 })), /"minAmount" must be >= 50/);
});

test("round based activity is capped at one round", () => {
  assert.throws(() => parseActivities(doc([act({ rounds: 2 })])), /"rounds" must be between 1 and 1/);
});

test("rounds must be null for non-round durations", () => {
  assert.throws(
    () => parseActivities(doc([act({ duration: "until_map_change", rounds: 3 })])),
    /"rounds" must be null when duration is "until_map_change"/,
  );
});

test("a clock activity is bounded, and rounds and seconds cannot be mixed", () => {
  const clock = parseActivities(doc([act({ duration: "seconds", seconds: 30, rounds: null })]));
  assert.equal(clock.activities[0]?.seconds, 30);
  assert.equal(clock.activities[0]?.rounds, null);

  assert.throws(
    () => parseActivities(doc([act({ duration: "seconds", seconds: 0, rounds: null })])),
    /"seconds" must be between 1 and 600/,
  );
  assert.throws(
    () => parseActivities(doc([act({ duration: "seconds", seconds: 601, rounds: null })])),
    /"seconds" must be between 1 and 600/,
  );
  assert.throws(
    () => parseActivities(doc([act({ duration: "seconds", seconds: 30, rounds: 1 })])),
    /"rounds" must be null when duration is "seconds"/,
  );
  assert.throws(
    () => parseActivities(doc([act({ rounds: 1, seconds: 30 })])),
    /"seconds" must be null when duration is "rounds"/,
  );
});

test("duplicate codes are rejected", () => {
  assert.throws(
    () => parseActivities(doc([act(), act({ title: "Copy" })])),
    /duplicate code "knives_only"/,
  );
});

test("announce must be printable ascii because GoldSrc chat cannot render cyrillic", () => {
  assert.throws(
    () => parseActivities(doc([act({ announce: "ТОЛЬКО НОЖИ!" })])),
    /"announce" must be printable ASCII/,
  );
});

test("unknown duration is rejected", () => {
  assert.throws(() => parseActivities(doc([act({ duration: "forever" })])), /"duration" must be one of/);
});

test("optional fields get defaults", () => {
  const config = parseActivities(doc([act()]));
  const [activity] = config.activities;
  assert.ok(activity);
  assert.equal(activity.priority, 0);
  assert.equal(activity.enabled, true);
  assert.equal(activity.cooldownSec, 60, "falls back to defaultCooldownSec");
  assert.equal(activity.globalCooldownSec, 0);
  assert.deepEqual(activity.params, {});
});

test("config errors are readable and typed", () => {
  assert.throws(
    () => parseActivities(doc([act()], { currency: "rub" })),
    (error: unknown) => error instanceof ConfigError && /"currency" must be an uppercase ISO code/.test(error.message),
  );
});
