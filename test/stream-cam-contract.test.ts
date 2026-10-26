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

test("the director keeps the third person base and a first person window", () => {
  assert.equal(cvarDefault("stcam_mode"), "1", "the base mode must be chase locked (third person)");
  assert.equal(cvarDefault("stcam_pov_mode"), "4", "the POV window must be OBS_IN_EYE");
  assert.equal(cvarDefault("stcam_pov"), "1", "the POV window is the point of the director");
  assert.ok(Number(cvarDefault("stcam_pov_sec")) > 0, "a zero-length POV window never shows");
  assert.ok(Number(cvarDefault("stcam_dwell")) > 0, "dwell is what stops the camera from hopping");
  assert.ok(Number(cvarDefault("stcam_interval")) > 0, "the hold time must be positive");
});

test("the status line still answers every key the runbook greps", () => {
  const status = /server_print\("stream_cam status:([^"]+)"/.exec(plugin)?.[1] ?? "";
  for (const key of ["enabled", "interval", "mode", "spectator", "target", "candidates", "pov", "dwell"]) {
    assert.match(status, new RegExp(`${key}=`), `amx_stcam status lost the ${key} key`);
  }
});

test("first person feeds the client health, armour and a weapon it can draw", () => {
  for (const message of ["Health", "ArmorValue", "CurWeapon", "WeaponList"]) {
    assert.match(plugin, new RegExp(`get_user_msgid\\("${message}"\\)`), `${message} is never looked up`);
  }

  // WeaponList is a fixed nine field message: one string (the model name) and eight bytes. A field
  // missing or reordered here is a client that draws nothing, or the wrong gun.
  const body = /message_begin\(MSG_ONE, g_msgWeaponList, _, g_camId\);([\s\S]*?)message_end\(\);/.exec(plugin)?.[1];
  assert.ok(body, "SendWeaponList does not build the message");
  assert.equal((body.match(/write_string\(/g) ?? []).length, 1, "WeaponList carries exactly one string");
  assert.equal((body.match(/write_byte\(/g) ?? []).length, 8, "WeaponList carries exactly eight bytes");

  // Leaving first person must switch the view model off, otherwise it hangs in front of the chase camera.
  assert.match(plugin, /SendCurWeapon\(g_camId, 0, 0, 0\)/, "the weapon is never switched off");
});
