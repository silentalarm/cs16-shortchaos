/**
 * team_war - "which team kills more" scoreboard for the stream.
 *
 * The server runs free for all with friendly fire on (yb_csdm_mode 2, mp_friendlyfire 1), so a team
 * kill is an ordinary event here. It still counts as a frag for the killer's team: the race is
 * "which side puts more bodies down", not the engine scoreboard, which subtracts a frag for a TK.
 * Every frag is counted here by hand: the engine's own score would punish a team kill.
 *
 * The score lives until the map changes: no per-round reset, no donation needed.
 *
 * HUD: this plugin does not draw anything itself. The client keeps one hudmessage per tick and
 * stream_cam's name/HP line overwrote a second one every second, so the score is published as
 * cvars and stream_cam renders one three-line block above that line:
 *   T 12 : 9 CT
 *   TOP T Name 7   |   TOP CT Name 5
 *   Name 100 HP 0 AR
 *
 * Contract (RCON):
 *   amx_team_war status   -> t=<n> ct=<n> top_t=<name>:<frags> top_ct=<name>:<frags>
 *   amx_team_war reset    -> drops every counter (a new map resets them on its own)
 *   amx_full_status       -> the same line plus the camera target and the duel state in one reply
 *                            (see CmdFullStatus: RCON serialises, so one round-trip beats three)
 *
 * Cvars: team_war_t / team_war_ct (score), team_war_top_t / team_war_top_ct ("name frags"),
 * team_war_name_len (14).
 */
#include <amxmodx>
#include <fun>

#define PLUGIN_NAME "Team War"
#define PLUGIN_VERSION "1.0.0"

// get_user_team() returns the CS team index: 1 = T, 2 = CT, 3 = spectator.
#define TEAM_T 1
#define TEAM_CT 2

// Not `MAX_SLOTS`: amxconst.inc already owns that name (32), and redefining it here aborts amxxpc
// with std::bad_alloc instead of a readable error.
#define MAX_SLOTS 33
#define NAME_LEN 32

#define HUD_REFRESH 1.0

new g_frags[MAX_SLOTS];
new g_teamFrags[3];
new g_lastLeader;
new g_ticks;

new cvar_nameLen;

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-shortchaos");
	register_srvcmd("amx_team_war", "CmdTeamWar");
	// One reply for the whole panel: see CmdFullStatus for why the three probes were merged.
	register_srvcmd("amx_full_status", "CmdFullStatus");

	// DeathMsg: 1 = killer, 2 = victim.
	register_event("DeathMsg", "OnDeathMsg", "a");

	cvar_nameLen = register_cvar("team_war_name_len", "14");
	// Read by stream_cam, which owns the only hudmessage this client renders: a second message sent
	// from here was overwritten every second by the name/HP line (checked on stream frames).
	register_cvar("team_war_t", "0");
	register_cvar("team_war_ct", "0");
	register_cvar("team_war_top_t", "-");
	register_cvar("team_war_top_ct", "-");

	// Format placeholders, not literal concatenation: amxxpc aborts with std::bad_alloc on a string
	// literal glued to a #define string (`"loaded " PLUGIN_VERSION ": ..."`).
	log_amx("loaded %s: top names %d chars", PLUGIN_VERSION, get_pcvar_num(cvar_nameLen));
}

public plugin_cfg()
{
	set_task(HUD_REFRESH, "TaskHud", 0, "", 0, "b");
}

/* Player ids are reused by the engine: a fresh client starts with a clean counter, otherwise a
   rejoined bot inherits somebody else's frags. */
public client_putinserver(id)
{
	if (id > 0 && id < MAX_SLOTS)
		g_frags[id] = 0;
}

/* Publishes the score once a second. The line itself is drawn by stream_cam: this client renders a
   single hudmessage, and a second one sent from here disappeared under the name/HP line on every
   frame (0.32 vs 0.22 made no difference, the later message simply wins). */
