import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import type { StoredDonation } from "../src/db.ts";

function donation(overrides: Partial<StoredDonation> = {}): StoredDonation {
  return {
    id: 1,
    username: "vasya",
    amount: 50,
    currency: "RUB",
    status: "applied",
    activityCode: "bot_nick",
    receivedAt: "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
}

test("the same donation id is stored only once", () => {
  const store = new Store(":memory:");
  try {
    assert.equal(store.record(donation()), true);
    assert.equal(store.record(donation({ username: "other", amount: 999 })), false, "duplicate delivery is ignored");
    assert.equal(store.has(1), true);
    assert.equal(store.recent().length, 1);
  } finally {
    store.close();
  }
});

test("polling cursor survives a restart", () => {
  const store = new Store(":memory:");
  try {
    assert.equal(store.getLastSeenId(), 0);
    store.setLastSeenId(4242);
    assert.equal(store.getLastSeenId(), 4242);
    store.setLastSeenId(4300);
    assert.equal(store.getLastSeenId(), 4300, "upsert replaces the previous cursor");
  } finally {
    store.close();
  }
});

test("cooldown facts come from applied rows only", () => {
  const store = new Store(":memory:");
  try {
    store.record(donation({ id: 1, receivedAt: "2026-01-01T12:00:00.000Z" }));
    store.record(donation({ id: 2, status: "rejected", reason: "below_minimum", activityCode: null, receivedAt: "2026-01-01T12:05:00.000Z" }));
    store.record(donation({ id: 3, status: "cooldown", reason: "donor_cooldown", receivedAt: "2026-01-01T12:06:00.000Z" }));

    assert.equal(store.lastAppliedByDonor("vasya"), "2026-01-01T12:00:00.000Z");
    assert.equal(store.lastAppliedByDonor("nobody"), null);
    assert.equal(store.lastAppliedByActivity("bot_nick"), "2026-01-01T12:00:00.000Z");
    assert.equal(store.lastAppliedByActivity("map_change"), null);
  } finally {
    store.close();
  }
});

test("recent donations come back newest first with their verdict", () => {
  const store = new Store(":memory:");
  try {
    store.record(donation({ id: 1, receivedAt: "2026-01-01T12:00:00.000Z" }));
    store.record(donation({ id: 2, receivedAt: "2026-01-01T12:01:00.000Z", activityCode: "knives_only" }));

    const rows = store.recent();
    assert.deepEqual(rows.map((row) => row.id), [2, 1]);
    assert.equal(rows[0]?.activityCode, "knives_only");
    assert.equal(rows[0]?.status, "applied");
  } finally {
    store.close();
  }
});

test("a store can be reopened on the same file", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cs16-db-"));
  const file = join(dir, "nested", "history.db");

  const first = new Store(file);
  first.record(donation());
  first.setLastSeenId(7);
  first.close();

  const second = new Store(file);
  try {
    assert.equal(second.getLastSeenId(), 7);
    assert.equal(second.has(1), true, "rows are persisted and the parent directory is created");
  } finally {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
