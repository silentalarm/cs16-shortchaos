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
 * reads as a refund request. Lasting effects end on their own clock (set_task + `seconds=` from the
 * catalogue), because a csdm_lite round almost never ends; Round_End, `amx_de clear` and plugin_end
 * are the fallback that drops whatever is still running. bot_nick persists until the map changes;
 * map_change changes the map at once.
 * Round fights (bounty, hot_potato, boss_raid) watch DeathMsg for the rest of the round: the
 * effect changes hands when a bot dies, which is the part the viewer is paying for.
 * Adding an activity = write a handler and add one RegisterDonationEffect line.
 */
#include <amxmodx>
#include <fakemeta>
#include <fun>
// Weapon ids and user_has_weapon: the HE party below has to tell a knife from a rifle.
#include <cstrike>
// ExecuteHamB (Ham_TraceAttack, Ham_TakeDamage) lives here; without it amxxpc aborts with SIGABRT
// and no diagnostics at all, which is the trap docs/runbook.md warns about.
#include <hamsandwich>

#define PLUGIN_NAME "Donation Events"
#define PLUGIN_VERSION "0.6.0"
#define API_VERSION 1

/* `#pragma dynamic` is in cells (4 bytes each). amxxpc aborts on this file with std::bad_alloc at a
   smaller heap even though the plugin itself would fit: the registry, the parameter table and the
   round-fight state push the static data to 29.6 KB of its 32 KB budget, and the compiler needs the
   spare arena. 65536 cells is 256 KB per plugin, which a 22-slot server can afford for the one
   plugin that matters, and it is the value that actually compiles here. */
#pragma dynamic 65536

// How long a blessed or cursed bot keeps its glow. Health and weapons reset on the next spawn.
#define GLOW_SECONDS 20.0

/* The registry only has to hold the codes the catalogue sells: the 18 legacy handlers plus the eight
   2025-10 events is 26, so the table is 30. It used to be 32, which costs 2 KB of static data for
   nothing - and static data is what amxxpc runs out of on this file, so it is not padded further. */
#define MAX_EFFECTS 30
/* m_pActiveItem is not defined by the CS include set of this AMXX build. 373 with the linux player
   offset (5) is the field the active weapon entity is read from; it has not moved since CS 1.6, and
   the alternative is a version-specific include. */
#define OFFSET_ACTIVE_ITEM 373
#define MAX_PARAMS 12
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
/* The name the plugin actually put on the bot, so a stale tag can be told apart from a name the
   server itself changed. Declared here, with the other nick state: a `new` further down the file is
   invisible to a function above it, and amxxpc answers that with std::bad_alloc, not with an error. */
new g_nickApplied[NICK_LEN];
new bool:g_nickActive;

/* The donor tag: a bot at the top of the scoreboard temporarily wears the buyer's name. It is
   separate from bot_nick on purpose - that one is bought outright and lasts until the map changes,
   while this one is a badge on top of whatever activity the money bought. */
#define TASK_DONOR_TAG 4021
new g_donorBot;
new g_donorOriginal[NICK_LEN];
new g_donorApplied[NICK_LEN];
new bool:g_donorActive;

new g_savedGravity;
new g_savedBotQuota;
new bool:g_gravitySaved;
new bool:g_quotaSaved;
/* zombie_round is the only effect that touches per-player run speed; the flag keeps CleanupActive
   from rewriting every bot's speed on a round end that never changed it. */
new bool:g_speedBoosted;

/* lightsaber_duel holds the whole field on knives for its clock. The flag is read by the respawn and
   weapon-switch hooks, and the health is captured at event start because the parameter table is gone
   by the time a bot respawns. */
new bool:g_duelActive;
new g_duelHealth;

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

/* The HE party was the first effect with a clock of its own: it does not end with the round, it ends
   when `seconds` runs out. The task runs twice a second, so the counter counts halves. */
#define TASK_HE_PARTY 4013
/* Accumulated party time is capped at 20 minutes: enough for any honest donation, short enough that a
   fat-fingered amount cannot leave the server in grenade mode for an hour. The task ticks twice a
   second, so the cap is in halves. */
#define MAX_HE_PARTY_TICKS 2400
new g_hePartyTicks;
new bool:g_hePartyActive;

/* Every other lasting effect now has a clock too. With csdm_lite a round almost never ends, so
   waiting for Round_End meant a gravity change, a bounty or a boss raid could sit on the server until
   the next map. The task id is derived from the registry index, which gives exactly one timer per
   code: starting the same effect again replaces its timer instead of stacking a second one. */
#define TASK_EFFECT_BASE 4500
#define DEFAULT_EFFECT_SECONDS 45.0

/* ---------- the 2025-10 event set: 50 RUB, 15 seconds, one event in the frame ---------- */

/* Every event of this set is a 15 second show and none of them may overlap: ice under a time stop, a
   freeze during a meteor shower, two handlers fighting over the same bots - the viewer sees none of
   it. Each handler calls BeginEvent() first, which ends whatever was running. */
#define EVENT_SECONDS 15.0

#define TASK_CANNON_AMMO 4701
#define TASK_METEOR 4702
#define TASK_RED_STOP 4703
#define TASK_RED_GO 4704

/* The explosion temp entity is a protocol constant; some include sets define the name, others do
   not, and a redefinition is a compile error, so it is guarded. */
#if !defined TE_EXPLOSION
#define TE_EXPLOSION 3
#endif

