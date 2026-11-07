/**
 * team_semiclip - teammates pass through each other.
 *
 * Twenty bots on fy_iceworld is twenty bodies in a room the size of a bus. The engine keeps teammates
 * solid, so a bot whose spawn exit is occupied pushes into the back of the bot standing there and stays
 * there: from the chase camera that is a bot that simply stopped, which is one of the two complaints this
 * plugin answers. The bot's own navigation knows nothing about the other body either, so
 * `yb_has_team_semiclip 1` (infra/entrypoint.sh) tells YaPB a teammate is not an obstacle.
 *
 * How: one pass every SEMICLIP_INTERVAL (0.025 s) over all alive players, not a per-player forward.
 *  1. every alive player is put back to SOLID_SLIDEBOX;
 *  2. any two alive players of the same team closer than `team_semiclip_radius` (36) units are both set
 *     to SOLID_NOT for the next pass.
 * The reset in step 1 is what guarantees nobody stays transparent: there is no state to leak on a death,
 * a team change or a map end, and turning the cvar off restores everybody within one pass. Enemies stay
 * solid on purpose - a bot passing through an enemy would make the firefight unreadable.
 *
 * Known cost: while two teammates overlap, hitscan passes through them. `mp_friendlyfire` is 0 in
 * infra/server.cfg, so nothing is lost today; with friendly fire switched on, a team kill at that distance
 * would stop being possible. The radius is just above the 32-unit player hull, so the window is the moment
 * the two actually touch.
 *
 * Contract (RCON):
 *   amx_semiclip -> team_semiclip: enabled=<0|1> radius=<n> transparent=<n>
 *
 * Cvars: team_semiclip_enabled (1), team_semiclip_radius (36).
 */
#include <amxmodx>
#include <fakemeta>

#define PLUGIN_NAME "Team Semiclip"
#define PLUGIN_VERSION "1.0.0"

// Not `MAX_SLOTS` from amxconst.inc: it already defines one (32), and redefining it aborts amxxpc with
// std::bad_alloc instead of a readable error.
#define MAX_SLOTS 33

// 40 passes a second: a bot at 250 u/s covers 6 units between two passes, so it cannot get inside a
// teammate without becoming transparent first.
#define SEMICLIP_INTERVAL 0.025

// Our own task id: csdm_lite, map_duel and bot_antistuck use 0, 4700 and 4701..4733.
#define TASK_SEMICLIP 4800

// get_user_team() returns the CS team index: 1 = T, 2 = CT, 3 = spectator.
#define TEAM_T 1
#define TEAM_CT 2

new g_cvarEnabled;
new g_cvarRadius;

new g_players[MAX_SLOTS];
new g_count;
new g_transparent;

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-shortchaos");
	register_srvcmd("amx_semiclip", "CmdSemiclip");

	g_cvarEnabled = register_cvar("team_semiclip_enabled", "1");
	g_cvarRadius = register_cvar("team_semiclip_radius", "36");

	// Format placeholders, not literal concatenation: amxxpc aborts with std::bad_alloc on a string
	// literal glued to a #define string.
	log_amx("loaded %s: radius %d units", PLUGIN_VERSION, get_pcvar_num(g_cvarRadius));
}

public plugin_cfg()
{
	set_task(SEMICLIP_INTERVAL, "TaskSemiclip", TASK_SEMICLIP, "", 0, "b");
}

public TaskSemiclip()
{
	g_count = 0;
	g_transparent = 0;

	// The restore pass runs before the early returns on purpose: a bot that died or changed team since the
	// previous pass must not be left transparent, and switching team_semiclip_enabled off has to bring
	// every body back within one pass.
	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (!is_user_alive(id))
			continue;

		set_pev(id, pev_solid, SOLID_SLIDEBOX);
		g_players[g_count++] = id;
	}

	if (!get_pcvar_num(g_cvarEnabled) || g_count < 2)
		return;

	new Float:origin[MAX_SLOTS][3];
	for (new i = 0; i < g_count; i++)
		pev(g_players[i], pev_origin, origin[i]);

	new Float:radius = get_pcvar_float(g_cvarRadius);
	new Float:limit = radius * radius;

	for (new i = 0; i < g_count; i++)
	{
		new team = get_user_team(g_players[i]);
		if (team != TEAM_T && team != TEAM_CT)
			continue;

		for (new j = i + 1; j < g_count; j++)
		{
			if (get_user_team(g_players[j]) != team)
				continue;

			if (DistanceSquared(origin[i], origin[j]) > limit)
				continue;

			set_pev(g_players[i], pev_solid, SOLID_NOT);
			set_pev(g_players[j], pev_solid, SOLID_NOT);
		}
	}

	for (new i = 0; i < g_count; i++)
	{
		if (pev(g_players[i], pev_solid) == SOLID_NOT)
			g_transparent++;
	}
}

/**
 * One line for a hand check from RCON: how many bodies are passing through each other right now.
 */
public CmdSemiclip(id, level, cid)
{
	server_print("team_semiclip: enabled=%d radius=%d transparent=%d",
		get_pcvar_num(g_cvarEnabled), get_pcvar_num(g_cvarRadius), g_transparent);
	return PLUGIN_HANDLED;
}

stock Float:DistanceSquared(const Float:a[3], const Float:b[3])
{
	new Float:dx = a[0] - b[0];
	new Float:dy = a[1] - b[1];
	new Float:dz = a[2] - b[2];
	return dx * dx + dy * dy + dz * dz;
}
