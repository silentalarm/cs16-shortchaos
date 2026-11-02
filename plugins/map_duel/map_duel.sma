/**
 * map_duel - the last fight of the map: the best bot of each team, then the map changes.
 *
 * Why the plugin owns the rotation: rounds are endless now (`mp_roundtime 9`, the engine clamps the
 * cvar at nine minutes, `mp_timelimit 0`), so
 * the engine never rotates a map on its own. A map lives exactly `map_duel_minutes`; `map_duel_prepare`
 * seconds before the end every bot except the two finalists is killed, respawns are switched off
 * (`csdm_lite_enabled 0`) and chaos is muted (`chaos_enabled 0`) - both would otherwise rebuild the
 * field in the middle of the fight.
 *
 * The finalists are one per team, the same two bots the panel shows as TOP T and TOP CT: the frag
 * counting here repeats team_war's rule (a team kill counts for the killer's team, the engine score
 * does not), so the panel and the duel cannot disagree. Both get 100 hp, no armour and the same
 * random primary; the first to die loses.
 *
 * The field is kept empty: a Ham_Spawn hook kills whatever the engine revives when a round restarts
 * and re-arms a finalist the engine respawns. One finalist per team also means no team is ever wiped
 * while the duel runs, so the round cannot end under it and reset the fight.
 *
 * Nothing is drawn by the game: the winner's name goes into a cvar and the panel draws it, the same
 * way the score reaches the stream.
 *
 * Contract (RCON):
 *   amx_map_duel status -> map_duel status: state=<idle|live|done> winner=<name|->
 *
 * Cvars: map_duel_enabled (1), map_duel_minutes (10), map_duel_prepare (45), map_duel_limit (45),
 * map_duel_weapons, map_duel_maps, map_duel_winner ("-", published), map_duel_state (published),
 * map_duel_touched (internal: set while the duel has the other plugins muted).
 */
#include <amxmodx>
#include <fakemeta>
#include <fun>
// ExecuteHamB lives in hamsandwich, not in fakemeta: without this include the compiler has no
// prototype for it and aborts instead of reporting an undefined symbol.
#include <hamsandwich>

#define PLUGIN_NAME "Map Duel"
#define PLUGIN_VERSION "1.0.0"

// get_user_team() returns the CS team index: 1 = T, 2 = CT, 3 = spectator.
#define TEAM_T 1
#define TEAM_CT 2

// Not `MAX_SLOTS`: amxconst.inc already owns that name, and redefining it aborts amxxpc.
#define SLOTS 33
#define NAME_LEN 32
#define WEAPON_LEN 24
#define MAP_LEN 32
#define LIST_LEN 256

#define STATE_IDLE 0
#define STATE_LIVE 1
#define STATE_DONE 2

// Five seconds between the last kill and changelevel: enough for the panel to poll the winner once.
#define CHANGE_DELAY 5.0

new g_state = STATE_IDLE;
new g_frags[SLOTS];
new g_duelistT;
new g_duelistCT;
new g_weapon[WEAPON_LEN];
new g_armed;

new cvar_enabled;
new cvar_minutes;
new cvar_prepare;
new cvar_limit;
new cvar_weapons;


