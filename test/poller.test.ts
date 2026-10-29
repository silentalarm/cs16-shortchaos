import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities } from "../src/activities.ts";
import type { ActivitiesConfig, Activity, ParamValue } from "../src/activities.ts";
import { Store } from "../src/db.ts";
import type { DonationRow } from "../src/db.ts";
import { drainQueue, pollOnce, restoreQueue } from "../src/poller.ts";
import { PendingQueue } from "../src/queue.ts";

/**
 * One poll pass: fetch, dedup, price the donation in 50 RUB steps, respect cooldowns, send through
 * RCON, keep the verdict. The shipped catalogue sells one effect (HE party), so a step is always
 * 60 seconds of grenades; the tests that need a second price step or an older effect patch the
 * catalogue instead of shipping dead entries.
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));
const START = Date.parse("2026-01-01T12:00:00.000Z");

type Patch = Partial<Pick<Activity, "enabled" | "price" | "cooldownSec" | "globalCooldownSec" | "duration" | "seconds">> & {
  params?: Record<string, ParamValue>;
};

/** The shipped catalogue with a few effects retimed or switched on for one test. */
function catalogWith(patches: Record<string, Patch>): ActivitiesConfig {
  return {
    ...catalog,
    activities: catalog.activities.map((activity) => {
      const patch = patches[activity.code];
      if (patch === undefined) return activity;
      return { ...activity, ...patch, params: { ...activity.params, ...(patch.params ?? {}) } };
    }),
  };
}

function donation(overrides: Partial<DonationRow> = {}): DonationRow {
  return { id: 1, username: "Vasya", amount: 50, currency: "RUB", message: null, createdAt: null, ...overrides };
}

