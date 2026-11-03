import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities } from "../src/activities.ts";
import {
  AutoRotation,
  chaosCodeAt,
  formatCountdown,
  freeCodeAt,
  loadAutoEvents,
  parseAutoEvents,
} from "../src/auto-events.ts";
import { buildActivityCommand } from "../src/command.ts";

/**
 * The free rotation is what keeps a quiet minute watchable, so what is pinned here is the contract:
 * every free code is a short clock the catalogue really has, the paid hero modes never appear in it,
 * a slot fires once (a restart or a slept-through hour must not dump a burst of effects), and a fresh
 * donation keeps the screen to itself.
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));
const config = loadAutoEvents(new URL("../config/auto-events.json", import.meta.url), catalog);
const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function activityOf(code: string) {
  return catalog.activities.find((activity) => activity.code === code);
}

test("the shipped rotation is a ranked free list with a chaos subset", () => {
  assert.equal(config.enabled, true);
  assert.equal(config.intervalSec, 180, "the owner asked for three minutes");
  assert.equal(config.free[0], "he_party", "the cheapest hook has to run first");
  assert.ok(config.free.length >= 4, "a rotation of two codes is a loop a viewer notices");
  assert.deepEqual(config.chaos, ["he_party", "meteor_shower", "jumpers", "bazooka_drop", "one_bullet"]);

  // A chaos burst is a free effect, so it must be one of the free ones.
  for (const code of config.chaos) {
    assert.ok(config.free.includes(code), `${code} is a chaos code outside the rotation`);
  }
  // The modes a viewer pays for stay paid: a free hero round leaves nothing to buy.
  for (const paid of ["nemesis", "survivor", "juggernaut", "sniper", "outbreak", "chaos_plague"]) {
    assert.equal(config.free.includes(paid), false, `${paid} runs on the house`);
  }
});

test("every free code is a clock that ends before the next slot", () => {
  for (const code of config.free) {
    const activity = activityOf(code);
    assert.ok(activity !== undefined, `${code} left the catalogue`);
    assert.equal(activity.duration, "seconds", `${code} is not a clock`);
    assert.ok((activity.seconds ?? 0) <= config.intervalSec, `${code} outlives its slot`);
  }
});

test("a bad rotation fails fast instead of firing nothing on stream", () => {
  const base = { version: 1, enabled: true, intervalSec: 180, quietAfterPaidSec: 60 };
  assert.throws(() => parseAutoEvents({ ...base, free: ["no_such_code"] }, catalog), /does not have/u);
  assert.throws(
    () => parseAutoEvents({ ...base, free: ["he_party"], chaos: ["meteor_shower"] }, catalog),
    /not in the free rotation/u,
  );
  assert.throws(() => parseAutoEvents({ ...base, free: [] }, catalog), /at least one code/u);
  assert.throws(() => parseAutoEvents({ ...base, free: ["he_party", "he_party"] }, catalog), /repeats/u);
  assert.throws(
    () => parseAutoEvents({ ...base, intervalSec: 30, free: ["he_party"] }, catalog),
    /longer than intervalSec/u,
  );
  assert.throws(() => parseAutoEvents({ ...base, intervalSec: 5 }, catalog), /between/u);
  assert.throws(() => parseAutoEvents({ ...base, version: 2 }, catalog), /"version"/u);
  // An empty list is allowed only when the rotation is switched off.
  assert.equal(parseAutoEvents({ ...base, enabled: false, free: [] }, catalog).free.length, 0);
});

test("the countdown is minutes and seconds, never negative", () => {
  assert.equal(formatCountdown(151), "2:31");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-5), "0:00");
  assert.equal(formatCountdown(59.2), "1:00", "a fractional slot rounds up, it never shows 0:59 twice");
});

test("the rotation wraps, and a disabled config hands out nothing", () => {
  assert.equal(freeCodeAt(config, 0), "he_party");
  assert.equal(freeCodeAt(config, config.free.length), "he_party");
  assert.equal(freeCodeAt({ ...config, enabled: false }, 0), null);
  assert.equal(chaosCodeAt(config, 0), "he_party");
  assert.equal(chaosCodeAt(config, config.chaos.length), "he_party");
  assert.equal(chaosCodeAt({ ...config, chaos: [] }, 3), null, "an empty list keeps amx_chaos force");
});

test("the panel is told what runs next, and when", () => {
  const rotation = new AutoRotation({
    config,
    activities: () => catalog,
    cursor: { slot: 0, nextAt: NOW + 151_000 },
  });

  assert.deepEqual(rotation.next(NOW), { code: "he_party", title: "HE party", secondsLeft: 151 });
  assert.equal(rotation.next(NOW + 200_000)?.secondsLeft, 0, "a late slot must not count backwards");
});


test("a slot fires once, then the next code is up", async () => {
  const sent: string[] = [];
  const run = async (command: string): Promise<string> => {
    sent.push(command);
    return "ok";
  };
  const rotation = new AutoRotation({ config, activities: () => catalog, cursor: { slot: 0, nextAt: NOW } });

  const first = await rotation.tick({ now: NOW, run });
  if (first.kind !== "ran") assert.fail(`expected a run, got ${first.kind}`);
  assert.equal(sent.length, 1);
  const heParty = activityOf("he_party");
  assert.ok(heParty !== undefined);
  assert.equal(sent[0], buildActivityCommand(heParty));
  assert.ok(sent[0]?.startsWith("amx_de he_party"), `unexpected command: ${sent[0]}`);

  // The same second again: the slot is spent, so nothing is sent.
  assert.equal((await rotation.tick({ now: NOW + 1_000, run })).kind, "idle");
  assert.equal(sent.length, 1);
  assert.equal(rotation.cursor.slot, 1);
  assert.equal(rotation.next(NOW + 1_000)?.code, "meteor_shower");
});

test("a host that slept through several slots fires one effect, not three", async () => {
  let calls = 0;
  const run = async (): Promise<string> => {
    calls += 1;
    return "ok";
  };
  const slept = NOW + 10 * 60_000;
  const rotation = new AutoRotation({ config, activities: () => catalog, cursor: { slot: 0, nextAt: NOW } });

  assert.equal((await rotation.tick({ now: slept, run })).kind, "ran");
  assert.equal(calls, 1);
  // The cadence restarts from the moment it fired: no burst of catch-up events on the next tick.
  assert.equal((await rotation.tick({ now: slept + 1_000, run })).kind, "idle");
  assert.equal(calls, 1);
  assert.equal(rotation.cursor.nextAt, slept + 180_000);
});

test("a paid donation keeps the screen: the free event steps aside but the cadence stays", async () => {
  const fresh = new AutoRotation({ config, activities: () => catalog, cursor: { slot: 1, nextAt: NOW } });
  const deferred = await fresh.tick({
    now: NOW,
    lastPaidAt: NOW - 30_000,
    run: async () => assert.fail("a free event overwrote a paid one"),
  });
  assert.equal(deferred.kind, "deferred");
  assert.equal(fresh.cursor.slot, 2, "the deferred slot is spent, the rotation keeps its order");
  assert.equal(fresh.cursor.nextAt, NOW + 180_000);

  // A paid effect two minutes old no longer blocks the slot.
  const stale = new AutoRotation({ config, activities: () => catalog, cursor: { slot: 1, nextAt: NOW } });
  assert.equal((await stale.tick({ now: NOW, lastPaidAt: NOW - 120_000, run: async () => "ok" })).kind, "ran");
});

test("a failed command is reported and does not retry the same slot", async () => {
  const rotation = new AutoRotation({ config, activities: () => catalog, cursor: { slot: 0, nextAt: NOW } });
  const failed = await rotation.tick({
    now: NOW,
    run: async () => {
      throw new Error("rcon timeout");
    },
  });

  if (failed.kind !== "failed") assert.fail(`expected a failure, got ${failed.kind}`);
  assert.match(failed.error, /rcon timeout/u);
  assert.equal(rotation.cursor.slot, 1);
});

test("a map duel owns the screen: the slot is spent, not fired late", async () => {
  const rotation = new AutoRotation({ config, activities: () => catalog, cursor: { slot: 1, nextAt: NOW } });
  const paused = await rotation.tick({
    now: NOW,
    pausedBy: "map_duel",
    run: async () => assert.fail("a free effect landed on the two finalists"),
  });

  if (paused.kind !== "paused") assert.fail(`expected a pause, got ${paused.kind}`);
  assert.equal(paused.reason, "map_duel");
  assert.equal(paused.code, "meteor_shower");
  // The slot is burned and the cadence restarts: the duel is a one-shot, and dumping the missed
  // effect the second it ends would look like the rotation is chasing the game.
  assert.equal(rotation.cursor.slot, 2);
  assert.equal(rotation.cursor.nextAt, NOW + 180_000);
});

test("the finale outranks a fresh donation", async () => {
  const rotation = new AutoRotation({ config, activities: () => catalog, cursor: { slot: 0, nextAt: NOW } });
  const paused = await rotation.tick({
    now: NOW,
    lastPaidAt: NOW - 5_000,
    pausedBy: "map_duel",
    run: async () => assert.fail("nothing may fire during the duel"),
  });

  assert.equal(paused.kind, "paused");
});

test("a free code may be off sale on purpose, and the rotation still runs it", () => {
  // `he_party` is 50 RUB like everything else, but it is the rotation's first slot, so it is kept out
  // of the paid pool instead of being sold and given away at the same time. The free clock looks the
  // code up in the catalogue, not in the on-sale subset: this assertion exists so the pair does not
  // get "fixed" by someone reading `enabled: false` as "never run this".
  const heParty = activityOf("he_party");
  assert.ok(heParty !== undefined);
  assert.equal(heParty.enabled, false, "the paid path must not sell the free hook");
  assert.equal(config.free[0], "he_party");
});

test("a quiet minute with no duel and no donation still fires", async () => {
  const rotation = new AutoRotation({ config, activities: () => catalog, cursor: { slot: 0, nextAt: NOW } });
  const ran = await rotation.tick({ now: NOW, pausedBy: null, lastPaidAt: null, run: async () => "ok" });
  assert.equal(ran.kind, "ran");
});

test("the rotation leaves out what is known not to work on the stream", () => {
  // `hex_wave` has no chicken model (`docs/activities/catalogue.md`), `fire_grenades` was measured as
  // "nobody burns" - YaPB bots never throw the HE the plugin puts in their hands - and `blink_bots`
  // teleports every bot, which in this project is measured as "3 kills in 90 s against 149 in 60 s"
  // (docs/runbook.md, bot_antistuck). The four sound codes stay out because the rotation is picture.
  for (const code of [
    "hex_wave",
    "fire_grenades",
    "blink_bots",
    "announcer_countdown",
    "quotes_pack",
    "siren",
    "music_swap",
  ]) {
    assert.equal(config.free.includes(code), false, `${code} must not be in the free rotation`);
  }
});

test("a disabled rotation shows nothing and fires nothing", async () => {
  const off = parseAutoEvents(
    { version: 1, enabled: false, intervalSec: 180, quietAfterPaidSec: 60, free: [], chaos: [] },
    catalog,
  );
  const rotation = new AutoRotation({ config: off, activities: () => catalog, cursor: { slot: 0, nextAt: NOW } });

  assert.equal(rotation.next(NOW), null);
  assert.equal((await rotation.tick({ now: NOW, run: async () => "ok" })).kind, "idle");
});