public TaskHud()
{
	new tTop[NAME_LEN];
	new ctTop[NAME_LEN];
	new tFrags;
	new ctFrags;
	FindTop(TEAM_T, tTop, charsmax(tTop), tFrags);
	FindTop(TEAM_CT, ctTop, charsmax(ctTop), ctFrags);

	new value[NAME_LEN + 8];

	format(value, charsmax(value), "%d", g_teamFrags[TEAM_T]);
	set_cvar_string("team_war_t", value);
	format(value, charsmax(value), "%d", g_teamFrags[TEAM_CT]);
	set_cvar_string("team_war_ct", value);

	format(value, charsmax(value), "%s %d", tTop, tFrags);
	set_cvar_string("team_war_top_t", value);
	format(value, charsmax(value), "%s %d", ctTop, ctFrags);
	set_cvar_string("team_war_top_ct", value);

	// One line a minute: the only trace of the race in the server log, and what tells an empty score
	// (no kills yet) apart from a plugin that stopped counting.
	if (++g_ticks % 60 == 0)
		log_amx("score: T %d : %d CT", g_teamFrags[TEAM_T], g_teamFrags[TEAM_CT]);
}

public OnDeathMsg()
{
	new killer = read_data(1);
	new victim = read_data(2);

	// A suicide or a world death ("fell to a clumsy, painful death") has nobody to credit.
	if (killer <= 0 || killer == victim || !is_user_connected(killer))
		return;

	new team = get_user_team(killer);
	if (team != TEAM_T && team != TEAM_CT)
		return;

	// Deliberately no victim-team check: friendly fire is on, and a team kill counts for the
	// killer's side - that is the rule the stream follows.
	g_frags[killer]++;
	g_teamFrags[team]++;

	ReportLead();
}

stock ReportLead()
{
	new leader;
	if (g_teamFrags[TEAM_T] > g_teamFrags[TEAM_CT])
		leader = TEAM_T;
	else if (g_teamFrags[TEAM_CT] > g_teamFrags[TEAM_T])
		leader = TEAM_CT;

	// Only a change of leader is announced: one chat line per frag would bury the kill feed.
	if (leader == 0 || leader == g_lastLeader)
		return;

	g_lastLeader = leader;
	if (leader == TEAM_T)
		client_print(0, print_chat, "[TEAM WAR] T LEADS %d : %d", g_teamFrags[TEAM_T], g_teamFrags[TEAM_CT]);
	else
		client_print(0, print_chat, "[TEAM WAR] CT LEADS %d : %d", g_teamFrags[TEAM_T], g_teamFrags[TEAM_CT]);
}

/* Best fragger of one team. A disconnected id keeps its counter until the next connect, so only
   connected players are read here. */
stock FindTop(team, out[], len, &frags)
{
	new best;
	frags = 0;
	copy(out, len, "-");

	for (new id = 1; id <= get_maxplayers() && id < MAX_SLOTS; id++)
	{
		if (g_frags[id] < 1 || !is_user_connected(id))
			continue;
		if (get_user_team(id) != team)
			continue;

		if (g_frags[id] > frags)
		{
			frags = g_frags[id];
			best = id;
		}
	}

	if (best <= 0)
		return;

	new name[NAME_LEN];
	get_user_name(best, name, charsmax(name));
	TrimName(name, get_pcvar_num(cvar_nameLen));
	copy(out, len, name);
}

/* The HUD line is fixed width: a long nickname pushes the CT side out of the frame. */
stock TrimName(name[], maxChars)
{
	if (maxChars < 3)
		maxChars = 3;
	if (maxChars > NAME_LEN - 1)
		maxChars = NAME_LEN - 1;

	if (strlen(name) > maxChars)
	{
		name[maxChars - 2] = '.';
		name[maxChars - 1] = '.';
		name[maxChars] = '^0';
	}
}

