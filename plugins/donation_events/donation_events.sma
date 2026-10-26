/**
 * donation_events - turns a donation into one activity on a CS 1.6 bot server.
 *
 * Contract with the control API (src/command.ts):
 *   amx_de codes                     -> prints "donation_events codes: a,b,c"
 *   amx_de version                   -> prints API and plugin version
 *   amx_de <code> key=value ...      -> queues the activity for the next round
 *
 * Rules: one activity per round, round effects are cleaned up on round end,
 * bot_nick persists until the map changes, map_change runs at the next round start.
 * Adding an activity = write a handler and add one RegisterDonationEffect line.
 */
#include <amxmodx>
#include <fakemeta>
#include <fun>

#define PLUGIN_NAME "Donation Events"
#define PLUGIN_VERSION "0.2.0"
#define API_VERSION 1

#define MAX_EFFECTS 32
#define MAX_PARAMS 16
#define MAX_QUEUE 8
#define CODE_LEN 32
#define KEY_LEN 24
#define VALUE_LEN 64
#define NICK_LEN 32

new g_codes[MAX_EFFECTS][CODE_LEN];
new g_handlers[MAX_EFFECTS][CODE_LEN];
new g_effectCount;

new g_queueCodes[MAX_QUEUE][CODE_LEN];
new g_queueParamCount[MAX_QUEUE];
new g_queueKeys[MAX_QUEUE][MAX_PARAMS][KEY_LEN];
new g_queueValues[MAX_QUEUE][MAX_PARAMS][VALUE_LEN];
new g_queueSize;

new g_activeCode[CODE_LEN];
new g_paramCount;
new g_paramKeys[MAX_PARAMS][KEY_LEN];
new g_paramValues[MAX_PARAMS][VALUE_LEN];

new g_nickBot;
new g_nickOriginal[NICK_LEN];
new bool:g_nickActive;

new g_savedGravity;
new g_savedBotQuota;
new bool:g_gravitySaved;
new bool:g_quotaSaved;

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-youtube");
	register_srvcmd("amx_de", "CmdDonationEvent");

	register_logevent("OnRoundStart", 2, "1=Round_Start");
	register_logevent("OnRoundEnd", 2, "1=Round_End");

	RegisterDonationEffect("bot_nick", "EffectBotNick");
	RegisterDonationEffect("meat_round", "EffectMeatRound");
	RegisterDonationEffect("knives_only", "EffectKnivesOnly");
	RegisterDonationEffect("moon_gravity", "EffectMoonGravity");
	RegisterDonationEffect("awp_only", "EffectAwpOnly");
	RegisterDonationEffect("bot_rain", "EffectBotRain");
	RegisterDonationEffect("terminators", "EffectTerminators");
	RegisterDonationEffect("zombie_round", "EffectZombieRound");
	RegisterDonationEffect("terminator_one", "EffectTerminatorOne");
	RegisterDonationEffect("map_change", "EffectMapChange");

	log_amx("loaded, API %d, %d activities", API_VERSION, g_effectCount);
}

stock RegisterDonationEffect(const code[], const handler[])
{
	if (g_effectCount >= MAX_EFFECTS)
	{
		log_amx("effect registry is full, %s dropped", code);
		return 0;
	}

	copy(g_codes[g_effectCount], CODE_LEN - 1, code);
	copy(g_handlers[g_effectCount], CODE_LEN - 1, handler);
	g_effectCount++;
	return 1;
}

stock FindEffect(const code[])
{
	for (new i = 0; i < g_effectCount; i++)
	{
		if (equali(g_codes[i], code))
			return i;
	}
	return -1;
}

public CmdDonationEvent(id, level, cid)
{
	new code[CODE_LEN];
	read_argv(1, code, CODE_LEN - 1);

	if (equal(code, "codes"))
	{
		new list[512];
		for (new i = 0; i < g_effectCount; i++)
		{
			if (i > 0)
				add(list, charsmax(list), ",");
			add(list, charsmax(list), g_codes[i]);
		}
		server_print("donation_events codes: %s", list);
		return PLUGIN_HANDLED;
	}

	if (equal(code, "version"))
	{
		server_print("donation_events version: %s api: %d activities: %d", PLUGIN_VERSION, API_VERSION, g_effectCount);
		return PLUGIN_HANDLED;
	}

	if (FindEffect(code) < 0)
	{
		log_amx("unknown activity '%s', ignored", code);
		server_print("donation_events rejected unknown activity %s", code);
		return PLUGIN_HANDLED;
	}

	if (!QueueCommand(code))
	{
		log_amx("queue is full, '%s' dropped", code);
		server_print("donation_events rejected queue_full");
		return PLUGIN_HANDLED;
	}

	log_amx("queued '%s' for the next round (queue %d)", code, g_queueSize);
	server_print("donation_events queued %s", code);
	return PLUGIN_HANDLED;
}

