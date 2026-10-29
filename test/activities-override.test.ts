import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActivities } from "../src/activities.ts";
import {
  applyOverrides,
  emptyOverrides,
  OverrideError,
  OverrideStore,
  overriddenCodes,
  parseOverrides,
} from "../src/activities-override.ts";
import { resolveDonation } from "../src/mapping.ts";

const base = loadActivities(new URL("../config/activities.json", import.meta.url));

test("an override changes only the fields it mentions", () => {
  const document = parseOverrides({ version: 1, activities: { knives_only: { price: 90 } } });
  const merged = applyOverrides(base, document);
  const knives = merged.activities.find((activity) => activity.code === "knives_only");
  const awp = merged.activities.find((activity) => activity.code === "awp_only");

  assert.equal(knives?.price, 90);
  assert.equal(knives?.announce, "KNIVES ONLY!");
  assert.equal(knives?.rounds, 1);
  assert.equal(awp?.price, 100);
  assert.deepEqual(overriddenCodes(document), ["knives_only"]);
});

test("params are merged over the defaults instead of replacing them", () => {
  const document = parseOverrides({ version: 1, activities: { bot_rain: { params: { extraBots: 10 } } } });
  const merged = applyOverrides(base, document);
  const rain = merged.activities.find((activity) => activity.code === "bot_rain");
  assert.deepEqual(rain?.params, { extraBots: 10, maxBots: 22, seconds: 90 });
});

test("disabling the only effect on sale leaves nothing to sell", () => {
  const document = parseOverrides({ version: 1, activities: { he_party: { enabled: false } } });
  const merged = applyOverrides(base, document);
  const resolution = resolveDonation({ amount: 100, currency: "RUB" }, merged);

  assert.equal(resolution.kind, "reject");
  assert.equal(resolution.kind === "reject" && resolution.reason, "no_activity");
});

test("an override can put a retired effect back on sale for the same 50 RUB step", () => {
  const document = parseOverrides({
    version: 1,
    activities: { he_party: { enabled: false }, knives_only: { enabled: true, price: 50 } },
  });
  const merged = applyOverrides(base, document);
  const resolution = resolveDonation({ amount: 250, currency: "RUB" }, merged);

  assert.equal(resolution.kind, "activate");
  if (resolution.kind !== "activate") return;
  assert.equal(resolution.units, 5, "5 steps of 50 RUB");
  // A round-based effect has no clock to extend, so every step keeps its own line.
  assert.deepEqual(resolution.activities.map((activity) => activity.code), Array(5).fill("knives_only"));
});

test("an override that breaks the catalogue rules is refused with a readable error", () => {
  const document = parseOverrides({ version: 1, activities: { knives_only: { price: 10 } } });
  assert.throws(() => applyOverrides(base, document), (error: unknown) => {
    assert.ok(error instanceof OverrideError);
    assert.match(error.message, /minAmount|price/i);
    return true;
  });
});

test("a malformed override document is refused, not silently ignored", () => {
  assert.throws(() => parseOverrides({ version: 2, activities: {} }), OverrideError);
  assert.throws(() => parseOverrides({ version: 1, activities: { knives_only: { price: "90" } } }), OverrideError);
  assert.throws(() => parseOverrides({ version: 1, activities: { knives_only: { enabled: "yes" } } }), OverrideError);
});

test("the override file round-trips and a missing file is simply empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-override-"));
  try {
    const path = join(dir, "nested", "activities.override.json");
    const store = new OverrideStore(path);
    assert.deepEqual(store.read(), emptyOverrides());

    const document = parseOverrides({ version: 1, defaultCooldownSec: 90, activities: { meat_round: { price: 70 } } });
    store.write(document);

    const saved = JSON.parse(readFileSync(path, "utf8")) as unknown;
    assert.deepEqual(parseOverrides(saved), document);
    assert.equal(applyOverrides(base, store.read()).defaultCooldownSec, 90);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt override file is reported instead of being treated as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-override-"));
  try {
    const path = join(dir, "activities.override.json");
    writeFileSync(path, "{ not json", "utf8");
    assert.throws(() => new OverrideStore(path).read(), OverrideError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
