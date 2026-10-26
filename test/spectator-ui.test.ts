import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The two translucent spectator bands are cut out of the frame by the encoder. The bands are not a
 * resource file and not a cvar: CS16Client paints them in CHudSpectatorGui::Draw(), where each strip
 * is INT_YPOS(2) tall and YPOS(y) = y/10, so exactly 20% of the render height is lost at the top and
 * at the bottom - measured on frames as 144 rows of the 960x720 capture. Both FillRGBABlend calls are
 * unconditional; the client cvars only empty the strips. The cut happens before the scale and the
 * picture is not stretched back to the canvas, so the gameplay keeps its pixel size: a band crop, not
 * a zoom.
 *
 * All of that lives in infra/stream/entrypoint.sh, so it can be checked without Docker or a game
 * server. The line endings are part of the contract too: the build context is the working tree, and a
 * CRLF shebang makes the capture container die before the first log line.
 */
const entrypoint = readFileSync(new URL("../infra/stream/entrypoint.sh", import.meta.url), "utf8");

test("the spectator bands are cut before the scale, so the picture is not zoomed", () => {
  assert.match(entrypoint, /BAND_PCT="\$\{STREAM_BAND_PERCENT:-20\}"/, "the bands are 20% by default");
  assert.match(
    entrypoint,
    /^VF="crop=\$\{CAP_W\}:\$\{VIEW_H\}:0:\$\{BAND_PX\},scale=\$\{GAME_W\}:\$\{GAME_H\}:flags=bicubic"$/m,
    "the bands must be cut before the scale",
  );
  assert.doesNotMatch(entrypoint, /STREAM_CROP/, "the legacy crop knobs are back");
  // Scaling the visible part up to the canvas height is what made the earlier attempt look zoomed.
  assert.doesNotMatch(entrypoint, /scale=\$\{OUT_W\}:\$\{OUT_H\}/, "the picture is stretched to the canvas");
});

test("the vertical layout derives a render height that fills the canvas", () => {
  const preset = entrypoint.match(
    /vertical\)\s+DEF_OUT_W=(\d+);\s*DEF_OUT_H=(\d+);\s*DEF_CAP_H=\d+;\s*FILL_CANVAS=1/,
  );
  assert.ok(preset, "the vertical preset no longer fills the canvas");
  const [, outW = 0, outH = 0] = preset.map(Number);
  assert.match(entrypoint, /^CAP_W=\$OUT_W$/m, "the client must render at the canvas width");

  // Mirror the derivation from the entrypoint: rows for the canvas plus the rows the two bands take.
  const bandPct = 20; // the STREAM_BAND_PERCENT default, checked in the test above
  let capH = Math.floor((outW * outH * 100) / (outW * (100 - 2 * bandPct)));
  if (capH % 2) capH += 1;

  const band = Math.floor((capH * bandPct) / 100 / 2) * 2;
  const viewH = capH - 2 * band;
  const gameH = Math.min(outH, Math.floor((outW * viewH) / outW / 2) * 2);

  assert.equal(capH, 2134, "the derived render height changed");
  assert.ok(gameH >= outH, `the vertical layout leaves ${outH - gameH}px of padding`);
  assert.match(
    entrypoint,
    /CAP_H=\$\(\( \(CAP_W \* OUT_H \* 100\) \/ \(OUT_W \* \(100 - 2 \* BAND_PCT\)\) \)\)/,
    "the render height must be derived, not hard-coded",
  );
});

test("the visible part is centred on the canvas", () => {
  assert.match(entrypoint, /PAD_Y=\$\(\( \(OUT_H - GAME_H\) \/ 2 \)\)/, "the band crop is not centred");
  assert.doesNotMatch(entrypoint, /PAD_Y=\$TOP/, "the fixed top offset is back");
});

test("the spectator overlay is switched off with the client cvars that exist", () => {
  for (const cvar of ["spec_drawstatus", "spec_drawnames", "spec_drawcone", "spec_decal"]) {
    assert.match(entrypoint, new RegExp(`echo "${cvar} 0"`), `${cvar} is never written to userconfig`);
  }

  // `hud_draw 0` would remove the translucent bars completely, but it also removes the whole HUD -
  // health, armour, ammo, radar, kill feed and the server's hudmessage. Tried on frames and rejected:
  // the HUD is what makes the picture readable as a game.
  assert.doesNotMatch(entrypoint, /echo "hud_draw 0"/, "hud_draw 0 takes the whole HUD with the bars");

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