/* Command line is "amx_de <code> key=value key=value ..."; values are already sanitized
   by the control API, here we only split and bound them. */
stock QueueCommand(const code[])
{
	if (g_queueSize >= MAX_QUEUE)
		return 0;

	new slot = g_queueSize;
	copy(g_queueCodes[slot], CODE_LEN - 1, code);
	g_queueParamCount[slot] = 0;

	new argc = read_argc();
	for (new i = 2; i < argc && g_queueParamCount[slot] < MAX_PARAMS; i++)
	{
		new arg[VALUE_LEN + KEY_LEN + 2];
		read_argv(i, arg, charsmax(arg));

		new separator = contain(arg, "=");
		if (separator <= 0)
			continue;

		arg[separator] = '^0';
		copy(g_queueKeys[slot][g_queueParamCount[slot]], KEY_LEN - 1, arg);
		copy(g_queueValues[slot][g_queueParamCount[slot]], VALUE_LEN - 1, arg[separator + 1]);
		g_queueParamCount[slot]++;
	}

	g_queueSize++;
	return 1;
}

/* ---------- parameters of the running activity ---------- */

stock ParamInt(const key[], fallback)
{
	for (new i = 0; i < g_paramCount; i++)
	{
		if (equali(g_paramKeys[i], key))
			return str_to_num(g_paramValues[i]);
	}
	return fallback;
}

stock Float:ParamFloat(const key[], Float:fallback)
{
	for (new i = 0; i < g_paramCount; i++)
	{
		if (equali(g_paramKeys[i], key))
			return str_to_float(g_paramValues[i]);
	}
	return fallback;
}

stock ParamCopy(const key[], out[], len, const fallback[])
{
	for (new i = 0; i < g_paramCount; i++)
	{
		if (equali(g_paramKeys[i], key))
		{
			copy(out, len, g_paramValues[i]);
			return 1;
		}
	}
	copy(out, len, fallback);
	return 0;
}

/* ---------- round lifecycle: one activity per round ---------- */

public OnRoundStart()
{
	ValidateNickState();

	if (g_queueSize > 0)
		set_task(0.3, "StartNextActivity");
}

public StartNextActivity()
{
	if (g_queueSize <= 0)
		return;

	if (g_activeCode[0])
	{
		log_amx("'%s' is still running, keeping '%s' for the next round", g_activeCode, g_queueCodes[0]);
		return;
	}

	new handler[CODE_LEN];
	new index;

	copy(g_activeCode, CODE_LEN - 1, g_queueCodes[0]);
	index = FindEffect(g_activeCode);
	LoadParamsFromSlot(0);
	ShiftQueue();

	if (index < 0)
	{
		log_amx("activity '%s' has no handler", g_activeCode);
		g_activeCode[0] = '^0';
		return;
	}

	copy(handler, CODE_LEN - 1, g_handlers[index]);
	RunHandler(handler);
	server_print("donation_events started %s", g_activeCode);
}

public OnRoundEnd()
{
	if (!g_activeCode[0])
		return;

	// The nickname is the only effect that outlives the round: it lives until a map change.
	if (equal(g_activeCode, "bot_nick"))
	{
		g_activeCode[0] = '^0';
		return;
	}

	CleanupActive();
	log_amx("activity '%s' finished", g_activeCode);
	server_print("donation_events finished %s", g_activeCode);
	g_activeCode[0] = '^0';
}

stock LoadParamsFromSlot(slot)
{
	g_paramCount = g_queueParamCount[slot];
	for (new i = 0; i < g_paramCount; i++)
	{
		copy(g_paramKeys[i], KEY_LEN - 1, g_queueKeys[slot][i]);
		copy(g_paramValues[i], VALUE_LEN - 1, g_queueValues[slot][i]);
	}
}

stock ShiftQueue()
{
	for (new slot = 1; slot < g_queueSize; slot++)
	{
		copy(g_queueCodes[slot - 1], CODE_LEN - 1, g_queueCodes[slot]);
		g_queueParamCount[slot - 1] = g_queueParamCount[slot];
		for (new i = 0; i < MAX_PARAMS; i++)
		{
			copy(g_queueKeys[slot - 1][i], KEY_LEN - 1, g_queueKeys[slot][i]);
			copy(g_queueValues[slot - 1][i], VALUE_LEN - 1, g_queueValues[slot][i]);
		}
	}
	g_queueSize--;
	if (g_queueSize < 0)
		g_queueSize = 0;
}

stock RunHandler(const handler[])
{
	if (!callfunc_begin(handler))
	{
		log_amx("handler '%s' is not public or missing", handler);
		return 0;
	}
	callfunc_end();
	return 1;
}

/* Restores every global this plugin touched. Health and weapons do not need restoring:
   the next spawn resets them. */
