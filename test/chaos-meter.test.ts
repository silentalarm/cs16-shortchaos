import { test } from "node:test";
import assert from "node:assert/strict";
import { addToChaos, CHAOS_THRESHOLD, chaosFill } from "../src/chaos-meter.ts";

/**
 * The chaos meter is the only place where donated money is turned into an event nobody bought:
 * every rouble counts, a full thousand fires one burst in `chaos_core`, and the overshoot stays on
 * the bar instead of being swallowed.
 */
test("money collects toward the burst and the overshoot carries over", () => {
  assert.equal(CHAOS_THRESHOLD, 1000);
  assert.deepEqual(addToChaos(0, 50), { total: 50, bursts: 0 });
  assert.deepEqual(addToChaos(950, 50), { total: 0, bursts: 1 }, "exactly full fires once, bar empty");
  assert.deepEqual(addToChaos(950, 100), { total: 50, bursts: 1 }, "1050 fires once and leaves 50");
  assert.deepEqual(addToChaos(0, 2500), { total: 500, bursts: 2 }, "a big donation fills it twice");
});

test("nonsense amounts never move the meter", () => {
  assert.deepEqual(addToChaos(0, Number.NaN), { total: 0, bursts: 0 });
  assert.deepEqual(addToChaos(Number.NaN, 50), { total: 50, bursts: 0 });
  assert.deepEqual(addToChaos(-500, 50), { total: 50, bursts: 0 });
  assert.deepEqual(addToChaos(0, -50), { total: 0, bursts: 0 });
  // Float noise must not reach the panel: the line shows roubles, not 0.30000000000000004.
  assert.deepEqual(addToChaos(0, 0.1 + 0.2), { total: 0.3, bursts: 0 });
});

test("the bar never shows a run it has not paid for", () => {
  assert.equal(chaosFill(0, 10), 0);
  assert.equal(chaosFill(99, 10), 0);
  assert.equal(chaosFill(500, 10), 5);
  assert.equal(chaosFill(999, 10), 9, "one rouble before the burst is not a full bar");
  assert.equal(chaosFill(1000, 10), 10);
  assert.equal(chaosFill(5000, 10), 10, "the bar cannot overflow the frame");
});
