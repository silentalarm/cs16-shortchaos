/**
 * csdm_lite - the "meat grinder": instant respawn for bots with a random weapon.
 *
 * Why not CSDM: CSDM 2.x ships a Pawn plugin layer *and* a C++ AMXX module (csdm_amxx), and the
 * plugins refuse to load without it ("Module/Library 'csdm' required for plugin"). That module needs
 * HLSDK headers and a 32-bit toolchain at build time. The behaviour we actually want for the stream
 * is small enough to own: respawn on death, strip, give a random primary, one second of protection.
 *
 * Spawn points are the map's own. Random points across the map were tried and dropped: a bot that
 * appears off the bot's navigation graph cannot build a path and stands still (3 kills in 90 s with
 * teleports, 8 in 45 s with extra spawn entities, 149 per minute on the normal spawns). The teams
 * meet at the spawns anyway, so the picture keeps moving without them.
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
#define PLUGIN_VERSION "1.2.0"

#define MAX_WEAPONS 8
#define WEAPON_LEN 24

new g_weapons[MAX_WEAPONS][WEAPON_LEN];
new g_weaponCount;

new g_cvarEnabled;
new g_cvarDelay;
new g_cvarWeapons;
new g_cvarProtect;
new g_cvarHealth;
new g_cvarDebug;

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

	// DeathMsg: 1 = killer, 2 = victim.
	register_event("DeathMsg", "OnDeathMsg", "a");
	LoadWeaponList();
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
