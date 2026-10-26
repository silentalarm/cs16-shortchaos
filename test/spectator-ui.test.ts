import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The two translucent spectator bands are not cropped out of the frame any more: cropping the clean
 * band cost a third of the picture and zoomed the rest. The top band (scores, map, round timer) is
 * switched off with a client cvar instead, because CS16Client draws it in code and never reads the
 * VGUI resources under cstrike/resource/UI - editing Spectator.res was a dead end, verified on frames.
 *
 * All of that lives in infra/stream/entrypoint.sh, so it can be checked without Docker or a game
 * server. The line endings are part of the contract too: the build context is the working tree, and a
 * CRLF shebang makes the capture container die before the first log line.
 */
const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");

test("the encoder keeps the whole frame: no crop is left in the filter chain", () => {
  assert.doesNotMatch(entrypoint, /crop=/, "the picture is cropped again");
  assert.doesNotMatch(entrypoint, /STREAM_CROP/, "the crop settings are back");
  assert.match(entrypoint, /^VF="scale=\$\{GAME_W\}:\$\{GAME_H\}:flags=bicubic"$/m);
});

test("the spectator overlay is switched off with the client cvars that exist", () => {
  for (const cvar of ["spec_drawstatus", "spec_drawnames", "spec_drawcone", "spec_decal"]) {
    assert.match(entrypoint, new RegExp(`echo "${cvar} 0"`), `${cvar} is never written to userconfig`);
  }

  // The cvars above only hide the *contents* of the panels; the translucent bars themselves are painted
  // by the client HUD, and `hud_draw 0` is the only switch that reaches them.
  assert.match(entrypoint, /echo "hud_draw 0"/, "the bars are back: hud_draw stays off");

  // `hud_spectator` looks like the obvious switch but is not a cvar in this client: the engine answers
  // "Unknown command" and the setting silently does nothing.
  assert.doesNotMatch(entrypoint, /hud_spectator/, "hud_spectator is not a cvar in CS16Client");

  // The cvars must land in the config file before the join, otherwise the overlay is drawn first.
  const cvars = entrypoint.indexOf('echo "spec_drawstatus 0"');
  assert.ok(cvars > entrypoint.indexOf("write_client_config() {"), "the cvars belong to write_client_config");
  assert.ok(cvars < entrypoint.indexOf('echo "connect $SERVER_ADDR"'), "the cvars must precede the join");
});

test("the dead VGUI resource path stays out of the entrypoint", () => {
  // CS16Client contains no "resource/UI" string at all, so patching Spectator.res or
  // BottomSpectator.res can never change the picture. This guards against re-adding that code: the
  // entrypoint may explain the dead end in a comment, but it must not rewrite `visible` fields again.
  assert.doesNotMatch(entrypoint, /"visible"/, "the entrypoint rewrites VGUI resources nobody reads");
  assert.doesNotMatch(entrypoint, /patch_spectator_ui/, "the resource patcher is back");
});

test("every shell script keeps LF endings", () => {
  const dirs = ["../infra/", "../infra/stream/"];
  for (const dir of dirs) {
    for (const name of readdirSync(new URL(dir, import.meta.url))) {
      if (!name.endsWith(".sh")) continue;

      const raw = readFileSync(new URL(`${dir}${name}`, import.meta.url));
      assert.equal(raw.includes(0x0d), false, `${dir}${name} has CRLF, the shebang breaks in the image`);
    }
  }
});
