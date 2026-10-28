/**
 * csdm_lite - the "meat grinder": instant respawn for bots with a random weapon, on random spawns.
 *
 * Why not CSDM: CSDM 2.x ships a Pawn plugin layer *and* a C++ AMXX module (csdm_amxx), and the
 * plugins refuse to load without it ("Module/Library 'csdm' required for plugin"). That module needs
 * HLSDK headers and a 32-bit toolchain at build time. The behaviour we actually want for the stream
 * is small enough to own: respawn on death, strip, give a random primary, one second of protection,
 * and a spawn point from the map's CSDM preset instead of the two team heaps.
 *
 * Only bots are respawned. The spectator camera is a client too; respawning it would move the
 * camera off its target on every bot death.
 */
#include <amxmodx>
#include <fakemeta>
#include <fun>
// ExecuteHamB lives in hamsandwich, not in fakemeta: without this include the compiler has no
// prototype for it and aborts (SIGABRT, no diagnostics) instead of reporting an undefined symbol.
#include <hamsandwich>

#define PLUGIN_NAME "CSDM Lite"
#define PLUGIN_VERSION "1.1.0"

#define MAX_WEAPONS 8
#define WEAPON_LEN 24

// One line per point in a CSDM spawn preset; a busy map has a few hundred.
#define MAX_SPAWNS 320
#define SPAWN_LINE_LEN 96

new g_weapons[MAX_WEAPONS][WEAPON_LEN];
new g_weaponCount;

new Float:g_spawnOrigins[MAX_SPAWNS][3];
new g_spawnYaw[MAX_SPAWNS];
new g_spawnCount;

new g_cvarEnabled;
new g_cvarDelay;
new g_cvarWeapons;
new g_cvarProtect;
new g_cvarHealth;
new g_cvarDebug;
new g_cvarRandomSpawn;

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-youtube");

	g_cvarEnabled = register_cvar("csdm_lite_enabled", "1");
	g_cvarDelay = register_cvar("csdm_lite_delay", "0.5");
	// Short list on purpose: a bot with an AWP in a three second round is a different game from one
	// with an XM1014, and that difference is the whole point of the mode.
	g_cvarWeapons = register_cvar("csdm_lite_weapons", "ak47,m4a1,awp,xm1014,p90,mp5navy");
	g_cvarProtect = register_cvar("csdm_lite_protect", "1");
	g_cvarHealth = register_cvar("csdm_lite_health", "100");
	// Off by default: one log line per death on a 24/7 server is a lot of noise. Turn it on over
	// RCON to prove the respawns are really happening.
	g_cvarDebug = register_cvar("csdm_lite_debug", "0");
	// Random spawn points across the map: implemented (see CreateScatterSpawns) but OFF by default.
	// Measured with 80 extra spawn entities from the dust2 CSDM preset: bots stand still on those
	// points, because YaPB cannot build a path from a place that is not on its waypoint graph -
	// 8 kills per 45 s against 149 per minute on the normal spawns. Kept behind a cvar instead of
	// deleted, so the idea can be finished once the graph side is solved.
	g_cvarRandomSpawn = register_cvar("csdm_lite_random_spawn", "0");

	// DeathMsg: 1 = killer, 2 = victim.
	register_event("DeathMsg", "OnDeathMsg", "a");
	LoadWeaponList();
}

/* Configs are read after the map is loaded, so the spawn preset of the right map is picked. The
   entities are created a moment later: at plugin_cfg the map has not spawned its own entities yet
   and CreateNamedEntity answers 0. */
public plugin_cfg()
{
	LoadSpawnPoints();
	set_task(3.0, "CreateScatterSpawns");
}

public OnDeathMsg()
{
	if (!get_pcvar_num(g_cvarEnabled))
		return;

	new victim = read_data(2);
	if (!is_user_connected(victim) || !is_user_bot(victim))
		return;

	// A temp for the float: the Float: cast applied straight to a function call in an argument
	// position made amxxpc abort with a core dump instead of an error message.
	new Float:delay = get_pcvar_float(g_cvarDelay);
	set_task(delay, "RespawnBot", victim);
}

