import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActivities } from "../src/activities.ts";
import type { StoredDonation } from "../src/db.ts";
import { HEADER, MAX_LINE_CHARS, buildOverlay, clean, writeOverlay } from "../src/overlay.ts";

/**
 * The overlay is the only place a viewer sees their own money working, so the text is pinned:
 * always three lines, always short enough for a 720 px wide frame, and never able to break the
 * encoder (drawtext expands `%` even in file content).
 */
const catalog = loadActivities(new URL("../config/activities.json", import.meta.url));
const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function donation(overrides: Partial<StoredDonation> = {}): StoredDonation {
  return {
    id: 1,
    username: "Vasya",
    amount: 130,
    currency: "RUB",
    status: "applied",
    activityCode: "glass_cannon",
    receivedAt: new Date(NOW).toISOString(),
    source: "da",
    ...overrides,
  };
}

test("without donations the overlay invites the first one and lists the cheapest options", () => {
  const overlay = buildOverlay({ recent: [], catalog, now: NOW });

  assert.equal(overlay.lines.length, 4);
  assert.equal(overlay.lines[0], HEADER);
  assert.equal(overlay.lines[1], "NO DONATIONS YET - BE THE FIRST");
  assert.equal(overlay.lines[2], "");
  assert.match(overlay.lines[3] ?? "", /^NEXT: 50 1000 HP CANNON \\| 50 LIGHTSABER DUEL$/);
  assert.equal(overlay.text, overlay.lines.join("\n"));
});

test("the last donation is shown with its amount, and what it bought on its own line", () => {
  const overlay = buildOverlay({ recent: [donation()], catalog, now: NOW });

  assert.equal(overlay.lines[1], "LAST: Vasya 130 RUB");
  assert.equal(overlay.lines[2], "ВЫПАЛО: ПУШКА");
});

test("a batch keeps every name: one strip could hold only the first one", () => {
  const overlay = buildOverlay({
    recent: [donation({ activityCode: "glass_cannon+he_party" })],
    catalog,
    now: NOW,
  });
  assert.equal(overlay.lines[2], "ВЫПАЛО: ПУШКА, HE PARTY");
});

test("a queued donation is marked as waiting, not as applied", () => {
  const overlay = buildOverlay({ recent: [donation({ status: "queued", activityCode: "meteor_shower" })], catalog, now: NOW });

  assert.equal(overlay.lines[1], "LAST: WAITING Vasya 130 RUB");
  assert.equal(overlay.lines[2], "ВЫПАЛО: МЕТЕОР");
});

test("the queue depth replaces the menu headline", () => {
  const overlay = buildOverlay({
    recent: [donation()],
    catalog,
    pending: [
      { donationId: 2, username: "B", amount: 90, source: "da", activityCode: "moon_gravity", command: "amx_de moon_gravity gravity=200", reason: "donor_cooldown", enqueuedAt: NOW, dueAt: NOW + 1000 },
    ],
    now: NOW,
  });

  assert.match(overlay.lines[3] ?? "", /^QUEUE: 1 \| 50 1000 HP CANNON/);
});

test("an activity that left the catalogue falls back to a generic label", () => {
  const overlay = buildOverlay({ recent: [donation({ activityCode: "removed" })], catalog, now: NOW });
  assert.equal(overlay.lines[1], "LAST: Vasya 130 RUB");
  assert.equal(overlay.lines[2], "ВЫПАЛО: QUEUED");
});

test("long names are clipped so the line fits the frame", () => {
  const overlay = buildOverlay({ recent: [donation({ username: "x".repeat(80) })], catalog, now: NOW });
  for (const line of overlay.lines) {
    assert.ok(line.length <= MAX_LINE_CHARS, `line too long: ${line.length} chars`);
  }
});

test("drawtext expansion characters are stripped, even from a nickname", () => {
  assert.equal(clean("100% \\ {pts}"), "100 {pts}");
  const overlay = buildOverlay({ recent: [donation({ username: "%%{pts:100}" })], catalog, now: NOW });
  assert.equal(overlay.text.includes("%"), false, "no percent sign may reach drawtext");
});

test("writing the overlay produces the text file and the json, atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "overlay-"));
  const overlay = buildOverlay({ recent: [donation()], catalog, now: NOW });

  writeOverlay(dir, overlay);

  assert.equal(readFileSync(join(dir, "overlay.txt"), "utf8"), `${overlay.text}\n`);
  const parsed: unknown = JSON.parse(readFileSync(join(dir, "overlay.json"), "utf8"));
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(overlay)));
});
