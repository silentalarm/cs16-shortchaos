import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * bot_antistuck is the safety net for a bot that grinds into a wall, and every rule in it came from a
 * picture: a bot in a corner for ten seconds, a bot shoved in a guessed direction, a camper pushed out of a
 * legitimate angle. None of that is reachable without a live server, so the three rules that keep it from
 * doing damage are pinned here.
 */
const plugin = readFileSync(new URL("../plugins/bot_antistuck/bot_antistuck.sma", import.meta.url), "utf8");
const entrypoint = readFileSync(new URL("../infra/entrypoint.sh", import.meta.url), "utf8");

const body = (name: string) =>
  new RegExp(`(?:stock bool:|stock |public )${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(plugin)?.[0] ?? "";

// Both tests look at the scan, so it is taken once here instead of inside one of them.
const scan = body("TaskScan");

test("a teleport is never used, even as a fallback", () => {
  // `set_user_origin` was measured on this server: the bot's graph keeps pointing where it was and it
  // freezes for the rest of the round (3 kills in 90 s against 149 in 60 s). The header explains that, so
  // the pattern has to look for a call, not for the name.
  assert.doesNotMatch(plugin, /set_user_origin\s*\(/, "the net teleports bots again");
  assert.doesNotMatch(plugin, /EngFunc_SetOrigin\s*\(/, "the net teleports bots again");
  // The only kill path is the silent one behind `bot_antistuck_respawn`: no death message, no frag.
  assert.match(plugin, /user_kill\(id, 1\)/, "the fallback is a visible death on camera");
});

test("camping is off, so the patience no longer waits out a camping window", () => {
  // The net used to keep quiet for 14 s because camping could hold an angle for up to 12 s. Camping is now
  // `yb_camping_allowed 0` (infra/entrypoint.sh), and the 12 s it was measured against never existed: YaPB
  // rejects `yb_camping_time_max` below 15 s, so the real window was the archive default 15-45 s, i.e. the
  // net spent most of a round shoving a camper it was told to respect.
  assert.match(entrypoint, /echo "yb_camping_allowed \\"0\\""/, "the patience is tuned for camping that is back on");

  const patience = /register_cvar\("bot_antistuck_patience",\s*"([\d.]+)"\)/.exec(plugin);
  // `assert.ok` narrows the type, `assert.notEqual` does not: without it `patience[1]` does not compile.
  assert.ok(patience !== null, "the corner case has no patience setting");

  // Not zero: a bot does stand still to aim or to watch a lane. Not 8 s either - measured on aim_map with
  // 20 bots, 8 s kicked twenty bots per 100 s and not one of them was stuck, which is a bot hopping on
  // camera for no reason. The escalation is what catches the ones that really never move.
  const value = Number(patience[1]);
  assert.ok(value >= 10, `patience (${value} s) is short enough to kick a bot that is only aiming`);
  assert.ok(value <= 20, `patience (${value} s) leaves a stuck bot standing for a third of a round`);

  // And the wall test itself is still the first rule, not an afterthought.
  assert.match(scan, /if \(!WallAhead\(id, normal\)\)/, "the wall test is gone");
  assert.ok(
    scan.indexOf("WallAhead") < scan.indexOf("FreeDirection"),
    "the corner fallback is asked before the wall in front",
  );
});

test("a corner shove is aimed at the room, and dropped when there is none", () => {
  const free = body("FreeDirection");
  assert.notEqual(free, "", "FreeDirection is missing");
  assert.match(free, /TR_flFraction/, "the free direction is chosen without measuring the room");
  assert.match(free, /return best > 0\.35/, "a bot boxed in on all four sides would be shoved into geometry");

  // The repeat ticks of a shove re-trace, and they have to know about the corner case too - otherwise
  // the kick is decided once and then never applied.
  const shove = body("TaskShove");
  assert.match(shove, /FreeDirection/, "the corner shove bails out on its own repeat ticks");

  // The two cases have to be told apart in the log, or "it took 10 s" is the only symptom anybody sees.
  assert.match(scan, /no wall in view/, "a corner shove looks identical to a wall shove in the log");
});

test("a shove that changes nothing escalates to a silent respawn", () => {
  // "после пинка всё равно сидят": a kick cannot change a bot's YaPB goal, so it walks straight back into
  // the corner. The counter turns that into a fix - after `bot_antistuck_escalate` shoves without progress
  // the bot is killed silently and csdm_lite brings it back on a spawn point, which is where a fresh goal
  // comes from. On by default, because that standing bot *is* the bug.
  const escalate = /register_cvar\("bot_antistuck_escalate",\s*"(\d+)"\)/.exec(plugin);
  assert.ok(escalate !== null, "the escalation has no setting");
  assert.ok(Number(escalate[1]) > 0, "the escalation is off by default, so the net is only a kick again");

  assert.match(scan, /g_shoves\[id\]\+\+/, "the net does not count its own shoves");
  assert.match(scan, /g_shoves\[id\] >= escalateLimit/, "a bot shoved for ever is never respawned");
  // Progress resets the counter, or a bot kicked out of one corner and into another dies for it.
  assert.match(scan, /g_shoves\[id\] = 0;/, "shoves are never forgotten on movement");

  const kill = body("KillForRespawn");
  assert.notEqual(kill, "", "KillForRespawn is missing");
  assert.match(kill, /user_kill\(id, 1\)/, "the escalation is a visible death on camera");
  assert.match(kill, /g_shoves\[id\] = 0;/, "the counter survives the respawn it caused");
  assert.match(kill, /log_amx/, "a respawn nobody can find in the log afterwards");
});