public RespawnBot(id)
{
	// Between the death message and this task the bot may have been kicked, or the map may have
	// changed: both leave an id that no longer belongs to the bot we meant to bring back.
	if (!is_user_connected(id) || is_user_alive(id) || !is_user_bot(id))
		return;

	ExecuteHamB(Ham_CS_RoundRespawn, id);
	ArmBot(id);

	if (get_pcvar_num(g_cvarDebug))
		log_amx("csdm_lite: respawned bot %d", id);

	if (get_pcvar_num(g_cvarProtect) > 0)
	{
		set_user_godmode(id, 1);
		set_task(1.0, "Unprotect", id);
	}
}

public Unprotect(id)
{
	if (is_user_connected(id))
		set_user_godmode(id, 0);
}

/* A freshly spawned bot holds the pistol the engine gave it. Replace everything with one random
   primary, so the weapon changes without anyone asking. */
stock ArmBot(id)
{
	if (g_weaponCount < 1)
		return;

	strip_user_weapons(id);
	give_item(id, "weapon_knife");

	new picked[WEAPON_LEN];
	new index = random(g_weaponCount);
	copy(picked, charsmax(picked), g_weapons[index]);

	new weapon[32];
	format(weapon, charsmax(weapon), "weapon_%s", picked);
	give_item(id, weapon);

	set_user_health(id, get_pcvar_num(g_cvarHealth));
}

/* Hand-rolled split: strtok() writing into the same buffer it reads from made amxxpc abort with a
   core dump, and a compiler crash is not something to work around at runtime. */
stock LoadWeaponList()
{
	new list[256];
	new item[WEAPON_LEN];
	new count;
	new length;
	new i;

	get_pcvar_string(g_cvarWeapons, list, charsmax(list));
	length = strlen(list);
	g_weaponCount = 0;
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

		if (!IsSafeWeapon(item))
		{
			log_amx("refusing weapon name '%s' from csdm_lite_weapons", item);
			continue;
		}

		if (g_weaponCount < MAX_WEAPONS)
		{
			copy(g_weapons[g_weaponCount], WEAPON_LEN - 1, item);
			g_weaponCount = g_weaponCount + 1;
		}
	}

	log_amx("loaded %d respawn weapons", g_weaponCount);
}

// The cvar is editable at runtime by anyone with rcon, so it is not trusted: a value with a space or
// a semicolon must never reach a console command.
stock bool:IsSafeWeapon(const weapon[])
{
	new length = strlen(weapon);
	if (length < 2 || length > WEAPON_LEN - 1)
		return false;

	for (new i = 0; i < length; i++)
	{
		new c = weapon[i];
		if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'))
			return false;
	}
	return true;
}

/* ---------- random spawn points ---------- */

/* Reads <amxx configs>/csdm/<map>.spawns.cfg: the presets ship with CSDM and the image already
   copies them into configs/csdm, so this needs no new dependency. One line is one point:
   "x y z <v> yaw 0 0 <v> yaw 0" - only the first three numbers and the yaw are used. */
