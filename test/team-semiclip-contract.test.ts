import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * team_semiclip makes teammates non-solid, and two properties of that are invisible in a screenshot but
 * fatal on stream: a body that stays transparent (it can no longer be shot, and it walks through the map
 * it was standing in) and the plugin not being loaded at all. Both are pinned here, without a server.
 */
const plugin = readFileSync(new URL("../plugins/team_semiclip/team_semiclip.sma", import.meta.url), "utf8");
const pluginsIni = readFileSync(new URL("../infra/plugins.ini", import.meta.url), "utf8");
const entrypoint = readFileSync(new URL("../infra/entrypoint.sh", import.meta.url), "utf8");

test("the restore pass runs before the early return", () => {
  const task = /public TaskSemiclip\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.notEqual(task, "", "TaskSemiclip is gone");

  assert.match(task, /set_pev\(id, pev_solid, SOLID_SLIDEBOX\)/, "nothing is ever restored to solid");

  // A bot that died, changed team or saw the cvar switched off is only brought back by this pass, so the
  // restore has to come before anything can return from the task.
  const restore = task.indexOf("SOLID_SLIDEBOX");
  const early = task.indexOf("get_pcvar_num(g_cvarEnabled)");
  assert.ok(early > 0, "the enable flag is not read");
  assert.ok(restore < early, "the restore sits after the early return: transparent bodies would survive it");
});

test("only teammates become transparent", () => {
  const task = /public TaskSemiclip\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(task, /get_user_team\(g_players\[j\]\) != team/, "enemies would pass through each other too");
  assert.match(plugin, /register_cvar\("team_semiclip_enabled"/, "no way to switch it off");
  assert.match(plugin, /register_srvcmd\("amx_semiclip"/, "the transparent count cannot be read from RCON");
});

test("the image loads it and the bot is told teammates are passable", () => {
  assert.match(pluginsIni, /^team_semiclip\.amxx$/m, "infra/plugins.ini does not load team_semiclip.amxx");
  // Without this the bot still treats a teammate as an obstacle and routes around a body it could use.
  assert.match(entrypoint, /echo "yb_has_team_semiclip \\"1\\""/, "YaPB is not told about the semiclip");
});
