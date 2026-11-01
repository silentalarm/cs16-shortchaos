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

test("camping is respected until the camping window is over", () => {
  // The front trace is what keeps a camper out of the net: it looks at a doorway, not at a wall. The corner
  // case (a wall *behind* the bot) is allowed past `bot_antistuck_patience` - and that value has to stay
  // above `yb_camping_time_max`, because a camper never moves for longer than that window.
  const patience = /register_cvar\("bot_antistuck_patience",\s*"([\d.]+)"\)/.exec(plugin);
  // `assert.ok` narrows the type, `assert.notEqual` does not: without it `patience[1]` does not compile.
  assert.ok(patience !== null, "the corner case has no patience setting");

  const campingMax = /yb_camping_time_max \\"([\d.]+)\\"/.exec(entrypoint);
  assert.ok(campingMax !== null, "the camping window is not set in the entrypoint any more");

  assert.ok(
    Number(patience[1]) > Number(campingMax[1]),
    `patience (${patience[1]} s) must stay above the camping window (${campingMax[1]} s) or campers get shoved`,
  );

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
