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
    "amx_de zombie_round seconds=60 zombieHealth=1000 zombieSpeed=1.2 zombies=3",
  );
  assert.equal(buildActivityCommand(activity("moon_gravity")), "amx_de moon_gravity gravity=200 seconds=60");
});

test("lists are comma separated", () => {
  assert.equal(
    buildActivityCommand(activity("map_change")),
    "amx_de map_change maps=fy_iceworld,fy_pool_day,fy_snow,fy_buzzkill,fy_simpsons,fy_aztec,fy_dustworld",
  );
});

test("the bot nickname travels as nick= and maxNameLength is applied", () => {
  assert.equal(buildActivityCommand(activity("bot_nick"), { nick: "Вася" }), "amx_de bot_nick nick=vasya");
  assert.equal(buildActivityCommand(activity("bot_nick"), { nick: "a".repeat(40) }), `amx_de bot_nick nick=${"a".repeat(16)}`);
});

test("the viewer's message travels as one underscore-joined token", () => {
  const phrase = activity("bot_phrase");

  assert.equal(buildActivityCommand(phrase, { message: "Привет, как дела?" }), "amx_de bot_phrase text=privet_kak_dela");
  // No spaces, no newlines, no quoting: the RCON line cannot be split or extended by a viewer.
  const hostile = buildActivityCommand(phrase, { message: 'go "; rcon_password x; //' });
  assert.equal(hostile.includes(" "), true, "the command itself keeps its argument separators");
  assert.equal(hostile.split(" ").length, 3, "a hostile message must not become extra arguments");
  assert.equal(hostile.includes('"'), false);
});

test("an empty or unprintable message is dropped, so the plugin keeps its default", () => {
  const phrase = activity("bot_phrase");
  assert.equal(buildActivityCommand(phrase, { message: "   " }), "amx_de bot_phrase");
  assert.equal(buildActivityCommand(phrase, { message: "***" }), "amx_de bot_phrase");
  assert.equal(buildActivityCommand(phrase, {}), "amx_de bot_phrase");
});

test("a message is ignored by activities that do not ask for one", () => {
  assert.equal(buildActivityCommand(activity("knives_only"), { message: "hello there" }), "amx_de knives_only");
});

test("blessing and cursing carry the nickname of the buyer", () => {
  assert.equal(
    buildActivityCommand(activity("bless_bot"), { nick: "Вася" }),
    "amx_de bless_bot health=250 weapon=weapon_deagle nick=vasya",
  );
  assert.equal(
    buildActivityCommand(activity("curse_leader"), { nick: "kolya" }),
    "amx_de curse_leader health=25 nick=kolya",
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
  assert.equal(buildActivityCommand(activity("bot_phrase"), { message: "suka" }), "amx_de bot_phrase text=suka");
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