public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-youtube");
	register_srvcmd("amx_map_duel", "CmdMapDuel");

	// DeathMsg: 1 = killer, 2 = victim.
	register_event("DeathMsg", "OnDeathMsg", "a");
	// Ham_Spawn, post: the player is alive again, so health and weapons can be written.
	RegisterHam(Ham_Spawn, "player", "OnSpawnPost", 1);

	cvar_enabled = register_cvar("map_duel_enabled", "1");
	// How long a map lives, and how long before its end the field is cleared for the duel.
	cvar_minutes = register_cvar("map_duel_minutes", "10");
	cvar_prepare = register_cvar("map_duel_prepare", "45");
	// Two bots can stall on the map geometry; then the one with more hp wins the map.
	cvar_limit = register_cvar("map_duel_limit", "60");
	// Both finalists get the same weapon from this list: a fair fight, still a surprise.
	cvar_weapons = register_cvar("map_duel_weapons", "ak47,m4a1,awp,xm1014,p90,mp5navy");
	// The rotation, in order and wrapping around: the engine's mapcycle is not read because the
	// engine never rotates this server any more.
	// Compact fight-yard maps only, and all of them fy_*: a vertical 9:16 feed has a second or two to
	// hook a viewer, and on de_dust2 the bots spend five of them running to each other with an empty
	// field in frame. None of these ship with HLDS - they are fetched by infra/fetch-maps.ps1 and
	// pinned by SHA256 in infra/maps/maps.json (test/map-duel-contract.test.ts checks both).
	// fy_simpsons was dropped: the house has corners too tight for the bot's navigation graph, and a
	// bot that grinds a wall there is the one thing a 9:16 feed cannot sell.
	// The pool is fight-yard only: a vertical feed has a second or two to hook a viewer, and on a big
	// map the bots spend five of them running at each other. aim_* are the same kind of box; awp_snow
	// was tried and is out (its snowfall reads as noise on the feed), fy_iceworld is back because it is
	// the densest of them and the only one whose two rooms meet in the first second.
	register_cvar("map_duel_maps",
		"aim_map,aim_headshot,aim_map_2010,aim_aztecplace,aim_dust2011,aim_aspect,fy_iceworld");

	// Published for the panel (control API -> ui/panel.ts) and for the log.
	register_cvar("map_duel_winner", "-");
	register_cvar("map_duel_state", "idle");
	// Set while the duel has the other plugins muted, so the next map knows what to switch back on.
	register_cvar("map_duel_touched", "0");

	log_amx("loaded %s: map lasts %d min, duel starts %d s before the end", PLUGIN_VERSION,
		get_pcvar_num(cvar_minutes), get_pcvar_num(cvar_prepare));
}

public plugin_cfg()
{
	set_cvar_string("map_duel_winner", "-");
	set_cvar_string("map_duel_state", "idle");
	g_state = STATE_IDLE;

	// A duel that ended in changelevel muted two plugins: the new map has to arm them again.
	RestorePlugins();
	ScheduleDuel();
}

/* Player ids are reused by the engine: a fresh client starts with a clean counter, otherwise a
   rejoined bot inherits somebody else's frags. */
public client_putinserver(id)
{
	if (id > 0 && id < SLOTS)
		g_frags[id] = 0;
}

/* The engine rotates on `mp_timelimit`, and that timer would fire in the middle of the duel: the map
   now ends when this plugin says so. */
stock ScheduleDuel()
{
	if (!get_pcvar_num(cvar_enabled))
	{
		log_amx("duel: disabled, the engine keeps the rotation");
		return;
	}

	new minutes = get_pcvar_num(cvar_minutes);
	if (minutes < 1)
	{
		log_amx("duel: map_duel_minutes is %d, the engine keeps the rotation", minutes);
		return;
	}

	if (get_cvar_num("mp_timelimit") != 0)
		set_cvar_num("mp_timelimit", 0);

	new prepare = get_pcvar_num(cvar_prepare);
	new delay = minutes * 60 - prepare;
	// A map shorter than the preparation window would start with the duel, which is the one thing a
	// fresh map must not do.
	if (delay < 30)
		delay = 30;

	// Float values come from the cvar natives: an `int -> Float:` conversion in a set_task argument
	// made this compiler abort instead of reporting anything.
	new Float:fdelay = get_pcvar_float(cvar_minutes) * 60.0;
	fdelay = fdelay - get_pcvar_float(cvar_prepare);
	if (fdelay < 30.0)
		fdelay = 30.0;

	set_task(fdelay, "TaskStartDuel");
	log_amx("duel: field clears in %d s, %d s before the map ends", delay, prepare);
}

