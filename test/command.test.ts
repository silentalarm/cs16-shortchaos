import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities, findActivity, parseActivities } from "../src/activities.ts";
import { CommandError, buildActivityCommand, sanitizeNick } from "../src/command.ts";

const config = loadActivities(new URL("../config/activities.json", import.meta.url));

function activity(code: string) {
  const found = findActivity(config, code);
  assert.ok(found, `activity ${code} must exist in the shipped catalogue`);
  return found;
}

test("cyrillic nicknames are transliterated because GoldSrc cannot render them", () => {
  assert.equal(sanitizeNick("Вася Пупкин"), "vasya_pupkin");
  assert.equal(sanitizeNick("ЮЛЯ"), "yulya");
  assert.equal(sanitizeNick("Щука"), "schuka");
});

test("nickname is reduced to the whitelist, so no RCON or chat injection survives", () => {
  assert.equal(sanitizeNick('"; rcon_password x; //'), "rcon_password_x");
  assert.equal(sanitizeNick("a\nb"), "a_b");
  assert.equal(sanitizeNick("   "), "DONATOR");
  assert.equal(sanitizeNick("***"), "DONATOR");
  assert.equal(sanitizeNick(""), "DONATOR");
});

test("nickname respects the length limit and never ends with a separator", () => {
  assert.equal(sanitizeNick("abcdefghij", 5), "abcde");
  assert.equal(sanitizeNick("abcde f", 6), "abcde");
  assert.equal(sanitizeNick("a", 999), "a");
});

test("simple activities produce a one-word command", () => {
  assert.equal(buildActivityCommand(activity("knives_only")), "amx_de knives_only");
  assert.equal(buildActivityCommand(activity("awp_only")), "amx_de awp_only");
});

test("params are serialized in a stable sorted order", () => {
  assert.equal(
    buildActivityCommand(activity("zombie_round")),
    "amx_de zombie_round zombieHealth=1000 zombieSpeed=1.2 zombies=3",
  );
  assert.equal(buildActivityCommand(activity("moon_gravity")), "amx_de moon_gravity gravity=200");
});

test("lists are comma separated", () => {
  assert.equal(
    buildActivityCommand(activity("map_change")),
    "amx_de map_change maps=de_dust2,de_inferno,de_nuke,cs_italy,de_aztec",
  );
});

test("the bot nickname travels as nick= and maxNameLength is applied", () => {
  assert.equal(buildActivityCommand(activity("bot_nick"), { nick: "Вася" }), "amx_de bot_nick nick=vasya");
  assert.equal(buildActivityCommand(activity("bot_nick"), { nick: "a".repeat(40) }), `amx_de bot_nick nick=${"a".repeat(16)}`);
});

test("a param with forbidden characters is refused before it reaches RCON", () => {
  const parsed = parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [
      {
        code: "evil_one",
        title: "Evil",
        announce: "EVIL",
        price: 50,
        duration: "rounds",
        rounds: 1,
        params: { weapon: "ak47; quit" },
      },
    ],
  });
  const [evil] = parsed.activities;
  assert.ok(evil);
  assert.throws(() => buildActivityCommand(evil), CommandError);
});

test("oversized commands are refused instead of being truncated by the server", () => {
  const parsed = parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [
      {
        code: "many_maps",
        title: "Many",
        announce: "MANY",
        price: 50,
        duration: "rounds",
        rounds: 1,
        params: { maps: Array.from({ length: 40 }, (_, index) => `de_map${index}`) },
      },
    ],
  });
  const [many] = parsed.activities;
  assert.ok(many);
  assert.throws(() => buildActivityCommand(many), /longer than 200 chars/);
});

test("non finite numbers never reach the command line", () => {
  const parsed = parseActivities({
    version: 1,
    currency: "RUB",
    minAmount: 50,
    activities: [
      { code: "bad_num", title: "B", announce: "B", price: 50, duration: "rounds", rounds: 1, params: { gravity: 0 } },
    ],
  });
  const [first] = parsed.activities;
  assert.ok(first);
  assert.equal(buildActivityCommand(first), "amx_de bad_num gravity=0");
});
