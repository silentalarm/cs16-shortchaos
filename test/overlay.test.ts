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

/** The menu is the two cheapest codes, ordered by price then code: derived here, so adding an event
 *  alphabetically earlier does not break a test about the line format. */
function cheapestMenu(count = 2): string {
  return catalog.activities
    .filter((activity) => activity.enabled)
    .sort((left, right) => left.price - right.price || left.code.localeCompare(right.code))
    .slice(0, count)
    .map((activity) => `${activity.price} ${activity.title.toUpperCase()}`)
    .join(" | ");
}

test("without donations the overlay invites the first one and lists the cheapest options", () => {
  const overlay = buildOverlay({ recent: [], catalog, now: NOW });

  assert.equal(overlay.lines.length, 3);
  assert.equal(overlay.lines[0], HEADER);
  assert.equal(overlay.lines[1], "NO DONATIONS YET - BE THE FIRST");
  assert.equal(overlay.lines[2], `NEXT: ${cheapestMenu()}`);
  assert.equal(overlay.text, overlay.lines.join("\n"));
});

test("the last donation is the nickname and the amount, nothing else", () => {
  // The viewer message used to ride along and pushed the line off centre; it is gone on purpose.
  const overlay = buildOverlay({
    recent: [donation({ message: "please knives" })],
    catalog,
    now: NOW,
  });

  assert.equal(overlay.lines[1], "Vasya 130 RUB");
});

test("the rotation line counts down to the next free event", () => {
  const overlay = buildOverlay({
    recent: [donation()],
    catalog,
    next: { code: "he_party", title: "HE party", secondsLeft: 151 },
    now: NOW,
  });

  assert.equal(overlay.lines[2], "ДАЛЬШЕ 2:31 · HE PARTY");
});

test("a queued donation is still one line: the waiting marker went with the message", () => {
  const overlay = buildOverlay({ recent: [donation({ status: "queued" })], catalog, now: NOW });

  assert.equal(overlay.lines[1], "Vasya 130 RUB");
});

test("an activity that left the catalogue does not break the donation line", () => {
  const overlay = buildOverlay({ recent: [donation({ activityCode: "removed" })], catalog, now: NOW });
  assert.equal(overlay.lines[1], "Vasya 130 RUB");
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