public TaskStartDuel()
{
	if (g_state != STATE_IDLE)
		return;

	if (!get_pcvar_num(cvar_enabled))
		return;

	g_duelistT = FindTop(TEAM_T);
	g_duelistCT = FindTop(TEAM_CT);

	if (!g_duelistT || !g_duelistCT)
	{
		log_amx("duel: no bot on one of the teams (t=%d ct=%d), changing the map", g_duelistT,
			g_duelistCT);
		ChangeMap();
		return;
	}

	g_state = STATE_LIVE;
	set_cvar_string("map_duel_state", "live");
	LowerPlugins();
	PickWeapon();
	ClearField();

	// Both are (re)armed after the field is cleared: a finalist may have been killed by a teammate
	// a second before the duel.
	ArmDuelist(g_duelistT);
	ArmDuelist(g_duelistCT);
	BringThemTogether();

	// Bots pick their own goals (bomb sites, hostages) and walk away from the fight: a fight nobody
	// watches is not what the last minute of a stream is for. The pair is re-anchored while the duel
	// runs, only when they drift apart.
	new Float:keep = 3.0;
	set_task(keep, "TaskKeepTogether", 0, "", 0, "b");

	new limit = get_pcvar_num(cvar_limit);
	if (limit < 5)
		limit = 5;
	new Float:flimit = get_pcvar_float(cvar_limit);
	if (flimit < 5.0)
		flimit = 5.0;
	set_task(flimit, "TaskDuelTimeout");

	log_amx("duel: t=%d ct=%d with %s, %d s limit", g_duelistT, g_duelistCT, g_weapon, limit);
}

/* The two finalists are put face to face. Measured on dust2: without this the fight never happened,
   the bots wandered for the whole limit and the winner was decided by hit points (100 vs 100, so by
   frags) - a coin toss on screen. 96 units is close enough for the bots to see each other and far
   enough not to spawn inside one another. */
stock BringThemTogether()
{
	if (!is_user_alive(g_duelistT) || !is_user_alive(g_duelistCT))
		return;

	new Float:origin[3];
	pev(g_duelistT, pev_origin, origin);

	new Float:spot[3];
	spot[0] = origin[0] + 96.0;
	spot[1] = origin[1];
	spot[2] = origin[2];

	engfunc(EngFunc_SetOrigin, g_duelistCT, spot);
	log_amx("duel: the counter-terrorist was moved next to the terrorist");
}

/* Called every few seconds while the duel runs. A finalist that ran off to a bomb site is brought
   back next to his opponent; the two are never re-anchored while they are close, so the fight is not
   teleported under the camera for no reason. */
public TaskKeepTogether()
{
	if (g_state != STATE_LIVE)
		return;

	if (!is_user_alive(g_duelistT) || !is_user_alive(g_duelistCT))
		return;

	new Float:tOrigin[3];
	new Float:ctOrigin[3];
	pev(g_duelistT, pev_origin, tOrigin);
	pev(g_duelistCT, pev_origin, ctOrigin);

	if (get_distance_f(tOrigin, ctOrigin) <= 400.0)
		return;

	BringThemTogether();
	log_amx("duel: the finalists drifted apart, they were put back together");
}

/* Everything else dies, so the fight has a stage of its own. One finalist per team stays alive, so
   no team is wiped here and the round cannot end and respawn the field. */
stock ClearField()
{
	for (new id = 1; id <= get_maxplayers() && id < SLOTS; id++)
	{
		if (!is_user_connected(id) || !is_user_alive(id) || !is_user_bot(id))
			continue;
		if (id == g_duelistT || id == g_duelistCT)
			continue;

		user_kill(id, 1);
	}
}

stock ArmDuelist(id)
{
	if (!is_user_connected(id) || !is_user_bot(id))
		return;

	// A finalist may have died a second before the duel: his own team kill, a fall.
	if (!is_user_alive(id))
		ExecuteHamB(Ham_CS_RoundRespawn, id);

	// csdm_lite hands out a second of godmode on respawn, and a duel where nobody can be hit for a
	// second is a duel the stream cannot show.
	set_user_godmode(id, 0);

	strip_user_weapons(id);
	give_item(id, "weapon_knife");

	if (g_armed)
	{
		new weapon[32];
		format(weapon, charsmax(weapon), "weapon_%s", g_weapon);
		give_item(id, weapon);
	}

	set_user_health(id, 100);
	set_user_armor(id, 0);
}

/* The engine respawns players when a round restarts, and anything but the two finalists must not be
   on the field until the map changes. */
public OnSpawnPost(id)
{
	if (g_state != STATE_LIVE)
		return;

	if (!is_user_connected(id) || !is_user_bot(id))
		return;

	if (id == g_duelistT || id == g_duelistCT)
	{
		ArmDuelist(id);
		return;
	}

	user_kill(id, 1);
}

