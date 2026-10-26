import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities } from "../src/activities.ts";
import { Store } from "../src/db.ts";
import type { DonationRow } from "../src/db.ts";
import { pollOnce } from "../src/poller.ts";

const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));
const START = Date.parse("2026-01-01T12:00:00.000Z");

function donation(overrides: Partial<DonationRow> = {}): DonationRow {
  return { id: 1, username: "Vasya", amount: 50, currency: "RUB", message: null, createdAt: null, ...overrides };
}

function setup(options: { donations?: DonationRow[]; failApply?: boolean } = {}) {
  const store = new Store(":memory:");
  const commands: string[] = [];
  const events: string[] = [];
  let now = START;
  let feed = options.donations ?? [];

  const deps = {
    store,
    catalog,
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

test("50 RUB renames a bot and the donation is stored as applied", async () => {
  const ctx = setup({ donations: [donation({ username: "Вася" })] });
  try {
    const summary = await pollOnce(ctx.deps);
    assert.equal(summary.applied, 1);
    assert.deepEqual(ctx.commands, ["amx_de bot_nick nick=vasya"]);

    const [row] = ctx.store.recent();
    assert.ok(row);
    assert.equal(row.status, "applied");
    assert.equal(row.activityCode, "bot_nick");
    assert.equal(row.receivedAt, new Date(START).toISOString());
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

test("foreign currency is rejected, not converted", async () => {
  const ctx = setup({ donations: [donation({ amount: 500, currency: "USD" })] });
  try {
    await pollOnce(ctx.deps);
    assert.deepEqual(ctx.commands, []);
    assert.equal(ctx.store.recent()[0]?.reason, "unsupported_currency");
  } finally {
    ctx.store.close();
  }
});

test("the same donation id delivered twice is applied once", async () => {
  const ctx = setup({ donations: [donation({ id: 7 }), donation({ id: 7 })] });
  try {

test("the same donor is rate limited for 60 seconds", async () => {
  const ctx = setup({ donations: [donation({ id: 1, amount: 75 }), donation({ id: 2, amount: 100 })] });
  try {
    const summary = await pollOnce(ctx.deps);
    assert.equal(summary.applied, 1);
    assert.equal(summary.cooled, 1);
    assert.deepEqual(ctx.commands, ["amx_de knives_only"]);

    const rows = ctx.store.recent();
    assert.equal(rows[0]?.status, "cooldown");
    assert.equal(rows[0]?.reason, "donor_cooldown:60s");

    ctx.setFeed([donation({ id: 3, amount: 100 })]);
    ctx.advance(61_000);
    const second = await pollOnce(ctx.deps);
    assert.equal(second.applied, 1);
    assert.deepEqual(ctx.commands, ["amx_de knives_only", "amx_de awp_only"]);
  } finally {
    ctx.store.close();
  }
});

test("map change is limited globally to once per ten minutes", async () => {
  const ctx = setup({ donations: [donation({ id: 1, username: "A", amount: 250 })] });
  try {
    await pollOnce(ctx.deps);
    assert.deepEqual(ctx.commands, ["amx_de map_change maps=de_dust2,de_inferno,de_nuke,cs_italy,de_aztec"]);

    ctx.advance(60_000);
    ctx.setFeed([donation({ id: 2, username: "B", amount: 250 })]);
    const second = await pollOnce(ctx.deps);
    assert.equal(second.cooled, 1);
    assert.equal(ctx.store.recent()[0]?.reason, "activity_cooldown:540s");

    ctx.advance(540_000);
    ctx.setFeed([donation({ id: 3, username: "C", amount: 250 })]);
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
    assert.deepEqual(ctx.commands, ["amx_de meat_round health=1", "amx_de moon_gravity gravity=200"]);
  } finally {
    ctx.store.close();
  }
});

    const summary = await pollOnce(ctx.deps);
    assert.equal(summary.applied, 1);
    assert.equal(summary.duplicates, 1);
    assert.equal(ctx.commands.length, 1);
  } finally {
    ctx.store.close();
  }
});
