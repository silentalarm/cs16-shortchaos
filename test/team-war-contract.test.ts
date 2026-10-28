import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * team_war is the stream's scoreboard: a race between T and CT that runs for the whole map.
 * Two details decide whether the feature works at all and are invisible without a game server:
 * a team kill has to count for the killer's team (the engine subtracts a frag for it), and the HUD
 * block has to sit in the band the encoder keeps, above the camera line stream_cam draws.
 */
const plugin = readFileSync(new URL("../plugins/team_war/team_war.sma", import.meta.url), "utf8");
const streamCam = readFileSync(new URL("../plugins/stream_cam/stream_cam.sma", import.meta.url), "utf8");
const pluginsIni = readFileSync(new URL("../infra/plugins.ini", import.meta.url), "utf8");

function defineValue(source: string, name: string): number | null {
  const match = new RegExp(`#define ${name} ([0-9.]+)`).exec(source);
  return match ? Number(match[1]) : null;
}

/** Vertical anchor of the plugin's own hudmessage: a literal or the define it is written with. */
function hudAnchor(source: string): number {
  const call = /set_hudmessage\([^;]*?-1\.0,\s*([0-9.]+|[A-Z_]+),/.exec(source)?.[1];
  assert.ok(call, "no hudmessage with a vertical anchor in the plugin");

  if (/^[0-9.]+$/.test(call)) return Number(call);

  const value = defineValue(source, call);
  assert.ok(value !== null, `define ${call} has no numeric value`);
  return value;
}

function onDeathMsg(): string {
  return /public OnDeathMsg\(\)\s*\{[\s\S]*?\n\}/.exec(plugin)?.[0] ?? "";
}

test("the plugin is loaded and follows the kill feed", () => {
  assert.match(pluginsIni, /^team_war\.amxx$/m, "infra/plugins.ini does not load team_war.amxx");
  assert.match(plugin, /register_event\("DeathMsg", "OnDeathMsg", "a"\)/);
  assert.match(plugin, /register_srvcmd\("amx_team_war"/);
  assert.match(onDeathMsg(), /read_data\(1\)/, "the killer is not read from DeathMsg");
});

test("a team kill counts for the killer's team", () => {
  const handler = onDeathMsg();
  // Whoever the victim is: a TK adds a frag to the killer's side. That is why the engine counter
  // (get_user_frags) is not used anywhere in this plugin - it subtracts one for a TK.
  assert.match(handler, /get_user_team\(killer\)/, "the killer's team is never looked up");
  assert.match(handler, /g_teamFrags\[team\]\+\+/, "the team counter is not incremented");
  assert.match(handler, /g_frags\[killer\]\+\+/, "the per-player counter is not incremented");
  assert.doesNotMatch(handler, /get_user_team\(victim\)/, "a team kill is filtered out again");
  assert.doesNotMatch(handler, /g_frags\[killer\]--/, "a team kill penalises the killer");
  assert.doesNotMatch(plugin, /get_user_frags/, "the engine score would not count team kills");
});

test("the score runs until the map changes", () => {
  // No Round_End handler: a per-round reset would turn a map-long race into a round score.
  assert.doesNotMatch(plugin, /Round_End/, "the score is reset per round");
  assert.doesNotMatch(plugin, /OnRoundEnd/, "the score is reset per round");
  assert.match(plugin, /amx_team_war reset/, "there is no way to clear the score by hand");
});

test("the score is published for the HUD that is actually drawn", () => {
  // The client renders a single hudmessage: the block this plugin used to send was overwritten by
  // the camera's name/HP line every second (checked on stream frames). The score now travels as
  // cvars and stream_cam draws it inside its one message.
  for (const cvar of ["team_war_t", "team_war_ct", "team_war_top_t", "team_war_top_ct"]) {
    assert.match(plugin, new RegExp(`register_cvar\\("${cvar}"`), `${cvar} is not registered`);
    assert.match(plugin, new RegExp(`set_cvar_string\\("${cvar}"`), `${cvar} is never updated`);
  }
  assert.doesNotMatch(plugin, /set_hudmessage|show_hudmessage/, "the plugin draws its own HUD again");
});

test("stream_cam draws both team tops above the name/HP line", () => {
  assert.match(
    streamCam,
    /"T %s : %s CT\^nTOP T %s {2}\| {2}TOP CT %s\^n%s {3}%d HP {3}%d AR"/,
    "the three-line HUD block changed",
  );
  assert.match(streamCam, /get_cvar_string\("team_war_t"/, "the camera never reads the score");
  assert.match(streamCam, /get_cvar_string\("team_war_top_ct"/, "the camera never reads the CT top");
  // The message dies after a couple of seconds, so it has to be refreshed faster than that.
  const refresh = Number(/#define HUD_REFRESH ([0-9.]+)/.exec(plugin)?.[1]);
  assert.ok(refresh > 0 && refresh < 2, `HUD_REFRESH ${refresh} would let the scoreline blink out`);
});

test("the score block sits inside the frame", () => {
  // The encoder cuts the client's two 20% bands: a message anchored at or above 0.20 loses its
  // glyph tops. The block is three lines, so it starts where the single line used to start.
  const anchor = hudAnchor(streamCam);
  assert.ok(anchor > 0.2, `the HUD block at ${anchor} is clipped by the band cut`);
});

test("the status probe reports both scores and both tops", () => {
  const status = /server_print\("team_war status:([^"]+)"/.exec(plugin)?.[1] ?? "";
  for (const key of ["t=", "ct=", "top_t=", "top_ct="]) {
    assert.match(status, new RegExp(key), `amx_team_war status lost ${key}`);
  }
});
