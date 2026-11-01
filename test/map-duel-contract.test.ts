import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

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
});

test("nothing outside the fight-yard pool can start or catch the stream", () => {
  // The duel owns the rotation (mp_timelimit 0), but a stale `MAP` or the stock 25-map mapcycle is
  // exactly how a stream comes back on de_dust2 after an unrelated restart.
  const entrypoint = readFileSync(new URL("../infra/entrypoint.sh", import.meta.url), "utf8");
  const compose = readFileSync(new URL("../infra/docker-compose.yml", import.meta.url), "utf8");

  const startMap = /MAP="\$\{MAP:-([a-z0-9_]+)\}"/.exec(entrypoint)?.[1] ?? "";
  assert.match(startMap, /^fy_/, `the server starts on ${startMap || "?"} instead of a fight-yard map`);
  assert.ok(compose.includes(`MAP: \${MAP:-${startMap}}`), "compose and the entrypoint disagree on the start map");

  const cycle = /MAPCYCLE="\$\{MAPCYCLE:-([^"}]+)\}"/.exec(entrypoint)?.[1] ?? "";
  const cycleMaps = cycle.split(",").filter((map) => map !== "");
  assert.deepEqual(cycleMaps, [
    "fy_iceworld", "fy_pool_day", "fy_snow", "fy_buzzkill", "fy_aztec", "fy_dustworld",
  ]);
  assert.match(entrypoint, /mapcycle\.txt/, "the stock mapcycle is never rewritten");
});

test("a fetched map brings its resources, and they land in the right directory", () => {
  // A .bsp on its own is not enough: fy_iceworld ships de_vegas.wad, and with the wad missing HLDS
  // dies with "TEX_InitFromWad: couldn't open de_vegas.wad" and comes back on the default map.
  const entrypoint = readFileSync(new URL("../infra/entrypoint.sh", import.meta.url), "utf8");
  const copy = /MAPS_EXTRA=[\s\S]*?\nfi\n/.exec(entrypoint)?.[0] ?? "";
  assert.ok(copy !== "", "the entrypoint does not copy maps-extra at all");
  assert.match(copy, /\*\.wad\) dest=\/hlds\/cstrike ;;/, "wads are not placed where HLDS looks for them");
  assert.match(copy, /\*\.bsp\|[^\n]*dest=\/hlds\/cstrike\/maps/, "maps do not go to cstrike/maps");

  const fetcher = readFileSync(new URL("../infra/fetch-maps.ps1", import.meta.url), "utf8");
  assert.match(fetcher, /'de_vegas\.wad'|\.wad/, "the fetcher does not take wads out of the archive");

  // The capture container has to see a map added after its volume was created, otherwise it cannot
  // join and the stream freezes on the map change a donation paid for.
  const stream = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");
  assert.match(stream, /sync_new_files/, "a new map never reaches the client volume");
  assert.match(stream, /--skip-old-files/, "the sync would copy everything on every start");
});

test("the rotation is fight-yard maps only, and every one of them is fetched", () => {
  // A vertical feed has a second or two to hook a viewer: on a big map the bots spend five of them
  // running to each other with an empty field in frame.
  const configured = /register_cvar\("map_duel_maps",\s*"([^"]+)"\)/.exec(plugin)?.[1] ?? "";
  const rotation = configured.split(",").filter((map) => map !== "");
  assert.deepEqual(rotation, [
    "fy_iceworld", "fy_pool_day", "fy_snow", "fy_buzzkill", "fy_aztec", "fy_dustworld",
  ]);
  for (const map of rotation) {
    assert.match(map, /^fy_/, `${map} is not a fight-yard map - the pool is fy_* only`);
  }

  // changelevel onto a map the server does not have hangs the stream, so a name has to be backed by
  // a file: either one of the maps that ship with HLDS, or one infra/fetch-maps.ps1 installed.
  const stock = new Set([
    "as_oilrig", "cs_747", "cs_assault", "cs_backalley", "cs_estate", "cs_havana", "cs_italy",
    "cs_militia", "cs_office", "cs_siege", "de_airstrip", "de_aztec", "de_cbble", "de_chateau",
    "de_dust", "de_dust2", "de_inferno", "de_nuke", "de_piranesi", "de_prodigy", "de_storm",
    "de_survivor", "de_torn", "de_train", "de_vertigo",
  ]);
  const mapsDir = new URL("../infra/maps/", import.meta.url);
  for (const map of rotation) {
    if (stock.has(map)) continue;
    assert.ok(
      existsSync(new URL(`${map}.bsp`, mapsDir)),
      `${map} is neither a stock map nor in infra/maps - run ./infra/fetch-maps.ps1`,
    );
    // A fetched map is pinned by hash, otherwise a re-uploaded file silently replaces it.
    const manifest = readFileSync(new URL("maps.json", mapsDir), "utf8");
    const pinned = new RegExp(`"name":\\s*"${map}"[\\s\\S]{0,200}?"sha256":\\s*"([0-9a-f]{64})"`).exec(manifest);
    assert.ok(pinned !== null, `${map} has no sha256 pin in infra/maps/maps.json`);
  }

  // The rotation used to be checked against the `map_change` activity's `maps=` list. That code was
  // removed with the 2026-10 reset; when S5 of docs/activities/roadmap.md brings a map rotation back,
  // this is the test that pins it against the cvar the duel uses.
  assert.ok(rotation.length > 0, "the map rotation is empty");
});

test("every map in the pool has a pinned navigation graph", () => {
  // YaPB 4.4 loads addons/yapb/data/graph/<map>.graph and analyzes a map itself when that file is
  // missing: on a fresh volume the bots then spend the first minutes of a map producing the graph
  // instead of playing it. infra/entrypoint.sh copies a pinned graph in when the volume has none.
  const configured = /register_cvar\("map_duel_maps",\s*"([^"]+)"\)/.exec(plugin)?.[1] ?? "";
  const graphs = new URL("../infra/maps/graph/", import.meta.url);

  for (const map of configured.split(",").filter((name) => name !== "")) {
    assert.ok(existsSync(new URL(`${map}.graph`, graphs)), `${map} has no pinned graph in infra/maps/graph`);
  }
  assert.match(
    readFileSync(new URL("../infra/entrypoint.sh", import.meta.url), "utf8"),
    /yapb graphs: \$\{graphs\} file\(s\) added/,
    "a pinned graph never reaches the server volume",
  );
});

