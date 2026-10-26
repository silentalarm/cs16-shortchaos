/**
 * stream_cam - the game server drives the camera of the autonomous stream client.
 *
 * Why the server and not the client: the capture client is a normal player that never presses a
 * key, so it cannot know whether the bot it follows is alive, and a client-side spec_next timer
 * kept parking the picture on a dead body (or on the "choose a team" VGUI panel, which is what
 * froze the first live stream). The server knows who is alive and who is moving, so it points the
 * camera itself through the observer entity fields.
 *
 * What it does:
 *   - recognises the stream client by nickname (stcam_spectator) and keeps it on the SPECTATOR team,
 *     re-sending `jointeam 6` right after the connect, which is the only way to close the team menu;
 *   - every second it samples how far each living player moved, so "camera target" means "somebody
 *     who is actually running around", not "somebody who happens to be closest";
 *   - every stcam_interval seconds it aims the camera at the most active player, never at the same
 *     one twice in a row while there is a choice.
 *
 * RCON contract (docs/runbook.md):
 *   amx_stcam status -> "stream_cam status: enabled=1 interval=8.0 mode=4 spectator=<name> target=<name> candidates=<n>"
 *
 * cvars: stcam_enable 1, stcam_interval 8.0, stcam_avoid_repeat 1, stcam_mode 4 (OBS_IN_EYE),
 *        stcam_spectator "StreamCam".
 */
#include <amxmodx>
#include <fakemeta>
#include <cstrike>

#define PLUGIN_NAME "Stream Camera"
#define PLUGIN_VERSION "0.1.0"

#define TASK_TICK 42001
#define MAX_PLAYERS 32
#define NAME_LEN 32
#define TEAM_SPECTATOR 3

new Float:g_prevOrigin[MAX_PLAYERS + 1][3];
new bool:g_hasOrigin[MAX_PLAYERS + 1];
new Float:g_activity[MAX_PLAYERS + 1];

new g_camId;
new g_target;
new Float:g_switchIn;

new cvar_enabled;
new cvar_interval;
new cvar_avoidRepeat;
new cvar_specName;
new cvar_mode;

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-youtube");

	cvar_enabled     = register_cvar("stcam_enable", "1");
	cvar_interval    = register_cvar("stcam_interval", "8.0");
	cvar_avoidRepeat = register_cvar("stcam_avoid_repeat", "1");
	cvar_specName    = register_cvar("stcam_spectator", "StreamCam");
	cvar_mode        = register_cvar("stcam_mode", "4");

	register_srvcmd("amx_stcam", "CmdStreamCam");

	set_task(1.0, "TaskTick", TASK_TICK, "", 0, "b");

	log_amx("loaded %s: interval %.1fs, mode %d", PLUGIN_VERSION, get_pcvar_float(cvar_interval), get_pcvar_num(cvar_mode));
}

public client_putinserver(id)
{
	g_hasOrigin[id] = false;
	g_activity[id] = 0.0;

	if (!IsStreamClient(id))
		return;

	g_camId = id;
	g_target = 0;
	g_switchIn = 0.0;

	new name[NAME_LEN];
	get_user_name(id, name, charsmax(name));
	log_amx("stream client is on the server: %s", name);

	// The client opens its "SELECT TEAM" VGUI panel the moment it receives a team of 0, and it never
	// closes that panel when the team changes afterwards: verified on the live stream that
	// `jointeam 6`, `menuselect 6` and `cancelselect` all left it on screen while the server already
	// reported the client as SPECTATOR. Assigning the team here runs before "entered the game", so
	// the first TeamInfo the client sees already says SPECTATOR and the panel does not open at all.
	cs_set_user_team(id, CS_TEAM_SPECTATOR);

	// Belt and braces for the case where the client still shows the panel: a jointeam is what the
	// SPECTATE button itself sends.
	set_task(1.0, "TaskJoinSpectator", id);
	set_task(4.0, "TaskJoinSpectator", id);
	set_task(9.0, "TaskJoinSpectator", id);
	set_task(15.0, "TaskJoinSpectator", id);
}

public client_disconnected(id)
{
	if (id == g_camId)
	{
		g_camId = 0;
		g_target = 0;
		g_switchIn = 0.0;
	}
	if (id == g_target)
		g_target = 0;

	g_hasOrigin[id] = false;
	g_activity[id] = 0.0;
}

public TaskJoinSpectator(id)
{
	if (!is_user_connected(id) || !IsStreamClient(id))
		return;

	client_cmd(id, "jointeam 6");
}

public TaskTick()
{
	if (!get_pcvar_num(cvar_enabled))
		return;

	if (g_camId > 0 && !IsStreamClient(g_camId))
		g_camId = 0;

	if (!g_camId)
		g_camId = FindStreamClient();

	if (!g_camId)
	{
		g_target = 0;
		return;
	}

	// Self-healing: the team can be reset by a map change or a late join, and a client without a
	// team is a client with the "SELECT TEAM" panel on screen.
	if (get_user_team(g_camId) != TEAM_SPECTATOR)
	{
		cs_set_user_team(g_camId, CS_TEAM_SPECTATOR);
		client_cmd(g_camId, "jointeam 6");
	}

	UpdateActivity();

	g_switchIn -= 1.0;
	if (g_switchIn <= 0.0 || !IsPlayable(g_target))
	{
		ChooseTarget();
		g_switchIn = get_pcvar_float(cvar_interval);
	}

	if (g_target > 0)
	{
		// pev_iuser1 is m_iObserverMode, pev_iuser2 is m_hObserverTarget (HL SDK entity fields).
		set_pev(g_camId, pev_iuser1, get_pcvar_num(cvar_mode));
		set_pev(g_camId, pev_iuser2, g_target);
	}
}