stock CleanupActive()
{
	if (g_gravitySaved)
	{
		set_cvar_num("sv_gravity", g_savedGravity);
		g_gravitySaved = false;
	}

	if (g_quotaSaved)
	{
		SetCvarFirst("yb_quota", "pb_quota", g_savedBotQuota);
		g_quotaSaved = false;
	}
}

public plugin_end()
{
	CleanupActive();
	if (g_nickActive)
		RestoreNick();
}

new g_nickApplied[NICK_LEN];

/* ---------- effects: one public function per activity code ---------- */

public EffectBotNick()
{
	new nick[VALUE_LEN];
	ParamCopy("nick", nick, charsmax(nick), "");

	if (nick[0] == '^0')
	{
		log_amx("bot_nick called without a nickname");
		return;
	}

	new bot = FindFirstBot();
	if (!bot)
	{
		log_amx("bot_nick: no bots are connected");
		return;
	}

	if (g_nickActive)
		RestoreNick();

	get_user_name(bot, g_nickOriginal, NICK_LEN - 1);
	set_user_info(bot, "name", nick);
	copy(g_nickApplied, NICK_LEN - 1, nick);
	g_nickBot = bot;
	g_nickActive = true;
	log_amx("bot_nick: bot %d is now '%s' (was '%s')", bot, nick, g_nickOriginal);
}

public EffectMeatRound()
{
	new health = ParamInt("health", 1);
	if (health < 1)
		health = 1;

	new bots;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		StripWeapons(id);
		give_item(id, "weapon_knife");
		set_user_health(id, health);
		bots++;
	}

	log_amx("meat_round: %d bots at %d hp with knives only", bots, health);
}

public EffectKnivesOnly()
{
	new bots;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		StripWeapons(id);
		give_item(id, "weapon_knife");
		bots++;
	}

	log_amx("knives_only: %d bots rearmed with knives", bots);
}

public EffectAwpOnly()
{
	new bots;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		StripWeapons(id);
		give_item(id, "weapon_awp");
		bots++;
	}

	log_amx("awp_only: %d bots rearmed with AWP", bots);
}

public EffectMoonGravity()
{
	new gravity = ParamInt("gravity", 200);
	if (gravity < 1 || gravity > 1000)
	{
		log_amx("moon_gravity: refusing gravity %d", gravity);
		return;
	}

	if (!g_gravitySaved)
	{
		g_savedGravity = get_cvar_num("sv_gravity");
		g_gravitySaved = true;
	}

	set_cvar_num("sv_gravity", gravity);
	log_amx("moon_gravity: sv_gravity %d for one round", gravity);
}

public EffectBotRain()
{
	new extra = ParamInt("extraBots", 6);
	new maxBots = ParamInt("maxBots", 24);
	new current = GetCvarFirst("yb_quota", "pb_quota", 0);

	if (extra < 1 || maxBots < 1)
	{
		log_amx("bot_rain: bad params extra=%d max=%d", extra, maxBots);
		return;
	}

	if (current <= 0)
	{
		log_amx("bot_rain: no bot quota cvar found (yb_quota/pb_quota)");
		return;
	}

	if (!g_quotaSaved)
	{
		g_savedBotQuota = current;
		g_quotaSaved = true;
	}

	new target = current + extra;
	if (target > maxBots)
		target = maxBots;

	SetCvarFirst("yb_quota", "pb_quota", target);
	log_amx("bot_rain: quota %d -> %d", current, target);
}

public EffectTerminators()
{
	new difficulty = ParamInt("difficulty", 100);

	if (SetCvarFirst("yb_difficulty", "pb_skill", difficulty))
	{
		log_amx("terminators: bot difficulty set to %d", difficulty);
		return;
	}

	// Graceful degradation: the bot plugin may expose a different cvar name, and an activity
	// that silently does nothing is worse than a visible buff.
	new bots;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		StripWeapons(id);
		give_item(id, "weapon_ak47");
		set_user_health(id, 300);
		bots++;
	}

	log_amx("terminators: no difficulty cvar, %d bots buffed instead", bots);
}

public EffectZombieRound()
{
	new zombies = ParamInt("zombies", 3);
	new health = ParamInt("zombieHealth", 1000);
	new Float:speed = ParamFloat("zombieSpeed", 1.2);

	if (zombies < 1)
		zombies = 1;
	if (health < 1)
		health = 1;
	if (speed < 0.1 || speed > 3.0)
		speed = 1.2;

	new made;
	for (new id = 1; id <= get_maxplayers() && made < zombies; id++)
	{
		if (!IsBotAlive(id))
			continue;

		StripWeapons(id);
		give_item(id, "weapon_knife");
		set_user_health(id, health);
		set_user_maxspeed(id, speed);
		made++;
	}

	log_amx("zombie_round: %d zombies with %d hp at speed %.2f", made, health, speed);
}