function setup(
  options: { donations?: DonationRow[]; failApply?: boolean; catalog?: ActivitiesConfig; random?: () => number } = {},
) {
  const store = new Store(":memory:");
  const commands: string[] = [];
  const events: string[] = [];
  let now = START;
  let feed = options.donations ?? [];

  const deps = {
    store,
    catalog: options.catalog ?? catalog,
    // Pinned by default: a test should say which effect it expects, not hope for one.
    random: options.random ?? (() => 0),
    fetchDonations: async (cursor: number) => feed.filter((row) => row.id > cursor),
    apply: async (command: string) => {
      if (options.failApply) throw new Error("RCON command timed out after 5000 ms");
      commands.push(command);
      return "L 01/01/2026 - 12:00:00: ok";
    },
    now: () => now,
    log: (event: string) => {
      events.push(event);
    },
  };

  return {
    store,
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
test("50 RUB buys one grenade party and the donation is stored as applied", async () => {
  const ctx = setup({ donations: [donation({ username: "Вася" })] });
  try {
    const summary = await pollOnce(ctx.deps);
    assert.equal(summary.applied, 1);
    assert.deepEqual(ctx.commands, ["amx_de he_party seconds=60 nick=vasya"]);

    const [row] = ctx.store.recent();
    assert.ok(row);
    assert.equal(row.status, "applied");
    assert.equal(row.activityCode, "he_party");
    assert.equal(row.receivedAt, new Date(START).toISOString());
  } finally {
    ctx.store.close();
  }
});

test("every extra 50 RUB lengthens the effect instead of sending a second command", async () => {
  const ctx = setup({ donations: [donation({ id: 1, amount: 150, username: "Вася" })] });
  try {
    await pollOnce(ctx.deps);
    assert.deepEqual(ctx.commands, ["amx_de he_party seconds=180 nick=vasya"]);
  } finally {
    ctx.store.close();
  }
});

test("money that does not fill a whole step buys nothing extra", async () => {
  const ctx = setup({ donations: [donation({ id: 1, amount: 99 })] });
  try {
    await pollOnce(ctx.deps);
    assert.deepEqual(ctx.commands, ["amx_de he_party seconds=60 nick=vasya"]);
    assert.equal(ctx.store.recent()[0]?.amount, 99, "the row keeps what the viewer actually paid");
  } finally {
    ctx.store.close();
  }
});

test("a donation below 50 RUB is recorded as rejected and never reaches the server", async () => {
  const ctx = setup({ donations: [donation({ amount: 49, username: "Cheap" })] });
  try {
    const summary = await pollOnce(ctx.deps);
    assert.equal(summary.rejected, 1);
    assert.deepEqual(ctx.commands, []);
    const [row] = ctx.store.recent();
    assert.equal(row?.status, "rejected");
    assert.equal(row?.reason, "below_minimum");
  } finally {
    ctx.store.close();
  }
});

test("a foreign donation is converted into steps, and the row keeps what was paid", async () => {
  // 2 USD = 180 RUB = three steps = 180 seconds of grenades.
  const ctx = setup({ donations: [donation({ amount: 2, currency: "USD" })] });
  try {
    const summary = await pollOnce(ctx.deps);
    assert.equal(summary.applied, 1);
    assert.deepEqual(ctx.commands, ["amx_de he_party seconds=180 nick=vasya"]);
    const [row] = ctx.store.recent();
    assert.equal(row?.activityCode, "he_party");
    // The row keeps what the viewer paid, so the panel can explain the conversion.
    assert.equal(row?.amount, 2);
    assert.equal(row?.currency, "USD");
  } finally {
    ctx.store.close();
  }
});
test("a phrase-carrying effect still gets the viewer's own text", async () => {
  const ctx = setup({
    catalog: catalogWith({
      he_party: { enabled: false },
      bot_phrase: { enabled: true, price: 50, cooldownSec: 0 },
    }),
    donations: [donation({ amount: 65, message: "Привет, как дела?" })],
  });
  try {
    await pollOnce(ctx.deps);
    // Underscores instead of spaces: the phrase has to stay a single RCON token.
    assert.deepEqual(ctx.commands, ["amx_de bot_phrase text=privet_kak_dela"]);
  } finally {
    ctx.store.close();
  }
});

test("an effect that accepts a nickname gets the sanitized buyer name", async () => {
  const ctx = setup({
    catalog: catalogWith({
      he_party: { enabled: false },
      bless_bot: { enabled: true, price: 50, cooldownSec: 0 },
    }),
    donations: [donation({ amount: 55, username: "Вася" })],
  });
  try {
    await pollOnce(ctx.deps);
    assert.deepEqual(ctx.commands, ["amx_de bless_bot health=250 weapon=weapon_deagle nick=vasya"]);
  } finally {
    ctx.store.close();
  }
});

test("the same donation id delivered twice is applied once", async () => {
  const ctx = setup({ donations: [donation({ id: 7 }), donation({ id: 7 })] });
  try {
    const summary = await pollOnce(ctx.deps);
    assert.equal(summary.applied, 1);
    assert.equal(summary.duplicates, 1);
    assert.equal(ctx.commands.length, 1);
  } finally {
    ctx.store.close();
  }
});

test("the same donor is rate limited for 60 seconds", async () => {
  const ctx = setup({
    catalog: catalogWith({ he_party: { cooldownSec: 60 } }),
    donations: [donation({ id: 1, amount: 50 }), donation({ id: 2, amount: 100 })],
  });
  try {
    const summary = await pollOnce(ctx.deps);
    assert.equal(summary.applied, 1);
    assert.equal(summary.cooled, 1);
    assert.deepEqual(ctx.commands, ["amx_de he_party seconds=60 nick=vasya"]);

    const rows = ctx.store.recent();
    assert.equal(rows[0]?.status, "cooldown");
    assert.equal(rows[0]?.reason, "donor_cooldown:60s");

    ctx.setFeed([donation({ id: 3, amount: 100 })]);
    ctx.advance(61_000);
    const second = await pollOnce(ctx.deps);
    assert.equal(second.applied, 1);
    assert.deepEqual(ctx.commands, ["amx_de he_party seconds=60 nick=vasya", "amx_de he_party seconds=120 nick=vasya"]);
  } finally {
    ctx.store.close();
  }
});

test("an effect with a global cooldown is limited to once per window", async () => {
  const ctx = setup({
    catalog: catalogWith({ he_party: { enabled: false }, map_change: { enabled: true, price: 50 } }),
    donations: [donation({ id: 1, username: "A", amount: 50 })],
  });
  try {
    await pollOnce(ctx.deps);
    assert.deepEqual(ctx.commands, [
      "amx_de map_change maps=fy_iceworld,fy_pool_day,fy_snow,fy_buzzkill,fy_simpsons,fy_aztec,fy_dustworld",
    ]);

    ctx.advance(60_000);
    ctx.setFeed([donation({ id: 2, username: "B", amount: 50 })]);
    const second = await pollOnce(ctx.deps);
    assert.equal(second.cooled, 1);
    assert.equal(ctx.store.recent()[0]?.reason, "activity_cooldown:540s");

    ctx.advance(540_000);
    ctx.setFeed([donation({ id: 3, username: "C", amount: 50 })]);
    const third = await pollOnce(ctx.deps);
    assert.equal(third.applied, 1);
    assert.equal(ctx.commands.length, 2);
  } finally {
    ctx.store.close();
  }
});
test("an rcon failure is recorded and does not stop the poll", async () => {
  const ctx = setup({ donations: [donation({ id: 1 })], failApply: true });
  try {
    const summary = await pollOnce(ctx.deps);
    assert.equal(summary.failed, 1);
    const [row] = ctx.store.recent();
    assert.equal(row?.status, "failed");
    assert.match(row?.reason ?? "", /RCON command timed out/);
    assert.equal(ctx.store.getLastSeenId(), 1, "the cursor still advances, the failed donation is not retried forever");
  } finally {
    ctx.store.close();
  }
});

test("after a poll the cursor lets the next poll skip processed donations", async () => {
  const ctx = setup({ donations: [donation({ id: 5 })] });
  try {
    await pollOnce(ctx.deps);
    assert.equal(ctx.store.getLastSeenId(), 5);
    const second = await pollOnce(ctx.deps);
    assert.equal(second.seen, 0);
    assert.equal(ctx.commands.length, 1);
  } finally {
    ctx.store.close();
  }
});

test("donations are processed oldest first even if the api returns them unsorted", async () => {
  const ctx = setup({
    donations: [donation({ id: 9, username: "B", amount: 90 }), donation({ id: 8, username: "A", amount: 60 })],
  });
  try {
    await pollOnce(ctx.deps);
    assert.deepEqual(ctx.commands, [
      "amx_de he_party seconds=60 nick=a",
      "amx_de he_party seconds=60 nick=b",
    ]);
  } finally {
    ctx.store.close();
  }
});

test("a restart restores the paid donations that were still waiting in SQLite", async () => {
  const store = new Store(":memory:");
  try {
    const queue = new PendingQueue();
    const commands: string[] = [];
    // An hour of downtime, but the entry itself waited only a minute: still worth applying.
    const now = START + 60 * 60_000;
    const deps = {
      store,
      catalog,
      apply: async (command: string) => {
        commands.push(command);
        return "ok";
      },
      queue,
      now: () => now,
      log: () => {},
    };

    store.record({
      id: 40,
      username: "Вася",
      amount: 100,
      currency: "RUB",
      status: "queued",
      activityCode: "awp_only",
      reason: "donor_cooldown:60s",
      receivedAt: new Date(now - 60_000).toISOString(),
      source: "da",
    });
    // A verdict that already ran is not restored: only `queued` means "paid, nothing happened yet".
    store.record({
      id: 41,
      username: "Petr",
      amount: 250,
      currency: "RUB",
      status: "applied",
      activityCode: "map_change",
      receivedAt: new Date(now - 120_000).toISOString(),
      source: "da",
    });

    assert.equal(restoreQueue(deps, now), 1, "exactly the queued row is restored");
    assert.equal(queue.size, 1);

    const drained = await drainQueue(deps, now);
    assert.equal(drained.applied, 1);
    assert.deepEqual(commands, ["amx_de awp_only"]);
    assert.equal(store.recent().find((row) => row.id === 40)?.status, "applied");
  } finally {
    store.close();
  }
});

test("a restored entry that waited out the queue window expires instead of firing hours late", async () => {
  const store = new Store(":memory:");
  try {
    const queue = new PendingQueue();
    const now = START + 60 * 60_000;
    const deps = { store, catalog, apply: async () => "ok", queue, now: () => now, log: () => {} };

    store.record({
      id: 42,
      username: "Old",
      amount: 250,
      currency: "RUB",
      status: "queued",
      activityCode: "map_change",
      reason: "activity_cooldown:540s",
      // Older than the queue's maxWaitMs: the map change is worthless by now.
      receivedAt: new Date(now - 60 * 60_000).toISOString(),
      source: "da",
    });

    assert.equal(restoreQueue(deps, now), 1);
    const drained = await drainQueue(deps, now);
    assert.equal(drained.expired, 1);
    assert.equal(drained.applied, 0);
    assert.equal(store.recent()[0]?.status, "expired");
  } finally {
    store.close();
  }
});