stock LoadSpawnPoints()
{
	new map[32];
	get_mapname(map, charsmax(map));

	new dir[64];
	get_localinfo("amxx_configsdir", dir, charsmax(dir));

	new path[PLATFORM_MAX_PATH];
	format(path, charsmax(path), "%s/csdm/%s.spawns.cfg", dir, map);

	g_spawnCount = 0;

	new file = fopen(path, "rt");
	if (!file)
	{
		log_amx("no spawn preset for %s, engine spawns are used", map);
		return;
	}

	new line[SPAWN_LINE_LEN];
	new Float:values[6];

	while (g_spawnCount < MAX_SPAWNS && fgets(file, line, charsmax(line)))
	{
		// One comparison for "empty line or whitespace": a char literal such as '\r' makes amxxpc
		// abort with std::bad_alloc, and every control character is <= ' ' anyway.
		if (line[0] <= ' ')
			continue;

		if (line[0] == '/')
			continue;

		if (ReadFloats(line, values, sizeof values) < 3)
			continue;

		g_spawnOrigins[g_spawnCount][0] = values[0];
		g_spawnOrigins[g_spawnCount][1] = values[1];
		g_spawnOrigins[g_spawnCount][2] = values[2];
		// The yaw sits at index 4; a preset without it leaves 0.0, which means "face north".
		g_spawnYaw[g_spawnCount] = floatround(values[4]);
		g_spawnCount++;
	}

	fclose(file);

	log_amx("loaded %d spawn points from %s", g_spawnCount, path);
}

/* Numbers out of one line. strtok() writing into the buffer it reads from crashed amxxpc before, so
   every token is copied out into its own string first. */
stock ReadFloats(const line[], Float:out[], maxValues)
{
	new length = strlen(line);
	new index;
	new i;

	while (i < length && index < maxValues)
	{
		// Everything at or below a space is a separator: space, tab, CR, LF, the closing NUL.
		while (i < length && line[i] <= ' ')
			i++;

		if (i >= length)
			break;

		new token[24];
		new count;

		while (i < length && line[i] > ' ' && count < charsmax(token))
		{
			token[count] = line[i];
			count++;
			i++;
		}
		token[count] = '^0';

		out[index] = str_to_float(token);
		index++;
	}

	return index;
}

/* CS picks a spawn entity at random for every respawn, so extra points are created instead of
   teleporting bots: a teleport leaves the bot plugin with a navigation node from the old place,
   and the bot then stands still for the rest of its life (measured: 3 kills per 90 s with
   teleports, 149 kills per minute without). With real spawn entities the engine does the work and
   the bots never notice. */
/* Spawn entity classes differ per map: de_dust2 carries info_player_start and info_player_deathmatch,
   some maps use the team-specific ones. All four are tried for every preset and the log line says
   how many the engine accepted. */
new const g_spawnClasses[][] =
{
	"info_player_start",
	"info_player_deathmatch",
	"info_player_counterterrorist",
	"info_player_terrorist"
};

public CreateScatterSpawns()
{
	if (!get_pcvar_num(g_cvarRandomSpawn))
		return;

	new created;
	for (new i = 0; i < g_spawnCount; i++)
	{
		for (new c = 0; c < sizeof g_spawnClasses; c++)
		{
			if (CreateSpawnEntity(g_spawnClasses[c], i))
				created++;
		}
	}

	if (created < 1)
	{
		log_amx("no extra spawn points created, engine spawns are used");
		return;
	}

	log_amx("created %d extra spawn points from %d presets", created, g_spawnCount);
}

stock bool:CreateSpawnEntity(const classname[], index)
{
	// CreateNamedEntity + AllocString: the classname must live in the engine's string table, with a
	// plain engfunc(EngFunc_CreateEntity, ...) the plugin dies with "Run time error 10".
	new entity = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, classname));
	if (!entity)
		return false;

	new Float:origin[3];
	origin[0] = g_spawnOrigins[index][0];
	origin[1] = g_spawnOrigins[index][1];
	origin[2] = g_spawnOrigins[index][2];
	engfunc(EngFunc_SetOrigin, entity, origin);

	// Face the direction the point was recorded with, otherwise a fresh bot stares at a wall.
	// Not engfunc(EngFunc_SetAngle): that constant makes amxxpc abort with std::bad_alloc.
	new Float:angles[3];
	angles[0] = 0.0;
	angles[1] = float(g_spawnYaw[index]);
	angles[2] = 0.0;
	set_pev(entity, pev_angles, angles);

	dllfunc(DLLFunc_Spawn, entity);
	return true;
}
