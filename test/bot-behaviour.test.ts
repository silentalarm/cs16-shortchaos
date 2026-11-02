import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * How the bots behave on stream. None of this is visible without a live server, and every line of it
 * was a complaint from the picture: bots that pull out a knife, bots that stop and look, bots that
 * stand in a corner, bots that run dry and then do nothing. The knobs live in two places - the
 * server config and csdm_lite - so both are pinned here.
 */
const serverCfg = readFileSync(new URL("../infra/server.cfg", import.meta.url), "utf8");
const entrypoint = readFileSync(new URL("../infra/entrypoint.sh", import.meta.url), "utf8");
const csdm = readFileSync(new URL("../plugins/csdm_lite/csdm_lite.sma", import.meta.url), "utf8");

function body(name: string): string {
  const found = new RegExp(`(?:public |stock )?${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(csdm);
  assert.ok(found !== null, `no ${name}() in csdm_lite`);
  return found[0];
}

test("a bot never fights with a knife, but may carry one while it rushes", () => {
  // Two different knobs, and only one of them was the complaint. `yb_stab_close_enemies` makes a bot
  // decide on its own to stab a nearby enemy instead of shooting it - that is what reads as broken on
  // the stream, so it is off. `yb_random_knife_attacks` is the opposite: a bot rushing with no enemy
  // nearby runs with the knife out, the way a human rotates, so it is on (`BOT_KNIFE_ATTACKS=1`) and a
  // bot holding a rifle in an empty corridor is the thing that looks frozen.
  assert.match(serverCfg, /^yb_random_knife_attacks 1$/m, "bots rush with a rifle in hand again");
  assert.match(serverCfg, /^yb_stab_close_enemies 0$/m, "bots still stab a close enemy");
  // server.cfg is re-executed away by YaPB on every map change, so the value that wins is the one
  // infra/entrypoint.sh writes into yapb.cfg - and its default has to agree with server.cfg: 1 makes a
  // rushing bot carry the knife, 0 turns that off.
  assert.ok(entrypoint.includes("BOT_KNIFE_ATTACKS:-1}"), "the knife-out fallback does not match server.cfg");
  assert.equal(entrypoint.includes("BOT_KNIFE_ATTACKS:-0}"), false, "a leftover 0 would override server.cfg on every map change");
  // Camping and shift-walking are what "стоял и смотрел" looks like from the camera. YaPB re-executes its
  // own conf/yapb.cfg on every map change, so server.cfg cannot pin either of them: the values that win are
  // the block infra/entrypoint.sh writes into that file. 4-12 s of holding an angle is human; the first
  // setting was 10-30 s, which is a third of a fight on fy_iceworld.
  assert.match(entrypoint, /echo "yb_camping_time_min \\"4\.0\\""/, "the camping window is long again");
  assert.match(entrypoint, /echo "yb_camping_time_max \\"12\.0\\""/, "the camping window is long again");
  assert.match(entrypoint, /echo "yb_walking_allowed \\"0\\""/, "bots still walk slowly when they hear somebody");
  // Team play: T against CT. yb_csdm_mode 0 makes a bot target the other team only; 2 (FFA) was the
  // old setting, where every bot was a target and a team kill fed the scoreboard.
  assert.match(serverCfg, /^yb_csdm_mode 0$/m, "bots went back to free-for-all targeting");
  assert.match(serverCfg, /^mp_friendlyfire 0$/m, "friendly fire would hand the other side free frags");
});

test("a knife-only event turns the knife rule on, and puts it back afterwards", () => {
  // Server config keeps `yb_stab_close_enemies 0`: a bot that stabs while holding a rifle reads as
  // broken. With every gun stripped the same value means nobody ever swings - measured on the live
  // server, `he_party` produced 0 kills in 60 s, and the same minute produced 5 knife kills once the
  // cvar was set to 1 by hand. The plugin therefore flips it, and derives the state from the field
  // instead of remembering it per event, so a map change (which re-executes yapb.cfg) repairs itself.
  const plugin = readFileSync(new URL("../plugins/donation_events/donation_events.sma", import.meta.url), "utf8");

  // Through the engine's command path: a direct cvar write is invisible to YaPB (measured - the cvar
  // read back as 1 while the bots kept standing still).
  assert.match(plugin, /server_cmd\("yb_stab_close_enemies %d", want \? 1 : 0\)/, "the knife rule is never turned on");
  assert.match(plugin, /#define MELEE_WATCH_TICK 1\.0/, "the watch is not a one second task");
  assert.match(plugin, /StartMeleeWatch\(\);/, "the watch is never started");
  // Half the field without a gun is a knife event; one disarmed bot is a bot that found a weapon box.
  assert.match(plugin, /knives \* 2 >= alive/, "the rule would flip on a single disarmed bot");
  assert.match(plugin, /if \(!HasGun\(id\)\)/, "a gun in the backpack stops counting");
});

test("the HE party throws its own grenades, because the bots never throw one", () => {
  // YaPB does not use the grenade slot at all: zero grenade events in a minute with twenty bots
  // holding one. The party's own TE_EXPLOSION with `DMG_BLAST` is what the announcement promises.
  const plugin = readFileSync(new URL("../plugins/donation_events/donation_events.sma", import.meta.url), "utf8");
  const found = /stock HePartyBlast\(\)\s*\{[\s\S]*?\n\}/.exec(plugin);
  assert.ok(found !== null, "no HePartyBlast() in the plugin");

  assert.match(found[0], /TE_EXPLOSION/, "the blast is invisible");
  assert.match(found[0], /DMG_BLAST/, "the blast does no damage");
  assert.match(found[0], /PlaySoundAt\(center, SPARK_SOUND/, "the blast is silent");
  assert.match(plugin, /HePartyBlast\(\);/, "the party never throws its grenade");
  // One blast every three seconds of a 0.5 s task: rare enough that the knife fight stays the show.
  // One blast every second of a 0.5 s task: with no knife in the field the explosions carry the show.
  assert.match(plugin, /#define HE_BLAST_TICKS 2/, "the blast cadence drifted");
  assert.match(plugin, /if \(!wasActive\)\s*\{\s*g_heBlastTicks = 0;/, "a new party inherits the old blast counter");

  // The field is grenades and nothing else: the disarm takes the knife too, and the kit lock hands the
  // grenade back instead of a knife, or a viewer reads a knife round.
  const disarm = /stock DisarmField\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.ok(disarm !== "", "no DisarmField() in the plugin");
  assert.match(disarm, /user_has_weapon\(id, CSW_KNIFE\)/, "the knife survives the disarm");
  assert.doesNotMatch(disarm, /give_item\(id, "weapon_knife"\)/, "the party still hands out knives");
  // "Endless" is the reserve, not the weapon: a thrown grenade leaves the entity in the inventory with
  // no rounds in it, so a bot given one grenade throws exactly one and stands still afterwards.
  assert.match(
    disarm,
    /cs_set_user_bpammo\(id, CSW_HEGRENADE, HE_PARTY_GRENADES\)/,
    "the grenade is handed out once per party instead of endlessly",
  );
  // A flashbang beside the HE: two throwables make the bots reach for one far more often (29 throws in
  // 25 s with the HE alone, 342 with the pair), and it is not a gun, so the disarm must not strip it.
  assert.match(disarm, /give_item\(id, "weapon_flashbang"\)/, "the party hands out one kind of throwable only");
  const hasGun = /stock bool:HasGun\(id\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(hasGun, /CSW_FLASHBANG/, "the disarm strips the flashbang it just gave");
  // And the log has to say whether the bots really threw: the counter is the only measurement there is.
  assert.match(disarm, /g_heThrown\+\+/, "the party no longer counts what the bots throw");
  assert.match(plugin, /he_party: over, %d grenades thrown by the bots/, "the throw count never reaches the log");
  assert.match(
    plugin,
    /if \(g_hePartyActive\)\s*\{\s*copy\(out, len, "weapon_hegrenade"\);/,
    "the kit lock does not hand the grenade back",
  );
  assert.match(plugin, /wantId != CSW_HEGRENADE/, "the kit lock puts a knife next to the grenade");
});

test("dropped weapons are swept off the map", () => {
  // 20 bots dying every couple of seconds leave one weapon box each, and CS 1.6 has no "never drop"
  // switch: the litter has to be removed. A sweep, not a per-death hook - the engine's own drop runs
  // on death and a hook there would race it.
  assert.match(csdm, /register_cvar\("csdm_lite_clean_weapons", "1"\)/, "the sweep is not on by default");
  assert.match(csdm, /set_task\(cleanSec, "TaskCleanWeapons", 0, "", 0, "b"\)/, "the sweep does not repeat");

  const clean = body("TaskCleanWeapons");
  assert.match(clean, /"classname", "weaponbox"/, "the sweep does not look for death drops");
  assert.match(clean, /EngFunc_RemoveEntity/, "the box is never removed");
  assert.doesNotMatch(clean, /armoury_entity/, "the sweep would delete the map's own placed weapons");
});

test("ammo is endless in reserve, the magazine still empties", () => {
  // mp_infinite_ammo fills the magazine (no reload at all); the request was the opposite: a bot that
  // reloads for ever without falling back to the knife.
  assert.match(serverCfg, /^mp_infinite_ammo 0$/m, "the engine mode would remove the reload");

  const top = body("TaskTopUpAmmo");
  assert.match(top, /get_user_weapon\(id, clip, bpammo\)/, "the reserve of the current weapon is never read");
  assert.match(top, /cs_set_user_bpammo\(id, weapon, reserve\)/, "the reserve is never refilled");
  assert.match(csdm, /#include <cstrike>/, "cs_set_user_bpammo needs the cstrike module");
  // One second, repeating: a bot never has to count bullets, and 20 bots a second is cheap.
  assert.match(csdm, /set_task\(interval, "TaskTopUpAmmo", 0, "", 0, "b"\)/, "the refill does not repeat");
  assert.match(csdm, /register_cvar\("csdm_lite_ammo_reserve", "200"\)/, "the refill amount has no default");

  // Grenades and the knife have no reserve magazine: handing out 200 grenades would be a bug the
  // stream would show immediately.
  const gun = body("IsGun");
  for (const weapon of ["CSW_KNIFE", "CSW_C4", "CSW_HEGRENADE", "CSW_FLASHBANG", "CSW_SMOKEGRENADE"]) {
    assert.ok(gun.includes(weapon), `${weapon} would get a reserve magazine`);
  }
});
