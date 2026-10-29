import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities } from "../src/activities.ts";
import { Store } from "../src/db.ts";
import type { DonationRow } from "../src/db.ts";
import { processDonation } from "../src/poller.ts";

/**
 * The admin panel injects fake donations through processDonation: these tests pin the three
 * properties that make that safe — the verdict is the real one, the poll cursor never moves, and
 * the rows are marked so they can be deleted without touching real history.
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));
const START = Date.parse("2026-01-01T12:00:00.000Z");

function simDonation(overrides: Partial<DonationRow> = {}): DonationRow {
  return { id: -START, username: "TestDonor", amount: 60, currency: "RUB", message: null, createdAt: null, ...overrides };
}

function setup(options: { catalog?: typeof catalog } = {}) {
  const store = new Store(":memory:");
  const commands: string[] = [];
  let now = START;

  const deps = {
    store,
    catalog: options.catalog ?? catalog,
    random: () => 0,
    apply: async (command: string) => {
      commands.push(command);
      return "L 01/01/2026 - 12:00:00: queued";
    },
    now: () => now,
  };

  return {
    store,
    commands,
    deps,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("a simulated 40 RUB donation is rejected exactly like a real one", async () => {
  const ctx = setup();
  try {
    const outcome = await processDonation(ctx.deps, simDonation({ amount: 40 }), { advanceCursor: false, source: "sim" });
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason, "below_minimum");
    assert.deepEqual(ctx.commands, []);

    const [row] = ctx.store.recent();
    assert.equal(row?.source, "sim");
    assert.equal(row?.status, "rejected");
  } finally {
    ctx.store.close();
  }
});

test("a simulated 60 RUB donation buys one grenade party, exactly like a real donation", async () => {
  const ctx = setup();
  try {
    const outcome = await processDonation(ctx.deps, simDonation({ amount: 60 }), { advanceCursor: false, source: "sim" });
    assert.equal(outcome.status, "applied");
    assert.equal(outcome.activityCode, "he_party");
    assert.equal(outcome.command, "amx_de he_party seconds=60 nick=testdonor");
    assert.deepEqual(ctx.commands, ["amx_de he_party seconds=60 nick=testdonor"]);
  } finally {
    ctx.store.close();
  }
});

test("a simulation never moves the DonationAlerts cursor", async () => {
  const ctx = setup();
  try {
    ctx.store.setLastSeenId(4242);
    await processDonation(ctx.deps, simDonation({ id: -9_999 }), { advanceCursor: false, source: "sim" });
    assert.equal(ctx.store.getLastSeenId(), 4242);
  } finally {
    ctx.store.close();
  }
});

test("a simulated donation consumes the cooldown unless the bypass flag is set", async () => {
  // The shipped HE party has no cooldown on purpose, so the window is switched on for this test.
  const patched = {
    ...catalog,
    activities: catalog.activities.map((activity) =>
      activity.code === "he_party" ? { ...activity, cooldownSec: 60 } : activity,
    ),
  };
  const ctx = setup({ catalog: patched });
  try {
    const first = await processDonation(ctx.deps, simDonation({ id: -1 }), { advanceCursor: false, source: "sim" });
    assert.equal(first.status, "applied");

    const second = await processDonation(ctx.deps, simDonation({ id: -2 }), { advanceCursor: false, source: "sim" });
    assert.equal(second.status, "cooldown");
    assert.match(second.reason ?? "", /^donor_cooldown:\d+s$/);

    const bypassed = await processDonation(ctx.deps, simDonation({ id: -3 }), {
      advanceCursor: false,
      source: "sim",
      bypassCooldown: true,
    });
    assert.equal(bypassed.status, "applied");
  } finally {
    ctx.store.close();
  }
});

test("resetSim drops simulated rows and keeps real donations", async () => {
  const ctx = setup();
  try {
    await processDonation(ctx.deps, simDonation({ id: 500, username: "Vasya" }), { advanceCursor: true, source: "da" });
    await processDonation(ctx.deps, simDonation({ id: -1, username: "Debug" }), { advanceCursor: false, source: "sim" });

    const deleted = ctx.store.resetSim();
    assert.equal(deleted, 1);

    const rows = ctx.store.recent();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.username, "Vasya");
    assert.equal(rows[0]?.source, "da");
  } finally {
    ctx.store.close();
  }
});

test("the same simulated id twice is reported as a duplicate, not applied again", async () => {
  const ctx = setup();
  try {
    await processDonation(ctx.deps, simDonation({ id: -1 }), { advanceCursor: false, source: "sim" });
    const again = await processDonation(ctx.deps, simDonation({ id: -1 }), { advanceCursor: false, source: "sim" });
    assert.equal(again.status, "duplicate");
    assert.equal(ctx.commands.length, 1);
  } finally {
    ctx.store.close();
  }
});
