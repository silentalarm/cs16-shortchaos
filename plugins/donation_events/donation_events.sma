/**
 * donation_events - turns a donation into one activity on a CS 1.6 bot server.
 *
 * Contract with the control API (src/command.ts):
 *   amx_de codes                     -> prints "donation_events codes: a,b,c"
 *   amx_de version                   -> prints API and plugin version
 *   amx_de status                    -> prints "donation_events status: api=1 active=<code|none> queued=0 nick=<nick|none>"
 *   amx_de clear                     -> cancels the round effects and restores the nickname
 *   amx_de <code> key=value ...      -> applies the activity now, in the same RCON call
 *
 * Rules: every activity applies at once - a donation that shows up on screen two minutes later
 * reads as a refund request. Round effects (meat_round, knives_only, bounty and the rest) are
 * cleaned up on round end; bot_nick persists until the map changes; map_change changes the map at
 * once.
 * Round fights (bounty, hot_potato, boss_raid) watch DeathMsg for the rest of the round: the
 * effect changes hands when a bot dies, which is the part the viewer is paying for.
 * Adding an activity = write a handler and add one RegisterDonationEffect line.
 */
#include <amxmodx>
#include <fakemeta>
#include <fun>

#define PLUGIN_NAME "Donation Events"
#define PLUGIN_VERSION "0.6.0"
#define API_VERSION 1

// How long a blessed or cursed bot keeps its glow. Health and weapons reset on the next spawn.
#define GLOW_SECONDS 20.0

#define MAX_EFFECTS 32
#define MAX_PARAMS 16
#define CODE_LEN 32
#define KEY_LEN 24
#define VALUE_LEN 64
#define NICK_LEN 32

new g_codes[MAX_EFFECTS][CODE_LEN];
new g_handlers[MAX_EFFECTS][CODE_LEN];
new g_effectCount;

/* The last activity that ran, reported by `amx_de status`. There is no per-round bookkeeping any
   more: every code runs immediately, Round_End only restores what the running effects touched. */
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

/* Round fights. All three are one-round effects that follow the kill feed, so their state lives
   next to the round state and is dropped in CleanupActive() together with the cvars we touched. */
#define MAX_BOSSES 4
#define MAX_TRACKED_BOTS 32

new g_bountyTarget;
new bool:g_bountyActive;
new g_bountyReward[VALUE_LEN];

new g_potatoHolder;
new bool:g_potatoActive;
new g_potatoHealth;