new g_cannonBot;
new bool:g_cannonActive;
/* The health the cannon bot had before it was buffed: "restore what it was" is part of what the
   viewer buys, and a 1000 HP bot that keeps the number after the clock is a bug you can see. */
new g_cannonSavedHealth;

new bool:g_meteorActive;
new g_meteorSprite;

new bool:g_redLightActive;
new bool:g_redFrozen;
/* `stock` has to be captured when the event starts: g_param* is cleared as soon as the command handler
   returns (`RunHandler` in HandleActivity), and the phase timers fire 1.5 s and 3.5 s later. Read the
   parameter there and the fallback 1 answers instead - which is exactly how the stock chime and the
   alarm came back after the first cue. */
new bool:g_redStockCues;



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
	// CurWeapon fires on every weapon switch: lightsaber_duel turns one back into a knife.
	register_event("CurWeapon", "OnCurWeapon", "be", "1=1");
	// A dropped weapon is a pickup away from breaking the duel; the touch hook refuses it.
	RegisterHam(Ham_Touch, "weaponbox", "OnWeaponBoxTouch");

	RegisterDonationEffect("bot_nick", "EffectBotNick");
	RegisterDonationEffect("meat_round", "EffectMeatRound");
	RegisterDonationEffect("knives_only", "EffectKnivesOnly");
	RegisterDonationEffect("he_party", "EffectHeParty");
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

	// The 2025-10 event set: 50 RUB each, 15 seconds each, one in the frame at a time.
	RegisterDonationEffect("glass_cannon", "EffectGlassCannon");
	RegisterDonationEffect("meteor_shower", "EffectMeteorShower");
	RegisterDonationEffect("red_light", "EffectRedLight");
	RegisterDonationEffect("lightsaber_duel", "EffectLightsaberDuel");
	RegisterDonationEffect("one_bullet", "EffectOneBullet");

	log_amx("loaded, API %d, %d activities", API_VERSION, g_effectCount);
}

/* The meteor is the only model this set needs; the sounds are stock CS files, precached so
   emit_sound cannot be dropped for an uncached sample. Custom sounds and models go here later.
   Precaching is not playback: a file listed here is only loaded into the client's cache, so removing
   a line here silences nothing - it only makes the corresponding emit_sound a no-op. `stock=0` is what
   turns those sounds off, and the red_light timers read it from a global, see g_redStockCues. */