/**
 * Prints the score line. Shared by `amx_team_war status` and `amx_full_status` so the two replies
 * can never drift apart.
 *
 * A nickname can contain spaces, and a key=value line with spaces in a value is unreadable in the
 * log: underscores stand for them here, the HUD keeps the real name.
 */
stock PrintScoreLine()
{
	new tTop[NAME_LEN];
	new ctTop[NAME_LEN];
	new tFrags;
	new ctFrags;
	FindTop(TEAM_T, tTop, charsmax(tTop), tFrags);
	FindTop(TEAM_CT, ctTop, charsmax(ctTop), ctFrags);
	replace_all(tTop, charsmax(tTop), " ", "_");
	replace_all(ctTop, charsmax(ctTop), " ", "_");
	server_print("team_war status: t=%d ct=%d top_t=%s:%d top_ct=%s:%d",
		g_teamFrags[TEAM_T], g_teamFrags[TEAM_CT], tTop, tFrags, ctTop, ctFrags);
}

/**
 * The whole panel in one RCON reply.
 *
 * RCON runs over UDP without a request id and the control API serialises its commands, so three
 * probes in a tick cost three round-trips plus the client's idle wait - and a paid activity queues
 * behind every one of them. This prints the three lines the panel already parses, read from the
 * cvars the other plugins publish: a copy of the numbers would be a second source of truth that
 * could disagree with the game.
 *
 * Contract (RCON): amx_full_status ->
 *   team_war status: t=<n> ct=<n> top_t=<name>:<frags> top_ct=<name>:<frags>
 *   stream_cam status: target=<name|-> hp=<n> ar=<n>
 *   map_duel status: state=<idle|live|done> winner=<name|->
 */
public CmdFullStatus(id, level, cid)
{
	new target[NAME_LEN];
	get_cvar_string("stcam_name", target, charsmax(target));
	if (target[0] == '^0')
		copy(target, charsmax(target), "-");

	new hp[8];
	new armor[8];
	get_cvar_string("stcam_hp", hp, charsmax(hp));
	get_cvar_string("stcam_ar", armor, charsmax(armor));
	if (hp[0] == '^0')
		copy(hp, charsmax(hp), "0");
	if (armor[0] == '^0')
		copy(armor, charsmax(armor), "0");
	server_print("stream_cam status: target=%s hp=%s ar=%s", target, hp, armor);

	// `state` is a Pawn keyword (state machines): the locals are named around it on purpose.
	new duelState[16];
	new duelWinner[NAME_LEN];
	get_cvar_string("map_duel_state", duelState, charsmax(duelState));
	get_cvar_string("map_duel_winner", duelWinner, charsmax(duelWinner));
	if (duelState[0] == '^0')
		copy(duelState, charsmax(duelState), "idle");
	if (duelWinner[0] == '^0')
		copy(duelWinner, charsmax(duelWinner), "-");
	// The cvar holds the name as the player typed it; the line has to stay one token per value.
	replace_all(duelWinner, charsmax(duelWinner), " ", "_");
	server_print("map_duel status: state=%s winner=%s", duelState, duelWinner);

	PrintScoreLine();
	return PLUGIN_HANDLED;
}

public CmdTeamWar(id, level, cid)
{
	new command[16];
	read_argv(1, command, charsmax(command));

	if (equal(command, "status"))
	{
		PrintScoreLine();
		return PLUGIN_HANDLED;
	}

	if (equal(command, "reset"))
	{
		for (new i = 0; i < MAX_SLOTS; i++)
			g_frags[i] = 0;
		g_teamFrags[TEAM_T] = 0;
		g_teamFrags[TEAM_CT] = 0;
		g_lastLeader = 0;
		log_amx("score reset by request");
		server_print("team_war reset");
		return PLUGIN_HANDLED;
	}

	server_print("team_war usage: amx_team_war <status|reset>");
	return PLUGIN_HANDLED;
}