new g_bosses[MAX_BOSSES];
new g_bossCount;
new g_bossHealth;
new g_bossWeapon[VALUE_LEN];
new bool:g_bossRaidActive;

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-youtube");
	register_srvcmd("amx_de", "CmdDonationEvent");

	register_logevent("OnRoundStart", 2, "1=Round_Start");
	register_logevent("OnRoundEnd", 2, "1=Round_End");

	// DeathMsg: 1 = killer, 2 = victim. Bounty, hot potato and the boss raid change hands on a kill.
	register_event("DeathMsg", "OnDeathMsg", "a");
	// ResetHUD is delivered to the player who just spawned: a boss has to come back as a boss.
	register_event("ResetHUD", "OnPlayerSpawn", "be");

	RegisterDonationEffect("bot_nick", "EffectBotNick");
	RegisterDonationEffect("meat_round", "EffectMeatRound");
	RegisterDonationEffect("knives_only", "EffectKnivesOnly");
	RegisterDonationEffect("moon_gravity", "EffectMoonGravity");
	RegisterDonationEffect("awp_only", "EffectAwpOnly");
	RegisterDonationEffect("bounty", "EffectBounty");
	RegisterDonationEffect("bot_rain", "EffectBotRain");
	RegisterDonationEffect("hot_potato", "EffectHotPotato");
	RegisterDonationEffect("terminators", "EffectTerminators");
	RegisterDonationEffect("zombie_round", "EffectZombieRound");
	RegisterDonationEffect("boss_raid", "EffectBossRaid");
	RegisterDonationEffect("terminator_one", "EffectTerminatorOne");
	RegisterDonationEffect("map_change", "EffectMapChange");
	RegisterDonationEffect("bless_bot", "EffectBlessBot");
	RegisterDonationEffect("curse_leader", "EffectCurseLeader");
	RegisterDonationEffect("bot_phrase", "EffectBotPhrase");
	RegisterDonationEffect("chaos_burst", "EffectChaosBurst");

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

	if (equal(code, "status"))
	{
		// One line, key=value, no spaces inside values: the admin panel parses exactly this.
		new active[CODE_LEN];
		if (g_activeCode[0])
			copy(active, CODE_LEN - 1, g_activeCode);
		else
			copy(active, CODE_LEN - 1, "none");

		new nick[NICK_LEN];
		copy(nick, NICK_LEN - 1, "none");
		if (g_nickActive && g_nickBot > 0 && is_user_connected(g_nickBot))
		{
			get_user_name(g_nickBot, nick, NICK_LEN - 1);
			if (nick[0] == '^0')
				copy(nick, NICK_LEN - 1, "none");
		}

		// `queued` is always 0 now that every activity runs at once; the key stays because the admin
		// panel parses this exact line.
		server_print("donation_events status: api=%d active=%s queued=0 nick=%s", API_VERSION, active, nick);
		return PLUGIN_HANDLED;
	}

	if (equal(code, "clear"))
	{
		ClearAll();
		log_amx("cleared by request");
		server_print("donation_events cleared");
		return PLUGIN_HANDLED;
	}

	if (FindEffect(code) < 0)
	{
		log_amx("unknown activity '%s', ignored", code);
		server_print("donation_events rejected unknown activity %s", code);
		return PLUGIN_HANDLED;
	}

	// Every activity runs in this call: the viewer pays for what happens now, not for the next
	// round. The code was validated above, so FindEffect always answers an index here.
	new handler[CODE_LEN];
	copy(handler, CODE_LEN - 1, g_handlers[FindEffect(code)]);

	g_paramCount = 0;
	LoadParamsFromArgs();
	copy(g_activeCode, CODE_LEN - 1, code);
	RunHandler(handler);
	log_amx("ran '%s' with %d params", code, g_paramCount);
	server_print("donation_events ran %s", code);
	g_paramCount = 0;
	return PLUGIN_HANDLED;
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

/* ---------- round lifecycle ---------- */

public OnRoundStart()
{
	ValidateNickState();
}

public OnRoundEnd()
{
	// Round effects never survive the round. `bot_nick` is persistent state with its own lifetime,
	// so the round only drops its label; the renamed bot keeps its name until a map change.
	new bool:nickRunning = false;
	if (g_activeCode[0] && equal(g_activeCode, "bot_nick"))
		nickRunning = true;

	// Unconditional: with every activity applying at once, a round can hold several effects, and
	// the cleanup must not depend on which one happened to be applied last.
	CleanupActive();

	if (g_activeCode[0] && !nickRunning)
	{
		log_amx("activity '%s' finished", g_activeCode);
		server_print("donation_events finished %s", g_activeCode);
	}
	g_activeCode[0] = '^0';
}

/* Command line is "amx_de <code> key=value key=value ..."; values are already sanitized by the
   control API, here we only split and bound them. */
stock LoadParamsFromArgs()
{
	new argc = read_argc();
	g_paramCount = 0;

	for (new i = 2; i < argc && g_paramCount < MAX_PARAMS; i++)
	{
		new arg[VALUE_LEN + KEY_LEN + 2];
		read_argv(i, arg, charsmax(arg));

		new separator = contain(arg, "=");
		if (separator <= 0)
			continue;

		arg[separator] = '^0';
		copy(g_paramKeys[g_paramCount], KEY_LEN - 1, arg);
		copy(g_paramValues[g_paramCount], VALUE_LEN - 1, arg[separator + 1]);
		g_paramCount++;
	}
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

	ClearFightState();
}

/* A finished round leaves nothing behind except the glow: health, weapons and armour are reset by
   the next spawn. The state is dropped even when a bot is gone, so a reused player id can never
   inherit somebody else's bounty. */
