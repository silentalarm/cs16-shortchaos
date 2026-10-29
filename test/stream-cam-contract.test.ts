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

test("the director defaults to third person, with first person as an opt-in switch", () => {
  assert.equal(cvarDefault("stcam_mode"), "1", "the base mode must be chase locked (third person)");
  assert.ok(Number(cvarDefault("stcam_dwell")) > 0, "dwell is what stops the camera from hopping");
  assert.ok(Number(cvarDefault("stcam_interval")) > 0, "the hold time must be positive");

  // The in-eye window is a pilot feature: off by default, and it is the *server's* observer mode that
  // decides - a client-side `spec_mode` request is overwritten by ApplyCamera() ten times a second,
  // which is exactly why the first attempt looked like it did nothing.
  assert.equal(cvarDefault("stcam_pov"), "0", "first person must be off unless somebody asks for it");
  assert.ok(Number(cvarDefault("stcam_pov_sec")) > 0, "the in-eye window needs a length");
  assert.match(plugin, /#define CAM_IN_EYE 4/, "there is no OBS_IN_EYE mode to switch to");
  assert.match(plugin, /g_povActive[^\n]*\?\s*CAM_IN_EYE\s*:/, "ApplyCamera ignores the window");

  const faked = [
    /EventDamage/,
    /register_event\("Damage"/,
    /get_user_msgid\("WeaponList"\)/,
    /get_user_msgid\("CurWeapon"\)/,
  ];
  for (const pattern of faked) {
    assert.doesNotMatch(plugin, pattern, `${pattern} is back: the view model must come from the client`);
  }
});

test("the status line still answers every key the runbook greps", () => {
  const status = /server_print\("stream_cam status:([^"]+)"/.exec(plugin)?.[1] ?? "";
  for (const key of ["enabled", "interval", "mode", "spectator", "target", "candidates", "dwell", "hp", "active"]) {
    assert.match(status, new RegExp(`${key}=`), `amx_stcam status lost the ${key} key`);
  }
  // pov= is the switch, pov_active= says whether the window is open right now: the only way to tell
  // from outside the game that the feature fired.
  assert.match(status, /pov=%d/, "the status line does not report the first person switch");
  assert.match(status, /pov_active=%d/, "the status line does not report an open in-eye window");
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

test("the panel outside the game gets its data from the plugin, not from the HUD", () => {
  // The in-game block is off by default now: the picture is drawn by the control API, and a
  // hudmessage on top of it would duplicate the numbers (and flicker at a 1 Hz refresh).
  assert.equal(cvarDefault("stcam_hud"), "0", "stcam_hud must default to 0");

  for (const name of ["stcam_name", "stcam_hp", "stcam_ar"]) {
    assert.match(plugin, new RegExp(`register_cvar\\("${name}"`), `${name} is not registered`);
    assert.match(plugin, new RegExp(`set_cvar_string\\("${name}"`), `${name} is never published`);
  }

  // Published before the stcam_hud gate, so the panel keeps working with the HUD switched off.
  const feed = /stock FeedHud\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  const publish = feed.indexOf("PublishTarget(");
  const gate = feed.indexOf("cvar_hud");
  assert.ok(publish >= 0, "FeedHud never publishes the target");
  assert.ok(gate > publish, "stcam_hud gates the publication: the panel would go blank");
});

test("the status line carries the armour and a single-token target", () => {
  const status = /server_print\("stream_cam status:([^"]+)"/.exec(plugin)?.[1] ?? "";
  assert.match(status, /ar=%d/, "the panel's parseTarget reads ar=");
  // Names come from the game and go through a regex on the reader side: no spaces allowed.
  assert.match(plugin, /ReplaceSpaces\(target, charsmax\(target\)\)/);
  assert.match(plugin, /ReplaceSpaces\(spectator, charsmax\(spectator\)\)/);
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