public plugin_precache()
{
	g_meteorSprite = precache_model("sprites/zerogxplode.spr");
	precache_sound("weapons/awp1.wav");
	precache_sound("weapons/knife_slash1.wav");
	// red_light cues: the alarm for RED, the positive chime for GREEN. Both ship with CS 1.6, and both
	// are muted at runtime by `stock=0`; the files stay precached because the catalogue may set stock=1.
	precache_sound("ambience/alarm1.wav");
	precache_sound("events/task_complete.wav");
	// The per-event announcement sounds (AnnounceEventSound). A file missing here is a silent event.
	precache_sound("ambience/thunder_clap.wav");
	precache_sound("ambience/lv_jubilee.wav");
	precache_sound("ambience/lv_neon.wav");
	precache_sound("ambience/Opera.wav");
	precache_sound("events/enemy_died.wav");
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
		// One line per ~100 characters, each with the same label. A single 300 character line comes
		// back to the control API truncated - measured: the tail of the registry was silently missing
		// and the panel reported six events as "not in the Pawn plugin" while the plugin had them.
		new list[128];
		new printed;

		for (new i = 0; i < g_effectCount; i++)
		{
			new needed = strlen(g_codes[i]) + (list[0] ? 1 : 0);
			if (list[0] && strlen(list) + needed > 100)
			{
				server_print("donation_events codes: %s", list);
				list[0] = '^0';
				printed++;
			}

			if (list[0])
				add(list, charsmax(list), ",");
			add(list, charsmax(list), g_codes[i]);
		}

		if (list[0])
		{
			server_print("donation_events codes: %s", list);
			printed++;
		}

		log_amx("codes: %d activities in %d lines", g_effectCount, printed);
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

	// The buyer's name goes on the scoreboard for every activity that carries a nickname and does not
	// rename a bot itself: the effect is what the money bought, this is who bought it. The tag lives as
	// long as the effect the same command bought.
	if (!equal(code, "bot_nick") && !equal(code, "bot_phrase") && !equal(code, "map_change") && !equal(code, "chaos_burst"))
	{
		new nick[VALUE_LEN];
		ParamCopy("nick", nick, charsmax(nick), "");
		AssignDonorNameToTopBot(nick, EffectSeconds(60.0));
	}

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

/* ---------- effect clocks ---------- */

/* The length comes from the command (`seconds=`, taken from config/activities.json) and falls back to
   the constant the effect passes: the RCON line is built by the control API, so the panel can retune a
   duration without recompiling the plugin. */
stock Float:EffectSeconds(Float:fallback)
{
	new Float:value = ParamFloat("seconds", fallback);
	if (value < 1.0)
		value = 1.0;
	if (value > 600.0)
		value = 600.0;
	return value;
}

/* Re-arms the clock of one effect: remove_task first, because a second donation of the same activity
   must extend the effect, not leave two timers racing to clean the same state. */
stock StartEffectTimer(const code[], Float:seconds)
{
	new index = FindEffect(code);
	if (index < 0)
		return 0;

	new taskid = TASK_EFFECT_BASE + index;
	remove_task(taskid);
	set_task(seconds, "TaskEffectFinished", taskid);
	log_amx("timer: '%s' ends in %.0f s", code, seconds);
	return taskid;
}

stock StopEffectTimer(const code[])
{
	new index = FindEffect(code);
	if (index >= 0)
		remove_task(TASK_EFFECT_BASE + index);
}

/* Drops every clock, including the HE party's. Called from Round_End, `amx_de clear` and plugin_end. */
stock StopAllEffectTimers()
{
	for (new i = 0; i < g_effectCount; i++)
		remove_task(TASK_EFFECT_BASE + i);

	// remove_task alone would leave the party's flag set: TaskHeParty is gone, so nothing would ever
	// clear it, and the next he_party would start on top of a state it believes is still running.
	remove_task(TASK_HE_PARTY);
	g_hePartyActive = false;
	g_hePartyTicks = 0;
}

public TaskEffectFinished(taskid)
{
	new index = taskid - TASK_EFFECT_BASE;
	if (index < 0 || index >= g_effectCount)
		return;

	new code[CODE_LEN];
	copy(code, CODE_LEN - 1, g_codes[index]);
	FinishEffect(code);
}

/* Ends one effect by its own clock: it gives back what *this* effect took, and leaves its neighbours
   running. The full reset (`CleanupActive`) stays for the round end, `amx_de clear` and plugin_end,
   where everything is supposed to stop. */
stock FinishEffect(const code[])
{
	StopEffectTimer(code);
	EndEffectState(code);

	if (g_activeCode[0] && equali(g_activeCode, code))
	{
		// Another effect of the same batch may still be armed: report that one, otherwise the stream
		// reads `active=none` and cuts the music while the game is still showing something.
		g_activeCode[0] = '^0';
		LiveEffectCode(g_activeCode, CODE_LEN - 1, code);
	}

	log_amx("activity '%s' finished on its timer", code);
	server_print("donation_events finished %s", code);
}

/* The first effect whose clock is still armed, skipping `skip`: what the status line reports while a
   batch is winding down. */
stock LiveEffectCode(dest[], len, const skip[])
{
	for (new i = 0; i < g_effectCount; i++)
	{
		if (!task_exists(TASK_EFFECT_BASE + i))
			continue;

		if (skip[0] && equali(skip, g_codes[i]))
			continue;

		copy(dest, len - 1, g_codes[i]);
		return 1;
	}
	return 0;
}

/* One effect's own undo. Codes handled here keep a batch alive: a meteor that ends must not restore the
   cannon bot's health, and a duel that ends must not drop a zombie's speed. Anything else (the older
   fight effects) keeps the global reset it has always had - their state is not split per effect yet. */
stock EndEffectState(const code[])
{
	if (equal(code, "glass_cannon"))
	{
		remove_task(TASK_CANNON_AMMO);
		if (g_cannonBot > 0 && g_cannonSavedHealth > 0 && is_user_alive(g_cannonBot))
			set_user_health(g_cannonBot, g_cannonSavedHealth);
		g_cannonActive = false;
		g_cannonBot = 0;
		g_cannonSavedHealth = 0;
		return;
	}

	if (equal(code, "meteor_shower"))
	{
		remove_task(TASK_METEOR);
		g_meteorActive = false;
		return;
	}

	if (equal(code, "red_light"))
	{
		remove_task(TASK_RED_STOP);
		remove_task(TASK_RED_GO);
		// Unconditional: a freeze whose task was dropped would leave the server frozen for good.
		ThawAll();
		g_redStockCues = false;
		return;
	}

	if (equal(code, "lightsaber_duel"))
	{
		g_duelActive = false;
		ResetBotSpeed();
		// The duel glows the whole field, and a glow is render state on the entity: it survives respawn.
		for (new id = 1; id <= get_maxplayers(); id++)
			ClearGlow(id);
		return;
	}

	if (equal(code, "one_bullet"))
	{
		// One round in the clip and nothing in reserve: the next spawn hands the normal kit back.
		return;
	}

	CleanupActive();
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
	// the cleanup must not depend on which one happened to be applied last. The clocks are dropped
	// with it: an effect the round already ended must not announce itself again in two minutes.
	StopAllEffectTimers();
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
	ClearDonorName();
	ResetBotSpeed();
	// The 2025-10 events keep their own tasks and cvars; one entry point for every reset path.
	ResetEventState();
}

/* Puts every bot back on the server's own run speed. Needed because set_user_maxspeed survives both
   death and respawn: without this the zombies of one donation would stay fast for the whole map. */
stock ResetBotSpeed()
{
	if (!g_speedBoosted)
		return;

	new Float:speed = get_cvar_float("sv_maxspeed");
	if (speed <= 0.0)
		speed = 320.0;

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (IsBotAlive(id))
			set_user_maxspeed(id, speed);
	}

	g_speedBoosted = false;
	log_amx("speed: back to %.0f", speed);
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
	StopAllEffectTimers();
	CleanupActive();

	if (g_nickActive)
		RestoreNick();

	g_activeCode[0] = '^0';
	g_paramCount = 0;
}

public plugin_end()
{
	// A map change unloads the plugin while the server keeps running: every clock and every cvar has
	// to be dropped here, or the next map inherits a renamed bot and a 200 gravity world.
	StopAllEffectTimers();
	CleanupActive();
	if (g_nickActive)
		RestoreNick();
}

/* A player id is a slot, not a person: the engine reuses the slot of a bot that dropped, so every
   piece of state keyed by id is dropped here. Without this the next occupant inherits somebody else's
   bounty, potato, boss bar or nickname.
 *
 * `drop`, `message` and `maxlen` are part of the AMXX forward
 * (`client_disconnected(id, bool:drop, message[], maxlen)`); nothing here depends on them. Declaring
 * the forward with a shorter parameter list makes amxxpc abort with std::bad_alloc instead of a
 * readable error, which costs an hour of guessing. */
