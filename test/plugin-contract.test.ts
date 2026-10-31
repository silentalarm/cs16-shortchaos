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
  // rifle csdm_lite gives a bot that died during the party. Armed once per run, because a second
  // `set_task` on the same id is silently dropped by some AMXX builds.
  assert.match(
    effect,
    /if \(!wasActive\)\s*\n\s*set_task\(0\.5, "TaskHeParty", TASK_HE_PARTY, "", 0, "b"\)/,
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

test("the donor's nickname is tagged onto a bot without stealing bot_nick's job", () => {
  const assign = /stock AssignDonorNameToTopBot\(const nick\[\], Float:seconds\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(assign, "", "AssignDonorNameToTopBot is missing");
  assert.match(assign, /FindLeaderBot\(\)/, "the bot on top of the scoreboard is not preferred");
  assert.match(assign, /PickRandomBot\(\)/, "there is no fallback when the leader is gone");
  assert.match(assign, /format\(name, charsmax\(name\), "\[DONOR\] %s", nick\)/, "the tag format changed");
  assert.match(assign, /set_user_info\(bot, "name", name\)/, "the bot is never renamed");
  assert.match(assign, /get_user_name\(bot, g_donorOriginal/, "the original name is not kept for the reset");
  assert.match(assign, /remove_task\(TASK_DONOR_TAG\)/, "a second donation stacks a second tag");
  // The viewer has to see which bot their money bought, so the shell is bright and it lasts as long as
  // the effect that came with the same command.
  assert.match(assign, /kRenderFxGlowShell, 255, 200, 0/, "the tag lost its gold shell");
  assert.match(assign, /set_task\(seconds, "ClearDonorName", TASK_DONOR_TAG\)/, "the tag ignores the effect clock");

  // The tag is part of the shared reset, not a leak that survives the round.
  assert.match(/stock CleanupActive\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "", /ClearDonorName\(\)/);
  assert.match(/public ClearDonorName\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "", /set_user_info\(g_donorBot, "name", g_donorOriginal\)/);

  // Every nickname-carrying activity gets the tag; nothing is excluded any more, because the code that
  // renamed a bot itself (bot_nick) and the one with nothing to rename (map_change) are gone.
  const dispatch = /public CmdDonationEvent\(id, level, cid\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(dispatch, /AssignDonorNameToTopBot\(nick, EffectSeconds/, "the tag is never applied");
});

test("a repeated HE party adds time instead of restarting the same minute", () => {
  const handler = /public EffectHeParty\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(handler, "", "EffectHeParty is missing");
  // 150 RUB is three 50 RUB steps: the plugin must add 180 seconds, not run 60 three times.
  assert.match(handler, /g_hePartyTicks \+= seconds \* 2/, "a second party restarts the clock");
  assert.match(handler, /MAX_HE_PARTY_TICKS/, "the accumulated clock has no ceiling");
  assert.match(handler, /if \(!wasActive\)\s*\n\s*set_task\(0\.5, "TaskHeParty"/, "the repeating task is armed twice");
  assert.match(source, /#define MAX_HE_PARTY_TICKS \d+/, "the ceiling is not defined");
});

test("every lasting effect on a clock ends itself, because a round never does", () => {
  // csdm_lite respawns every bot in half a second, so Round_End almost never arrives: an effect that
  // waits for it would stay on the server until the map changes.
  const timed = catalog.activities.filter(
    (activity) => activity.duration === "seconds" && activity.code !== "he_party",
  );
  assert.ok(timed.length >= 5, `only ${timed.length} effects carry a clock`);

  for (const activity of timed) {
    const handlerName = registered().get(activity.code);
    assert.ok(handlerName, `${activity.code} has no handler`);
    const handler = new RegExp(`public ${handlerName}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
    assert.match(
      handler,
      new RegExp(`StartEffectTimer\\("${activity.code}"`),
      `${activity.code} never starts its own clock`,
    );
  }
});

test("the effect clock reads seconds= from the command and replaces an older timer", () => {
  const start = /stock StartEffectTimer\(const code\[\], Float:seconds\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(start, "", "StartEffectTimer is missing");
  assert.match(start, /remove_task\(taskid\)/, "a second donation stacks a second timer");
  assert.match(start, /set_task\(seconds, "TaskEffectFinished", taskid\)/);
  assert.match(start, /TASK_EFFECT_BASE \+ index/, "the task id is not derived from the registry index");

  const seconds = /stock Float:EffectSeconds\(Float:fallback\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(seconds, /ParamFloat\("seconds", fallback\)/, "the RCON parameter is ignored");
  assert.match(seconds, /value > 600\.0/, "a donated duration is not bounded");
  assert.match(source, /#define DEFAULT_EFFECT_SECONDS 45\.0/);
});

test("every reset path drops the clocks, not only the state", () => {
  for (const name of ["OnRoundEnd", "ClearAll", "plugin_end"]) {
    const body = new RegExp(`(?:public|stock) ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
    assert.match(body, /StopAllEffectTimers\(\)/, `${name} leaves a timer behind`);
  }
  // The panel's "stop everything" also has to end the repeating HE party task.
  assert.match(/stock StopAllEffectTimers\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "", /remove_task\(TASK_HE_PARTY\)/);
});

test("a dropped player id takes its effect state with it", () => {
  // The forward is `client_disconnected(id, bool:drop, message[], maxlen)`; a shorter copy of it makes
  // amxxpc abort with std::bad_alloc instead of reporting the mismatch, so the signature is the contract.
  const disconnected = /public client_disconnected\(id, bool:drop, message\[\], maxlen\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(disconnected, "", "client_disconnected is not handled");
  assert.match(disconnected, /remove_task\(id\)/, "the delayed re-arm survives the disconnect");
  assert.match(disconnected, /ClearGlow\(id\)/, "the glow stays on a reused slot");
  assert.match(disconnected, /g_donorBot == id/, "the donor tag stays on a reused slot");
});

test("an effect only gives back what it still owns", () => {
  // The claim layer: a resource is taken by the newest code and released by ownership, not by putting
  // a saved value back. Without it the second donation of the night undoes the first one's state.
  // The resources are plain defines because they are array indexes; a tagged enum only buys warnings.
  assert.match(source, /#define CLAIM_COUNT \d+/, "the claim resources are not declared");
  assert.match(source, /#define MAX_CLAIMS \d+/, "the claim depth is not declared");

  const take = /stock bool:ClaimTake\(res, owner, value\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(take, "", "ClaimTake is missing");
  assert.match(take, /g_claimDepth\[res\]\+\+/, "a claim is not recorded");
  assert.match(take, /g_claimDepth\[res\] >= MAX_CLAIMS/, "the claim stack has no ceiling");

  const release = /stock bool:ClaimRelease\(res, owner\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(release, "", "ClaimRelease is missing");
  assert.match(release, /new bool:top = \(i == g_claimDepth\[res\] - 1\)/, "a release cannot tell whether it was the newest claim");
  assert.match(release, /return top;/, "the caller is never told to undo");
});

test("every catalogue code has its own undo and never resets its neighbours", () => {
  const undo = /stock EndEffectState\(const code\[\]\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(undo, "", "EndEffectState is missing");
  // The old fallback reset every running effect: a meteor ending used to cut a duel short.
  assert.doesNotMatch(undo, /CleanupActive\(\)/, "a finished effect resets its neighbours again");

  for (const activity of catalog.activities) {
    assert.match(undo, new RegExp(`equal\\(code, "${activity.code}"\\)`), `${activity.code} has no undo branch`);
  }
});

test("the status line reports every running effect, not the last one", () => {
  const status = /if \(equal\(code, "status"\)\)\s*\{[\s\S]*?\n\t\}/.exec(source)?.[0] ?? "";
  assert.notEqual(status, "", "the status probe is missing");
  assert.match(status, /ActiveList\(active, charsmax\(active\)\)/, "the status line does not build a list");
  assert.match(status, /active=%s queued=0 nick=%s/, "the status line format changed");

  const list = /stock ActiveList\(dest\[\], len\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(list, "", "ActiveList is missing");
  assert.match(list, /task_exists\(TASK_EFFECT_BASE \+ i\)/, "a running clock is not detected");
  assert.match(list, /g_hePartyActive/, "he_party keeps its own task and would never be listed");
});

test("no timer reads the RCON parameter table", () => {
  // g_paramKeys is overwritten by the next donation, so a timer that reads it acts on somebody else's
  // money. Handlers snapshot what they need into globals (g_redStockCues, g_meteorDamage, ...).
  const timers = [...source.matchAll(/public (Task\w+|ReArmOnSpawn)\([^)]*\)\s*\{[\s\S]*?\n\}/g)].map((match) => match[0]);
  assert.ok(timers.length >= 4, `only ${timers.length} timers found`);
  for (const timer of timers) {
    assert.doesNotMatch(timer, /Param(Int|Float|Copy)\(/, `a timer reads live parameters: ${timer.slice(0, 60)}`);
  }
});

test("chaos_core resets a slot the engine hands to the next bot", () => {
  const chaos = readFileSync(new URL("../plugins/chaos_core/chaos_core.sma", import.meta.url), "utf8");
  const disconnected = /public client_disconnected\(id, bool:drop, message\[\], maxlen\)\s*\{[\s\S]*?\n\}/.exec(chaos)?.[0] ?? "";
  assert.notEqual(disconnected, "", "chaos_core has no client_disconnected");
  assert.match(disconnected, /set_user_rendering\(id\)/, "the render state of the slot is left behind");
  assert.match(chaos, /public plugin_end\(\)\s*\{\s*StopAll\(\);/, "plugin_end no longer reverts the cvars");
});

test("the five classes are one applier and a table, not five handlers", () => {
  const classes = ["raptors", "brutes", "runners", "jumpers", "regenerators"];

  // One applier: a second copy of it is a second place for the same bug.
  assert.equal([...source.matchAll(/stock bool:StartClass\(/g)].length, 1, "StartClass is defined twice");

  for (const code of classes) {
    const handlerName = registered().get(code);
    assert.ok(handlerName, `${code} is not registered`);
    const handler = new RegExp(`public ${handlerName}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
    assert.match(handler, new RegExp(`StartClass\\("${code}"`), `${code} does not use the shared applier`);
  }

  // Every parameter of the system is read from the command, so the panel retunes a preset without a
  // recompile: count, health, speed, gravity, regen, knockback.
  const applier = /stock bool:StartClass\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(applier, "", "StartClass is missing");
  for (const key of ["count", "health", "speed", "gravity", "regen", "knockback"]) {
    assert.match(applier, new RegExp(`Param(?:Int|Float)\\("${key}"`), `${key}= is never read from the command`);
  }

  // Health, speed and gravity are per-spawn values and csdm_lite re-arms every respawn: without the
  // re-arm a raptor comes back as a plain bot halfway through the event.
  const spawn = /public OnPlayerSpawn\(id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(spawn, /IsClassed\(id\)/, "a class bot respawns as a plain bot");
  const rearm = /public ReArmOnSpawn\(id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(rearm, /ArmClass\(id, false\)/, "the re-arm loses the class shape, and `false` keeps the saved health");

  // The undo releases each claim once, outside the slot loop: ClaimRelease pops the entry, so a release
  // per bot answers "not the owner" from the second slot on and leaves the field shaped like a class.
  const undo = /stock EndClass\(const code\[\]\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(undo, "", "EndClass is missing");
  assert.match(undo, /new bool:healthOwned = ClaimRelease\(CLAIM_HEALTH, owner\)/, "the health claim is released per slot");
  assert.match(undo, /remove_task\(TASK_CLASS_REGEN\)/, "regeneration keeps ticking after the clock");
  assert.match(undo, /g_classPicked\[id\] = 0/, "the per-slot flag outlives the event");

  // Two class events overlap by design - a 45 s clock and a 20 s global cooldown - so the newer one has
  // to end the running one, and the ended run's clock has to be a no-op when it fires later. Otherwise
  // the earlier clock clears the flags and the regeneration task of the run that is on screen.
  assert.match(applier, /if \(g_classActive\)\s*\n\s*EndClass\(g_classCode\)/, "a second class event stacks on the running one");
  assert.match(applier, /copy\(g_classCode, CODE_LEN - 1, code\)/, "the running class is not recorded");
  assert.match(undo, /if \(!equali\(g_classCode, code\)\)/, "a stale class clock tears the newer run down");
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(reset, /g_classCode\[0\] = '\^0'/, "the class owner outlives a full reset");

  // Knockback is an impulse with a ceiling: a bot thrown into a wall or off the map is not a class, it is
  // a missing player. The damage hook is where it has to live, because a class bot is pushed by every
  // hit and not only by a knife.
  const push = /stock PushBot\(victim, attacker, Float:damage\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(push, "", "PushBot is missing");
  assert.match(push, /if \(push > KNOCKBACK_CAP\)/, "the knockback has no ceiling");
  const damage = /public OnTakeDamage\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(damage, /PushBot\(victim, attacker, damage\)/, "knockback is never applied");

  // A push is invisible: the bot keeps standing where it was put and the log says nothing, so the run
  // counts the impulses it applied and how many of them hit the ceiling. Without the summary the only
  // answer to "does knockback work" is a picture nobody can re-read afterwards.
  assert.match(push, /g_classCappedPushes\+\+/, "the cap is never counted");
  assert.match(push, /g_classPushes\+\+/, "the impulses are never counted");
  assert.match(undo, /%d knockback\(s\), %d at the cap/, "the run does not report what its knockback did");
  assert.match(applier, /g_classPushes = 0/, "the counters survive into the next run");
});

test("a replaced hero or infection cannot tear down the run that replaced it", () => {
  // Same rule as the five classes, on the two systems of stage 2: the newer event ends the running one,
  // and the ended run's clock is a no-op when it fires later. Without it `nemesis` bought while
  // `survivor` is on ends the survivor's health claim where nobody can see it, and `outbreak` bought
  // on top of `chaos_plague` clears the infected flags of the newer run.
  const startHero = /stock bool:StartHero\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(startHero, "", "StartHero is missing");
  assert.match(startHero, /if \(g_heroActive\)\s*\n\s*EndHero\(g_heroCode\)/, "a second hero event stacks on the running one");
  assert.match(startHero, /copy\(g_heroCode, CODE_LEN - 1, code\)/, "the running hero is not recorded");

  const endHero = /stock EndHero\(const code\[\]\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(endHero, "", "EndHero is missing");
  assert.match(endHero, /if \(!equali\(g_heroCode, code\)\)/, "a stale hero clock cuts the camera off the newer hero");

  const startOutbreak = /stock bool:StartOutbreak\(const code\[\]\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(startOutbreak, "", "StartOutbreak is missing");
  assert.match(startOutbreak, /if \(g_outbreakActive\)\s*\n\s*EndOutbreak\(g_outbreakCode\)/, "a second infection stacks on the running one");
  assert.match(startOutbreak, /copy\(g_outbreakCode, CODE_LEN - 1, code\)/, "the running infection is not recorded");

  const endOutbreak = /stock EndOutbreak\(const code\[\]\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(endOutbreak, "", "EndOutbreak is missing");
  assert.match(endOutbreak, /if \(!equali\(g_outbreakCode, code\)\)/, "a stale infection clock clears the flags of the newer run");
  assert.match(endOutbreak, /g_infected\[id\] = 0/, "the flags are never cleared");

  // A full reset drops both owners, or the next map inherits a run that believes it is still in charge.
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(reset, /g_heroCode\[0\] = '\^0'/, "the hero owner outlives a full reset");
  assert.match(reset, /g_outbreakCode\[0\] = '\^0'/, "the infection owner outlives a full reset");
});

test("the five S4 skills are registered, clocked and undone like every other effect", () => {
  const handlers = registered();
  const skills: [string, string][] = [
    ["hex_wave", "EffectHexWave"],
    ["chain_lightning", "EffectChainLightning"],
    ["blink_bots", "EffectBlinkBots"],
    ["hero_roulette", "EffectHeroRoulette"],
    ["vampiric_aura", "EffectVampiricAura"],
  ];

  for (const [code, handler] of skills) {
    assert.equal(handlers.get(code), handler, `${code} is not registered`);

    const effect = new RegExp(`public ${handler}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
    assert.notEqual(effect, "", `${handler} is missing`);
    assert.match(effect, /BeginEvent\("/, `${code} does not open an event`);
    // A clock, not a round: csdm_lite ends a round in half a second, so Round_End never arrives.
    assert.match(effect, new RegExp(`StartEffectTimer\\("${code}", EffectSeconds\\(`), `${code} has no clock`);
    assert.match(
      source,
      new RegExp(`if \\(equal\\(code, "${code}"\\)\\)`),
      `${code} has no undo branch in EndEffectState`,
    );
  }

  // The three timers are dropped on every reset path, or a task outlives its flag by one map.
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  for (const task of ["TASK_CHAIN", "TASK_BLINK", "TASK_ROULETTE"]) {
    assert.match(reset, new RegExp(`remove_task\\(${task}\\)`), `${task} survives a full reset`);
  }
});

test("the blink traces before it moves a bot, and refuses a solid landing", () => {
  const blink = /stock bool:BlinkBot\(id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(blink, "", "BlinkBot is missing");

  // The order is the point: a bot placed inside geometry is stuck for the rest of the event, and the
  // engine snaps a bad origin back without an error, which reads as "the skill did nothing".
  const traced = blink.indexOf("EngFunc_TraceLine");
  const moved = blink.indexOf("EngFunc_SetOrigin");
  assert.notEqual(traced, -1, "the destination is never traced");
  assert.notEqual(moved, -1, "the bot is never moved");
  assert.ok(traced < moved, "the bot is moved before the destination is checked");
  assert.match(blink, /CONTENTS_SOLID/, "a solid landing is not refused");
  assert.match(blink, /fraction < 0\.5/, "a blink that stops at the first wall still counts as a blink");
});

test("the roulette hides its power until it fires, and the aura heals in the damage hook", () => {
  const roulette = /public EffectHeroRoulette\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(roulette, "", "EffectHeroRoulette is missing");
  // The surprise is the product: the chat may not name the power before the timer applies it.
  assert.doesNotMatch(roulette, /Announce\(/, "the roulette announces its power before it fires");
  assert.match(roulette, /set_task\(delay, "TaskRoulette", TASK_ROULETTE\)/, "the power is never applied later");
  const pool = /stock RoulettePool\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(pool, "", "RoulettePool is missing");
  assert.match(pool, /format\(key, charsmax\(key\), "power%d"/, "the pool is not read one name at a time");
  assert.match(pool, /equali\(value, name\)/, "a pool name is matched as a substring, not as a name");

  const fire = /stock RouletteFire\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(fire, /Announce\(/, "the reveal has no chat line");
  assert.match(fire, /switch \(g_roulettePower\)/, "the pool is not used to pick a branch");

  const damage = /public OnTakeDamage\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(damage, /AuraHeal\(attacker, damage\)/, "the aura never heals");
});

test("the hex takes the costume off again, and the aura keeps a ceiling", () => {
  const undo = /stock EndHexWave\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(undo, "", "EndHexWave is missing");
  // A render-side state outlives death: without the reset the bot is a chicken for the rest of the map.
  assert.match(undo, /cs_reset_user_model\(g_hexBot\)/, "the costume is never taken off");
  assert.match(undo, /ClaimRelease\(CLAIM_SPEED, owner\)/, "the speed is put back blindly");

  const arm = /stock ArmHexed\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(arm, /if \(g_hexCostume\)/, "the model is set even when the file is missing");
  assert.match(arm, /StripWeapons\(id\)/, "the chicken keeps its weapons");

  const respawn = /public ReArmOnSpawn\(id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(respawn, /ArmHexed\(id, false\)/, "a respawned chicken comes back with a rifle");

  const heal = /stock AuraHeal\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(heal, /REGEN_CEIL/, "the aura has no ceiling");

  // Measured on the test server: precaching a .mdl that is not in the image is not a soft failure, it is
  // `FATAL ERROR (shutting down): Mod_LoadModel: models/player/chicken/chicken.mdl not found`, and the
  // server goes into a restart loop. The file has to be checked before it is precached.
  const precache = /public plugin_precache\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  const checked = precache.indexOf("file_exists(HEX_MODEL_PATH)");
  const loaded = precache.indexOf("precache_model(HEX_MODEL_PATH)");
  assert.notEqual(checked, -1, "the costume file is not checked before use");
  assert.ok(checked < loaded, "the costume is precached before the file is checked");
});

test("fire grenades burn what a blast catches, and stop burning when the clock does", () => {
  assert.match(source, /RegisterDonationEffect\("fire_grenades", "EffectFireGrenades"\)/);

  const effect = /public EffectFireGrenades\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(effect, "", "EffectFireGrenades is missing");
  assert.match(effect, /ParamInt\("damage", 60\)/, "the damage is not read from the command");
  assert.match(effect, /ParamInt\("burn", 15\)/, "the burn length is not read from the command");
  // The grenade is the trigger: the field has to be holding one for the blast to happen at all.
  assert.match(effect, /set_task\(0\.5, "TaskFireParty", TASK_FIRE_PARTY/, "nobody is ever handed a grenade");
  // ...and since YaPB holds it and never throws it, the event also carries a blast of its own.
  assert.match(effect, /set_task\(SPARK_PERIOD, "TaskFireSpark", TASK_FIRE_SPARK/, "the event waits for a bot that never throws");
  assert.match(effect, /ParamInt\("radius", SPARK_RADIUS_DEFAULT\)/, "the spark's width is not read from the command");

  // The spark is a real explosion - the same DMG_BLAST label a thrown HE carries - so ignition stays in the
  // one damage hook the meteor path already proved.
  const spark = /public TaskFireSpark\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(spark, "", "TaskFireSpark is missing");
  assert.match(spark, /ExecuteHamB\(Ham_TakeDamage, id, 0, 0, float\(FIRE_SPARK_DAMAGE\), DMG_BLAST\)/, "the spark is not a blast");
  assert.match(spark, /new radius = g_fireRadius/, "the spark reads the live parameter table");

  // DMG_BLAST is the engine's own label for an explosion, so the damage hook is where the ignition
  // belongs: a grenade entity scan would be a second guess at a fact the engine already resolved.
  const damage = /public OnTakeDamage\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(damage, /damagebits & DMG_BLAST/, "an explosion never ignites anything");
  assert.match(damage, /IgniteBot\(victim\)/, "the blast is detected but nobody burns");

  const burn = /public TaskBurn\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(burn, /ExecuteHamB\(Ham_TakeDamage, id, 0, 0, float\(g_fireDamage\), DMG_BURN\)/, "the fire does no damage");
  assert.match(burn, /if \(!IsBotAlive\(id\)\)/, "a dead bot keeps burning");

  const undo = /stock EndFireGrenades\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(undo, "", "EndFireGrenades is missing");
  assert.match(undo, /remove_task\(TASK_FIRE_PARTY\)/, "the grenade party outlives its clock");
  assert.match(undo, /remove_task\(TASK_BURN\)/, "the fire outlives its clock");
  assert.match(undo, /remove_task\(TASK_FIRE_SPARK\)/, "the spark outlives its clock");
  assert.match(undo, /g_fireTicks\[id\] = 0/, "the countdowns survive the event");
});

test("freeze grenades find a flashbang the damage hook cannot see", () => {
  assert.match(source, /RegisterDonationEffect\("freeze_nades", "EffectFreezeNades"\)/);

  const effect = /public EffectFreezeNades\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(effect, "", "EffectFreezeNades is missing");
  assert.match(effect, /ParamInt\("freeze", 6\)/, "the freeze length is not read from the command");
  assert.match(effect, /ParamInt\("radius", 300\)/, "the blast radius is not read from the command");
  // A flashbang deals no damage, so the trigger cannot be DMG_BLAST, but a bot never throws one either: the
  // event carries its own pulse as well as the scan.
  assert.match(effect, /set_task\(FLASH_SCAN, "TaskFlashScan", TASK_FLASH_SCAN/, "nothing ever detects a flashbang");
  assert.match(effect, /set_task\(SPARK_PERIOD, "TaskFlashSpark", TASK_FLASH_SPARK/, "the event waits for a bot that never throws");
  assert.match(effect, /ClaimTake\(CLAIM_FREEZE, owner, 1\)/, "the freeze is taken without a claim");

  const scan = /public TaskFlashScan\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(scan, "", "TaskFlashScan is missing");
  assert.match(scan, /engfunc\(EngFunc_FindEntityByString, ent, "classname", "grenade"\)/, "the scan does not look for thrown grenades");
  assert.match(scan, /pev\(ent, pev_dmgtime\)/, "the fuse of the grenade is never read");
  assert.match(scan, /IsFlashGrenade\(ent\)/, "an HE would freeze the field as well");
  // The entity is removed in the frame it goes off, so the last origin has to come from the previous pass.
  assert.match(scan, /FlashStillThere\(i, seenEnt, seenFuse, seenCount\)/, "the scan cannot tell a blast from a grenade in the air");
  assert.match(scan, /FlashBlast\(g_flashOrigin\[i\]\)/, "a detonation is detected but nothing freezes");

  const flash = /stock bool:IsFlashGrenade\(ent\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(flash, /containi\(model, "flashbang"\)/, "the grenade model is not checked");

  // The pulse is the half that makes the event happen: the freeze it applies is the same FlashBlast the
  // scan calls, so there is one freeze path and two sources of it.
  const pulse = /public TaskFlashSpark\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(pulse, "", "TaskFlashSpark is missing");
  assert.match(pulse, /FlashBlast\(center\)/, "the pulse freezes nobody");
  // The bang comes from the blast, as `PlaySoundAt` (an info_target parked at the origin), and it is the
  // ice sample when the image has it. `emit_sound(0, ...)` puts the sample at the map origin, where the
  // distance fades it to nothing: the event was audible in the log and silent on the stream.
  assert.match(pulse, /PlaySoundAt\(center, g_freezeIce \? FREEZE_SOUND : FLASH_SOUND/, "the pulse has no bang the stream can hear");
  assert.doesNotMatch(pulse, /emit_sound\(0, CHAN_AUTO, FLASH_SOUND/, "the bang is back at the world origin");

  // The ice: a custom sample rendered by the image, and shards rather than a smoke puff on the blast.
  assert.match(source, /#define FREEZE_SOUND "freeze\/ice_crack\.wav"/, "the freeze lost its own sample");
  assert.match(source, /file_exists\(FREEZE_SOUND_PATH\)[\s\S]{0,120}precache_sound\(FREEZE_SOUND\)/, "the ice sample is never precached");
  const blast = /stock FlashBlast\(const Float:center\[3\]\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(blast, /IceShards\(center, g_freezeRadius\)/, "the freeze draws no ice");
  assert.match(blast, /set_user_rendering\(id, kRenderFxGlowShell, 170, 230, 255/, "the frozen bot is not frosted");

  const thaw = /public TaskThaw\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(thaw, "", "TaskThaw is missing");
  assert.match(thaw, /ThawBot\(id\)/, "a frozen bot never moves again");
  assert.match(thaw, /if \(!IsBotAlive\(id\)\)/, "a dead bot keeps a freeze countdown");
  // Thawing somebody else's freeze is the bug the claim layer exists to prevent.
  assert.match(thaw, /ClaimTake\(CLAIM_FREEZE, owner, 1\)/, "the countdown thaws a freeze a newer event owns");

  const undo = /stock EndFreezeNades\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(undo, "", "EndFreezeNades is missing");
  assert.match(undo, /remove_task\(TASK_FLASH_PARTY\)/, "the grenade party outlives its clock");
  assert.match(undo, /remove_task\(TASK_FLASH_SCAN\)/, "the scan outlives its clock");
  assert.match(undo, /remove_task\(TASK_THAW\)/, "the countdown outlives its clock");
  assert.match(undo, /remove_task\(TASK_FLASH_SPARK\)/, "the pulse outlives its clock");
  assert.match(undo, /g_freezeTicks\[id\] = 0/, "the countdowns survive the event");
  assert.match(undo, /ClaimRelease\(CLAIM_FREEZE, owner\)/, "the freeze is never given back");
  assert.match(undo, /if \(top\)\s*\n\s*ThawBot\(id\)/, "the undo thaws a bot a newer event is holding");
});

test("the five S5 chases read the field, and each one gives its state back", () => {
  for (const [code, handler] of [
    ["guntrain", "EffectGunTrain"],
    ["statues", "EffectStatues"],
    ["head_hunter", "EffectHeadHunter"],
    ["king_of_the_hill", "EffectKingOfTheHill"],
    ["duel_bell", "EffectDuelBell"],
  ]) {
    assert.match(source, new RegExp(`RegisterDonationEffect\\("${code}", "${handler}"\\)`), `${code} is not registered`);
  }

  const damage = /public OnDeathMsg\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  // Both kill-feed rules live in the one event hook: the ladder promotes, the mark pays.
  assert.match(damage, /GunTrainKill\(killer\)/, "a kill never moves anybody up the ladder");
  assert.match(damage, /HeadHunterKill\(victim, killer\)/, "the mark never pays its killer");

  const train = /public EffectGunTrain\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(train, /TrainReadLadder\(\)/, "the ladder is never read");
  assert.match(train, /StartEffectTimer\("guntrain"/, "the ladder has no clock");
  const parse = /stock TrainReadLadder\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  // One token per rung: a comma-joined list is split by the engine before the plugin ever sees it.
  assert.match(parse, /format\(key, charsmax\(key\), "rung%d"/, "the rungs are not read one by one");
  assert.match(parse, /IsSafeWeapon\(/, "a ladder rung reaches give_item unchecked");

  const statues = /public TaskStatues\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(statues, /CanSee\(other, id\)/, "nothing is looked at");
  assert.match(statues, /FreezeBot\(id\)/, "a seen bot keeps walking");
  assert.match(statues, /ThawBot\(id\)/, "an unseen bot never walks again");
  assert.match(statues, /ClaimTake\(CLAIM_FREEZE/, "the freeze is taken without the claim");

  const hunter = /public EffectHeadHunter\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(hunter, /ParamCopy\("reward"/, "the reward is not read from the command");
  assert.match(hunter, /IsSafeWeapon\(g_markReward\)/, "the reward reaches give_item unchecked");
  assert.match(hunter, /set_task\(float\(period\), "TaskMark"/, "the mark never moves");
  const paid = /stock HeadHunterKill\(victim, killer\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(paid, /g_markGlow\[killer\] = floatround/, "the gold shell has no clock");
  assert.match(paid, /SetHamParamFloat|give_item\(killer, g_markReward\)/, "the killer is never paid");

  const hill = /public EffectKingOfTheHill\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(hill, /ParamInt\("hold", 3\)/, "the hold is not read from the command");
  assert.match(hill, /AliveBotCentre\(g_hillCentre\)/, "the hill is placed without asking where the fight is");
  assert.match(hill, /ClaimTake\(CLAIM_HEALTH/, "the hill's health is taken without the claim");
  const tick = /public TaskHill\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(tick, /g_hillDwell\[id\] = 0\.0/, "the hold survives leaving the hill");

  const bell = /public EffectDuelBell\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(bell, /set_task\(float\(period\), "TaskDuelBell"/, "the bell never rings again");
  const ring = /stock DuelBell\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  // A teleport into a wall is a bot the viewer never sees again, so the spot is checked first.
  assert.match(ring, /SafeSpot\(placeA\) && SafeSpot\(placeB\)/, "the pair is teleported into solid space");
  assert.match(ring, /DropForDuel\(first, placeA\)/, "the first bot never moves");
});

test("the six S6 physics codes move the world and give it back", () => {
  const handlers = registered();
  const codes: [string, string][] = [
    ["airstrike", "EffectAirstrike"],
    ["weapon_rain", "EffectWeaponRain"],
    ["quake", "EffectQuake"],
    ["fire_ring", "EffectFireRing"],
    ["invert_velocity", "EffectInvertVelocity"],
    ["low_gravity_knives", "EffectLowGravityKnives"],
  ];

  const body = (name: string) =>
    new RegExp(`public ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  const stock = (name: string) =>
    new RegExp(`stock ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";

  for (const [code, handler] of codes) {
    assert.equal(handlers.get(code), handler, `${code} is not registered`);
    const effect = body(handler);
    assert.match(effect, /BeginEvent\("/, `${code} does not open an event`);
    // A clock, not a round: csdm_lite respawns every bot, so Round_End almost never arrives.
    assert.match(effect, new RegExp(`StartEffectTimer\\("${code}"`), `${code} has no clock`);
  }

  // Airstrike: the first blast is on the ring, the last one on the leader, and the barrage ends with its
  // last blast instead of leaving a 20 second status line over four seconds of explosions.
  const air = body("EffectAirstrike");
  assert.match(air, /ParamInt\("strikes", 10\)/, "the strike count is not read from the command");
  assert.match(air, /ParamInt\("damage", 120\)/, "the damage is not read from the command");
  assert.match(air, /ParamInt\("radius", 300\)/, "the blast radius is not read from the command");
  assert.match(air, /floatcos\(angle, degrees\) \* AIR_RING_RADIUS/, "the barrage does not start on the ring");
  const airTick = body("TaskAirstrike");
  assert.match(airTick, /float\(step\) \/ float\(g_airStrikes\)/, "the strikes do not converge");
  assert.match(airTick, /Ham_TakeDamage, id, 0, 0, float\(g_airDamage\), DMG_BLAST/, "the blast deals no damage");
  assert.match(airTick, /FinishEffect\("airstrike"\)/, "the barrage outlives its last strike");
  assert.match(stock("EndAirstrike"), /remove_task\(TASK_AIRSTRIKE\)/, "the barrage outlives its clock");

  // Weapon rain: the five-entity cap is the reason the code exists on a software renderer, and the boxes
  // are removed with the event instead of staying on the map forever.
  const rain = body("EffectWeaponRain");
  assert.match(rain, /ParamInt\("count", 5\)/, "the drop count is not read from the command");
  assert.match(rain, /if \(count > RAIN_MAX_DROPS\)/, "the five box cap is not enforced");
  assert.match(rain, /DropRainWeapon\(\)/, "the first box waits for the timer");
  const drop = stock("DropRainWeapon");
  assert.match(drop, /armoury_entity/, "no weapon entity is created");
  assert.match(drop, /cs_set_armoury_type\(ent, weaponId, 1\)/, "the entity has no weapon type");
  assert.match(drop, /get_weaponname\(weaponId, name/, "the world model is not derived from the weapon");
  const rainUndo = stock("EndWeaponRain");
  assert.match(rainUndo, /EngFunc_RemoveEntity/, "a box outlives the event");
  assert.match(rainUndo, /g_rainEnts\[i\] = 0/, "the box list survives the event");

  // Quake: a random shove per tick, with a ceiling - a bot launched through the skybox is a missing player.
  const quake = body("EffectQuake");
  assert.match(quake, /ParamInt\("force", 400\)/, "the impulse is not read from the command");
  assert.match(quake, /ParamFloat\("period", 0.7\)/, "the period is not read from the command");
  const quakeTick = body("TaskQuake");
  assert.match(quakeTick, /floatcos\(angle, degrees\) \* g_quakeForce/, "nothing is shoved");
  assert.match(quakeTick, /if \(speed > QUAKE_MAX_SPEED\)/, "the shove has no ceiling");
  assert.match(stock("EndQuake"), /remove_task\(TASK_QUAKE\)/, "the shove outlives its clock");

  // Fire ring: the circle starts at the farthest bot and shrinks by `shrink` every `period`.
  const ring = body("EffectFireRing");
  assert.match(ring, /ParamInt\("shrink", 40\)/, "the shrink is not read from the command");
  assert.match(ring, /AliveBotCentre\(g_ringCentre\)/, "the ring is placed without asking where the fight is");
  assert.match(ring, /ParamInt\("damage", 5\)/, "the burn is not read from the command");
  const ringTick = body("TaskFireRing");
  assert.match(ringTick, /g_ringRadius -= g_ringShrink/, "the ring never shrinks");
  assert.match(ringTick, /get_distance_f\(g_ringCentre, origin\) <= radius/, "everybody burns, inside or out");
  assert.match(ringTick, /Ham_TakeDamage, id, 0, 0, float\(g_ringDamage\), DMG_BURN/, "the zone deals no damage");
  assert.match(stock("EndFireRing"), /g_ringBurnt\[id\] = 0/, "a burn countdown outlives the event");
});

test("the six S6 physics codes give the world back", () => {
  const stock = (name: string) =>
    new RegExp(`stock ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  const body = (name: string) =>
    new RegExp(`public ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";

  // Invert velocity: the claim is what lets one run hand the field back without flipping it under a newer one.
  const invert = body("EffectInvertVelocity");
  assert.match(invert, /ParamFloat\("period", 0.2\)/, "the flip period is not read from the command");
  assert.match(invert, /ClaimTake\(CLAIM_VELOCITY/, "the velocity is taken without a claim");
  const flip = stock("FlipVelocities");
  assert.match(flip, /velocity\[0\] = -velocity\[0\]/, "the direction is never inverted");
  const invertUndo = stock("EndInvertVelocity");
  assert.match(invertUndo, /ClaimRelease\(CLAIM_VELOCITY/, "the field is never released");
  assert.match(invertUndo, /FlipVelocities\(\)/, "the last flipped direction is never given back");

  // Low gravity knives: the only cvar this system writes, plus the weapon pool. Both are claims, and the
  // undo is the one path that puts sv_gravity back.
  const knives = body("EffectLowGravityKnives");
  assert.match(knives, /ParamInt\("gravity", 150\)/, "the gravity is not read from the command");
  assert.match(knives, /ClaimGravity\(owner, g_knivesGravity\)/, "sv_gravity is written without a claim");
  assert.match(knives, /ArmKnives\(id\)/, "the field keeps its rifles");
  const arm = stock("ArmKnives");
  assert.match(arm, /strip_user_weapons\(id\)/, "the guns are never taken away");
  assert.match(arm, /give_item\(id, "weapon_knife"\)/, "the bot is left without a knife");
  const knivesUndo = stock("EndLowGravityKnives");
  assert.match(knivesUndo, /ClaimRelease\(CLAIM_GRAVITY, owner\)/, "the gravity claim is never released");
  assert.match(knivesUndo, /RestoreGravity\(\)/, "sv_gravity stays at the donated value");
  assert.match(knivesUndo, /remove_task\(TASK_GRAVITY_KNIVES\)/, "the re-arm outlives its clock");

  // A full reset drops the flags as well: a dropped task with a live flag is a moon-walk on the next map.
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(reset, /remove_task\(TASK_GRAVITY_KNIVES\)/);
  assert.match(reset, /g_knivesActive = false/);
  assert.match(reset, /g_invertActive = false/);
  assert.match(reset, /g_ringBurnt\[id\] = 0/);
});

test("the four S8 sound codes print the line, claim the bed and give it back", () => {
  const handlers = registered();
  const codes: [string, string][] = [
    ["announcer_countdown", "EffectAnnouncerCountdown"],
    ["quotes_pack", "EffectQuotesPack"],
    ["siren", "EffectSiren"],
    ["music_swap", "EffectMusicSwap"],
  ];
  const body = (name: string) =>
    new RegExp(`public ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  const stock = (name: string) =>
    new RegExp(`stock ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";

  for (const [code, handler] of codes) {
    assert.equal(handlers.get(code), handler, `${code} is not registered`);
    const effect = body(handler);
    assert.match(effect, /BeginEvent\("/, `${code} does not open an event`);
    assert.match(effect, new RegExp(`StartEffectTimer\\("${code}"`), `${code} has no clock`);
  }

  // The countdown is a rhythm: one chat line per second, ending on FIGHT, and the task stops itself.
  const countdown = body("EffectAnnouncerCountdown");
  assert.match(countdown, /ClaimTake\(CLAIM_AUDIO/, "the countdown does not claim the bed");
  assert.match(
    countdown,
    /set_task\(1\.0, "TaskCountdown", TASK_COUNTDOWN, "", 0, "b", COUNTDOWN_FROM \+ 1\)/,
    "the numbers are not on a one second clock",
  );
  const tick = body("TaskCountdown");
  assert.match(tick, /Announce\("%d", g_countdownLeft\)/, "the next number is never printed");
  assert.match(tick, /Announce\("FIGHT!"\)/, "the countdown never ends on FIGHT");
  assert.match(tick, /remove_task\(TASK_COUNTDOWN\)/, "the countdown keeps ticking after FIGHT");
  assert.match(stock("EndAnnouncerCountdown"), /ClaimRelease\(CLAIM_AUDIO/, "the bed is never released");

  // A quote is the viewer's phrase when there is one, the built-in pack otherwise, and always ASCII.
  const quotes = body("EffectQuotesPack");
  assert.match(quotes, /ParamCopy\("text"/, "the viewer's phrase is never read");
  assert.match(quotes, /RandomQuote\(phrase/, "a panel run has no fallback line");
  assert.match(quotes, /CleanPhrase\(phrase\)/, "the chat line is not forced to ASCII");
  assert.match(quotes, /Announce\("%s says: '%s'"/, "the subtitle line changed");
  const clean = stock("CleanPhrase");
  assert.match(clean, /text\[i\] = '\?'/, "a non-ascii byte reaches the chat");

  // The two beds and the countdown own the audio; the undo of each gives the claim back.
  for (const [effectName, undoName] of [
    ["EffectAnnouncerCountdown", "EndAnnouncerCountdown"],
    ["EffectSiren", "EndSiren"],
    ["EffectMusicSwap", "EndMusicSwap"],
  ] as [string, string][]) {
    assert.match(body(effectName), /ClaimTake\(CLAIM_AUDIO/, `${effectName} does not claim the bed`);
    assert.match(stock(undoName), /ClaimRelease\(CLAIM_AUDIO/, `${undoName} never gives the bed back`);
  }

  // A full reset drops the countdown task: a dropped task with a live flag prints numbers on the next map.
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(reset, /remove_task\(TASK_COUNTDOWN\)/);
  assert.match(reset, /g_countdownActive = false/);
  assert.match(reset, /g_sirenActive = false/);
  assert.match(reset, /g_musicSwapActive = false/);
});

test("the bazooka is a weapon the bot fires, not a prop", () => {
  const body = (name: string) =>
    new RegExp(`public ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  const stock = (name: string) =>
    new RegExp(`stock ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";

  // The launcher is a weapon the bot AI already knows, armed on the carrier, and its own trigger is the
  // hook that launches the rocket: a classname of our own would never be pressed by YaPB.
  assert.match(
    source,
    /RegisterHam\(Ham_Weapon_PrimaryAttack, BAZOOKA_WEAPON, "OnBazookaAttack"\)/,
    "the carrier's trigger is not hooked",
  );
  const arm = stock("ArmBazooka");
  assert.match(arm, /give_item\(id, BAZOOKA_WEAPON\)/, "the carrier is never given the launcher");
  assert.match(arm, /cs_set_user_bpammo\(id, CSW_AWP, 90\)/, "the launcher runs dry mid-run");
  assert.match(arm, /DressBazooka\(id\)/, "the carrier keeps the stock model in hand");

  // The model in the hand is the player's own field, and the game rewrites it on every switch and spawn,
  // so it is written from a tick and not once.
  assert.match(
    stock("DressBazooka"),
    /set_pev\(id, pev_weaponmodel, g_bazookaModelString\)/,
    "the in-hand model is not the one this repository makes",
  );
  const dress = body("TaskBazookaDress");
  assert.match(dress, /ArmBazooka\(next\)/, "the role never moves to a living bot");
  assert.match(dress, /ClaimTake\(CLAIM_WEAPONS/, "the launcher re-arms under a newer weapon rule");

  // The trigger launches, the bullet is dropped: without that the hitscan does the killing and the rocket
  // is decoration.
  assert.match(body("OnBazookaAttack"), /LaunchRocket\(id\)/, "the trigger launches nothing");
  assert.match(body("OnTraceAttack"), /return HAM_SUPERCEDE;/, "the launcher still lands AWP headshots");

  // The rocket flies, explodes on what it touches, and the blast is what damages - with falloff, so one
  // rocket does not kill the whole field at the rim.
  const step = stock("StepRocket");
  assert.match(step, /EngFunc_TraceLine/, "the rocket flies through walls");
  assert.match(step, /BazookaBlast\(landing/, "the rocket never explodes");
  const blast = stock("BazookaBlast");
  assert.match(blast, /Ham_TakeDamage, id, 0, attacker, damage, DMG_BLAST/, "the blast deals no damage");
  assert.match(blast, /float\(BAZOOKA_MIN_DAMAGE\)/, "the blast is a dud at the rim");
  // Measured live: with the carrier inside its own blast the role moved six times in one 45 s run and the
  // camera never held a shot. The owner is skipped on purpose.
  assert.match(blast, /if \(id == owner\)\s*\n\s*continue;/, "the carrier is killed by its own rocket");

  // A full reset drops the launcher: its tick, its rockets and the model field it rewrote.
  const undo = stock("EndBazookaDrop");
  assert.match(undo, /remove_task\(TASK_BAZOOKA_DRESS\)/, "the dress tick outlives the clock");
  assert.match(undo, /EndBazookaRockets\(\)/, "a rocket stays in the air after the clock");
  assert.match(
    undo,
    /set_pev\(g_bazookaBot, pev_weaponmodel, g_bazookaAwpModelString\)/,
    "the launcher model stays on the bot",
  );
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(reset, /EndBazookaRockets\(\)/, "a map change keeps a rocket flying");

  // And a respawn arms it again: csdm_lite hands the slot a random rifle half a second after the death.
  assert.match(source, /g_bazookaActive && id == g_bazookaBot/, "a respawned carrier is never re-armed");
});

test("an event that arms a bot re-arms it after csdm_lite respawns the slot", () => {
  const respawn = /public ReArmOnSpawn\(id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  const spawn = /public OnPlayerSpawn\(id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.notEqual(respawn, "", "ReArmOnSpawn is missing");

  // one_bullet: an ammo rule for the whole clock. It used to be applied once, so a bot that died came back
  // with csdm_lite's full rifle and the event was over for that bot.
  const one = /public EffectOneBullet\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(one, /g_oneBulletActive = true/, "the event never records that the rule is running");
  assert.match(one, /OneBulletArm\(id\)/, "the handler keeps its own copy of the ammo rule");
  assert.match(respawn, /if \(g_oneBulletActive\)\s*\n\s*OneBulletArm\(id\)/, "a respawned bot gets a full rifle");
  assert.match(spawn, /g_oneBulletActive/, "a spawn during the event never schedules the re-arm");
  const oneUndo = /if \(equal\(code, "one_bullet"\)\)\s*\{[\s\S]*?\n\t\}/.exec(source)?.[0] ?? "";
  assert.match(oneUndo, /g_oneBulletActive = false/, "the ammo rule outlives its clock");
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(reset, /g_oneBulletActive = false/, "the flag survives a full reset");

  // glass_cannon is a role like a hero: the M249, the health and the glow are the paid picture, and a
  // respawn puts csdm_lite's rifle in their place.
  assert.match(
    respawn,
    /if \(g_cannonActive && id == g_cannonBot\)\s*\n\s*\{[\s\S]*?ArmGlassCannon\(id\)/,
    "the cannon comes back as a plain bot",
  );
  assert.match(spawn, /g_cannonActive && id == g_cannonBot/, "the cannon's respawn never schedules the re-arm");

  // guntrain: the rung is per slot, so the bot comes back where it climbed to - unless a newer event owns
  // the weapon pool, which ClaimTake is asked about.
  const train =
    /if \(g_trainActive && ClaimTake\(CLAIM_WEAPONS, FindEffect\("guntrain"\), 1\)\)\s*\{[\s\S]*?\n\t\}/.exec(source)?.[0] ?? "";
  assert.match(train, /give_item\(id, g_trainLadder\[level\]\)/, "a respawned climber drops to the bottom rung");
  assert.match(train, /level >= g_trainCount/, "a stale rung index reaches the ladder array");
  assert.match(spawn, /g_trainActive/, "a climber's respawn never schedules the re-arm");
});

test("the sniper spends five rounds and earns them back", () => {
  assert.equal(registered().get("sniper"), "EffectSniper", "the sniper is not registered");
  assert.equal(registered().has("assassin"), false, "the silhouette mode is still registered as well");

  const body = (name: string) =>
    new RegExp(`public ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  const stock = (name: string) =>
    new RegExp(`stock ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";

  // The role is the shared hero machine - one bot, the camera, a clock - plus the AWP and a budget.
  const effect = body("EffectSniper");
  assert.match(effect, /ParamInt\("rounds", SNIPER_ROUNDS_DEFAULT\)/, "the budget is not read from the command");
  assert.match(effect, /StartHero\("sniper", SNIPER_WEAPON\)/, "the sniper is not a hero role");
  assert.match(effect, /StartEffectTimer\("sniper"/, "the sniper has no clock");

  // The budget is counted in shots, not in ammo: csdm_lite refills every reserve once a second, so the
  // launcher is taken away when the fifth shot is spent instead of being left dry.
  assert.match(
    source,
    /RegisterHam\(Ham_Weapon_PrimaryAttack, SNIPER_WEAPON, "OnSniperAttack"\)/,
    "a shot spends nothing",
  );
  const shot = body("OnSniperAttack");
  assert.match(shot, /g_sniperLeft--/, "a shot does not spend a round");
  assert.match(shot, /StripWeapons\(g_heroBot\)/, "the AWP stays in hand after the last round");
  assert.match(
    stock("SniperTopUp"),
    /cs_set_user_bpammo\(id, CSW_AWP, 0\)/,
    "the reserve is left full, which csdm_lite would refill into infinite rounds",
  );
  assert.match(stock("ArmHero"), /SniperArm\(id\)/, "a respawned sniper comes back without rounds");

  // A kill pays one round back, and the budget goes with the role.
  assert.match(body("OnDeathMsg"), /SniperReward\(\)/, "a kill pays nothing back");
  assert.match(stock("EndHero"), /g_sniperArmed = false/, "the budget outlives the role");
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(reset, /g_sniperArmed = false/, "a full reset keeps a sniper armed");
});

test("an event that arms a bot keeps the weapon, the floor and the switch", () => {
  const body = (name: string) =>
    new RegExp(`public ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  const stock = (name: string) =>
    new RegExp(`stock (?:[A-Za-z_]+:)?${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";

  // One place answers "what should this bot hold", and every code that arms a bot is a branch there.
  const kit = stock("KitWeapon");
  for (const holder of ["g_heroActive", "g_bazookaActive", "g_cannonActive", "g_trainActive", "g_duelActive", "g_knivesActive", "g_hePartyActive"]) {
    assert.match(kit, new RegExp(holder), `${holder} never locks its kit`);
  }
  assert.match(kit, /copy\(out, len, BAZOOKA_WEAPON\)/, "the carrier's launcher is not the locked weapon");

  // A weapon switch puts the kit back, and the respawn-driven rifle csdm_lite hands out goes with it.
  assert.match(stock("EnforceKit"), /get_user_weapon\(id\) == wantId/, "the switch is never checked");
  assert.match(stock("EnforceKit"), /engclient_cmd\(id, wanted\)/, "the bot is never told to hold the kit");
  const cur = /public OnCurWeapon\(id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(cur, /EnforceKit\(id\)/, "a weapon switch is never enforced");

  // Nothing is picked up off the floor while a kit is locked, and the boxes are swept.
  const touch = /public OnWeaponBoxTouch\(ent, id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(touch, /IsKitLocked\(id\)/, "a bot can pick up a dropped weapon during an event");
  const sweep = body("TaskKitSweep");
  assert.match(sweep, /EngFunc_FindEntityByString, ent, "classname", "weaponbox"/, "the floor is never swept");
  assert.match(sweep, /EngFunc_RemoveEntity/, "a swept box is left in the world");
  assert.match(sweep, /remove_task\(TASK_KIT_SWEEP\)/, "the sweep outlives the last locked bot");
  // The enforcement cannot live in the weapon-switch event alone: `CurWeapon` is a client event and YaPB
  // never sends it - a nemesis killed with an AWP for a whole round before this loop existed.
  assert.match(sweep, /if \(IsBotAlive\(id\) && IsKitLocked\(id\)\)\s*\n\s*\{?\s*\n?\s*EnforceKit\(id\)/, "the kit is only enforced on a client event");
  const awp = /public OnBazookaAttack\(weapon\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(awp, /IsKitWeapon\(id, BAZOOKA_WEAPON\)/, "a locked bot can fire an AWP it is not supposed to hold");
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(reset, /remove_task\(TASK_KIT_SWEEP\)/, "the sweep survives a full reset");
});

test("every blast draws its radius, and the rocket is visible", () => {
  const stock = (name: string) =>
    new RegExp(`stock ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  const body = (name: string) =>
    new RegExp(`public ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";

  // The shockwave is built from TE_BEAMPOINTS, the one beam message this set already runs live; a ring of
  // segments on the blast's own radius.
  const wave = stock("Shockwave");
  assert.match(wave, /SHOCKWAVE_SEGMENTS/, "the ring has no segments");
  assert.match(wave, /DrawBeamColour\(from, to/, "the ring draws nothing");
  assert.match(stock("DrawBeamColour"), /TE_BEAMPOINTS/, "the ring uses an unverified temp entity");

  // The three places a paid radius is drawn.
  assert.match(stock("BazookaBlast"), /Shockwave\(origin, radius/, "the rocket blast has no radius on screen");
  assert.match(stock("FlashBlast"), /Shockwave\(center, g_freezeRadius/, "the freeze pulse has no radius on screen");
  assert.match(body("TaskAirstrike"), /Shockwave\(pos, float\(radius\)/, "an airstrike has no radius on screen");

  // The rocket itself: a beam streak it leaves behind and a flash at the muzzle - and no sprite. The first
  // version carried `sprites/zerogxplode.spr` on the entity and drew as a black square on the stream (an
  // entity does not animate a sprite, and frame 0 of that file is black), so the sprite and the TE_SMOKE
  // puffs are gone and the rocket is drawn from the one beam message this set runs live.
  const step = stock("StepRocket");
  assert.match(step, /DrawBeamColour\(from, to, 255, 140, 40/, "the rocket leaves no trail");
  assert.match(step, /DrawBeamColour\(from, to, 255, 230, 150/, "the trail has no bright core");
  const launch = stock("LaunchRocket");
  assert.doesNotMatch(launch, /SetModel, ent, "sprites\//, "the rocket wears a sprite again - that is the black square");
  assert.match(launch, /TE_EXPLOSION/, "the launch has no flash");
  assert.doesNotMatch(source, /RocketSmoke|write_byte\(TE_SMOKE\)/, "the smoke puffs are back - they drew as black squares");
});

test("no unfinished markers left in the plugin source", () => {
  assert.equal(/\/\/\s*PART[0-9]/.test(source), false, "the file still contains a PART marker");
});

test("the hero modes wear their own model and give it back", () => {
  const stock = (name: string) =>
    new RegExp(`stock ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  // `infra/models/player/{nemesis,survivor}`: two re-skins of stock soldiers, applied for the length of the
  // role. Both are checked before they are precached, because `Mod_LoadModel: not found` is a FATAL ERROR in
  // GoldSrc, not a warning - an image built from an older tree must not take the server into a restart loop.
  const precache = /public plugin_precache\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(precache, /g_nemesisLook = file_exists\(NEMESIS_MODEL_PATH\) != 0/, "the nemesis model is precached blind");
  assert.match(precache, /precache_model\(NEMESIS_MODEL_PATH\)/, "the nemesis model is never precached");
  assert.match(precache, /g_survivorLook = file_exists\(SURVIVOR_MODEL_PATH\) != 0/, "the survivor model is precached blind");
  assert.match(precache, /precache_model\(SURVIVOR_MODEL_PATH\)/, "the survivor model is never precached");

  // ArmHero is the only way into the role (start, role moving to another bot, respawn), so the look goes on
  // there and cannot be lost by a death.
  assert.match(stock("ArmHero"), /DressHeroModel\(id\)/, "the hero wears the stock soldier");

  const dress = stock("DressHeroModel");
  assert.notEqual(dress, "", "DressHeroModel is missing");
  assert.match(dress, /cs_set_user_model\(id, NEMESIS_MODEL, true\)/, "the nemesis model is never put on a bot");
  assert.match(dress, /cs_set_user_model\(id, SURVIVOR_MODEL, true\)/, "the survivor model is never put on a bot");
  assert.match(dress, /g_heroLookSet = true/, "the undo cannot tell whether the model is this file's");

  // The undo, three ways: the effect's own clock, a full reset that drops the tasks without running them,
  // and the role moving to another bot when the carrier dies.
  const undress = stock("UndressHeroModel");
  assert.notEqual(undress, "", "UndressHeroModel is missing");
  assert.match(undress, /cs_reset_user_model\(g_heroBot\)/, "the hero keeps the nemesis skin after the event");
  // Only when this file set it: `cs_reset_user_model` lifts the model lock of anybody, and the hex_wave
  // chicken on the same slot must not be taken off by a hero's clock.
  assert.match(undress, /if \(g_heroLookSet && g_heroBot > 0/, "the undo resets a model it never set");

  assert.match(stock("EndHero"), /UndressHeroModel\(\)/, "the effect clock never takes the skin off");
  const reset = /public ResetEventState\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(reset, /UndressHeroModel\(\)/, "a full reset keeps the hero skin");
  const guard = /public TaskHeroGuard\(\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(guard, /UndressHeroModel\(\)/, "a carrier that dies keeps the skin into its respawn");
});

test("the camera follows the bot an event landed on", () => {
  const stock = (name: string) =>
    new RegExp(`stock ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  const body = (name: string) =>
    new RegExp(`public ${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? "";
  // The lock goes out as `#userid`. A nickname is resolved by stream_cam against its own player list, and a
  // name is not stable: spaces arrive as underscores, the donor tag renames the top bot, and a bot with an
  // underscore in its own nick never matches - the event ran, the lock logged, the picture stayed elsewhere.
  const lock = stock("LockCameraOn");
  assert.notEqual(lock, "", "LockCameraOn is missing");
  assert.match(lock, /server_cmd\("amx_stcam lock #%d %d", userid, seconds\)/, "the lock still travels as a nickname");
  assert.doesNotMatch(lock, /name\[i\] == ' '/, "the nickname is still being mangled for the command");
  // The lock has to expire with the event even when no undo runs.
  assert.match(lock, /if \(seconds < 1\)\s*\n\s*seconds = 1;/, "a lock can be taken for zero seconds");
  assert.match(source, /new g_heroSeconds = 60;/, "the hero clock is not snapshotted for the camera");
  assert.match(stock("ArmHero"), /LockCameraOn\(id, g_heroSeconds\)/, "the hero is never put on camera");

  // Every event that lands on one bot puts the camera there, with its own clock.
  assert.match(stock("ArmGlassCannon"), /LockCameraOn\(id, g_cannonSeconds\)/, "the cannon is off camera");
  assert.match(stock("ArmHexed"), /LockCameraOn\(id, g_hexSeconds\)/, "the chicken is off camera");
  assert.match(body("EffectHeroRoulette"), /LockCameraOn\(bot, /, "the roulette candidate is off camera");
  assert.match(body("EffectBazookaDrop"), /LockCameraOn\(bot, floatround\(EffectSeconds/, "the launcher carrier is off camera");

  // And a respawn takes the camera back: the role is re-applied through the same stocks, which is where the
  // lock is taken - a hero whose picture went to its killer stayed off camera until the next event.
  const rearm = /public ReArmOnSpawn\(id\)\s*\{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";
  assert.match(rearm, /ArmHero\(id\)/, "a respawned hero does not get its own camera back");
});
