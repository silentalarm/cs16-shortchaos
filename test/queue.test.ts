import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities } from "../src/activities.ts";
import { Store } from "../src/db.ts";
import type { DonationRow } from "../src/db.ts";
import { drainQueue, pollOnce } from "../src/poller.ts";
import { PendingQueue } from "../src/queue.ts";

/**
 * A donation that hits a cooldown is paid money: it waits for its window instead of being
 * rejected. These tests pin the three things that make that safe — the wait is bounded, the
 * command is the one the viewer paid for, and the row ends up `applied` exactly once.
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));
const START = Date.parse("2026-01-01T12:00:00.000Z");

function donation(overrides: Partial<DonationRow> = {}): DonationRow {
  return { id: 1, username: "Vasya", amount: 75, currency: "RUB", message: null, createdAt: null, ...overrides };
}

function setup() {
  const store = new Store(":memory:");
  const queue = new PendingQueue();
  const commands: string[] = [];
  const events: string[] = [];
  let now = START;
  let feed: DonationRow[] = [];

  const deps = {
    store,
    catalog,
    queue,
    fetchDonations: async (cursor: number) => feed.filter((row) => row.id > cursor),
    apply: async (command: string) => {
      commands.push(command);
      return "L 01/01/2026 - 12:00:00: queued";
    },
    now: () => now,
    log: (event: string) => {
      events.push(event);
    },
  };

  return {
    store,
    queue,
    commands,
    events,
    deps,
    setFeed(next: DonationRow[]) {
      feed = next;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

function entry(donationId: number, dueAt: number, overrides: Partial<Parameters<PendingQueue["add"]>[0]> = {}) {
  return {
    donationId,
    username: "A",
    amount: 75,
    source: "da" as const,
    activityCode: "knives_only",
    command: "amx_de knives_only",
    reason: "donor_cooldown",
    enqueuedAt: START,
    dueAt,
    ...overrides,
  };
}

test("the queue hands out entries only when their due time has come", () => {
  const queue = new PendingQueue();
  queue.add(entry(1, START + 60_000));

  assert.equal(queue.due(START + 59_999).ready.length, 0);
  assert.equal(queue.due(START + 60_000).ready.length, 1);
});

test("ready entries are ordered by due time and a taken entry never comes back", () => {
  const queue = new PendingQueue();
  queue.add(entry(2, START + 120_000));
  queue.add(entry(1, START + 60_000));

  const ready = queue.due(START + 300_000).ready;
  assert.deepEqual(ready.map((item) => item.donationId), [1, 2]);

  assert.ok(queue.take(1));
  assert.equal(queue.take(1), null);
  assert.equal(queue.size, 1);
});

test("an entry that waited too long expires instead of running late", () => {
  const queue = new PendingQueue({ maxWaitMs: 60_000 });
  queue.add(entry(1, START + 30_000));

  const result = queue.due(START + 60_001);
  assert.equal(result.ready.length, 0);
  assert.deepEqual(result.expired.map((item) => item.donationId), [1]);
  assert.equal(queue.size, 0, "an expired entry is removed, not retried");
});

test("a full queue evicts the oldest entry so the newest donation is never dropped", () => {
  const queue = new PendingQueue({ maxEntries: 1 });

  assert.equal(queue.add(entry(1, START + 1_000)), null);
  const evicted = queue.add(entry(2, START + 1_000));
  assert.equal(evicted?.donationId, 1);
  assert.equal(queue.size, 1);
});

test("postponing keeps the entry in the queue with a later due time", () => {
  const queue = new PendingQueue();
  queue.add(entry(1, START + 60_000));

  assert.equal(queue.postpone(1, START + 120_000, "activity_cooldown"), true);
  assert.equal(queue.due(START + 90_000).ready.length, 0);
  assert.equal(queue.due(START + 120_000).ready.length, 1);
  assert.equal(queue.postpone(99, START, "donor_cooldown"), false);

test("a donation blocked by a cooldown is queued and applied later through the same command", async () => {
  const ctx = setup();
  try {
    ctx.setFeed([donation({ id: 1, amount: 75 }), donation({ id: 2, amount: 100 })]);
    const first = await pollOnce(ctx.deps);

    assert.equal(first.applied, 1);
    assert.equal(first.queued, 1);
    assert.deepEqual(ctx.commands, ["amx_de knives_only"]);
    assert.equal(ctx.queue.size, 1);

    const queuedRow = ctx.store.recent()[0];
    assert.equal(queuedRow?.status, "queued");
    assert.equal(queuedRow?.reason, "donor_cooldown:60s");

    // Nothing may run before the window opens.
    const early = await drainQueue(ctx.deps);
    assert.equal(early.applied, 0);
    assert.deepEqual(ctx.commands, ["amx_de knives_only"]);

    ctx.advance(60_000);
    const late = await drainQueue(ctx.deps);
    assert.equal(late.applied, 1);
    assert.deepEqual(ctx.commands, ["amx_de knives_only", "amx_de awp_only"]);
    assert.equal(ctx.queue.size, 0);

    const appliedRow = [...ctx.store.recent()].find((row) => row.id === 2);
    assert.equal(appliedRow?.status, "applied");
    assert.equal(appliedRow?.reason, null);
    assert.ok(ctx.events.includes("donation.dequeued"));
  } finally {
    ctx.store.close();
  }
});

test("a queued activity that is still cooling down globally waits instead of firing twice", async () => {
  const ctx = setup();
  try {
    // The same donor twice in a minute: the second one waits for the 60 s donor cooldown, which
    // runs out long before the 10 min global map_change cooldown.
    ctx.setFeed([
      donation({ id: 1, username: "A", amount: 250 }),
      donation({ id: 2, username: "A", amount: 250 }),
    ]);
    await pollOnce(ctx.deps);
    assert.equal(ctx.commands.length, 1);
    assert.equal(ctx.queue.size, 1);

    ctx.advance(60_000);
    const drain = await drainQueue(ctx.deps);
    assert.equal(drain.applied, 0, "map_change may not restart the map twice in ten minutes");
    assert.equal(drain.requeued, 1, "the entry goes back into the queue, it is not dropped");
    assert.equal(ctx.queue.size, 1);

    ctx.advance(540_000);
    const drained = await drainQueue(ctx.deps);
    assert.equal(drained.applied, 1);
    assert.equal(ctx.commands.length, 2);
  } finally {
    ctx.store.close();
  }
});

test("a queued entry for an activity that left the catalogue fails loudly, not silently", async () => {
  const ctx = setup();
  try {
    ctx.queue.add(entry(42, START, { activityCode: "removed_activity", command: "amx_de removed_activity" }));
    ctx.store.record({
      id: 42,
      username: "Vasya",
      amount: 75,
      currency: "RUB",
      status: "queued",
      activityCode: "removed_activity",
      receivedAt: new Date(START).toISOString(),
      source: "da",
    });

    const drained = await drainQueue(ctx.deps);
    assert.equal(drained.failed, 1);
    assert.deepEqual(ctx.commands, []);
    assert.equal(ctx.store.recent()[0]?.status, "failed");
    assert.equal(ctx.store.recent()[0]?.reason, "activity_disabled");
  } finally {
    ctx.store.close();
  }
});

test("without a queue a cooldown keeps the old reject-on-the-spot behaviour", async () => {
  const ctx = setup();
  try {
    const { queue: _omitted, ...withoutQueue } = ctx.deps;
    ctx.setFeed([donation({ id: 1, amount: 75 }), donation({ id: 2, amount: 100 })]);

    const summary = await pollOnce(withoutQueue);
    assert.equal(summary.applied, 1);
    assert.equal(summary.cooled, 1);
    assert.equal(summary.queued, 0);
    assert.equal(ctx.store.recent()[0]?.status, "cooldown");
  } finally {
    ctx.store.close();
  }
});

});
