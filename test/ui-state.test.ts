import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActivities } from "../src/activities.ts";
import type { StoredDonation } from "../src/db.ts";
import { buildOverlay } from "../src/overlay.ts";
import type { PendingActivity } from "../src/queue.ts";
import { buildUiState, themeFor, uiSignature } from "../src/ui/state.ts";

/**
 * The panel is what a viewer actually reads, so the state is pinned: the donation lines come from
 * the same function that feeds the text fallback, a missing score is null (never a fake 0 : 0), and
 * the change signature ignores the clock so an idle server does not re-render 5 times a second.
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));
const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function donation(overrides: Partial<StoredDonation> = {}): StoredDonation {
  return {
    id: 7,
    username: "Vasya",
    amount: 130,
    currency: "RUB",
    status: "applied",
    activityCode: "bot_rain",
    receivedAt: new Date(NOW).toISOString(),
    source: "da",
    ...overrides,
  };
}

function pending(count: number): PendingActivity[] {
  return Array.from({ length: count }, (_, index) => ({
    donationId: 100 + index,
    username: "Vasya",
    amount: 60,
    source: "da" as const,
    activityCode: "knives_only",
    command: "amx_de knives_only",
    reason: "cooldown",
    enqueuedAt: NOW,
    dueAt: NOW + 30_000,
  }));
}

test("the panel repeats the donation lines the text fallback already owns", () => {
  const recent = [donation()];
  const overlay = buildOverlay({ recent, catalog, pending: pending(2), now: NOW });
  const state = buildUiState({ score: null, recent, catalog, pending: pending(2), now: NOW });

  assert.equal(state.donation, overlay.lines[1]);
  assert.equal(state.menu, overlay.lines[2]);
  assert.equal(state.queueSize, 2);
});

test("no score yet stays null instead of showing 0 : 0", () => {
  const state = buildUiState({ score: null, recent: [], catalog, now: NOW });
  assert.equal(state.score, null);
  assert.equal(state.target, null);
  assert.equal(state.stale, false);
});

test("the score and the target travel through untouched", () => {
  const state = buildUiState({
    score: { t: 12, ct: 9, topT: "Smith 7", topCt: "Neo 5" },
    target: { name: "Smith", hp: 87, armor: 42 },
    recent: [],
    catalog,
    now: NOW,
    stale: true,
  });

  assert.deepEqual(state.score, { t: 12, ct: 9, topT: "Smith 7", topCt: "Neo 5" });
  assert.deepEqual(state.target, { name: "Smith", hp: 87, armor: 42 });
  assert.equal(state.stale, true);
});

test("the theme follows the paid activity and nothing else", () => {
  assert.equal(themeFor(null), "default");
  assert.equal(themeFor("chaos_burst"), "chaos");
  assert.equal(themeFor("moon_gravity"), "chaos");
  assert.equal(themeFor("bounty"), "fight");
  assert.equal(themeFor("boss_raid"), "fight");
  assert.equal(themeFor("bot_rain"), "event");
  assert.equal(themeFor("bot_nick"), "default");
  // An override file may add codes: an unknown one must not throw.
  assert.equal(themeFor("some_new_activity"), "default");

  const withActivity = buildUiState({ score: null, recent: [donation({ activityCode: "bounty" })], catalog, now: NOW });
  assert.equal(withActivity.theme, "fight");
  assert.equal(withActivity.activityCode, "bounty");
});

test("the winner of the duel reaches the picture and leaves with the map", () => {
  const base = buildUiState({ score: { t: 1, ct: 2, topT: "", topCt: "" }, recent: [], catalog, now: NOW });
  assert.equal(base.winner, "", "a map without a duel shows no winner");

  const won = buildUiState({
    score: { t: 1, ct: 2, topT: "", topCt: "" },
    winner: "Mr Smith",
    recent: [],
    catalog,
    now: NOW,
  });
  assert.equal(won.winner, "Mr Smith");
  // The panel only re-renders on a changed signature: the winner has to be part of it.
  assert.notEqual(uiSignature(base), uiSignature(won), "the winner never reaches the picture");
});

test("the change signature ignores the clock and follows the numbers", () => {
  const first = buildUiState({ score: { t: 1, ct: 2, topT: "", topCt: "" }, recent: [], catalog, now: NOW });
  const later = buildUiState({
    score: { t: 1, ct: 2, topT: "", topCt: "" },
    recent: [],
    catalog,
    now: NOW + 60_000,
  });

  assert.equal(uiSignature(first), uiSignature(later), "a new timestamp must not force a re-render");

  const scored = buildUiState({ score: { t: 1, ct: 3, topT: "", topCt: "" }, recent: [], catalog, now: NOW });
  assert.notEqual(uiSignature(first), uiSignature(scored), "a new frag must reach the picture");

  const queued = buildUiState({
    score: { t: 1, ct: 2, topT: "", topCt: "" },
    recent: [],
    catalog,
    pending: pending(1),
    now: NOW,
  });
  assert.notEqual(uiSignature(first), uiSignature(queued), "a new queue entry must reach the picture");
});
