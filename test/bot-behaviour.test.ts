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
const csdm = readFileSync(new URL("../plugins/csdm_lite/csdm_lite.sma", import.meta.url), "utf8");

function body(name: string): string {
  const found = new RegExp(`(?:public |stock )?${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(csdm);
  assert.ok(found !== null, `no ${name}() in csdm_lite`);
  return found[0];
}

test("a bot never fights with a knife, and never stands still instead of shooting", () => {
  // Both knife behaviours belong to YaPB itself, not to the engine: left on, a bot decides on its
  // own to run at someone with a knife, which on the stream looks like a broken bot.
  assert.match(serverCfg, /^yb_random_knife_attacks 0$/m, "bots still attack with a knife at random");
  assert.match(serverCfg, /^yb_stab_close_enemies 0$/m, "bots still stab a close enemy");
  // Camping and shift-walking are what "стоял и смотрел" looks like from the camera.
  assert.match(serverCfg, /^yb_camping_allowed 0$/m, "bots are allowed to camp again");
  assert.match(serverCfg, /^yb_walking_allowed 0$/m, "bots still walk slowly when they hear somebody");
  // Team play: T against CT. yb_csdm_mode 0 makes a bot target the other team only; 2 (FFA) was the
  // old setting, where every bot was a target and a team kill fed the scoreboard.
  assert.match(serverCfg, /^yb_csdm_mode 0$/m, "bots went back to free-for-all targeting");
  assert.match(serverCfg, /^mp_friendlyfire 0$/m, "friendly fire would hand the other side free frags");
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