public client_disconnected(id, bool:drop, message[], maxlen)
{
	if (id <= 0 || id > get_maxplayers())
		return;

	// The 0.3 s re-arm a boss or the potato scheduled for this spawn.
	remove_task(id);
	ClearGlow(id);

	if (g_bountyTarget == id)
	{
		g_bountyTarget = 0;
		g_bountyActive = false;
		StopEffectTimer("bounty");
	}

	if (g_potatoHolder == id)
	{
		g_potatoHolder = 0;
		g_potatoActive = false;
		StopEffectTimer("hot_potato");
	}

	DropBoss(id);

	if (g_nickBot == id)
	{
		g_nickActive = false;
		g_nickBot = 0;
		g_nickApplied[0] = '^0';
	}

	if (g_donorBot == id)
	{
		// Nobody is left to restore the name on, so only the state is dropped.
		g_donorActive = false;
		g_donorBot = 0;
		g_donorApplied[0] = '^0';
		remove_task(TASK_DONOR_TAG);
	}

	// The cannon re-arms a role on a player id; the next occupant of the slot must not inherit it.
	// The ticking task picks a fresh bot on its next pass.

	log_amx("client %d left, its effect state is dropped", id);
}

/* Removes one id from the boss list and keeps the list dense, so IsBoss and the re-arm never look at
   an empty slot that a fresh connection could take over. */
stock DropBoss(id)
{
	for (new i = 0; i < g_bossCount; i++)
	{
		if (g_bosses[i] != id)
			continue;

		for (new j = i; j < g_bossCount - 1; j++)
			g_bosses[j] = g_bosses[j + 1];

		g_bossCount--;
		g_bosses[g_bossCount] = 0;
		i--;
	}

	if (g_bossCount == 0 && g_bossRaidActive)
	{
		g_bossRaidActive = false;
		StopEffectTimer("boss_raid");
	}
}

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
	// Weapons and health come back with the next respawn, but a bot that never dies would keep 1 HP
	// for the rest of the map: the clock is what makes the effect temporary, not the round.
	StartEffectTimer("meat_round", EffectSeconds(DEFAULT_EFFECT_SECONDS));
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

/* HE party: every weapon gone, endless HE grenades, for a fixed number of seconds. The effect is a
   timer, not a round: a round is nine minutes now, and this is a 60 second gag.
 *
 * A thrown grenade is handed straight back, and a bot that dies while the party runs is disarmed
 * again right after csdm_lite respawned it with a rifle - which is why this re-arms the field twice
 * a second instead of once at the start. */
public EffectHeParty()
{
	new seconds = ParamInt("seconds", 60);
	if (seconds < 5)
		seconds = 5;
	if (seconds > 600)
		seconds = 600;

	// A party that is already running is extended, not restarted: 150 RUB is three 50 RUB steps, and
	// every step has to add a minute instead of re-selling the same one. The cap keeps a huge donation
	// from parking the server in grenade mode for an hour.
	new bool:wasActive = g_hePartyActive;
	if (wasActive)
		g_hePartyTicks += seconds * 2;
	else
		g_hePartyTicks = seconds * 2;

	if (g_hePartyTicks > MAX_HE_PARTY_TICKS)
		g_hePartyTicks = MAX_HE_PARTY_TICKS;

	g_hePartyActive = true;

	DisarmField();

	// One repeating task for the whole run: a second `set_task` on the same id would be ignored by
	// some AMXX builds and would double the counter on others.
	if (!wasActive)
		set_task(0.5, "TaskHeParty", TASK_HE_PARTY, "", 0, "b");

	log_amx("he_party: knives and endless HE, +%d s (total %d s)", seconds, g_hePartyTicks / 2);
}

public TaskHeParty()
{
	if (!g_hePartyActive)
		return;

	DisarmField();

	g_hePartyTicks = g_hePartyTicks - 1;
	if (g_hePartyTicks > 0)
		return;

	g_hePartyActive = false;
	remove_task(TASK_HE_PARTY);
	Announce("HE GRENADES ARE OVER");
	// Nothing to restore: the bots keep the knife until they die, and the next spawn gives them a
	// real weapon again through csdm_lite.
	log_amx("he_party: over, the next spawn arms the bots again");
}

/* Every alive bot: a knife and a grenade, nothing else. The check walks the whole weapon list, not
   the weapon in hand: a bot that keeps a rifle in the backpack pulls it out the moment it sees
   somebody, and the party is over without the timer ever firing. */
stock DisarmField()
{
	new disarmed;

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		if (HasGun(id))
		{
			StripWeapons(id);
			give_item(id, "weapon_knife");
			disarmed++;
		}

		// The grenade is re-given after it is thrown, which is the "endless" part of the activity.
		if (!user_has_weapon(id, CSW_HEGRENADE))
			give_item(id, "weapon_hegrenade");
	}

	if (disarmed > 0)
		log_amx("he_party: %d bots disarmed", disarmed);
}

stock bool:HasGun(id)
{
	new weapons[32];
	new count;
	get_user_weapons(id, weapons, count);

	for (new i = 0; i < count; i++)
	{
		if (weapons[i] == CSW_KNIFE)
			continue;
		if (weapons[i] == CSW_HEGRENADE)
			continue;
		return true;
	}

	return false;
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
	// sv_gravity is server wide: without a clock a single donation would change the map's physics
	// until the next changelevel, because Round_End almost never arrives here.
	StartEffectTimer("moon_gravity", EffectSeconds(60.0));
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
	// The quota is a server cvar: the extra bots have to go away on their own, or the stream ends up
	// with a full server nobody asked for.
	StartEffectTimer("bot_rain", EffectSeconds(90.0));
	log_amx("bot_rain: quota %d -> %d", current, target);
}

