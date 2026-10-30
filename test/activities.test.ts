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
  // 18 codes, one price step each: the ladder is the only "menu" the viewer sees, so every step
  // has to show a different picture. bless_bot/curse_leader/bot_phrase are cheap instant ones,
  // chaos_burst only triggers plugins/chaos_core, he_party is the one effect on a clock of its own,
  // bounty/hot_potato/boss_raid follow the round.
  assert.equal(config.activities.length, 23, "18 legacy codes plus five 2025-10 events");

  const codes = config.activities.map((activity) => activity.code);
  assert.equal(new Set(codes).size, codes.length, "codes are unique");
  assert.equal(codes.includes("zone_start"), false, "the zone activities are gone for good");

  // The 2025-10 deal: eight events, one price, one length. A 50 RUB step rolls one of them at random,
  // so an entry that is not enabled can never be drawn and every enabled entry has to cost exactly
  // one step and last exactly 15 seconds - otherwise the same money buys a longer or a cheaper show.
  // `lightsaber_duel` is the one agreed exception: the opera bed is the event's whole soundtrack, so the
  // clock is 30 seconds and the track is cut by it instead of ending mid-phrase.
  const longer: Record<string, number> = { lightsaber_duel: 30 };
  const onSale = config.activities.filter((activity) => activity.enabled);
  assert.deepEqual(
    onSale.map((activity) => activity.code).sort(),
    [
      "glass_cannon",
      "lightsaber_duel",
      "meteor_shower",
      "one_bullet",
      "red_light",
    ],
    "five events on sale",
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
  assert.equal(byDuration.get("bot_nick"), "until_map_change");
  assert.equal(byDuration.get("map_change"), "instant");
  assert.equal(byDuration.get("chaos_burst"), "instant");

  const mapChange = config.activities.find((activity) => activity.code === "map_change");
  assert.ok(mapChange);
  assert.ok(mapChange.globalCooldownSec >= 600, "map change is rate limited to once per 10 minutes");
});

test("every effect on a clock carries that clock in its params as well", () => {
  const config = loadActivities(shippedConfig);
  const timed = config.activities.filter((activity) => activity.duration === "seconds");
  assert.equal(timed.length, 15, "the five 2025-10 events plus the ten effects that used to wait for Round_End");

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

test("the round fights carry the parameters the plugin reads", () => {
  const config = loadActivities(shippedConfig);
  const byCode = new Map(config.activities.map((activity) => [activity.code, activity]));

  const bounty = byCode.get("bounty");
  assert.ok(bounty);
  assert.equal(bounty.price, 105);
  assert.equal(bounty.duration, "seconds", "a round never ends here, so the bounty has a clock");
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