public EffectTerminatorOne()
{
	new weapon[32];
	ParamCopy("weapon", weapon, charsmax(weapon), "weapon_m249");
	if (!IsSafeWeapon(weapon))
		copy(weapon, charsmax(weapon), "weapon_m249");

	new health = ParamInt("health", 500);
	if (health < 1)
		health = 500;

	new bot = FindFirstBot();
	if (!bot)
	{
		log_amx("terminator_one: no bots are connected");
		return;
	}

	StripWeapons(bot);
	give_item(bot, weapon);
	set_user_health(bot, health);
	set_user_armor(bot, 100);

	new others;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (id == bot || !IsBotAlive(id))
			continue;

		StripWeapons(id);
		give_item(id, "weapon_knife");
		others++;
	}

	log_amx("terminator_one: bot %d has %s and %d hp, %d bots on knives", bot, weapon, health, others);
}

public EffectMapChange()
{
	new maps[VALUE_LEN * 2];
	new map[32];

	ParamCopy("maps", maps, charsmax(maps), "");

	if (!PickRandomMap(maps, map, charsmax(map)))
	{
		log_amx("map_change: no usable map in '%s'", maps);
		return;
	}

	log_amx("map_change: going to %s", map);
	server_cmd("changelevel %s", map);
}

/* ---------- helpers ---------- */

stock bool:IsBotAlive(id)
{
	if (!is_user_alive(id))
		return false;
	return is_user_bot(id) != 0;
}

stock FindFirstBot()
{
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (IsBotAlive(id))
			return id;
	}
	return 0;
}

stock StripWeapons(id)
{
	strip_user_weapons(id);
}

// Weapon names come from the catalogue, but a typo must never be able to inject a command.
stock bool:IsSafeWeapon(const weapon[])
{
	new length = strlen(weapon);
	if (length < 8 || length > 31)
		return false;
	if (!equal(weapon, "weapon_", 7))
		return false;

	for (new i = 7; i < length; i++)
	{
		new c = weapon[i];
		if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'))
			return false;
	}
	return true;
}

stock bool:IsSafeMapName(const map[])
{
	new length = strlen(map);
	if (length < 1 || length > 31)
		return false;

	for (new i = 0; i < length; i++)
	{
		new c = map[i];
		if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_'))
			return false;
	}
	return true;
}

/* Picks one entry from "a,b,c"; returns false when nothing safe is left. */
stock bool:PickRandomMap(const list[], out[], len)
{
	new offsets[16];
	new lengths[16];
	new count;
	new start;
	new total = strlen(list);

	for (new i = 0; i <= total; i++)
	{
		if (i == total || list[i] == ',')
		{
			if (count < 16 && i > start)
			{
				offsets[count] = start;
				lengths[count] = i - start;
				count++;
			}
			start = i + 1;
		}
	}

	if (count == 0)
		return false;

	new candidate[32];
	new pick = random_num(0, count - 1);
	new length = lengths[pick];
	if (length > 31)
		length = 31;

	for (new i = 0; i < length; i++)
		candidate[i] = list[offsets[pick] + i];
	candidate[length] = '^0';

	if (!IsSafeMapName(candidate))
		return false;

	copy(out, len, candidate);
	return true;
}

/* Bot cvar names differ between YaPB and PodBot, so try both and report honestly. */
stock SetCvarFirst(const first[], const second[], value)
{
	if (first[0] && get_cvar_pointer(first))
	{
		set_cvar_num(first, value);
		return 1;
	}

	if (second[0] && get_cvar_pointer(second))
	{
		set_cvar_num(second, value);
		return 1;
	}

	return 0;
}

stock GetCvarFirst(const first[], const second[], fallback)
{
	if (first[0] && get_cvar_pointer(first))
		return get_cvar_num(first);
	if (second[0] && get_cvar_pointer(second))
		return get_cvar_num(second);
	return fallback;
}

stock RestoreNick()
{
	if (g_nickBot > 0 && is_user_connected(g_nickBot))
		set_user_info(g_nickBot, "name", g_nickOriginal);

	g_nickActive = false;
	g_nickBot = 0;
	g_nickApplied[0] = '^0';
}

/* After a map change player ids are gone, so the renamed bot can no longer be restored:
   the state is dropped instead of pointing at a stranger. */
stock ValidateNickState()
{
	if (!g_nickActive)
		return;

	new name[NICK_LEN];
	if (g_nickBot <= 0 || !is_user_connected(g_nickBot))
	{
		g_nickActive = false;
		g_nickBot = 0;
		return;
	}

	get_user_name(g_nickBot, name, NICK_LEN - 1);
	if (!equal(name, g_nickApplied))
	{
		g_nickActive = false;
		g_nickBot = 0;
		g_nickApplied[0] = '^0';
	}
}