public OnDeathMsg()
{
	new killer = read_data(1);
	new victim = read_data(2);

	// The same rule as team_war: a team kill counts for the killer's team, so the finalists are
	// exactly the two bots the panel calls TOP T and TOP CT.
	if (g_state != STATE_DONE && killer > 0 && killer != victim && is_user_connected(killer))
	{
		new team = get_user_team(killer);
		if (team == TEAM_T || team == TEAM_CT)
			g_frags[killer]++;
	}

	if (g_state != STATE_LIVE)
		return;

	if (victim != g_duelistT && victim != g_duelistCT)
		return;

	new winner;
	if (victim == g_duelistT)
		winner = g_duelistCT;
	else
		winner = g_duelistT;

	FinishDuel(winner);
}

/* Neither finalist found the other in time: more health wins, and a tie is broken by the frags the
   bot brought into the duel. */
public TaskDuelTimeout()
{
	if (g_state != STATE_LIVE)
		return;

	new hpT = 0;
	new hpCT = 0;

	if (is_user_alive(g_duelistT))
		hpT = get_user_health(g_duelistT);
	if (is_user_alive(g_duelistCT))
		hpCT = get_user_health(g_duelistCT);

	new winner;
	if (hpT > hpCT)
		winner = g_duelistT;
	else if (hpCT > hpT)
		winner = g_duelistCT;
	else if (g_frags[g_duelistT] >= g_frags[g_duelistCT])
		winner = g_duelistT;
	else
		winner = g_duelistCT;

	log_amx("duel: timeout at %d vs %d hp", hpT, hpCT);
	FinishDuel(winner);
}

stock FinishDuel(winner)
{
	if (g_state != STATE_LIVE)
		return;

	g_state = STATE_DONE;
	set_cvar_string("map_duel_state", "done");
	// The keep-together task is a repeating one: it has to stop before the changelevel task is
	// scheduled, or removing every task of id 0 would take the map change with it.
	remove_task(0);

	new name[NAME_LEN];
	if (winner > 0 && is_user_connected(winner))
		get_user_name(winner, name, charsmax(name));
	else
		copy(name, charsmax(name), "-");

	// The panel polls this once a second and prints "WINNER: <name>"; the game draws nothing, the
	// same decision that keeps the score outside the client.
	set_cvar_string("map_duel_winner", name);
	// Chat is part of the game picture, so the fight also ends with a line in the kill feed.
	client_print(0, print_chat, "[DUEL] WINNER: %s", name);

	log_amx("duel winner: %s", name);
	set_task(CHANGE_DELAY, "TaskChangeMap");
}

public TaskChangeMap()
{
	ChangeMap();
}

stock ChangeMap()
{
	new next[MAP_LEN];
	if (!NextMap(next, charsmax(next)))
	{
		log_amx("duel: no usable map in map_duel_maps, the map stays");
		return;
	}

	log_amx("duel: changelevel %s", next);
	server_cmd("changelevel %s", next);
}

/* The best fragger of one team, with team_war's tie-break (the lowest id wins). A team without a
   single frag still sends somebody, so a freshly started map gets its finale too. */
stock FindTop(team)
{
	new best;
	new bestFrags = 0;

	for (new id = 1; id <= get_maxplayers() && id < SLOTS; id++)
	{
		if (!is_user_connected(id) || !is_user_bot(id))
			continue;
		if (get_user_team(id) != team)
			continue;

		if (!best || g_frags[id] > bestFrags)
		{
			best = id;
			bestFrags = g_frags[id];
		}
	}

	return best;
}


/* One weapon for both finalists, so the fight is decided by aim and not by the drop. Reservoir
   sampling: one pass over the list, every valid name equally likely, no array to size. */
