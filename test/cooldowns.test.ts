import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCooldown, msFromIso } from "../src/cooldowns.ts";
import type { Activity } from "../src/activities.ts";

const activity = { code: "knives_only", cooldownSec: 60, globalCooldownSec: 0 } as Pick<
  Activity,
  "code" | "cooldownSec" | "globalCooldownSec"
>;
const mapChange = { code: "map_change", cooldownSec: 60, globalCooldownSec: 600 } as Pick<
  Activity,
  "code" | "cooldownSec" | "globalCooldownSec"
>;

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

test("first donation is always allowed", () => {
  assert.deepEqual(checkCooldown({ activity, now: NOW, lastAppliedByDonor: null, lastAppliedByActivity: null }), {
    allowed: true,
  });
});

test("donor cooldown blocks for 60 seconds and reports the remaining time", () => {
  const verdict = checkCooldown({
    activity,
    now: NOW,
    lastAppliedByDonor: NOW - 45_200,
    lastAppliedByActivity: null,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false && verdict.reason, "donor_cooldown");
  assert.equal(verdict.allowed === false && verdict.retryAfterSec, 15);
});

test("donor cooldown expires exactly at the boundary", () => {
  assert.deepEqual(
    checkCooldown({ activity, now: NOW, lastAppliedByDonor: NOW - 60_000, lastAppliedByActivity: null }),
    { allowed: true },
  );
  assert.equal(
    checkCooldown({ activity, now: NOW, lastAppliedByDonor: NOW - 59_000, lastAppliedByActivity: null }).allowed,
    false,
  );
});

test("map change is limited globally, not per donor", () => {
  const verdict = checkCooldown({
    activity: mapChange,
    now: NOW,
    lastAppliedByDonor: null,
    lastAppliedByActivity: NOW - 9 * 60_000,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false && verdict.reason, "activity_cooldown");
  assert.equal(verdict.allowed === false && verdict.retryAfterSec, 60);

  assert.deepEqual(
    checkCooldown({ activity: mapChange, now: NOW, lastAppliedByDonor: null, lastAppliedByActivity: NOW - 600_000 }),
    { allowed: true },
  );
});

test("donor cooldown is checked before the activity cooldown", () => {
  const verdict = checkCooldown({
    activity: mapChange,
    now: NOW,
    lastAppliedByDonor: NOW - 1_000,
    lastAppliedByActivity: NOW - 1_000,
  });
  assert.equal(verdict.allowed === false && verdict.reason, "donor_cooldown");
});

test("clock skew in the future does not block forever", () => {
  const verdict = checkCooldown({
    activity,
    now: NOW,
    lastAppliedByDonor: NOW + 30_000,
    lastAppliedByActivity: null,
  });
  assert.equal(verdict.allowed, false, "a future timestamp keeps the donor on cooldown");
  assert.equal(verdict.allowed === false && verdict.retryAfterSec, 60);
});

test("zero cooldown never blocks", () => {
  const free = { code: "free", cooldownSec: 0, globalCooldownSec: 0 } as Pick<
    Activity,
    "code" | "cooldownSec" | "globalCooldownSec"
  >;
  assert.deepEqual(
    checkCooldown({ activity: free, now: NOW, lastAppliedByDonor: NOW - 1, lastAppliedByActivity: NOW - 1 }),
    { allowed: true },
  );
});

test("iso parsing tolerates null and garbage", () => {
  assert.equal(msFromIso(null), null);
  assert.equal(msFromIso("not a date"), null);
  assert.equal(msFromIso("2026-01-01T12:00:00.000Z"), NOW);
});
