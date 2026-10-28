import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadActivities } from "../src/activities.ts";
import { buildActivityCommand } from "../src/command.ts";

/**
 * The Pawn plugin and the catalogue must agree: the control API can send a code the plugin
 * does not know, and the plugin can keep a handler nobody can trigger. Both are bugs that
 * only show up during a stream, so they are checked here without needing a game server.
 */
const source = readFileSync(new URL("../plugins/donation_events/donation_events.sma", import.meta.url), "utf8");
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));

function registered(): Map<string, string> {
  const map = new Map<string, string>();
  // Every activity is dispatched in the same RCON call; there is no separate "immediate" registry
  // and no per-round queue any more.
  const pattern = /RegisterDonationEffect\("([a-z0-9_]+)",\s*"([A-Za-z0-9_]+)"\)/g;
  for (const match of source.matchAll(pattern)) {
    const [, code, handler] = match;
    assert.ok(code && handler);
    assert.equal(map.has(code), false, `code ${code} registered twice`);
    map.set(code, handler);
  }
  return map;
}

test("every activity in the catalogue has a handler in the plugin", () => {
  const handlers = registered();
  const missing = catalog.activities.map((activity) => activity.code).filter((code) => !handlers.has(code));
  assert.deepEqual(missing, [], `catalogue codes without a plugin handler: ${missing.join(", ")}`);
});

test("the HE party keeps the field on knives and grenades until its clock runs out", () => {
  assert.match(source, /RegisterDonationEffect\("he_party", "EffectHeParty"\)/);

  const effect = /public EffectHeParty\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(effect, /ParamInt\("seconds", 60\)/, "the length is not read from the command");
  // Twice a second, repeating: the re-arm is what hands a thrown grenade back and what undoes the
  // rifle csdm_lite gives a bot that died during the party.
  assert.match(
    effect,
    /set_task\(step, "TaskHeParty", TASK_HE_PARTY, "", 0, "b"\)/,
    "the field is disarmed once instead of continuously",
  );

  const tick = /public TaskHeParty\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(tick, /DisarmField\(\)/, "a respawned bot keeps its rifle for the length of the party");
  assert.match(tick, /remove_task\(TASK_HE_PARTY\)/, "the task outlives the clock");

  const disarm = /stock DisarmField\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(disarm, /StripWeapons\(id\)/, "nothing is taken away");
  assert.match(disarm, /give_item\(id, "weapon_hegrenade"\)/, "no grenades are handed out");

  // A rifle in the backpack is pulled out the moment the bot sees somebody, so the whole weapon list
  // is checked, not the weapon in hand.
  const hasGun = /stock bool:HasGun\(id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(hasGun, /get_user_weapons\(id, weapons, count\)/, "only the weapon in hand is checked");
  assert.match(hasGun, /CSW_KNIFE/, "the knife counts as a weapon");
});

test("every plugin handler is reachable from the catalogue", () => {
  const handlers = registered();
  const known = new Set(catalog.activities.map((activity) => activity.code));
  const orphans = [...handlers.keys()].filter((code) => !known.has(code));
  assert.deepEqual(orphans, [], `plugin handlers nobody can buy: ${orphans.join(", ")}`);
});

test("each registered handler is a public function", () => {
  for (const [code, handler] of registered()) {
    assert.equal(
      new RegExp(`public\\s+${handler}\\s*\\(`).test(source),
      true,
      `${code} points at ${handler}, which is not a public function`,
    );
  }
});

test("the plugin answers the contract probes used by the control API", () => {
  assert.match(source, /register_srvcmd\("amx_de"/);
  assert.match(source, /equal\(code, "codes"\)/);
  assert.match(source, /equal\(code, "version"\)/);
  assert.match(source, /LoadParamsFromArgs/);
});

test("every activity is applied in the same RCON call", () => {
  // The per-round queue and the separate "immediate" registry were removed on purpose: a viewer
  // must see the effect of their payment at once.
  for (const dead of [/QueueCommand/, /StartNextActivity/, /g_queueSize/, /RegisterImmediateEffect/]) {
    assert.doesNotMatch(source, dead, `${dead} is back: activities must not wait for a round`);
  }
  assert.match(source, /ran '%s' with %d params/, "the dispatch log line changed");
});

test("every command the catalogue can produce stays a single line", () => {
  for (const activity of catalog.activities) {
    const command = buildActivityCommand(activity, { nick: "Vasya Pupkin" });
    assert.equal(command.includes("\n") || command.includes("\r"), false, `${activity.code} produced a multi-line command`);
    assert.ok(command.length <= 200, `${activity.code} produced an oversized command`);
  }
});

test("no unfinished markers left in the plugin source", () => {
  assert.equal(/\/\/\s*PART[0-9]/.test(source), false, "the file still contains a PART marker");
});
