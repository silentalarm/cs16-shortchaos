import { test } from "node:test";
import assert from "node:assert/strict";
import { GamePoller, parseScore, parseTarget, parseWinner } from "../src/game-poller.ts";

/**
 * The panel reads the game through three console lines. Every parser is pinned against the exact
 * strings the plugins print, because a silent `null` here means a panel without a score, and nobody
 * notices that until the stream is live.
 */
const SCORE_LINE = "team_war status: t=12 ct=9 top_t=Mr_Smith:7 top_ct=Neo:5";
const TARGET_LINE =
  "stream_cam status: enabled=1 interval=25.0 mode=1 spectator=StreamCam target=Mr_Smith candidates=20 dwell=6.0 hp=87 active=1 ar=42";
const DUEL_LINE = "map_duel status: state=live winner=-";

/** What `amx_full_status` prints: the three lines above, in one RCON reply. */
function fullStatus(score = SCORE_LINE, target = "stream_cam status: target=Mr_Smith hp=87 ar=42", duel = DUEL_LINE): string {
  return `${score}\n${target}\n${duel}`;
}

test("the team race line becomes a score", () => {
  assert.deepEqual(parseScore(SCORE_LINE), { t: 12, ct: 9, topT: "Mr Smith 7", topCt: "Neo 5" });
});

test("field order does not matter and a missing side is not a zero", () => {
  assert.deepEqual(parseScore("team_war status: ct=4 t=6"), { t: 6, ct: 4, topT: "", topCt: "" });
  assert.equal(parseScore("team_war status: t=6 top_t=Neo:5"), null);
  assert.equal(parseScore("Unknown command: amx_team_war"), null);
  assert.equal(parseScore(""), null);
});

test("a nickname with a frag count keeps both halves", () => {
  assert.deepEqual(parseScore("t=1 ct=2 top_t=Neo top_ct=bot_7:12"), {
    t: 1,
    ct: 2,
    topT: "Neo",
    topCt: "bot 7 12",
  });
});

test("the camera status becomes the bot on camera", () => {
  assert.deepEqual(parseTarget(TARGET_LINE), { name: "Mr Smith", hp: 87, armor: 42 });
});

test("no camera target is null, not a bot called -", () => {
  assert.equal(parseTarget("stream_cam status: enabled=1 target=- candidates=3 hp=0 active=0 ar=0"), null);
  assert.equal(parseTarget("Unknown command: amx_stcam"), null);
  // An armour field the plugin does not print yet must not break the line.
  assert.deepEqual(parseTarget("stream_cam status: target=Smith hp=50"), { name: "Smith", hp: 50, armor: 0 });
});

test("the duel line names the winner, and only once the duel is decided", () => {
  assert.equal(parseWinner("map_duel status: state=done winner=Mr_Smith"), "Mr Smith");
  // A running duel has no winner yet, and the cvar keeps the previous map's name: `state` guards it.
  assert.equal(parseWinner("map_duel status: state=live winner=Mr_Smith"), "");
  assert.equal(parseWinner("map_duel status: state=idle winner=-"), "");
  assert.equal(parseWinner("map_duel status: state=done winner=-"), "");
  assert.equal(parseWinner("Unknown command: amx_map_duel"), "");
  assert.equal(parseWinner(""), "");
});

test("the winner of the last duel reaches the panel and goes away with the map", async () => {
  let duel = "map_duel status: state=live winner=-";
  const poller = new GamePoller({
    exec: async (command) => (command === "amx_full_status" ? fullStatus(SCORE_LINE, undefined, duel) : ""),
    intervalMs: 100,
    staleAfter: 1,
    log: () => {},
  });

  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(poller.snapshot().winner, "");

  duel = "map_duel status: state=done winner=Mr_Smith";
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(poller.snapshot().winner, "Mr Smith");

  // A fresh map resets the cvar; the panel must stop showing the previous winner.
  duel = "map_duel status: state=idle winner=-";
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(poller.snapshot().winner, "");

  poller.stop();
});

test("a dead server dims the panel instead of emptying it", async () => {
  let reply = SCORE_LINE;
  let fail = false;
  const poller = new GamePoller({
    exec: async (command) => {
      if (fail) throw new Error("RCON command timed out");
      return command === "amx_full_status" ? fullStatus(reply) : "";
    },
    intervalMs: 100,
    staleAfter: 1,
    log: () => {},
  });

  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(poller.snapshot().score, { t: 12, ct: 9, topT: "Mr Smith 7", topCt: "Neo 5" });
  assert.equal(poller.snapshot().stale, false);

  fail = true;
  await new Promise((resolve) => setTimeout(resolve, 220));
  // The last known score stays; only the stale flag changes, so the panel dims what it still shows.
  assert.equal(poller.snapshot().score?.t, 12);
  assert.equal(poller.snapshot().stale, true);

  fail = false;
  reply = "team_war status: t=13 ct=9 top_t=Mr_Smith:8 top_ct=Neo:5";
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(poller.snapshot().stale, false);
  assert.equal(poller.snapshot().score?.t, 13);

  poller.stop();
});

test("the whole panel costs one RCON command per tick", async () => {
  const commands: string[] = [];
  const poller = new GamePoller({
    exec: async (command) => {
      commands.push(command);
      return fullStatus();
    },
    intervalMs: 100,
    staleAfter: 1,
    log: () => {},
  });

  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  poller.stop();

  // Three probes cost three round-trips through a serialised RCON socket, and a paid activity used
  // to wait behind every one of them.
  assert.deepEqual(commands, ["amx_full_status"]);
  assert.deepEqual(poller.snapshot().score, { t: 12, ct: 9, topT: "Mr Smith 7", topCt: "Neo 5" });
  assert.deepEqual(poller.snapshot().target, { name: "Mr Smith", hp: 87, armor: 42 });
});

test("an old image without amx_full_status falls back to the three probes", async () => {
  const commands: string[] = [];
  const events: string[] = [];
  const poller = new GamePoller({
    exec: async (command) => {
      commands.push(command);
      if (command === "amx_team_war status") return SCORE_LINE;
      if (command === "amx_stcam status") return TARGET_LINE;
      if (command === "amx_map_duel status") return "map_duel status: state=done winner=Mr_Smith";
      return "Unknown command: amx_full_status";
    },
    intervalMs: 100,
    staleAfter: 1,
    log: (event) => events.push(event),
  });

  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  // The first tick recovers on its own instead of leaving the panel empty until the image is rebuilt.
  assert.equal(poller.snapshot().score?.t, 12);
  assert.equal(poller.snapshot().winner, "Mr Smith");
  assert.deepEqual(events, ["game.legacy_status"]);

  await new Promise((resolve) => setTimeout(resolve, 150));
  poller.stop();

  // Decided once: the missing command is not probed again on every tick.
  assert.equal(commands.filter((command) => command === "amx_full_status").length, 1);
  assert.ok(commands.length > 3, "the fallback stopped polling");
});

test("a dry run (no password) never invents a score", async () => {
  const poller = new GamePoller({ exec: async () => "", intervalMs: 100, staleAfter: 1, log: () => {} });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(poller.snapshot().score, null);
  assert.equal(poller.snapshot().stale, true);
  poller.stop();
});