/**
 * Movement score per player: distance travelled since the previous second, with decay, so a bot
 * that sprinted once does not own the camera until the end of the round.
 */
stock UpdateActivity()
{
	new Float:origin[3];

	for (new id = 1; id <= MAX_PLAYERS; id++)
	{
		if (!IsPlayable(id))
		{
			g_hasOrigin[id] = false;
			g_activity[id] = (g_activity[id] > 0.5) ? (g_activity[id] - 0.5) : 0.0;
			continue;
		}

		pev(id, pev_origin, origin);
		if (!g_hasOrigin[id])
		{
			g_prevOrigin[id][0] = origin[0];
			g_prevOrigin[id][1] = origin[1];
			g_prevOrigin[id][2] = origin[2];
			g_hasOrigin[id] = true;
			continue;
		}

		new Float:delta = vector_distance(origin, g_prevOrigin[id]);
		g_prevOrigin[id][0] = origin[0];
		g_prevOrigin[id][1] = origin[1];
		g_prevOrigin[id][2] = origin[2];

		g_activity[id] = g_activity[id] * 0.75 + delta;
	}
}

stock ChooseTarget()
{
	new best;
	new candidates;
	new Float:bestScore = -1.0;

	for (new id = 1; id <= MAX_PLAYERS; id++)
	{
		if (!IsPlayable(id))
			continue;

		candidates++;

		new Float:score = g_activity[id];
		if (id == g_target && get_pcvar_num(cvar_avoidRepeat))
			score -= 1000.0;

		if (score > bestScore)
		{
			bestScore = score;
			best = id;
		}
	}

	new previous[NAME_LEN] = "none";
	if (g_target > 0 && is_user_connected(g_target))
		get_user_name(g_target, previous, charsmax(previous));

	g_target = best;
	if (!g_target)
		return;

	new name[NAME_LEN];
	get_user_name(g_target, name, charsmax(name));
	log_amx("camera target %s (score %.0f, was %s, candidates %d)", name, bestScore, previous, candidates);
}

stock FindStreamClient()
{
	for (new id = 1; id <= MAX_PLAYERS; id++)
	{
		if (IsStreamClient(id))
			return id;
	}
	return 0;
}

/**
 * The client is a real (non-bot) connection whose nickname contains stcam_spectator. The
 * spectator-team check is a fallback for a renamed client: humans are not allowed on this server,
 * so a non-bot that is not playing can only be the camera.
 */
stock bool:IsStreamClient(id)
{
	if (id <= 0 || id > MAX_PLAYERS)
		return false;
	if (!is_user_connected(id) || is_user_bot(id) || is_user_hltv(id))
		return false;

	new name[NAME_LEN];
	new match[NAME_LEN];
	get_user_name(id, name, charsmax(name));
	get_pcvar_string(cvar_specName, match, charsmax(match));

	if (match[0] && containi(name, match) != -1)
		return true;

	return get_user_team(id) == TEAM_SPECTATOR;
}

stock bool:IsPlayable(id)
{
	if (id <= 0 || id > MAX_PLAYERS)
		return false;
	if (id == g_camId)
		return false;
	if (!is_user_connected(id) || !is_user_alive(id))
		return false;
	return true;
}

public CmdStreamCam(id, level, cid)
{
	new arg[16];
	read_argv(1, arg, charsmax(arg));

	if (equal(arg, "cmd"))
	{
		// Troubleshooting lever: `amx_stcam cmd <client command>` types a command into the camera
		// client. Needed because the "SELECT TEAM" VGUI panel is client-side and there is no other
		// way to find what closes it on a headless client. RCON-only, never reachable in game.
		new cmd[32], extra[32];
		read_argv(2, cmd, charsmax(cmd));
		read_argv(3, extra, charsmax(extra));

		if (!g_camId)
		{
			server_print("stream_cam: no camera client connected");
			return PLUGIN_HANDLED;
		}

		new line[72];
		if (extra[0])
			formatex(line, charsmax(line), "%s %s", cmd, extra);
		else
			copy(line, charsmax(line), cmd);

		client_cmd(g_camId, "%s", line);
		server_print("stream_cam: sent '%s' to the camera client", line);
		return PLUGIN_HANDLED;
	}

	if (!equal(arg, "status"))
	{
		server_print("stream_cam usage: amx_stcam status | amx_stcam cmd <client command> [arg]");
		return PLUGIN_HANDLED;
	}

	new spectator[NAME_LEN] = "none";
	new target[NAME_LEN] = "none";
	new candidates;

	if (g_camId > 0 && is_user_connected(g_camId))
		get_user_name(g_camId, spectator, charsmax(spectator));
	if (g_target > 0 && is_user_connected(g_target))
		get_user_name(g_target, target, charsmax(target));

	for (new i = 1; i <= MAX_PLAYERS; i++)
	{
		if (IsPlayable(i))
			candidates++;
	}

	// One line, key=value, no spaces inside values: docs/runbook.md greps exactly this.
	server_print("stream_cam status: enabled=%d interval=%.1f mode=%d spectator=%s target=%s candidates=%d",
		get_pcvar_num(cvar_enabled), get_pcvar_float(cvar_interval), get_pcvar_num(cvar_mode),
		spectator, target, candidates);

	return PLUGIN_HANDLED;
}