stock ClearFightState()
{
	if (g_bountyTarget > 0)
		ClearGlow(g_bountyTarget);

	if (g_potatoHolder > 0)
		ClearGlow(g_potatoHolder);

	for (new i = 0; i < g_bossCount; i++)
		ClearGlow(g_bosses[i]);

	g_bountyTarget = 0;
	g_bountyActive = false;
	g_potatoHolder = 0;
	g_potatoActive = false;
	g_bossCount = 0;
	g_bossRaidActive = false;
}

/* Cancels everything at once: the round effect and the persistent nickname. Used by `amx_de clear`
   (the panel's "stop everything") and by nothing else. */
stock ClearAll()
{
	CleanupActive();

	if (g_nickActive)
		RestoreNick();

	g_activeCode[0] = '^0';
	g_paramCount = 0;
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

	// One slot stays free for the spectator camera: it is a real connection, and a quota
	// that fills every slot keeps it out of the server.
	new slots = get_maxplayers() - 1;
	if (maxBots > slots)
	{
		log_amx("bot_rain: maxBots %d clamped to %d (server slots)", maxBots, slots);
		maxBots = slots;
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

/* ---------- round fights: bounty, hot potato, boss raid ---------- */

/* One kill can end any of the three, so they are checked in one handler: DeathMsg is a global event
   and three separate registrations would mean three reads of the same data. */
public OnDeathMsg()
{
	new killer = read_data(1);
	new victim = read_data(2);

	if (g_bountyActive && victim == g_bountyTarget)
		ClaimBounty(killer, victim);

	if (g_potatoActive && victim == g_potatoHolder)
		PassHotPotato(killer, victim);

	if (g_bossRaidActive && IsBoss(victim))
		ReportBossDown(killer, victim);
}

/* The price goes on the leader, not on a random bot: with a 0.5 s respawn somebody kills a random
   bot within seconds, and the bounty would be claimed before the viewer finishes reading it. */
public EffectBounty()
{
	new nick[VALUE_LEN];
	ParamCopy("nick", nick, charsmax(nick), "");

	new health = ParamInt("health", 150);
	if (health < 50)
		health = 50;
	if (health > 2000)
		health = 2000;

	new reward[VALUE_LEN];
	ParamCopy("reward", reward, charsmax(reward), "weapon_deagle");
	if (!IsSafeWeapon(reward))
		copy(reward, charsmax(reward), "weapon_deagle");

	new target = FindLeaderBot();
	if (!target)
	{
		log_amx("bounty: no bots are connected");
		return;
	}

	g_bountyTarget = target;
	g_bountyActive = true;
	copy(g_bountyReward, charsmax(g_bountyReward), reward);

	set_user_health(target, health);
	set_user_rendering(target, kRenderFxGlowShell, 255, 200, 0, kRenderNormal, 25);

	new botName[NICK_LEN];
	get_user_name(target, botName, NICK_LEN - 1);
	if (nick[0] == '^0')
		Announce("BOUNTY ON %s (%d HP)", botName, health);
	else
		Announce("%s PUT A BOUNTY ON %s (%d HP)", nick, botName, health);
	log_amx("bounty: '%s' on bot %d '%s', %d hp, reward %s", nick, target, botName, health, reward);
}

stock ClaimBounty(killer, victim)
{
	new victimName[NICK_LEN];
	get_user_name(victim, victimName, NICK_LEN - 1);
	// The glow would otherwise survive the respawn and mark a bot that no longer has a price.
	ClearGlow(victim);

	g_bountyActive = false;
	g_bountyTarget = 0;

	if (killer <= 0 || killer == victim || !is_user_connected(killer) || !is_user_bot(killer))
	{
		Announce("BOUNTY ON %s WENT UNSOLD", victimName);
		log_amx("bounty: '%s' died without a killer, nobody is paid", victimName);
		return;
	}

	// The reward is a weapon and health: money means nothing on a server where nobody buys.
	give_item(killer, g_bountyReward);
	set_user_health(killer, 100);

	new killerName[NICK_LEN];
	get_user_name(killer, killerName, NICK_LEN - 1);
	Announce("%s CLAIMED THE BOUNTY ON %s", killerName, victimName);
	log_amx("bounty: bot %d '%s' killed bot %d '%s' and got %s", killer, killerName, victim, victimName, g_bountyReward);
}

/* ---------- hot potato: the holder is the target, the killer inherits it ---------- */

public EffectHotPotato()
{
	new nick[VALUE_LEN];
	ParamCopy("nick", nick, charsmax(nick), "");

	new health = ParamInt("health", 25);
	if (health < 1)
		health = 1;
	if (health > 100)
		health = 100;

	new bot = PickRandomBot();
	if (!bot)
	{
		log_amx("hot_potato: no bots are connected");
		return;
	}

	g_potatoHolder = bot;
	g_potatoHealth = health;
	g_potatoActive = true;
	PotatoArm(bot);

	new botName[NICK_LEN];
	get_user_name(bot, botName, NICK_LEN - 1);
	if (nick[0] == '^0')
		Announce("HOT POTATO: %s - KILL HIM TO PASS IT", botName);
	else
		Announce("%s MADE %s THE HOT POTATO", nick, botName);
	log_amx("hot_potato: '%s' -> bot %d '%s', %d hp", nick, bot, botName, health);
}

stock PotatoArm(id)
{
	StripWeapons(id);
	give_item(id, "weapon_knife");
	set_user_health(id, g_potatoHealth);
	set_user_rendering(id, kRenderFxGlowShell, 255, 120, 0, kRenderNormal, 25);
}

stock PassHotPotato(killer, victim)
{
	new victimName[NICK_LEN];
	get_user_name(victim, victimName, NICK_LEN - 1);
	// Cleared here, not at round end: the old holder respawns in 0.5 s and the orange shell would
	// stay on a bot that no longer carries anything.
	ClearGlow(victim);

	g_potatoActive = false;
	g_potatoHolder = 0;

	// A suicide, a fall or a kill by the world burns the potato: passing it to a dead player would
	// leave the glow on a corpse and the announcement would name nobody.
	if (killer <= 0 || killer == victim || !is_user_connected(killer) || !is_user_bot(killer))
	{
		Announce("HOT POTATO BURNED OUT WITH %s", victimName);
		log_amx("hot_potato: '%s' died without a killer, the potato is gone", victimName);
		return;
	}

	g_potatoHolder = killer;
	g_potatoActive = true;
	PotatoArm(killer);

	new killerName[NICK_LEN];
	get_user_name(killer, killerName, NICK_LEN - 1);
	Announce("%s IS THE HOT POTATO NOW", killerName);
	log_amx("hot_potato: passed from bot %d '%s' to bot %d '%s'", victim, victimName, killer, killerName);
}

/* ---------- boss raid: a few tanks against everyone else ---------- */

public EffectBossRaid()
{
	new nick[VALUE_LEN];
	ParamCopy("nick", nick, charsmax(nick), "");

	new wanted = ParamInt("bosses", 2);
	if (wanted < 1)
		wanted = 1;
	if (wanted > MAX_BOSSES)
		wanted = MAX_BOSSES;

	new health = ParamInt("bossHealth", 1500);
	if (health < 200)
		health = 200;
	if (health > 10000)
		health = 10000;

	new bossWeapon[VALUE_LEN];
	ParamCopy("bossWeapon", bossWeapon, charsmax(bossWeapon), "weapon_m249");
	if (!IsSafeWeapon(bossWeapon))
		copy(bossWeapon, charsmax(bossWeapon), "weapon_m249");

	new gruntWeapon[VALUE_LEN];
	ParamCopy("gruntWeapon", gruntWeapon, charsmax(gruntWeapon), "weapon_deagle");
	if (!IsSafeWeapon(gruntWeapon))
		copy(gruntWeapon, charsmax(gruntWeapon), "weapon_deagle");

	// Both sides are picked from one scratch list, so nobody can end up on both of them.
	new bots[MAX_TRACKED_BOTS];
	new count;
	for (new id = 1; id <= get_maxplayers() && count < MAX_TRACKED_BOTS; id++)
	{
		if (IsBotAlive(id))
			bots[count++] = id;
	}

	if (count < 2)
	{
		log_amx("boss_raid: at least 2 living bots are needed, found %d", count);
		return;
	}

	// One raider at least: a raid of nothing but bosses is not a raid.
	if (wanted >= count)
		wanted = count - 1;

	g_bossCount = 0;
	g_bossHealth = health;
	g_bossRaidActive = true;
	copy(g_bossWeapon, charsmax(g_bossWeapon), bossWeapon);

	// Swap-to-front pick: as random as shuffling the list, without a second array.
	for (new i = 0; i < wanted; i++)
	{
		new pick = random_num(i, count - 1);
		new swap = bots[i];
		bots[i] = bots[pick];
		bots[pick] = swap;
		g_bosses[g_bossCount++] = bots[i];
	}

	for (new i = 0; i < g_bossCount; i++)
		BossArm(g_bosses[i]);

	new raiders;
	for (new i = wanted; i < count; i++)
	{
		StripWeapons(bots[i]);
		give_item(bots[i], "weapon_knife");
		give_item(bots[i], gruntWeapon);
		set_user_health(bots[i], 100);
		set_user_armor(bots[i], 50);
		raiders++;
	}

	if (nick[0] == '^0')
		Announce("BOSS RAID: %d BOSSES VS %d RAIDERS", g_bossCount, raiders);
	else
		Announce("%s CALLED A BOSS RAID: %d VS %d", nick, g_bossCount, raiders);
	log_amx("boss_raid: '%s' %d bosses (%d hp, %s) vs %d raiders (%s)", nick, g_bossCount, health, bossWeapon, raiders, gruntWeapon);
}

stock BossArm(id)
{
	StripWeapons(id);
	give_item(id, "weapon_knife");
	give_item(id, g_bossWeapon);
	set_user_health(id, g_bossHealth);
	set_user_armor(id, 100);
	set_user_rendering(id, kRenderFxGlowShell, 255, 0, 0, kRenderNormal, 25);
}

stock bool:IsBoss(id)
{
	for (new i = 0; i < g_bossCount; i++)
	{
		if (g_bosses[i] == id)
			return true;
	}
	return false;
}

stock ReportBossDown(killer, victim)
{
	new victimName[NICK_LEN];
	get_user_name(victim, victimName, NICK_LEN - 1);

	if (killer <= 0 || killer == victim || !is_user_connected(killer))
	{
		Announce("BOSS %s IS DOWN", victimName);
		log_amx("boss_raid: boss %d '%s' died without a killer", victim, victimName);
		return;
	}

	new killerName[NICK_LEN];
	get_user_name(killer, killerName, NICK_LEN - 1);
	Announce("BOSS %s DOWN - %s GETS THE KILL", victimName, killerName);
	log_amx("boss_raid: bot %d '%s' killed boss %d '%s'", killer, killerName, victim, victimName);
}

/* csdm_lite re-arms every respawn with a random weapon, so without this a boss would be an ordinary
   bot again after its first death and the raid would last one kill. The short delay is what puts
   this after csdm_lite's own arming, which runs in the same respawn. */
public OnPlayerSpawn(id)
{
	if (!g_bossRaidActive && !g_potatoActive)
		return;

	if (!is_user_connected(id) || !is_user_bot(id))
		return;

	if (IsBoss(id) || (g_potatoActive && id == g_potatoHolder))
		set_task(0.3, "RebuffOnSpawn", id);
}

public RebuffOnSpawn(id)
{
	if (!is_user_connected(id) || !is_user_alive(id) || !is_user_bot(id))
		return;

	if (g_bossRaidActive && IsBoss(id))
		BossArm(id);
	else if (g_potatoActive && id == g_potatoHolder)
		PotatoArm(id);
}

/* ---------- helpers ---------- */

/* The cheap personal tier: one bot gets the donor's name, a big health pool and a glow, so the
   viewer's money is visible on a single fighter for the next GLOW_SECONDS. */
public EffectBlessBot()
{
	new nick[VALUE_LEN];
	ParamCopy("nick", nick, charsmax(nick), "");

	new health = ParamInt("health", 250);
	if (health < 50)
		health = 50;
	if (health > 1000)
		health = 1000;

	new weapon[VALUE_LEN];
	ParamCopy("weapon", weapon, charsmax(weapon), "weapon_deagle");

	new bot = PickRandomBot();
	if (!bot)
	{
		log_amx("bless_bot: no bots are connected");
		return;
	}

	StripWeapons(bot);
	if (IsSafeWeapon(weapon))
		give_item(bot, weapon);
	give_item(bot, "weapon_knife");
	set_user_health(bot, health);
	set_user_rendering(bot, kRenderFxGlowShell, 0, 120, 255, kRenderNormal, 20);

	new botName[NICK_LEN];
	get_user_name(bot, botName, NICK_LEN - 1);
	Announce("%s BLESSED %s (^%d HP)", nick, botName, health);
	log_amx("bless_bot: %s -> bot %d '%s', %d hp, %s", nick, bot, botName, health, weapon);
	set_task(GLOW_SECONDS, "ClearGlow", bot);
}

/* The social hook: the bot with the most frags loses its weapons and most of its health.
   Frags are not shown in the message: the server runs free-for-all with friendly fire, where a
   kill subtracts a frag, so the number can be negative and only confuses the chat. */
public EffectCurseLeader()
{
	new nick[VALUE_LEN];
	ParamCopy("nick", nick, charsmax(nick), "");

	new health = ParamInt("health", 25);
	if (health < 1)
		health = 1;

	new bot = FindLeaderBot();
	if (!bot)
	{
		log_amx("curse_leader: no bots are connected");
		return;
	}

	new botName[NICK_LEN];
	get_user_name(bot, botName, NICK_LEN - 1);

	StripWeapons(bot);
	give_item(bot, "weapon_knife");
	set_user_health(bot, health);
	set_user_rendering(bot, kRenderFxGlowShell, 255, 40, 0, kRenderNormal, 20);

	Announce("%s CURSED THE LEADER %s", nick, botName);
	log_amx("curse_leader: %s cursed bot %d '%s', %d hp, knife only", nick, bot, botName, health);
	set_task(GLOW_SECONDS, "ClearGlow", bot);
}

/* The viewer's own words. RCON cannot carry spaces, so the control API sends underscores and the
   phrase arrives here as a single token; it is turned back into spaces for the chat line. */
public EffectBotPhrase()
{
	new text[VALUE_LEN];
	ParamCopy("text", text, charsmax(text), "");

	if (text[0] == '^0')
	{
		log_amx("bot_phrase: called without a phrase");
		return;
	}

	replace_all(text, charsmax(text), "_", " ");

	new bot = PickRandomBot();
	if (!bot)
	{
		log_amx("bot_phrase: no bots are connected");
		return;
	}

	new botName[NICK_LEN];
	get_user_name(bot, botName, NICK_LEN - 1);
	Announce("%s: %s", botName, text);
	log_amx("bot_phrase: bot %d '%s' said '%s'", bot, botName, text);
}

/* Runs one chaos effect right now, through plugins/chaos_core. The core owns the effects, the
   weights and the reverts; this is only the trigger, so a donation cannot leave a cvar behind. */
public EffectChaosBurst()
{
	server_cmd("amx_chaos force");
	Announce("CHAOS INCOMING");
	log_amx("chaos_burst: forced a chaos effect");
}

/* Removes the glow a bless/curse put on a bot. Health and weapons do not need this: the next
   spawn resets them, the glow would otherwise stay for the rest of the map. */
public ClearGlow(id)
{
	if (id > 0 && id <= get_maxplayers() && is_user_connected(id))
		set_user_rendering(id);
}

/* ---------- helpers ---------- */

stock Announce(const format[], any:...)
{
	// The nickname arrives as an argument, never inside the format string: a stray '%' from a bot
	// name would otherwise be read as a format specifier.
	new text[192];
	vformat(text, charsmax(text), format, 2);
	client_print(0, print_chat, "[DONATE] %s", text);
}

stock PickRandomBot()
{
	new bots[32];
	new count;

	for (new id = 1; id <= get_maxplayers() && count < sizeof bots; id++)
	{
		if (IsBotAlive(id))
			bots[count++] = id;
	}

	if (count == 0)
		return 0;

	return bots[random(count)];
}

stock FindLeaderBot()
{
	new best;
	new bestFrags = -1;

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new frags = get_user_frags(id);
		if (frags > bestFrags)
		{
			bestFrags = frags;
			best = id;
		}
	}

	return best;
}

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





