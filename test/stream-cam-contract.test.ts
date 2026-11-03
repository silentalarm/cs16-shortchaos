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
// The game server's own entrypoint: it is what turns STREAM_EYE* into the cvars the plugin registers.
const serverEntrypoint = readFileSync(new URL("../infra/entrypoint.sh", import.meta.url), "utf8");


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
  assert.match(plugin, /EyeWanted\(\)\s*\?\s*CAM_IN_EYE\s*:/, "ApplyCamera ignores the window");

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
  // from outside the game that the feature fired. The lens keys were added for the action camera and
  // eye_ammo/eye_btn are the two shot signals counted separately.
  assert.match(status, /pov=%d/, "the status line does not report the first person switch");
  assert.match(status, /pov_active=%d/, "the status line does not report an open in-eye window");
  for (const key of ["eye", "vmodel", "eye_active", "eye_sec", "eye_cuts", "eye_ammo", "eye_btn"]) {
    assert.match(status, new RegExp(`${key}=`), `amx_stcam status lost the ${key} key`);
  }
});

test("the camera can be held on a paid hero, and the lock ends by itself", () => {
  // Stage 1 of docs/activities/roadmap.md: a round mode buys shots of a particular bot, and the
  // director's "busiest bot" is not that bot. Without the lock the money is spent off camera - the
  // reason `sniper_moment` was rejected in docs/events.md.
  assert.match(plugin, /register_srvcmd\("amx_stcam", "CmdStreamCam"\)/, "the command is not registered");
  assert.match(plugin, /equal\(arg, "lock"\)/, "amx_stcam lock is not handled");
  assert.match(plugin, /equal\(arg, "unlock"\)/, "amx_stcam unlock is not handled");
  assert.match(plugin, /read_argv\(2, who, charsmax\(who\)\)/, "the lock does not take a target");
  assert.match(plugin, /str_to_float\(raw\)/, "the lock length is not read from the command");
  assert.match(plugin, /#define LOCK_MAX_SECONDS 600\.0/, "a donated lock length is not bounded");
  assert.match(plugin, /#define LOCK_DEFAULT_SECONDS 20\.0/, "the default lock length changed");

  // Applied in the same RCON call, because the event and the lock arrive in the same second.
  const lock = /if \(equal\(arg, "lock"\)\)\s*\{[\s\S]*?\n\t\}/.exec(plugin)?.[0] ?? "";
  assert.notEqual(lock, "", "the lock branch is missing");
  assert.match(lock, /ApplyCamera\(\)/, "the camera is not cut in the call that took the lock");
  assert.match(lock, /IsPlayable\(target\)/, "a dead bot can be locked");

  // Every path out: the clock, the death of the bot, a disconnect, the round start and the manual unlock.
  assert.match(plugin, /stock bool:CameraLocked\(Float:now\)/, "CameraLocked is missing");
  assert.match(plugin, /stock ReleaseLock\(const reason\[\]\)/, "ReleaseLock is missing");
  const tick = /public TaskTick\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(tick, /now >= g_lockUntil/, "the lock never expires on its own");
  assert.match(tick, /!CameraLocked\(now\) && now >= g_dwellUntil/, "the director relocks during a paid cut");
  const pick = /stock PickTarget\(const reason\[\], preferred\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(pick, /if \(CameraLocked\(get_gametime\(\)\)\)\s*\n\t\treturn;/, "the director ignores the lock");
  const death = /public EventDeathMsg\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(death, /victim == g_lockTarget[\s\S]*ReleaseLock/, "a dead hero keeps the camera");
  const gone = /public client_disconnected\(id\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(gone, /id == g_lockTarget[\s\S]*ReleaseLock/, "a disconnected hero keeps the camera");
  const round = /public OnRoundStart\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(round, /ReleaseLock\("round start"\)/, "the lock survives the round it was bought for");
});

test("the status line reports the lock as a name and the seconds left", () => {
  const status = /server_print\("stream_cam status:([^"]+)"/.exec(plugin)?.[1] ?? "";
  assert.match(status, /locked=%s/, "the panel cannot tell that the camera is held");
  assert.match(status, /lock_left=%.1f/, "the panel cannot tell when the lock ends");
  assert.match(plugin, /new locked\[NAME_LEN\] = "none"/, "an unlocked camera must read locked=none");
  assert.match(plugin, /ReplaceSpaces\(locked, charsmax\(locked\)\)/, "the lock name would break the key=value line");
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
test("the action camera cuts on a shot and hands the picture back", () => {
  // stcam_eye: 0 third person only, 1 first person while the followed bot shoots, 2 held while it
  // lives. 1 is the shipped picture - the feature exists to be seen, and it always gives the camera
  // back on its own.
  assert.equal(cvarDefault("stcam_eye"), "1", "the shot-triggered lens is the shipped picture");

  const hold = Number(cvarDefault("stcam_eye_sec"));
  const ceiling = Number(cvarDefault("stcam_eye_max"));
  assert.ok(hold > 0, "the window needs a length: it is the hold after the last shot AND the pause in third person");
  assert.ok(ceiling >= hold, "a ceiling below the hold would clip the window on the very first shot");

  // One answer to "first person or not": the kill window and the shooting window share the observer
  // field, so two separate flags would overwrite each other.
  assert.match(plugin, /stock bool:EyeWanted\(\)/, "there is no single answer to \"first person or not\"");
  assert.match(plugin, /EyeWanted\(\)\s*\?\s*CAM_IN_EYE\s*:/, "ApplyCamera ignores the lens");

  // The shot is read from the clip - firing is the only thing that spends a round - with the IN_ATTACK
  // button as the fallback for the weapons that spend nothing. Both are counted for the status line:
  // whether a YaPB fake client reports buttons at all is not documented anywhere.
  assert.match(plugin, /get_user_weapon\(g_target,\s*clip,\s*reserve\)/, "the shot detector lost the clip");
  assert.match(plugin, /IN_ATTACK/, "the button fallback is gone");
  assert.match(plugin, /g_eyeAmmoCuts\+\+/, "the clip trigger is not counted");
  assert.match(plugin, /g_eyeButtonCuts\+\+/, "the button trigger is not counted");

  // Ten times a second, not once: the cut and the return both have to land inside the action.
  const follow = /public TaskFollow\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(follow, /UpdateEye\(\)/, "TaskFollow never updates the lens: the cut waits for the 1 Hz tick");
  const eye = /stock UpdateEye\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(eye, /LeavePov\(/, "an expired window is never closed");
  assert.match(eye, /WatchFire\(\)/, "UpdateEye never looks for a shot");
  assert.match(eye, /RelayWeaponAnim\(\)/, "the gun in the picture never shoots: no animation relay");

  // The window is shared, so it is entered through one door with a reason and a length.
  assert.match(plugin, /stock EnterPov\(const reason\[\], Float:seconds\)/, "EnterPov lost its reason and hold");
  assert.match(plugin, /EnterPov\("shot"|EnterPov\(byAmmo/, "no trigger actually opens the window");
  const leave = /stock LeavePov\(const reason\[\]\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(leave, /g_eyeQuietUntil/, "nothing keeps the camera in third person between two cuts");

  // A new target means a new clip count: keeping the old one reads a weapon switch as a shot.
  const pick = /stock PickTarget\(const reason\[\], preferred\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(pick, /ResetEyeTracking\(\)/, "the shot detector survives a target change");

  // The animation relay is the difference between a gun and a photograph of a gun.
  const relay = /stock RelayWeaponAnim\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
  assert.match(relay, /SVC_WEAPONANIM/, "the weapon animation is not relayed any more");
  assert.match(relay, /write_byte\(anim\)/, "SVC_WEAPONANIM needs the sequence as its first byte");
});

test("the lens is tuned from .env, and the defaults agree", () => {
  // One env var per cvar, patched into server.cfg by the entrypoint (the plugin re-reads them on every
  // map change). The pairs are the contract: a default that drifts between .env.example and the plugin
  // is a picture nobody can reproduce.
  const pairs: [string, string][] = [
    ["STREAM_EYE", "stcam_eye"],
    ["STREAM_EYE_SEC", "stcam_eye_sec"],
    ["STREAM_EYE_MAX", "stcam_eye_max"],
  ];

  for (const [env, cvar] of pairs) {
    assert.match(
      serverEntrypoint,
      new RegExp(`grep -q '\\^${cvar} '`),
      `${cvar} is never written into server.cfg, so ${env} does nothing`,
    );
    const fromEnv = new RegExp(`^${env}=([^\\r\\n]+)$`, "m").exec(envExample)?.[1];
    assert.equal(fromEnv, cvarDefault(cvar), `${env} and the ${cvar} default disagree`);
  }
});