public EffectTerminators()
{
	new difficulty = ParamInt("difficulty", 100);

	if (SetCvarFirst("yb_difficulty", "pb_skill", difficulty))
	{
		StartEffectTimer("terminators", EffectSeconds(60.0));
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
	StartEffectTimer("terminators", EffectSeconds(60.0));
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
		// zombieSpeed is a multiplier of the normal run speed: set_user_maxspeed takes units, and
		// passing 1.2 froze the zombies in place instead of making them fast.
		new Float:baseSpeed = get_cvar_float("sv_maxspeed");
		if (baseSpeed <= 0.0)
			baseSpeed = 320.0;
		set_user_maxspeed(id, baseSpeed * speed);
		made++;
	}

	g_speedBoosted = made > 0;

	StartEffectTimer("zombie_round", EffectSeconds(60.0));
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
	StartEffectTimer("terminator_one", EffectSeconds(60.0));
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
	// The fight follows the kill feed, and with csdm_lite the round does not end: the bounty needs its
	// own deadline or an unfound target keeps the price forever.
	StartEffectTimer("bounty", EffectSeconds(60.0));

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
	// The bounty is settled here; its clock would only fire into an empty state.
	StopEffectTimer("bounty");

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
	StartEffectTimer("hot_potato", EffectSeconds(60.0));

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
		StopEffectTimer("hot_potato");
		Announce("HOT POTATO BURNED OUT WITH %s", victimName);
		log_amx("hot_potato: '%s' died without a killer, the potato is gone", victimName);
		return;
	}

	g_potatoHolder = killer;
	g_potatoActive = true;
	PotatoArm(killer);
	// Each pass resets the deadline: the potato is one effect that changes hands, not one per victim.
	StartEffectTimer("hot_potato", EffectSeconds(60.0));

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
	StartEffectTimer("boss_raid", EffectSeconds(90.0));
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
   this after csdm_lite's own arming, which runs in the same respawn. The duel uses the same hook for
   the same reason: a bot that respawns with a rifle mid-duel would end the "knives only" rule. */
