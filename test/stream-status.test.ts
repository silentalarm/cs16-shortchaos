import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDuelState, parsePluginCodes, parsePluginStatus, parseProgress, readStreamHealth, HEARTBEAT_STALE_AFTER_SEC, STALE_AFTER_SEC } from "../src/stream-status.ts";

const PROGRESS = [
  "frame=120",
  "fps=29.97",
  "bitrate=2010.5kbits/s",
  "total_size=1500000",
  "drop_frames=0",
  "dup_frames=2",
  "speed=1.01x",
  "progress=continue",
  "",
  "frame=240",
  "fps=30.00",
  "bitrate=1998.2kbits/s",
  "total_size=3000000",
  "drop_frames=3",
  "dup_frames=4",
  "speed=1.00x",
  "out_time_us=8000000",
  "progress=continue",
  "",
].join("\n");

test("progress is parsed as the last ffmpeg block, not the first", () => {
  const progress = parseProgress(PROGRESS);
  assert.ok(progress);
  assert.equal(progress.frame, 240);
  assert.equal(progress.fps, 30);
  assert.equal(progress.bitrate, "1998.2kbits/s");
  assert.equal(progress.dropFrames, 3);
  assert.equal(progress.dupFrames, 4);
  assert.equal(progress.outTimeSec, 8);
  assert.equal(progress.speed, "1.00x");
});

test("empty or garbage progress yields null instead of zeros", () => {
  assert.equal(parseProgress(""), null);
  assert.equal(parseProgress("noise\nmore noise"), null);
});

test("ffmpeg's single stats line is parsed too, padding and all", () => {
  const progress = parseProgress(
    "frame=  360 fps= 30 q=23.0 Lsize=    3274KiB time=00:00:12.16 bitrate=2204.4kbits/s dup=0 drop=4 speed=1.01x",
  );
  assert.ok(progress);
  assert.equal(progress.frame, 360);
  assert.equal(progress.fps, 30);
  assert.equal(progress.bitrate, "2204.4kbits/s");
  assert.equal(progress.outTimeSec, 12.16);
  assert.equal(progress.dropFrames, 4);
  assert.equal(progress.dupFrames, 0);
  assert.equal(progress.speed, "1.01x");
});

