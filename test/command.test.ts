import { test } from "node:test";
import assert from "node:assert/strict";
import { parseActivities } from "../src/activities.ts";
import type { Activity } from "../src/activities.ts";
import { CommandError, buildActivityCommand, sanitizeNick } from "../src/command.ts";

/**
 * A minimal activity: the builder is tested on its own rules, not on today's shop. Borrowing a code
 * from config/activities.json made every removal from the catalogue a broken test, and the builder
 * never cared what the code was called.
 */
function bare(overrides: Partial<Activity> = {}): Activity {
  return {
    code: "test_effect",
    title: "Test",
    announce: "TEST",
    price: 50,
    priority: 0,
    duration: "instant",
    rounds: null,
    seconds: null,
    cooldownSec: 0,
    globalCooldownSec: 0,
    enabled: true,
    params: {},
    ...overrides,
  };
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

test("an activity without params produces a one-word command", () => {
  assert.equal(buildActivityCommand(bare()), "amx_de test_effect");
});

test("params are serialized in a stable sorted order", () => {
  assert.equal(
    buildActivityCommand(bare({ params: { seconds: 60, zombieSpeed: 1.2, zombies: 3 } })),
    "amx_de test_effect seconds=60 zombieSpeed=1.2 zombies=3",
  );
});

test("lists are comma separated", () => {
  assert.equal(
    buildActivityCommand(bare({ params: { maps: ["fy_iceworld", "fy_snow"] } })),
    "amx_de test_effect maps=fy_iceworld,fy_snow",
  );
});

test("the bot nickname travels as nick= and maxNameLength is applied", () => {
  const withNick = bare({ params: { maxNameLength: 16 } });
  assert.equal(buildActivityCommand(withNick, { nick: "Вася" }), "amx_de test_effect nick=vasya");
  assert.equal(buildActivityCommand(withNick, { nick: "a".repeat(40) }), `amx_de test_effect nick=${"a".repeat(16)}`);
});

test("the viewer's message travels as one underscore-joined token", () => {
  const phrase = bare({ params: { maxPhraseLength: 40 } });

  assert.equal(buildActivityCommand(phrase, { message: "Привет, как дела?" }), "amx_de test_effect text=privet_kak_dela");
  // No spaces, no newlines, no quoting: the RCON line cannot be split or extended by a viewer.
  const hostile = buildActivityCommand(phrase, { message: 'go "; rcon_password x; //' });
  assert.equal(hostile.includes(" "), true, "the command itself keeps its argument separators");
  assert.equal(hostile.split(" ").length, 3, "a hostile message must not become extra arguments");
  assert.equal(hostile.includes('"'), false);
});

test("an empty or unprintable message is dropped, so the plugin keeps its default", () => {
  const phrase = bare({ params: { maxPhraseLength: 40 } });
  assert.equal(buildActivityCommand(phrase, { message: "   " }), "amx_de test_effect");
  assert.equal(buildActivityCommand(phrase, { message: "***" }), "amx_de test_effect");
  assert.equal(buildActivityCommand(phrase, {}), "amx_de test_effect");
});

test("a message is ignored by activities that do not ask for one", () => {
  assert.equal(buildActivityCommand(bare(), { message: "hello there" }), "amx_de test_effect");
});

test("health and weapon travel with the nickname in one line", () => {
  const buff = bare({ params: { health: 250, maxNameLength: 16, weapon: "weapon_deagle" } });
  assert.equal(
    buildActivityCommand(buff, { nick: "Вася" }),
    "amx_de test_effect health=250 weapon=weapon_deagle nick=vasya",
  );
});

test("advertising and abuse in a nickname are replaced instead of renamed onto a bot", () => {
  // A link in the nickname is free advertising on every stream frame for one 50 RUB donation.
  assert.equal(sanitizeNick("https://promo.ru"), "Anonim_Bot");
  assert.equal(sanitizeNick("www.kupi-forex.net"), "Anonim_Bot");
  assert.equal(sanitizeNick("t.me/kanal"), "Anonim_Bot");
  assert.equal(sanitizeNick("казино.casino"), "Anonim_Bot");
  // Banned roots arrive in transliteration, which is what the plugin prints.
  assert.equal(sanitizeNick("СУКА"), "Anonim_Bot");
  assert.equal(sanitizeNick("blyad_vasya"), "Anonim_Bot");
  assert.equal(sanitizeNick("pizdec"), "Anonim_Bot", "a root inside a longer word still counts");
});

test("an honest nickname survives the stopword filter", () => {
  for (const name of ["Вася Пупкин", "sergio", "artur", "ivan_2000", "kaban"]) {
    assert.notEqual(sanitizeNick(name), "Anonim_Bot", `${name} was treated as abuse`);
  }
});

test("a viewer phrase is not stopword filtered", () => {
  // The phrase is the product the viewer paid for; only the nickname sticks to the scoreboard.
  assert.equal(
    buildActivityCommand(bare({ params: { maxPhraseLength: 40 } }), { message: "suka" }),
    "amx_de test_effect text=suka",
  );
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
