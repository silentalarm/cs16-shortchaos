import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * map_duel ends every map with a fight between the two team tops, and it is the only thing that
 * rotates the map now (the engine's timelimit is 0). Four details decide whether that works on a
 * live server and none of them is visible without one: respawns have to be off during the fight (or
 * the losers are back in half a second), the round must not end under the duel, both finalists must
 * get the same gun, and the changelevel has to come from a list this plugin owns.
 */
const plugin = readFileSync(new URL("../plugins/map_duel/map_duel.sma", import.meta.url), "utf8");
const pluginsIni = readFileSync(new URL("../infra/plugins.ini", import.meta.url), "utf8");
const serverCfg = readFileSync(new URL("../infra/server.cfg", import.meta.url), "utf8");

/** Body of one Pawn function, so a match cannot come from a neighbouring handler. */
function body(name: string): string {
  const found = new RegExp(`(?:public |stock )?${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(plugin);
  assert.ok(found !== null, `no ${name}() in the plugin`);
  return found[0];
}

test("the plugin is loaded and hooks the three events the duel needs", () => {
  assert.match(pluginsIni, /^map_duel\.amxx$/m, "infra/plugins.ini does not load map_duel.amxx");
  assert.match(plugin, /register_event\("DeathMsg", "OnDeathMsg", "a"\)/);
  assert.match(plugin, /RegisterHam\(Ham_Spawn, "player", "OnSpawnPost", 1\)/);
  assert.match(plugin, /register_srvcmd\("amx_map_duel"/);
});

test("a map has no time limit of its own and the engine never rotates it", () => {
  // The engine clamps mp_roundtime at 9 minutes; 9 is longer than the map, so no round ever ends on
  // the clock and the fight is never chopped mid-action.
  assert.match(serverCfg, /^mp_roundtime 9$/m, "rounds got a short time limit back");
  assert.match(serverCfg, /^mp_timelimit 0$/m, "the engine would rotate the map in the middle of the duel");
  // The plugin repeats it at map start: a stale cvar in a volume must not reintroduce the rotation.
  assert.match(body("ScheduleDuel"), /set_cvar_num\("mp_timelimit", 0\)/);
});

test("the finalists are one per team, so no team is wiped and the round cannot end", () => {
  const start = body("TaskStartDuel");
  assert.match(start, /FindTop\(TEAM_T\)/, "the terrorist top is not read");
  assert.match(start, /FindTop\(TEAM_CT\)/, "the counter-terrorist top is not read");
  // team_war's rule, so the duel finalists are exactly the two bots the panel calls TOP T / TOP CT.
  const death = body("OnDeathMsg");
  assert.match(death, /g_frags\[killer\]\+\+/, "the plugin does not count frags of its own");
  assert.doesNotMatch(plugin, /get_user_frags/, "the engine score would not count team kills");
});

test("the field is cleared and respawns stay off for the length of the fight", () => {
  assert.match(body("ClearField"), /user_kill\(id, 1\)/, "the other bots are never killed");
  assert.match(body("LowerPlugins"), /set_cvar_num\("csdm_lite_enabled", 0\)/, "respawns are still on");
  // A chaos effect hands out random weapons; it would rewrite the duel mid-fight.
  assert.match(body("LowerPlugins"), /set_cvar_num\("chaos_enabled", 0\)/, "chaos is still running");
  // Both are switched back on by the next map, or the server streams dead bots after the duel.
  const restore = body("RestorePlugins");
  assert.match(restore, /set_cvar_num\("csdm_lite_enabled", 1\)/);
  assert.match(restore, /set_cvar_num\("chaos_enabled", 1\)/);
  assert.match(restore, /map_duel_touched/, "someone else's settings would be overwritten");

  // A round restart respawns everybody: the hook has to send them straight back down, and re-arm a
  // finalist the engine revived.
  const spawn = body("OnSpawnPost");
  assert.match(spawn, /g_state != STATE_LIVE/, "bots would be killed outside a duel");
  assert.match(spawn, /user_kill\(id, 1\)/);
  assert.match(spawn, /ArmDuelist\(id\)/);
});


test("the finalists are put face to face instead of hoping they meet", () => {
  // Measured on dust2: two bots left alone never met in the 45 s limit, and the map was decided by
  // hit points. The counter-terrorist is moved next to the terrorist before the fight starts.
  const start = body("TaskStartDuel");
  assert.match(start, /BringThemTogether\(\)/, "the duel starts with the bots apart");
  const move = body("BringThemTogether");
  assert.match(move, /pev\(g_duelistT, pev_origin, origin\)/, "the anchor is not the terrorist");
  assert.match(move, /EngFunc_SetOrigin, g_duelistCT/, "the second finalist is never moved");

  // Bots pick their own goals and walk away: a fight nobody watches is not a duel, so the pair is
  // pulled back together while the fight runs - and the repeating task is dropped before the map
  // change is scheduled, or remove_task would take the changelevel with it.
  assert.match(start, /set_task\(keep, "TaskKeepTogether", 0, "", 0, "b"\)/, "the pair is never re-anchored");
  assert.match(body("TaskKeepTogether"), /get_distance_f\(tOrigin, ctOrigin\)/, "the drift is never measured");
  assert.match(body("FinishDuel"), /remove_task\(0\)/, "the keep-together task outlives the duel");
});

test("both finalists get 100 hp and the same random weapon", () => {
  const arm = body("ArmDuelist");
  assert.match(arm, /set_user_health\(id, 100\)/, "the finalists do not start on full health");
  assert.match(arm, /strip_user_weapons\(id\)/);
  assert.match(arm, /format\(weapon, charsmax\(weapon\), "weapon_%s", g_weapon\)/,
    "the weapon is not the one picked for the duel");
  assert.match(arm, /set_user_godmode\(id, 0\)/, "csdm_lite's protection would survive the duel");

  const start = body("TaskStartDuel");
  // One PickWeapon() per duel, before either bot is armed: the same gun for both.
  assert.equal((start.match(/PickWeapon\(\)/g) ?? []).length, 1, "the weapon is picked per bot");
  assert.ok(start.indexOf("PickWeapon()") < start.indexOf("ArmDuelist(g_duelistT)"),
    "a bot is armed before the weapon is picked");
});

test("the winner reaches the panel and the map changes a few seconds later", () => {
  const finish = body("FinishDuel");
  assert.match(finish, /set_cvar_string\("map_duel_winner", name\)/, "the panel never learns the winner");
  assert.match(finish, /set_task\(CHANGE_DELAY, "TaskChangeMap"\)/, "the map never changes");
  // A duel where neither bot finds the other still has to end: more hp wins.
  assert.match(body("TaskDuelTimeout"), /get_user_health\(g_duelistT\)/);
  assert.match(body("TaskDuelTimeout"), /FinishDuel\(winner\)/);
});

test("changelevel only ever uses a name from map_duel_maps", () => {
  const next = body("NextMap");
  assert.match(next, /get_cvar_string\("map_duel_maps"/, "the rotation is not the plugin's list");
  assert.match(next, /IsSafeName\(item\)/, "an RCON cvar would reach a console command unchecked");

  // The list has to stay in step with the maps the donation activity knows about.
  const activities = readFileSync(new URL("../config/activities.json", import.meta.url), "utf8");
  const configured = /register_cvar\("map_duel_maps", "([^"]+)"\)/.exec(plugin)?.[1] ?? "";
  for (const map of ["de_dust2", "de_inferno", "de_nuke", "cs_italy", "de_aztec"]) {
    assert.ok(configured.includes(map), `map_duel_maps has no ${map}`);
    assert.ok(activities.includes(map), `activities.json has no ${map}`);
  }
});