public OnPlayerSpawn(id)
{
	if (!g_bossRaidActive && !g_potatoActive && !g_duelActive)
		return;

	if (!is_user_connected(id) || !is_user_bot(id))
		return;

	if (IsBoss(id) || (g_potatoActive && id == g_potatoHolder) || g_duelActive)
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
	else if (g_duelActive)
		DuelArm(id);
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

/* ---------- the 2025-10 events: shared state ---------- */

/* `stock=0` in the catalogue mutes the built-in cues: the stream then plays its own files for the
   phases (src/voice.ts schedules them), and two sound sources on top of each other is noise. */
stock bool:HasStockCues()
{
	return ParamInt("stock", 1) != 0;
}

/* Every event opens with its own sound. Without an audio cue a frozen picture or a sudden freeze reads
   as a broken stream; stock CS 1.6 files only, because the capture client already has them. The
   catalogue can override nothing here on purpose: an arbitrary path from RCON would have to be
   precached first, and a missing sample is a silent event, not an error.
   `stock=0` silences the whole stock channel of that event, this opener included: `red_light` opens
   on `ambience/lv_neon.wav`, a neon hum that sat right on top of the stream's own RED cue. */
stock AnnounceEventSound(const code[])
{
	new sound[64];

	if (!HasStockCues())
	{
		log_amx("event '%s' opens without a stock sound (stock=0)", code);
		return;
	}

	if (equal(code, "meteor_shower"))
		copy(sound, charsmax(sound), "ambience/thunder_clap.wav");
	else if (equal(code, "glass_cannon"))
		copy(sound, charsmax(sound), "ambience/lv_jubilee.wav");
	else if (equal(code, "lightsaber_duel"))
		copy(sound, charsmax(sound), "ambience/Opera.wav");
	else if (equal(code, "one_bullet"))
		copy(sound, charsmax(sound), "weapons/awp1.wav");
	else if (equal(code, "red_light"))
		copy(sound, charsmax(sound), "ambience/lv_neon.wav");
	else
		copy(sound, charsmax(sound), "events/task_complete.wav");

	emit_sound(0, CHAN_AUTO, sound, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
	log_amx("event '%s' announces itself with %s", code, sound);
}

/* Several paid activities run at once - one donation can buy a whole batch - so starting one must not
   cancel the others. Nothing is reset here: each effect owns its own state and its own clock, and
   `FinishEffect` gives back only what the effect that ended had taken. */
public BeginEvent(const code[])
{
	AnnounceEventSound(code);
	log_amx("event '%s' starts", code);
}

/* Drops every task and every cvar this set touched. CleanupActive calls it, so Round_End,
   `amx_de clear`, plugin_end and every effect clock inherit the same reset. */
public ResetEventState()
{
	remove_task(TASK_CANNON_AMMO);
	remove_task(TASK_METEOR);
	remove_task(TASK_RED_STOP);
	remove_task(TASK_RED_GO);

	if (g_cannonBot > 0 && g_cannonSavedHealth > 0 && is_user_alive(g_cannonBot))
		set_user_health(g_cannonBot, g_cannonSavedHealth);

	// Every glow goes, not only the two the handlers remember by id: `lightsaber_duel` glows the whole
	// field, and a glow is a render mode on the entity, so it survives respawn and stays for the rest of
	// the map - that is the "glow never goes away" a viewer reported.
	for (new id = 1; id <= get_maxplayers(); id++)
		ClearGlow(id);


	// Unconditional: a red light or a time stop whose task was dropped would otherwise leave the
	// whole server frozen with nothing left to undo it.
	ThawAll();

	g_cannonActive = false;
	g_cannonBot = 0;
	g_cannonSavedHealth = 0;
	g_meteorActive = false;
	g_redLightActive = false;
	g_redFrozen = false;
	g_redStockCues = false;
	g_duelActive = false;
}

stock FreezeBot(id)
{
	set_pev(id, pev_flags, pev(id, pev_flags) | FL_FROZEN);
}

stock ThawBot(id)
{
	if (id > 0 && id <= get_maxplayers() && is_user_connected(id))
		set_pev(id, pev_flags, pev(id, pev_flags) & ~FL_FROZEN);
}

stock FreezeAll()
{
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (IsBotAlive(id))
			FreezeBot(id);
	}
}

stock ThawAll()
{
	for (new id = 1; id <= get_maxplayers(); id++)
		ThawBot(id);
}

/* The nearest other bot, or 0. The time stop aims its shots server-side instead of trusting a frozen
   bot's aim, because the three shots are the thing the viewer paid for. */
stock FindNearestBot(id)
{
	new Float:origin[3];
	new Float:candidate[3];
	pev(id, pev_origin, origin);

	new best;
	new Float:bestDistance = 99999.0;

	for (new other = 1; other <= get_maxplayers(); other++)
	{
		if (other == id || !IsBotAlive(other))
			continue;

		pev(other, pev_origin, candidate);
		new Float:distance = get_distance_f(origin, candidate);
		if (distance < bestDistance)
		{
			bestDistance = distance;
			best = other;
		}
	}

	return best;
}

/* ---------- the 2025-10 events: handlers ---------- */





/* A big gun and one hit point: the viewer pays to watch a glass cannon either farm or die. The role
   moves to another bot when it dies, otherwise 1 HP would end the show in two seconds. */
public EffectGlassCannon()
{
	BeginEvent("glass_cannon");

	g_cannonBot = PickRandomBot();
	if (!g_cannonBot)
	{
		log_amx("glass_cannon: no bots are connected");
		return;
	}

	g_cannonActive = true;
	ArmGlassCannon(g_cannonBot);
	set_task(0.2, "TaskCannonAmmo", TASK_CANNON_AMMO, "", 0, "b");

	StartEffectTimer("glass_cannon", EffectSeconds(EVENT_SECONDS));
	DonorSay("1 HP, AN M249 AND NO RELOAD");
}

stock ArmGlassCannon(id)
{
	// The old health is remembered so the clock can put it back: 1000 HP that stays after the event is
	// not "a buff", it is a broken bot the viewer keeps seeing.
	g_cannonSavedHealth = get_user_health(id);
	if (g_cannonSavedHealth < 1)
		g_cannonSavedHealth = 100;

	StripWeapons(id);
	give_item(id, "weapon_m249");
	give_item(id, "weapon_knife");
	set_user_health(id, ParamInt("health", 1000));
	set_user_rendering(id, kRenderFxGlowShell, 255, 0, 0, kRenderNormal, 22);

	log_amx("glass_cannon: bot %d armed with %d hp (was %d)", id, ParamInt("health", 1000), g_cannonSavedHealth);
}

public TaskCannonAmmo()
{
	if (!g_cannonActive)
	{
		remove_task(TASK_CANNON_AMMO);
		return;
	}

	if (!IsBotAlive(g_cannonBot))
	{
		g_cannonBot = PickRandomBot();
		if (!g_cannonBot)
			return;

		ArmGlassCannon(g_cannonBot);
		return;
	}

	// Refilling the clip five times a second is what removes the reload: the bot never runs dry long
	// enough for the animation to start, so the M249 simply never stops.
	new weapon = get_pdata_cbase(g_cannonBot, OFFSET_ACTIVE_ITEM, 5);
	if (weapon > 0)
		cs_set_weapon_ammo(weapon, 100);
	cs_set_user_bpammo(g_cannonBot, CSW_M249, 200);
}



/* Meteors: explosions and damage spheres on a timer, aimed near a random bot so the strike lands
   where the camera already is. The sprite is precached in plugin_precache().
   Ten times more often than the first version and a fraction of the damage: the field is under
   constant fire, but a meteor tickles - 43 strikes a second at 2 damage is 86 damage per second in
   the blast, against 1200 before, which killed a bot before the viewer saw the shower. */
#define METEOR_INTERVAL 0.07
#define METEOR_STRIKES 3

public EffectMeteorShower()
{
	BeginEvent("meteor_shower");

	if (!PickRandomBot())
	{
		log_amx("meteor_shower: no bots are connected");
		return;
	}

	g_meteorActive = true;
	MeteorVolley();
	set_task(METEOR_INTERVAL, "TaskMeteor", TASK_METEOR, "", 0, "b");

	StartEffectTimer("meteor_shower", EffectSeconds(EVENT_SECONDS));
	log_amx("meteor_shower: %d strikes every %.2f s, %d damage a strike",
		METEOR_STRIKES, METEOR_INTERVAL, ParamInt("damage", 2));
	DonorSay("METEOR SHOWER");
}

public TaskMeteor()
{
	if (!g_meteorActive)
	{
		remove_task(TASK_METEOR);
		return;
	}

	MeteorVolley();
}

/* Three strikes per tick, every METEOR_INTERVAL. The first version dropped one explosion per 1.5 s,
   which read as weather rather than as an event; the interval is what makes the barrage. */
stock MeteorVolley()
{
	for (new i = 0; i < METEOR_STRIKES; i++)
		MeteorStrike();
}

stock MeteorStrike()
{
	new pivot = PickRandomBot();
	if (!pivot)
		return;

	new Float:center[3];
	pev(pivot, pev_origin, center);
	center[0] += random_float(-220.0, 220.0);
	center[1] += random_float(-220.0, 220.0);

	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_EXPLOSION);
	write_coord(floatround(center[0]));
	write_coord(floatround(center[1]));
	write_coord(floatround(center[2]));
	write_short(g_meteorSprite);
	write_byte(30);
	write_byte(15);
	write_byte(0);
	message_end();

	new radius = ParamInt("radius", 320);
	new damage = ParamInt("damage", 2);

	// No per-strike log line: at 43 strikes a second it would write 640 lines per event and format a
	// string inside the hot loop. The setup line in EffectMeteorShower carries the numbers instead.
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:where[3];
		pev(id, pev_origin, where);
		if (get_distance_f(center, where) > float(radius))
			continue;

		ExecuteHamB(Ham_TakeDamage, id, 0, 0, float(damage), DMG_BLAST);
	}
}