stock PickWeapon()
{
	new list[LIST_LEN];
	new item[WEAPON_LEN];
	new count;
	new length;
	new i;

	get_pcvar_string(cvar_weapons, list, charsmax(list));
	length = strlen(list);

	g_weapon[0] = '^0';
	g_armed = 0;
	count = 0;

	for (i = 0; i <= length; i++)
	{
		if (i < length && list[i] != ',')
		{
			if (count < WEAPON_LEN - 1)
			{
				item[count] = list[i];
				count = count + 1;
			}
			continue;
		}

		item[count] = '^0';
		count = 0;

		if (item[0] == '^0')
			continue;

		if (!IsSafeName(item))
		{
			log_amx("duel: refusing weapon name '%s' from map_duel_weapons", item);
			continue;
		}

		g_armed = g_armed + 1;
		if (random(g_armed) == 0)
			copy(g_weapon, charsmax(g_weapon), item);
	}

	if (!g_armed)
		log_amx("duel: map_duel_weapons holds no usable name, the finalists fight on knives");
}

/* The entry after the current map, wrapping around. A map that is not in the list at all (a donated
   map_change can take the server anywhere) starts the list from the top. */
stock bool:NextMap(out[], len)
{
	new list[LIST_LEN];
	new item[MAP_LEN];
	new current[MAP_LEN];
	new first[MAP_LEN];
	new after[MAP_LEN];
	new count;
	new length;
	new i;
	new found = 0;

	get_cvar_string("map_duel_maps", list, charsmax(list));
	get_mapname(current, charsmax(current));
	length = strlen(list);
	count = 0;
	first[0] = '^0';
	after[0] = '^0';

	for (i = 0; i <= length; i++)
	{
		if (i < length && list[i] != ',')
		{
			if (count < MAP_LEN - 1)
			{
				item[count] = list[i];
				count = count + 1;
			}
			continue;
		}

		item[count] = '^0';
		count = 0;

		if (item[0] == '^0')
			continue;

		if (!IsSafeName(item))
		{
			log_amx("duel: refusing map name '%s' from map_duel_maps", item);
			continue;
		}

		if (first[0] == '^0')
			copy(first, charsmax(first), item);

		if (found && after[0] == '^0')
			copy(after, charsmax(after), item);

		if (equal(item, current))
			found = 1;
	}

	if (after[0] != '^0')
	{
		copy(out, len, after);
		return true;
	}

	if (first[0] != '^0')
	{
		copy(out, len, first);
		return true;
	}

	return false;
}

/* Cvars are editable over RCON, so a name with a space or a semicolon must never reach a console
   command: map and weapon names are [a-z0-9_] only. */
stock bool:IsSafeName(const name[])
{
	new length = strlen(name);
	if (length < 2 || length > MAP_LEN - 1)
		return false;

	for (new i = 0; i < length; i++)
	{
		new c = name[i];
		if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'))
			return false;
	}

	return true;
}

/* Respawns and random weapons would rebuild the field, and a chaos effect would hand a finalist a
   new gun in the middle of the fight. */
stock LowerPlugins()
{
	set_cvar_num("map_duel_touched", 1);
	set_cvar_num("csdm_lite_enabled", 0);
	set_cvar_num("chaos_enabled", 0);
}

stock RestorePlugins()
{
	if (!get_cvar_num("map_duel_touched"))
		return;

	set_cvar_num("csdm_lite_enabled", 1);
	set_cvar_num("chaos_enabled", 1);
	set_cvar_num("map_duel_touched", 0);
	log_amx("duel: csdm_lite and chaos are back on");
}

public CmdMapDuel(id, level, cid)
{
	new command[16];
	read_argv(1, command, charsmax(command));

	if (!equal(command, "status"))
	{
		server_print("map_duel usage: amx_map_duel <status>");
		return PLUGIN_HANDLED;
	}

	new winner[NAME_LEN];
	get_cvar_string("map_duel_winner", winner, charsmax(winner));
	// A nickname can contain spaces, and a key=value line with spaces in a value is unreadable.
	replace_all(winner, charsmax(winner), " ", "_");

	// The state is printed per branch: a second char buffer here made amxxpc abort with
	// std::bad_alloc, and a compiler crash is not something to work around at runtime.
	if (g_state == STATE_LIVE)
		server_print("map_duel status: state=live winner=%s", winner);
	else if (g_state == STATE_DONE)
		server_print("map_duel status: state=done winner=%s", winner);
	else
		server_print("map_duel status: state=idle winner=%s", winner);

	return PLUGIN_HANDLED;
}

