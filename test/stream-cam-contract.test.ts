import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The camera director lives in two places at once: the server plugin decides the observer mode and
 * the capture client has its own default in infra/stream/entrypoint.sh. They drifted apart once
 * already (the client asked for map overview while the plugin wanted in-eye), which reads on screen
 * as a camera that does not obey anybody. Nothing here needs a game server.
 */
const plugin = readFileSync(new URL("../plugins/stream_cam/stream_cam.sma", import.meta.url), "utf8");
const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

function cvarDefault(name: string): string | undefined {
  const match = new RegExp(`register_cvar\\("${name}",\\s*"([^"]+)"\\)`).exec(plugin);
  return match?.[1];
}

test("the client's default camera mode matches stcam_mode", () => {
  const clientMode = /\$\{STREAM_SPEC_MODE:-(\d)\}/.exec(entrypoint)?.[1];
  assert.ok(clientMode, "entrypoint.sh has no STREAM_SPEC_MODE default");
  assert.equal(cvarDefault("stcam_mode"), clientMode, "stcam_mode and STREAM_SPEC_MODE disagree");

  const envMode = /^STREAM_SPEC_MODE=(\d)/m.exec(envExample)?.[1];
  assert.equal(envMode, clientMode, ".env.example would start the client in another mode");
});

test("the director is third person only", () => {
  assert.equal(cvarDefault("stcam_mode"), "1", "the base mode must be chase locked (third person)");
  assert.ok(Number(cvarDefault("stcam_dwell")) > 0, "dwell is what stops the camera from hopping");
  assert.ok(Number(cvarDefault("stcam_interval")) > 0, "the hold time must be positive");

  // The in-eye window was removed on purpose: a spectator has no view model, so it had to be faked
  // with WeaponList + CurWeapon, and every cut to and from first person read as the camera glitching.
  // The patterns below match code, not the explanatory comments above them.
  const dead = [
    /stcam_pov/,
    /IsPov/,
    /EventDamage/,
    /register_event\("Damage"/,
    /get_user_msgid\("WeaponList"\)/,
    /get_user_msgid\("CurWeapon"\)/,
  ];
  for (const pattern of dead) {
    assert.doesNotMatch(plugin, pattern, `${pattern} is back: the director must stay in third person`);
  }
});

test("the status line still answers every key the runbook greps", () => {
  const status = /server_print\("stream_cam status:([^"]+)"/.exec(plugin)?.[1] ?? "";
  for (const key of ["enabled", "interval", "mode", "spectator", "target", "candidates", "dwell", "hp", "active"]) {
    assert.match(status, new RegExp(`${key}=`), `amx_stcam status lost the ${key} key`);
  }
  assert.doesNotMatch(status, /pov=/, "there is no first person mode to report any more");
});

test("the HUD still gets real health and armour from the server", () => {
  // A spectator has no player state of its own, so both numbers are pushed every second: without them
  // the client draws an empty health bar and the bot name with 0 HP.
  for (const message of ["Health", "ArmorValue"]) {
    assert.match(plugin, new RegExp(`get_user_msgid\\("${message}"\\)`), `${message} is never looked up`);
  }

  assert.match(plugin, /show_hudmessage\(g_camId, "%s", text\)/, "the readable HUD line is gone");
  // The team race rides in the same message: a second hudmessage is overwritten by this one.
  assert.match(plugin, /TOP T %s {2}\| {2}TOP CT %s/, "the team score is not part of the HUD block");
  assert.match(plugin, /get_pcvar_num\(cvar_hud\)/, "stcam_hud no longer gates the line");
});

test("the spectator's PVS anchor follows the target faster than the director tick", () => {
  // The engine builds the client's PVS from the invisible spectator's own origin. A once-a-second
  // copy was too coarse: the bot crossed a portal between ticks and its model stopped arriving,
  // which reads on stream as the character disappearing for a moment.
  const fast = /set_task\(\s*0\.1\s*,\s*"TaskFollow"/.exec(plugin);
  assert.ok(fast, "TaskFollow is missing: the PVS anchor is synced only on the director tick");

  const follow = /public TaskFollow\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(follow, /ApplyCamera\(\)/, "TaskFollow does not re-apply the whole observer state");
  assert.match(follow, /g_modeResets\+\+/, "TaskFollow no longer counts observer-mode resets");
  assert.match(follow, /g_targetResets\+\+/, "TaskFollow no longer counts observer-target resets");

  const sync = /stock SyncCameraOrigin\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(sync, /set_pev\(g_camId, pev_origin/, "SyncCameraOrigin does not copy the target origin");

  const camera = /stock ApplyCamera\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(camera, /SyncCameraOrigin\(\)/, "a freshly picked target is not anchored in the same tick");
  assert.doesNotMatch(camera, /set_pev\(g_camId, pev_origin/, "ApplyCamera still owns the PVS anchor");
});

test("the HUD line sits below the spectator band the encoder cuts off", () => {
  // hudmessage y is a fraction of the render height, and the stream entrypoint cuts the client's two
  // 20% bands before scaling. A line anchored at 0.20 lands exactly on the cut and loses the tops of
  // its glyphs - seen on frames once the render went portrait.
  const anchor = /set_hudmessage\(255, 255, 255, -1\.0, ([0-9.]+),/.exec(plugin)?.[1];
  assert.ok(anchor, "the HUD line anchor is gone");
  assert.ok(Number(anchor) > 0.2, `the HUD line at ${anchor} is clipped by the band cut`);
});