/* Squid game: the picture alternates between everybody running and everybody frozen. It opens on RED,
   because that is the frame that reads without any explanation. */
public EffectRedLight()
{
	BeginEvent("red_light");

	g_redLightActive = true;
	FreezeAll();
	g_redFrozen = true;
	DonorSay("RED LIGHT");
	// The alarm is the whole point of the game: the picture freezes, so the sound has to tell the
	// viewer whether that freeze is the game or a broken stream. Stock CS files, so no new assets;
	// stock=0 mutes them when the stream plays its own cues for the phases instead.
	// Captured here, not read again in the timers: the parameter table is gone by then.
	g_redStockCues = HasStockCues();
	if (g_redStockCues)
		emit_sound(0, CHAN_AUTO, "ambience/alarm1.wav", VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
	log_amx("red_light: RED, stock cues %s", g_redStockCues ? "on" : "off");

	set_task(1.5, "TaskRedLightGo", TASK_RED_GO);
	StartEffectTimer("red_light", EffectSeconds(EVENT_SECONDS));
}

public TaskRedLightGo()
{
	if (!g_redLightActive)
		return;

	ThawAll();
	g_redFrozen = false;
	DonorSay("GREEN LIGHT");
	if (g_redStockCues)
		emit_sound(0, CHAN_AUTO, "events/task_complete.wav", VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
	log_amx("red_light: GREEN, stock cues %s", g_redStockCues ? "on" : "off");
	set_task(2.0, "TaskRedLightStop", TASK_RED_STOP);
}

public TaskRedLightStop()
{
	if (!g_redLightActive)
		return;

	FreezeAll();
	g_redFrozen = true;
	DonorSay("RED LIGHT");
	if (g_redStockCues)
		emit_sound(0, CHAN_AUTO, "ambience/alarm1.wav", VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
	log_amx("red_light: RED again, stock cues %s", g_redStockCues ? "on" : "off");
	set_task(1.5, "TaskRedLightGo", TASK_RED_GO);
}

/* Knives with a team glow and 25 HP: the duel is over in one swing, so the extra run speed is what
   makes it watchable. The speeds go back through ResetBotSpeed, the glow through ClearGlow.
   The duel owns the field until its clock runs out: DuelArm is re-applied on every respawn, a weapon
   switch back to a rifle is undone (OnCurWeapon) and a dropped weapon cannot be picked up
   (OnWeaponBoxTouch), so "knives only" holds for the whole event and not just for the bots that
   happened to be alive when it started. */
public EffectLightsaberDuel()
{
	BeginEvent("lightsaber_duel");

	new health = ParamInt("health", 25);
	if (health < 1)
		health = 1;

	g_duelHealth = health;
	g_duelActive = true;

	new bots;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		DuelArm(id);
		bots++;
	}

	// ResetBotSpeed (called from CleanupActive) is what puts the speeds back on the clock.
	g_speedBoosted = true;

	// `stock=0` leaves the soundtrack to the stream, and the swing cue is a stock sound too: the stream
	// plays the opera bed instead of it.
	if (HasStockCues())
		emit_sound(0, CHAN_ITEM, "weapons/knife_slash1.wav", VOL_NORM, ATTN_NORM, 0, PITCH_NORM);

	StartEffectTimer("lightsaber_duel", EffectSeconds(EVENT_SECONDS));
	log_amx("lightsaber_duel: %d bots on knives, %d hp, other weapons blocked", bots, health);
	DonorSay("KNIVES ARE LIGHTSABERS");
}

/* One bot into duel shape: knife in hand, the duel health, the extra run speed and the team glow. */
stock DuelArm(id)
{
	StripWeapons(id);
	give_item(id, "weapon_knife");
	set_user_health(id, g_duelHealth > 0 ? g_duelHealth : 25);
	set_user_maxspeed(id, DuelSpeed());

	if (get_user_team(id) == 1)
		set_user_rendering(id, kRenderFxGlowShell, 255, 40, 0, kRenderNormal, 18);
	else
		set_user_rendering(id, kRenderFxGlowShell, 0, 120, 255, kRenderNormal, 18);
}

stock Float:DuelSpeed()
{
	new Float:speed = get_cvar_float("sv_maxspeed");
	if (speed <= 0.0)
		speed = 320.0;
	return speed * 1.4;
}

/* A weapon switch that is not the knife: the duel is knives, so the weapon goes and the knife comes
   back. Bots pick weapons up from the ground and csdm_lite re-arms on respawn; both end here. */
public OnCurWeapon(id)
{
	if (!g_duelActive || !is_user_alive(id))
		return;

	new weapon = read_data(2);
	if (weapon == CSW_KNIFE || weapon == 0)
		return;

	StripWeapons(id);
	give_item(id, "weapon_knife");
	engclient_cmd(id, "weapon_knife");
	log_amx("lightsaber_duel: weapon %d taken from bot %d", weapon, id);
}

/* `weaponbox` is a dropped weapon. During the duel it is not picked up: HAM_SUPERCEDE leaves it on
   the ground untouched. Players (the spectator camera) are not affected. */
public OnWeaponBoxTouch(ent, id)
{
	if (!g_duelActive || id <= 0 || id > get_maxplayers())
		return HAM_IGNORED;
	if (!is_user_bot(id) || !is_user_alive(id))
		return HAM_IGNORED;

	return HAM_SUPERCEDE;
}

/* One round in the clip, none in reserve: the first shot is the event, everything after it is a knife
   fight. The clock exists so the effect has the same length as the rest of the set. */
public EffectOneBullet()
{
	BeginEvent("one_bullet");

	new bots;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new weapons[32];
		new count;
		get_user_weapons(id, weapons, count);

		for (new i = 0; i < count; i++)
		{
			if (weapons[i] == CSW_KNIFE)
				continue;
			cs_set_user_bpammo(id, weapons[i], 0);
		}

		new active = get_pdata_cbase(id, OFFSET_ACTIVE_ITEM, 5);
		if (active > 0)
			cs_set_weapon_ammo(active, 1);

		bots++;
	}

	StartEffectTimer("one_bullet", EffectSeconds(EVENT_SECONDS));
	log_amx("one_bullet: %d bots down to one round", bots);
	DonorSay("ONE BULLET EACH");
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

/* The buyer's name in the chat line of an event. Every 2025-10 event accepts `nick=`, so the money
   leaves a trace a viewer can see; without it the chat says what happened but not who paid for it. */
stock DonorSay(const text[])
{
	new nick[VALUE_LEN];
	if (!ParamCopy("nick", nick, charsmax(nick), ""))
	{
		Announce("%s", text);
		return;
	}

	Announce("%s: %s", nick, text);
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

/* Puts the buyer's name on the bot that leads the scoreboard (or on any living bot when the board is
   empty of bots), so a donation is visible on the fighter everyone is watching.

   Separate from EffectBotNick: that renames a bot for the whole map because that is what the viewer
   paid for, while this tag rides on top of another activity and disappears on its own. The original
   name is kept here and restored by ClearDonorName, so the scoreboard never keeps a stale tag. */
stock AssignDonorNameToTopBot(const nick[], Float:seconds)
{
	if (nick[0] == '^0')
		return 0;

	new bot = FindLeaderBot();
	if (!bot)
		bot = PickRandomBot();
	if (!bot)
	{
		log_amx("donor_tag: no bots are connected");
		return 0;
	}

	// A second donation replaces the tag instead of stacking a second task on another bot.
	if (g_donorActive)
		ClearDonorName();

	new name[NICK_LEN];
	get_user_name(bot, g_donorOriginal, NICK_LEN - 1);

	// Gold shell, and a thick one: this is the one thing on screen that says "this bot is here because
	// somebody paid", and it has to read from a phone at 720 px, not only on a monitor.
	set_user_rendering(bot, kRenderFxGlowShell, 255, 200, 0, kRenderNormal, 18);

	// GoldSrc truncates player names at 31 characters; "[DONOR] " plus a 16 char nickname fits.
	format(name, charsmax(name), "[DONOR] %s", nick);
	set_user_info(bot, "name", name);
	copy(g_donorApplied, charsmax(g_donorApplied), name);

	g_donorBot = bot;
	g_donorActive = true;

	// The tag lives exactly as long as the effect it announces: both are paid for with the same money.
	if (seconds < 5.0)
		seconds = 5.0;
	if (seconds > 600.0)
		seconds = 600.0;

	remove_task(TASK_DONOR_TAG);
	set_task(seconds, "ClearDonorName", TASK_DONOR_TAG);
	log_amx("donor_tag: bot %d '%s' is now '%s' for %.0f s", bot, g_donorOriginal, name, seconds);
	return 1;
}

/* Restores the previous name and drops the shell. Safe to call when nothing is tagged. */
public ClearDonorName()
{
	remove_task(TASK_DONOR_TAG);

	if (g_donorBot > 0 && is_user_connected(g_donorBot) && g_donorApplied[0] != '^0')
	{
		new name[NICK_LEN];
		get_user_name(g_donorBot, name, NICK_LEN - 1);
		// Only the bot still wearing the tag is touched: the slot may already belong to someone else.
		if (equal(name, g_donorApplied))
		{
			set_user_info(g_donorBot, "name", g_donorOriginal);
			if (is_user_alive(g_donorBot))
				set_user_rendering(g_donorBot);
		}
	}

	g_donorActive = false;
	g_donorBot = 0;
	g_donorApplied[0] = '^0';
	g_donorOriginal[0] = '^0';
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





