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
  assert.match(pool, /ParamCopy\("pool"/, "the pool is not read from the command");
  assert.match(pool, /containi\(pool, "deagle"\)/, "the pool names are not read one by one");

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
  assert.match(undo, /g_fireTicks\[id\] = 0/, "the countdowns survive the event");
});

test("no unfinished markers left in the plugin source", () => {
  assert.equal(/\/\/\s*PART[0-9]/.test(source), false, "the file still contains a PART marker");
});
