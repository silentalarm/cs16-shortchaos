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
  // 21 codes, one price step each: the ladder is the only "menu" the viewer sees, so every step
  // has to show a different picture. bless_bot/curse_leader/bot_phrase are cheap instant ones,
  // chaos_burst only triggers plugins/chaos_core, bounty/hot_potato/boss_raid follow the round.
  assert.equal(config.activities.length, 17, "17 activities after the zone activities were dropped");

  const codes = config.activities.map((activity) => activity.code);
  assert.equal(new Set(codes).size, codes.length, "codes are unique");
  assert.equal(codes.includes("zone_start"), false, "the zone activities are gone for good");

  const prices = config.activities.map((activity) => activity.price);
  assert.equal(new Set(prices).size, prices.length, "prices are unique so mapping needs no viewer input");
  assert.equal(Math.min(...prices), config.minAmount, "cheapest activity costs the minimum donation");
  assert.deepEqual([...prices].sort((a, b) => a - b), prices, "catalogue is sorted by price ascending");

  for (const activity of config.activities) {
    if (activity.duration === "rounds") {
      assert.equal(activity.rounds, 1, `${activity.code} must last at most ${MAX_ROUNDS} round`);
    }
  }

  const byDuration = new Map(config.activities.map((activity) => [activity.code, activity.duration]));
  assert.equal(byDuration.get("bot_nick"), "until_map_change");
  assert.equal(byDuration.get("map_change"), "instant");
  assert.equal(byDuration.get("chaos_burst"), "instant");

  const mapChange = config.activities.find((activity) => activity.code === "map_change");
  assert.ok(mapChange);
  assert.ok(mapChange.globalCooldownSec >= 600, "map change is rate limited to once per 10 minutes");
});

test("the round fights carry the parameters the plugin reads", () => {
  const config = loadActivities(shippedConfig);
  const byCode = new Map(config.activities.map((activity) => [activity.code, activity]));

  const bounty = byCode.get("bounty");
  assert.ok(bounty);
  assert.equal(bounty.price, 105);
  assert.equal(bounty.duration, "rounds");
  assert.equal(bounty.params.health, 150);
  assert.equal(bounty.params.reward, "weapon_deagle");

  const potato = byCode.get("hot_potato");
  assert.ok(potato);
  assert.equal(potato.price, 125);
  assert.equal(potato.params.health, 25);

  const raid = byCode.get("boss_raid");
  assert.ok(raid);
  assert.equal(raid.price, 185);
  assert.equal(raid.params.bosses, 2);
  assert.equal(raid.params.bossHealth, 1500);
  assert.equal(raid.params.bossWeapon, "weapon_m249");
  assert.equal(raid.params.gruntWeapon, "weapon_deagle");

  for (const activity of [bounty, potato, raid]) {
    // Without maxNameLength the poller sends no `nick=` and the buyer never appears in the chat
    // line the plugin prints, which is the only trace of who paid.
    assert.equal(typeof activity.params.maxNameLength, "number", `${activity.code} must accept a nickname`);
  }
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