test("a missing status.json means the stream was never started here", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-status-"));
  try {
    const health = readStreamHealth(dir);
    assert.equal(health.configured, false);
    assert.equal(health.stale, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an old progress file is reported as stale, because a live process can still be stuck", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs16-status-"));
  try {
    const layout = {
      kind: "rtmp",
      label: "rtmp://mediamtx:1935/live/test",
      width: 720,
      height: 1280,
      captureWidth: 960,
      captureHeight: 720,
      fps: 30,
      bitrateKbps: 2000,
      recordSec: 0,
      audio: true,
      startedAt: "2026-01-01T12:00:00Z",
    };
    writeFileSync(join(dir, "status.json"), JSON.stringify(layout), "utf8");
    writeFileSync(join(dir, "progress.txt"), PROGRESS, "utf8");

    const mtime = Date.now() / 1000;
    utimesSync(join(dir, "progress.txt"), mtime, mtime);

    const fresh = readStreamHealth(dir, mtime * 1000 + 2_000);
    assert.equal(fresh.configured, true);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.ageSec, 2);
    assert.equal(fresh.layout?.width, 720);
    assert.equal(fresh.layout?.height, 1280);
    assert.equal(fresh.layout?.audio, true);

    const stalled = readStreamHealth(dir, mtime * 1000 + (STALE_AFTER_SEC + 10) * 1000);
    assert.equal(stalled.stale, true);
    assert.equal(stalled.ageSec, STALE_AFTER_SEC + 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const LAYOUT = {
  kind: "rtmp",
  label: "rtmp://mediamtx:1935/live/test",
  width: 720,
  height: 1280,
  captureWidth: 960,
  captureHeight: 720,
  fps: 30,
  bitrateKbps: 2000,
  recordSec: 0,
  audio: true,
  startedAt: "2026-01-01T12:00:00Z",
};

function tempDirWith(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cs16-status-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf8");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a fresh heartbeat decides the verdict: moving picture is live", () => {
  const home = tempDirWith({
    "status.json": JSON.stringify(LAYOUT),
    "runtime.json": JSON.stringify({ ts: 1_000_000, xashAlive: true, logAgeSec: 3, frozen: false, restarts: 0 }),
  });
  try {
    const health = readStreamHealth(home.dir, 1_000_010_000);
    assert.equal(health.verdict, "live");
    assert.equal(health.stale, false);
    assert.equal(health.ageSec, 10);
    assert.equal(health.runtime?.xashAlive, true);
    assert.equal(health.runtime?.logAgeSec, 3);
  } finally {
    home.cleanup();
  }
});

test("a static picture is reported as frozen, not as a dead encoder", () => {
  const home = tempDirWith({
    "status.json": JSON.stringify(LAYOUT),
    "runtime.json": JSON.stringify({ ts: 1_000_000, xashAlive: true, logAgeSec: 1, frozen: true, restarts: 1 }),
  });
  try {
    const health = readStreamHealth(home.dir, 1_000_005_000);
    assert.equal(health.verdict, "frozen");
    assert.equal(health.stale, false);
    assert.equal(health.runtime?.frozen, true);
    assert.equal(health.runtime?.restarts, 1);
  } finally {
    home.cleanup();
  }
});

test("a heartbeat older than the threshold means the capture container is gone", () => {
  const home = tempDirWith({
    "status.json": JSON.stringify(LAYOUT),
    "progress.txt": PROGRESS,
    "runtime.json": JSON.stringify({ ts: 1_000_000, xashAlive: true, logAgeSec: 900, frozen: false, restarts: 0 }),
  });
  try {
    const health = readStreamHealth(home.dir, 1_000_000_000 + (HEARTBEAT_STALE_AFTER_SEC + 30) * 1000);
    assert.equal(health.verdict, "stalled");
    assert.equal(health.stale, true);
    assert.equal(health.ageSec, HEARTBEAT_STALE_AFTER_SEC + 30);
  } finally {
    home.cleanup();
  }
});

test("a malformed heartbeat is ignored instead of failing the whole panel", () => {
  const home = tempDirWith({
    "status.json": JSON.stringify(LAYOUT),
    "runtime.json": "{not json",
  });
  try {
    const health = readStreamHealth(home.dir);
    assert.equal(health.runtime, null);
    assert.equal(health.verdict, "unknown");
    assert.equal(health.configured, true);
  } finally {
    home.cleanup();
  }
});

test("plugin codes are read after the label, so header words are not codes", () => {
  const codes = parsePluginCodes("donation_events codes: bot_nick,meat_round,he_party");
  assert.deepEqual(codes, ["bot_nick", "meat_round", "he_party"]);
  // The old split of the whole line returned ["donation_events", "codes:", ...] as well.
  assert.equal(codes.includes("donation_events"), false);
  assert.equal(codes.includes("codes:"), false);
});

test("a plugin reply without a code list yields nothing instead of header junk", () => {
  assert.deepEqual(parsePluginCodes("donation_events rejected unknown activity codes"), []);
  assert.deepEqual(parsePluginCodes(""), []);
  assert.deepEqual(parsePluginCodes("donation_events codes:"), []);
});

test("duplicate codes in the reply are reported once", () => {
  assert.deepEqual(parsePluginCodes("codes: knives_only,knives_only,awp_only"), ["knives_only", "awp_only"]);
});

test("plugin status is parsed into active, queued and nick", () => {
  const status = parsePluginStatus("donation_events status: api=1 active=glass_cannon queued=2 nick=vasya");
  assert.equal(status.active, "glass_cannon");
  assert.deepEqual(status.actives, ["glass_cannon"]);
  assert.equal(status.queued, 2);
  assert.equal(status.nick, "vasya");
});

test("several effects in one frame are all reported, not just the last one", () => {
  // The plugin joins the running codes with '+': one donation can buy a whole batch, and the panel has
  // to say what is on screen. `active` keeps the first code for older consumers.
  const status = parsePluginStatus(
    "donation_events status: api=1 active=meteor_shower+lightsaber_duel+he_party queued=0 nick=vasya",
  );
  assert.deepEqual(status.actives, ["meteor_shower", "lightsaber_duel", "he_party"]);
  assert.equal(status.active, "meteor_shower");
  assert.equal(status.nick, "vasya");
});

test("the map duel is read as idle, live or done, and anything else is no duel", () => {
  // The free rotation pauses only on `live`; an unreachable server answers nothing at all, and that
  // must keep the rotation running rather than freeze it for the rest of the map.
  assert.equal(parseDuelState("map_duel status: state=live winner=-"), "live");
  assert.equal(parseDuelState("map_duel status: state=idle winner=-"), "idle");
  assert.equal(parseDuelState("map_duel status: state=done winner=vasya"), "done");
  assert.equal(parseDuelState("map_duel status: state=LIVE winner=-"), "live");
  assert.equal(parseDuelState(""), null);
  assert.equal(parseDuelState("unknown command amx_map_duel"), null);
});

test("an idle server reports none, and an old plugin reply keeps everything null", () => {
  const idle = parsePluginStatus("donation_events status: api=1 active=none queued=0 nick=none");
  assert.equal(idle.active, null);
  assert.deepEqual(idle.actives, []);
  assert.equal(idle.queued, 0);
  assert.equal(idle.nick, null);

  const old = parsePluginStatus("donation_events rejected unknown activity status");
  assert.equal(old.active, null);
  assert.deepEqual(old.actives, []);
  assert.equal(old.queued, null);
  assert.equal(old.raw, "donation_events rejected unknown activity status");
});
