/**
 * donation_events - turns a donation into one activity on a CS 1.6 bot server.
 *
 * Contract with the control API (src/command.ts):
 *   amx_de codes                     -> prints "donation_events codes: a,b,c"
 *   amx_de version                   -> prints API and plugin version
 *   amx_de status                    -> prints "donation_events status: api=1 active=<a+b|none> queued=0 nick=<nick|none>"
 *   amx_de clear                     -> cancels every running effect
 *   amx_de <code> key=value ...      -> applies the activity now, in the same RCON call
 *
 * Rules: every activity applies at once - a donation that shows up on screen two minutes later
 * reads as a refund request. Lasting effects end on their own clock (set_task + `seconds=` from the
 * catalogue), because a csdm_lite round almost never ends; Round_End, `amx_de clear` and plugin_end
 * are the fallback that drops whatever is still running.
 *
 * Several paid effects run at the same time, one donation can buy a whole batch, so an effect may
 * only undo what it still owns: every shared resource (gravity, run speed, health, the weapon rule,
 * glow, the freeze, the camera, the audio bed) is taken as a *claim* and released on the effect's own
 * clock. `EndEffectState` is the only place a code gives its state back, and it never resets a
 * neighbour. The nine systems this plugin is growing into are described in docs/activities/.
 *
 * Adding an activity = write a handler, claim what it touches, add one RegisterDonationEffect line
 * and one branch in EndEffectState.
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

/* The registry only has to hold the codes the catalogue sells plus the ones the roadmap is about to
   add: 6 surviving codes today, 50 when the nine systems of docs/activities/ are built. 56 leaves a
   little room to add a code without a recompile of the table, and the strings live in a table of
   codes and handler names, which is the cheapest part of the static data this file spends. */
#define MAX_EFFECTS 56
/* m_pActiveItem is not defined by the CS include set of this AMXX build. 373 with the linux player
   offset (5) is the field the active weapon entity is read from; it has not moved since CS 1.6, and
   the alternative is a version-specific include. */
#define OFFSET_ACTIVE_ITEM 373
#define MAX_PARAMS 12
#define CODE_LEN 32
#define KEY_LEN 24
#define VALUE_LEN 64
#define NICK_LEN 32
/* The `active` field of the status line: a '+'-joined list of running codes. Five codes of up to 20
   characters plus separators fit; the list is capped, not truncated mid-code. */
#define ACTIVE_LEN 128

new g_codes[MAX_EFFECTS][CODE_LEN];
new g_handlers[MAX_EFFECTS][CODE_LEN];
new g_effectCount;

/* The last activity that ran, reported by `amx_de status`. There is no per-round bookkeeping any
   more: every code runs immediately, Round_End only restores what the running effects touched. */
new g_activeCode[CODE_LEN];
new g_paramCount;
new g_paramKeys[MAX_PARAMS][KEY_LEN];
new g_paramValues[MAX_PARAMS][VALUE_LEN];

/* The donor tag: a bot at the top of the scoreboard temporarily wears the buyer's name. It is the
   badge on top of whatever activity the money bought, not a nickname the viewer owns. */
#define TASK_DONOR_TAG 4021
new g_donorBot;
new g_donorOriginal[NICK_LEN];
new g_donorApplied[NICK_LEN];
new bool:g_donorActive;

/* ---------- resource claims ----------
   Effects run at the same time, so "restore the value I saved" is wrong the moment two of them touch
   the same resource: the slower one would put back a value the newer one never had. A claim is
   (resource, owner, value). The owner is a registry index and not the code string, because a
   CLAIM_COUNT x MAX_CLAIMS x CODE_LEN table is several KB of static data, and amxxpc already runs
   close to its budget on this file. The newest claim wins; `ClaimRelease` answers whether the caller
   *was* the newest, and only then may it undo the state it applied. */
/* The resources an effect can own. Plain defines rather than a tagged enum: these values are array
   indexes, and a tag here buys nothing but "tag mismatch" warnings on every `g_claimDepth[res]`. */
#define CLAIM_GRAVITY 0
#define CLAIM_SPEED 1
#define CLAIM_HEALTH 2
#define CLAIM_WEAPONS 3
#define CLAIM_GLOW 4
#define CLAIM_FREEZE 5
#define CLAIM_AUDIO 6
#define CLAIM_CAMERA 7
#define CLAIM_COUNT 8
#define MAX_CLAIMS 3
new g_claimOwner[CLAIM_COUNT][MAX_CLAIMS];
new g_claimValue[CLAIM_COUNT][MAX_CLAIMS];
new g_claimDepth[CLAIM_COUNT];
/* sv_gravity as the server had it before the first claim took it: the only value a release may put
   back once no claim is left. */
new g_gravityBase;
new bool:g_gravityBaseSaved;

/* lightsaber_duel is the only effect that touches per-player run speed; the flag keeps ResetBotSpeed
   from rewriting every bot's speed on a reset that never changed it. */
new bool:g_speedBoosted;

/* lightsaber_duel holds the whole field on knives for its clock. The flag is read by the respawn and
   weapon-switch hooks, and the health is captured at event start because the parameter table is gone
   by the time a bot respawns. */
new bool:g_duelActive;
new g_duelHealth;

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
/* Task id ranges, so a new system cannot collide with an old one:
     4013  HE party's repeating task
     4021  the donor tag
     4500+ effect clocks, one per registry index (MAX_EFFECTS is 56, so 4500..4555)
     4701+ the per-effect helper tasks of the 2025-10 set
     4800+ everything added after the reset (docs/activities/roadmap.md)
   A per-player task must be mapped from the player id, because `client_disconnected` drops the task
   with the same id. */
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
   viewer buys, and a 1000 HP bot that keeps the number after the clock is a bug you can see.
   `g_cannonHealth` is the buff itself, captured from the command: ArmGlassCannon runs again from the
   ammo task when the hero dies, and by then the parameter table belongs to another donation. */
new g_cannonSavedHealth;
new g_cannonHealth = 1000;

/* The hero modes (`nemesis`, `survivor`): one bot carries the round. The state is shared by both codes
   on purpose - two hero events at the same time would fight over the same claims anyway, and the claim
   layer makes the newer one the owner. Everything the guard task needs is snapshotted, because by the
   time it fires the parameter table belongs to another donation. */
#define TASK_HERO_GUARD 4801
new g_heroBot;
new bool:g_heroActive;
new g_heroCode[CODE_LEN];
new g_heroHealth;
new g_heroSavedHealth;
new g_heroKnife;
new g_heroWeapon[VALUE_LEN];
new Float:g_heroSpeed;
/* 0 = draw the red glow, 1..255 = semi-transparent (255 is invisible). `assassin` is the code that
   needs this: a hero the viewer cannot see is not a hero, a hero they barely see is a hunter. */
new g_heroAlpha;
/* Where the role goes when the hero dies: 0 = a random bot, 1 = the killer (`juggernaut`: the bot that
   killed the boss becomes the boss, which is the whole point of the mode). */
new bool:g_heroToKiller;
new g_heroNext;

/* Outbreak: every bot carries a flag, a knife kill converts the victim and the respawn hook re-arms it.
   A flag and not a health value: csdm_lite re-arms on every spawn, so the only thing that has to survive
   a death is "this bot is on the infected side". */
#define MAX_SLOTS 33
new g_infected[MAX_SLOTS];
new bool:g_outbreakActive;
new g_infectHealth;
new g_infectKnife;
new Float:g_infectSpeed;

new bool:g_meteorActive;
new g_meteorSprite;
/* Snapshot of the command's parameters: MeteorStrike runs 43 times a second from a timer, and by then
   the parameter table belongs to whatever donation arrived last. Same rule as g_redStockCues. */
new g_meteorRadius = 320;
new g_meteorDamage = 2;

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

	register_logevent("OnRoundEnd", 2, "1=Round_End");

	// ResetHUD is delivered to the player who just spawned: the duel re-arms its rule there.
	register_event("ResetHUD", "OnPlayerSpawn", "be");
	// DeathMsg drives the round modes: the juggernaut role moves to its killer and an infected knife
	// converts the victim (S1, docs/activities/systems.md).
	register_event("DeathMsg", "OnDeathMsg", "a");
	// CurWeapon fires on every weapon switch: lightsaber_duel turns one back into a knife.
	register_event("CurWeapon", "OnCurWeapon", "be", "1=1");
	// A dropped weapon is a pickup away from breaking the duel; the touch hook refuses it.
	RegisterHam(Ham_Touch, "weaponbox", "OnWeaponBoxTouch");
	// The nemesis knife: the hero's swipe is rewritten per hit, every other hit keeps its damage.
	RegisterHam(Ham_TakeDamage, "player", "OnTakeDamage");

	// The hero modes (S1 of docs/activities/systems.md): one bot carries the round.
	RegisterDonationEffect("nemesis", "EffectNemesis");
	RegisterDonationEffect("survivor", "EffectSurvivor");
	RegisterDonationEffect("juggernaut", "EffectJuggernaut");
	RegisterDonationEffect("assassin", "EffectAssassin");
	RegisterDonationEffect("outbreak", "EffectOutbreak");
	RegisterDonationEffect("chaos_plague", "EffectChaosPlague");

	RegisterDonationEffect("he_party", "EffectHeParty");

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
		// One line, key=value, no spaces inside values: the admin panel parses exactly this. `active`
		// is a '+'-joined list, because several paid effects run at the same time; `nick` keeps its
		// key for the panel and reports the bot wearing the buyer's tag, or `none`.
		new active[ACTIVE_LEN];
		ActiveList(active, charsmax(active));

		if (active[0] == '^0')
			copy(active, charsmax(active), "none");

		new nick[NICK_LEN];
		copy(nick, NICK_LEN - 1, "none");
		if (g_donorActive && g_donorBot > 0 && is_user_connected(g_donorBot))
		{
			get_user_name(g_donorBot, nick, NICK_LEN - 1);
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

	// The buyer's name goes on the scoreboard on top of the effect the same command bought: the effect
	// is what the money bought, the gold shell is who bought it. The tag lives as long as the effect.
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

/* Every code whose clock is still armed, joined by '+', capped at five entries. Several paid effects
   run at the same time, so `active` is a list and not one code: the panel needs to know that a meteor
   is still going while the cannon is also on. `he_party` keeps its own repeating task and is asked
   separately, because it has no generic clock. */
stock ActiveList(dest[], len)
{
	dest[0] = '^0';
	new parts;

	for (new i = 0; i < g_effectCount && parts < 5; i++)
	{
		if (!task_exists(TASK_EFFECT_BASE + i))
			continue;

		if (dest[0] != '^0')
			add(dest, len, "+");
		add(dest, len, g_codes[i]);
		parts++;
	}

	if (g_hePartyActive && parts < 5)
	{
		if (dest[0] != '^0')
			add(dest, len, "+");
		add(dest, len, "he_party");
	}
}

/* ---------- resource claims: who may undo what ---------- */

/* Push a claim and report whether the caller is now the newest owner of that resource. A caller that
   is not the newest must not touch it: that is the whole point, a later effect overrides an earlier
   one instead of the two fighting over the same cvar. */
stock bool:ClaimTake(res, owner, value)
{
	if (owner < 0 || res < CLAIM_GRAVITY || res >= CLAIM_COUNT)
		return false;

	// The same owner claiming twice replaces its own entry instead of taking a second slot.
	for (new i = 0; i < g_claimDepth[res]; i++)
	{
		if (g_claimOwner[res][i] == owner)
		{
			g_claimValue[res][i] = value;
			return i == g_claimDepth[res] - 1;
		}
	}

	if (g_claimDepth[res] >= MAX_CLAIMS)
	{
		// Drop the oldest claim. Its owner is the one that has run longest and whose clock fires first;
		// it will release a resource it no longer holds, which ClaimRelease reports safely.
		for (new i = 0; i < MAX_CLAIMS - 1; i++)
		{
			g_claimOwner[res][i] = g_claimOwner[res][i + 1];
			g_claimValue[res][i] = g_claimValue[res][i + 1];
		}
		g_claimDepth[res] = MAX_CLAIMS - 1;
	}

	g_claimOwner[res][g_claimDepth[res]] = owner;
	g_claimValue[res][g_claimDepth[res]] = value;
	g_claimDepth[res]++;
	return true;
}

/* Release one claim. `true` means the caller was the newest owner, so it has to undo the state it
   applied; `false` means somebody newer owns the resource and the undo must be skipped. */
stock bool:ClaimRelease(res, owner)
{
	if (owner < 0 || res < CLAIM_GRAVITY || res >= CLAIM_COUNT)
		return false;

	for (new i = g_claimDepth[res] - 1; i >= 0; i--)
	{
		if (g_claimOwner[res][i] != owner)
			continue;

		new bool:top = (i == g_claimDepth[res] - 1);
		for (new j = i; j < g_claimDepth[res] - 1; j++)
		{
			g_claimOwner[res][j] = g_claimOwner[res][j + 1];
			g_claimValue[res][j] = g_claimValue[res][j + 1];
		}

		g_claimDepth[res]--;
		g_claimOwner[res][g_claimDepth[res]] = -1;
		g_claimValue[res][g_claimDepth[res]] = 0;
		return top;
	}

	return false;
}

/* Drops every claim an owner holds. `amx_de clear`, the round end and plugin_end start from a blank
   field, and a leftover claim would let the next event believe the resource is still taken. */
stock ReleaseAllClaims(owner)
{
	for (new res = 0; res < CLAIM_COUNT; res++)
	{
		for (new i = g_claimDepth[res] - 1; i >= 0; i--)
		{
			if (g_claimOwner[res][i] != owner)
				continue;

			for (new j = i; j < g_claimDepth[res] - 1; j++)
			{
				g_claimOwner[res][j] = g_claimOwner[res][j + 1];
				g_claimValue[res][j] = g_claimValue[res][j + 1];
			}

			g_claimDepth[res]--;
			g_claimOwner[res][g_claimDepth[res]] = -1;
			g_claimValue[res][g_claimDepth[res]] = 0;
		}
	}
}

/* sv_gravity is the one resource the plugin can apply on its own: the base is captured before the
   first claim, and only the newest owner writes the cvar. */
stock ClaimGravity(owner, gravity)
{
	if (!g_gravityBaseSaved)
	{
		g_gravityBase = get_cvar_num("sv_gravity");
		g_gravityBaseSaved = true;
	}

	ClaimTake(CLAIM_GRAVITY, owner, gravity);
	set_cvar_num("sv_gravity", gravity);
}

stock RestoreGravity()
{
	if (!g_gravityBaseSaved)
		return;

	set_cvar_num("sv_gravity", g_gravityBase);
	g_gravityBaseSaved = false;
}

/* One effect's own undo, and the only undo an effect may run: a code releases the claims it holds and
   touches nothing else. Codes that used to fall through to CleanupActive() - which resets every other
   running effect as well - have their own branch here. That fallback is why a meteor ending on its
   clock used to restore the cannon bot's health and cut a duel short. */
stock EndEffectState(const code[])
{
	new owner = FindEffect(code);

	if (equal(code, "glass_cannon"))
	{
		remove_task(TASK_CANNON_AMMO);
		// The health is only put back by the effect that still owns it: a second health event on the
		// same bot overrides this one, and then the old value is not the right one any more.
		if (ClaimRelease(CLAIM_HEALTH, owner) && g_cannonBot > 0 && g_cannonSavedHealth > 0 && is_user_alive(g_cannonBot))
			set_user_health(g_cannonBot, g_cannonSavedHealth);
		if (ClaimRelease(CLAIM_GLOW, owner))
			ClearGlow(g_cannonBot);
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
		if (ClaimRelease(CLAIM_SPEED, owner))
			ResetBotSpeed();
		// The duel glows the whole field, and a glow is render state on the entity: it survives respawn.
		if (ClaimRelease(CLAIM_GLOW, owner))
		{
			for (new id = 1; id <= get_maxplayers(); id++)
				ClearGlow(id);
		}
		return;
	}

	if (equal(code, "nemesis") || equal(code, "survivor") || equal(code, "juggernaut") || equal(code, "assassin"))
	{
		// Every hero mode shares one state; EndHero asks the claim layer whether this event still owns it.
		EndHero(code);
		return;
	}

	if (equal(code, "outbreak"))
	{
		EndOutbreak(code);
		return;
	}

	if (equal(code, "chaos_plague"))
	{
		// Two systems in one code, so two undos: the boss and the infection.
		EndHero(code);
		EndOutbreak(code);
		return;
	}

	if (equal(code, "he_party"))
	{
		// The party owns its own repeating task instead of a generic clock, so its undo is explicit.
		remove_task(TASK_HE_PARTY);
		g_hePartyActive = false;
		g_hePartyTicks = 0;
		ClaimRelease(CLAIM_WEAPONS, owner);
		return;
	}

	if (equal(code, "one_bullet"))
	{
		// One round in the clip and nothing in reserve: the next spawn hands the normal kit back.
		return;
	}

	// No fallback on purpose: a code without a branch here would reset its neighbours, which is the
	// bug this function exists to avoid. A new code adds a branch, and the contract test insists on it.
}

/* ---------- round lifecycle ---------- */

public OnRoundEnd()
{
	// Unconditional: with every activity applying at once, a round can hold several effects, and
	// the cleanup must not depend on which one happened to be applied last. The clocks are dropped
	// with it: an effect the round already ended must not announce itself again in two minutes.
	StopAllEffectTimers();
	CleanupActive();

	if (g_activeCode[0])
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

/* The full reset, used by the round end, `amx_de clear` and plugin_end: every claim is dropped, the
   gravity returns to the value the server had before the first claim, and every effect-specific cvar
   is released by ResetEventState. Health and weapons need no restoring - the next spawn resets them. */
stock CleanupActive()
{
	for (new res = 0; res < CLAIM_COUNT; res++)
		g_claimDepth[res] = 0;

	RestoreGravity();
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

/* Cancels everything at once. Used by `amx_de clear` (the panel's "stop everything") and by nothing
   else. */
stock ClearAll()
{
	StopAllEffectTimers();
	CleanupActive();

	g_activeCode[0] = '^0';
	g_paramCount = 0;
}

public plugin_end()
{
	// A map change unloads the plugin while the server keeps running: every clock, every claim and
	// every cvar has to be dropped here, or the next map inherits a 200 gravity world.
	StopAllEffectTimers();
	CleanupActive();
}

/* A player id is a slot, not a person: the engine reuses the slot of a bot that dropped, so every
   piece of state keyed by id is dropped here. Without this the next occupant inherits somebody else's
   glow or donor tag.
 *
 * `drop`, `message` and `maxlen` are part of the AMXX forward
 * (`client_disconnected(id, bool:drop, message[], maxlen)`); nothing here depends on them. Declaring
 * the forward with a shorter parameter list makes amxxpc abort with std::bad_alloc instead of a
 * readable error, which costs an hour of guessing. */
public client_disconnected(id, bool:drop, message[], maxlen)
{
	if (id <= 0 || id > get_maxplayers())
		return;

	// The 0.3 s re-arm the duel schedules for this spawn.
	remove_task(id);
	ClearGlow(id);

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

/* ---------- effects: one public function per activity code ---------- */

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
	// The field's weapon rule belongs to this event until its own task ends; another weapon event that
	// starts later takes the claim and this one stops owning the knives.
	ClaimTake(CLAIM_WEAPONS, FindEffect("he_party"), 1);

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

/* ---------- respawn hooks ---------- */

/* csdm_lite re-arms every respawn with a random weapon, so without this a bot that respawns mid-duel
   would break the "knives only" rule on its first death. The short delay is what puts this after
   csdm_lite's own arming, which runs in the same respawn. The re-arm is a public task because
   set_task can only call a public, and the task id is the player id so `client_disconnected` can
   drop it with the same `remove_task(id)`. */
public OnPlayerSpawn(id)
{
	if (!g_duelActive && !g_outbreakActive)
		return;

	if (!is_user_connected(id) || !is_user_bot(id))
		return;

	// The infection is the reason this hook now fires on every respawn: csdm_lite hands the bot a rifle
	// half a second after it died, and an infected bot has to come back with a knife.
	if (g_duelActive || IsInfected(id))
		set_task(0.3, "ReArmOnSpawn", id);
}

public ReArmOnSpawn(id)
{
	if (!IsBotAlive(id))
		return;

	// The infection outranks the duel: an infected bot keeps its knife and its health even mid-duel,
	// and the claim layer decides whose numbers win when both events are running.
	if (g_outbreakActive && IsInfected(id))
	{
		ArmInfected(id);
		return;
	}

	if (g_duelActive)
		DuelArm(id);
}

/* ---------- helpers ---------- */

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

	// A hero mode holds a bot's health and the camera; a full reset gives both back, and
	// `amx_stcam unlock` is idempotent when nothing was held.
	remove_task(TASK_HERO_GUARD);
	g_heroActive = false;
	g_heroBot = 0;
	g_heroSavedHealth = 0;
	g_heroCode[0] = '^0';
	server_cmd("amx_stcam unlock");

	// The infection is a flag per bot, so a reset has to walk the slots or an infected bot comes back
	// as one on the next respawn without any event running.
	g_outbreakActive = false;
	for (new id = 0; id < MAX_SLOTS; id++)
		g_infected[id] = 0;
	g_heroNext = 0;

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

	// Two claims, both on the hero bot: its health and its glow. A later event that re-specs the same
	// bot takes ownership, and this one then ends without touching it (see EndEffectState).
	new owner = FindEffect("glass_cannon");
	g_cannonHealth = ParamInt("health", 1000);
	ClaimTake(CLAIM_HEALTH, owner, g_cannonHealth);
	ClaimTake(CLAIM_GLOW, owner, 1);

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
	set_user_health(id, g_cannonHealth);
	set_user_rendering(id, kRenderFxGlowShell, 255, 0, 0, kRenderNormal, 22);

	log_amx("glass_cannon: bot %d armed with %d hp (was %d)", id, g_cannonHealth, g_cannonSavedHealth);
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
	g_meteorRadius = ParamInt("radius", 320);
	g_meteorDamage = ParamInt("damage", 2);
	MeteorVolley();
	set_task(METEOR_INTERVAL, "TaskMeteor", TASK_METEOR, "", 0, "b");

	StartEffectTimer("meteor_shower", EffectSeconds(EVENT_SECONDS));
	log_amx("meteor_shower: %d strikes every %.2f s, %d damage a strike",
		METEOR_STRIKES, METEOR_INTERVAL, g_meteorDamage);
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

	// Read from the snapshot, not from the parameter table: this runs 43 times a second from a timer.
	new radius = g_meteorRadius;
	new damage = g_meteorDamage;

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
	// A freeze is a claim: a second event that wants the field frozen (or wants it moving) takes the
	// resource from this one, and then this event's clock ends without thawing somebody else's freeze.
	ClaimTake(CLAIM_FREEZE, FindEffect("red_light"), 1);
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

	// ResetBotSpeed (released with the CLAIM_SPEED claim in EndEffectState) is what puts the speeds
	// back; the weapon rule and the field glow belong to this event until its clock runs out.
	g_speedBoosted = true;
	new owner = FindEffect("lightsaber_duel");
	ClaimTake(CLAIM_SPEED, owner, 140);
	ClaimTake(CLAIM_WEAPONS, owner, 1);
	ClaimTake(CLAIM_GLOW, owner, 1);

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

/* ---------- the hero modes: nemesis and survivor (S1 of docs/activities/systems.md) ---------- */
/*
 * One bot carries the whole round: scaled health, a fixed weapon, a knife that hits for what the donor
 * paid for, and the camera locked on it. The numbers are the Zombie Plague ones adapted to a 60 second
 * clock and ~20 bots - `baseHealth + perBot x alive bots`, because 30 000 HP does not die inside a
 * minute and a boss that survives its own event reads as a broken event.
 *
 * `nemesis` fights with a knife at `knife` damage, `survivor` with a rifle; the rest is shared, so the
 * two codes differ in their parameters and not in their code.
 */
public EffectNemesis()
{
	BeginEvent("nemesis");

	if (!StartHero("nemesis", "weapon_knife"))
	{
		log_amx("nemesis: no bots are connected");
		return;
	}

	StartEffectTimer("nemesis", EffectSeconds(60.0));
	DonorSay("NEMESIS: ONE BOT AGAINST EVERYONE");
}

public EffectSurvivor()
{
	BeginEvent("survivor");

	if (!StartHero("survivor", "weapon_m249"))
	{
		log_amx("survivor: no bots are connected");
		return;
	}

	StartEffectTimer("survivor", EffectSeconds(60.0));
	DonorSay("SURVIVOR: EVERYONE WANTS HIM DEAD");
}

public EffectJuggernaut()
{
	BeginEvent("juggernaut");

	if (!StartHero("juggernaut", "weapon_knife"))
	{
		log_amx("juggernaut: no bots are connected");
		return;
	}

	StartEffectTimer("juggernaut", EffectSeconds(60.0));
	DonorSay("THE JUGGERNAUT: KILL HIM AND YOU BECOME HIM");
}

public EffectAssassin()
{
	BeginEvent("assassin");

	if (!StartHero("assassin", "weapon_knife"))
	{
		log_amx("assassin: no bots are connected");
		return;
	}

	StartEffectTimer("assassin", EffectSeconds(45.0));
	DonorSay("AN ASSASSIN IS HUNTING THE FIELDS");
}

public EffectOutbreak()
{
	BeginEvent("outbreak");

	if (!StartOutbreak("outbreak"))
	{
		log_amx("outbreak: no bots are connected");
		return;
	}

	StartEffectTimer("outbreak", EffectSeconds(60.0));
	DonorSay("OUTBREAK: A KNIFE KILL TURNS YOU");
}

public EffectChaosPlague()
{
	BeginEvent("chaos_plague");

	// Everything at once: the boss, the infection and the chaos mod. The two systems do not share state
	// (the hero is one bot, the infection is a flag per bot), so they compose instead of fighting.
	if (!StartHero("chaos_plague", "weapon_knife"))
	{
		log_amx("chaos_plague: no bots are connected");
		return;
	}

	// A field with nobody left to infect still has its boss, so the failure here is not fatal.
	StartOutbreak("chaos_plague");
	server_cmd("amx_chaos force");

	StartEffectTimer("chaos_plague", EffectSeconds(60.0));
	DonorSay("CHAOS PLAGUE: EVERYTHING AT ONCE");
}

stock bool:StartHero(const code[], const weapon[])
{
	g_heroBot = PickRandomBot();
	if (!g_heroBot)
		return false;

	new alive;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (IsBotAlive(id))
			alive++;
	}

	new baseHealth = ParamInt("baseHealth", 1500);
	new perBot = ParamInt("perBot", 600);
	g_heroHealth = baseHealth + perBot * alive;
	if (g_heroHealth < 100)
		g_heroHealth = 100;

	g_heroKnife = ParamInt("knife", 0);

	g_heroSpeed = ParamFloat("speed", 1.3);
	if (g_heroSpeed < 1.0)
		g_heroSpeed = 1.0;

	g_heroAlpha = ParamInt("alpha", 0);
	if (g_heroAlpha < 0)
		g_heroAlpha = 0;
	if (g_heroAlpha > 255)
		g_heroAlpha = 255;

	g_heroToKiller = ParamInt("transfer", 0) == 1;
	g_heroNext = 0;

	ParamCopy("weapon", g_heroWeapon, charsmax(g_heroWeapon), weapon);
	if (g_heroWeapon[0] == '^0')
		copy(g_heroWeapon, charsmax(g_heroWeapon), weapon);

	copy(g_heroCode, CODE_LEN - 1, code);
	g_heroActive = true;

	new owner = FindEffect(code);
	ClaimTake(CLAIM_HEALTH, owner, g_heroHealth);
	ClaimTake(CLAIM_SPEED, owner, floatround(g_heroSpeed * 100.0));
	ClaimTake(CLAIM_WEAPONS, owner, 1);
	ClaimTake(CLAIM_GLOW, owner, 1);
	ClaimTake(CLAIM_CAMERA, owner, 1);

	ArmHero(g_heroBot);

	// The role moves when the bot dies: a boss that stays dead for the rest of its clock leaves the
	// viewer watching nothing, which is the problem glass_cannon solved with its ammo task.
	remove_task(TASK_HERO_GUARD);
	set_task(0.5, "TaskHeroGuard", TASK_HERO_GUARD, "", 0, "b");

	log_amx("%s: bot %d, %d hp (%d alive), knife %d, weapon %s",
		code, g_heroBot, g_heroHealth, alive, g_heroKnife, g_heroWeapon);
	return true;
}

/* Puts the hero shape on one bot: the weapon, the health, the extra speed, the glow and the camera. */
stock ArmHero(id)
{
	// The health it had before the buff, so the clock can put it back: a 13 500 HP bot that keeps the
	// number after the event is a bot the viewer keeps seeing for the rest of the map.
	g_heroSavedHealth = get_user_health(id);
	if (g_heroSavedHealth < 1)
		g_heroSavedHealth = 100;

	StripWeapons(id);
	give_item(id, "weapon_knife");
	if (!equal(g_heroWeapon, "weapon_knife"))
		give_item(id, g_heroWeapon);

	set_user_health(id, g_heroHealth);

	new Float:speed = get_cvar_float("sv_maxspeed");
	if (speed <= 0.0)
		speed = 320.0;
	set_user_maxspeed(id, speed * g_heroSpeed);

	// Semi-transparent instead of a glow: the assassin is a silhouette in the frame, which reads as
	// "somebody is hunting" without hiding the bot from the viewer the way full invisibility would.
	if (g_heroAlpha > 0)
		set_user_rendering(id, kRenderFxNone, 0, 0, 0, kRenderTransAlpha, g_heroAlpha);
	else
		set_user_rendering(id, kRenderFxGlowShell, 255, 0, 0, kRenderNormal, 20);

	LockCameraOn(id);
}

/* Hands the camera to the hero for the rest of the clock: the money bought that bot's shots, and the
   director follows whoever looks busiest (docs/activities/roadmap.md, stage 1). The nickname goes out
   the way `stream_cam status` publishes it - spaces as underscores - and the plugin reads it back. */
stock LockCameraOn(id)
{
	if (id <= 0 || !is_user_connected(id))
		return;

	new name[VALUE_LEN];
	get_user_name(id, name, charsmax(name));
	for (new i = 0, len = strlen(name); i < len; i++)
	{
		if (name[i] == ' ')
			name[i] = '_';
	}

	new seconds = ParamInt("seconds", 60);
	server_cmd("amx_stcam lock %s %d", name, seconds);
	log_amx("hero camera lock: %s for %d s", name, seconds);
}

public TaskHeroGuard()
{
	if (!g_heroActive)
	{
		remove_task(TASK_HERO_GUARD);
		return;
	}

	if (IsBotAlive(g_heroBot))
		return;

	// The killer takes the role when the mode says so (`juggernaut`); otherwise the next hero is random.
	new next = 0;
	if (g_heroToKiller && g_heroNext > 0 && IsBotAlive(g_heroNext))
		next = g_heroNext;

	g_heroNext = 0;
	g_heroBot = next > 0 ? next : PickRandomBot();
	if (!g_heroBot)
		return;

	// The same numbers as the bot that died: a replacement hero must not be a cheaper fight.
	ArmHero(g_heroBot);
	Announce(next > 0 ? "THE KILLER IS THE NEW JUGGERNAUT" : "THE HERO MOVED TO ANOTHER BOT");
}

/* Ends a hero mode. Only the effect that still owns the field puts the hero back: a newer hero event
   has already replaced these numbers, and that is what the claim layer is for. */
stock EndHero(const code[])
{
	new owner = FindEffect(code);
	remove_task(TASK_HERO_GUARD);

	if (ClaimRelease(CLAIM_HEALTH, owner) && g_heroBot > 0 && g_heroSavedHealth > 0 && is_user_alive(g_heroBot))
		set_user_health(g_heroBot, g_heroSavedHealth);

	if (ClaimRelease(CLAIM_SPEED, owner) && g_heroBot > 0 && is_user_alive(g_heroBot))
	{
		new Float:speed = get_cvar_float("sv_maxspeed");
		if (speed <= 0.0)
			speed = 320.0;
		set_user_maxspeed(g_heroBot, speed);
	}

	if (ClaimRelease(CLAIM_GLOW, owner) && g_heroBot > 0)
		ClearGlow(g_heroBot);

	ClaimRelease(CLAIM_WEAPONS, owner);
	// The camera goes back to the director, unless a newer hero event took it: the claim knows.
	if (ClaimRelease(CLAIM_CAMERA, owner))
		server_cmd("amx_stcam unlock");

	g_heroActive = false;
	g_heroBot = 0;
	g_heroSavedHealth = 0;
	g_heroCode[0] = '^0';
}

/* ---------- outbreak: a knife kill converts the victim (S1) ---------- */

stock bool:StartOutbreak(const code[])
{
	new alive[MAX_SLOTS];
	new count;

	for (new id = 1; id <= get_maxplayers() && count < MAX_SLOTS - 1; id++)
	{
		if (IsBotAlive(id))
			alive[count++] = id;
	}

	if (count == 0)
		return false;

	g_infectHealth = ParamInt("health", 1500);
	g_infectKnife = ParamInt("infectKnife", 150);
	g_infectSpeed = ParamFloat("speed", 1.15);
	if (g_infectSpeed < 1.0)
		g_infectSpeed = 1.0;

	new share = ParamInt("share", 33);
	if (share < 1)
		share = 1;
	if (share > 90)
		share = 90;

	// At least one infected, and never the whole field: a round where everybody is infected has no
	// fight in it, and the first knife kill is what the viewer paid to see.
	new seeds = count * share / 100;
	if (seeds < 1)
		seeds = 1;
	if (seeds >= count)
		seeds = count - 1;

	for (new i = 0; i < MAX_SLOTS; i++)
		g_infected[i] = 0;

	new taken;
	while (taken < seeds)
	{
		new pick = alive[random(count)];
		if (pick <= 0 || g_infected[pick])
			continue;

		InfectBot(pick);
		taken++;
	}

	g_outbreakActive = true;

	new owner = FindEffect(code);
	ClaimTake(CLAIM_HEALTH, owner, g_infectHealth);
	ClaimTake(CLAIM_SPEED, owner, floatround(g_infectSpeed * 100.0));
	ClaimTake(CLAIM_WEAPONS, owner, 1);
	ClaimTake(CLAIM_GLOW, owner, 1);

	log_amx("%s: %d infected of %d bots", code, seeds, count);
	return true;
}

stock bool:IsInfected(id)
{
	return id > 0 && id < MAX_SLOTS && g_infected[id] != 0;
}

stock InfectBot(id)
{
	if (id <= 0 || id >= MAX_SLOTS)
		return;

	g_infected[id] = 1;

	// The conversion is the clip: say it, the stream is watched without commentary.
	if (is_user_connected(id))
	{
		new name[NICK_LEN];
		get_user_name(id, name, charsmax(name));
		Announce("%s IS INFECTED", name);
	}

	log_amx("outbreak: bot %d is infected", id);
}

/* The infected shape: knife only, the infection health and speed, a green glow. */
stock ArmInfected(id)
{
	StripWeapons(id);
	give_item(id, "weapon_knife");
	set_user_health(id, g_infectHealth);

	new Float:speed = get_cvar_float("sv_maxspeed");
	if (speed <= 0.0)
		speed = 320.0;
	set_user_maxspeed(id, speed * g_infectSpeed);

	set_user_rendering(id, kRenderFxGlowShell, 0, 200, 40, kRenderNormal, 16);
}

stock EndOutbreak(const code[])
{
	new owner = FindEffect(code);

	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (g_infected[id] && is_user_connected(id))
			ClearGlow(id);
		g_infected[id] = 0;
	}

	g_outbreakActive = false;

	// The speed only goes back if this event still owns it: a duel or a hero mode has its own numbers.
	if (ClaimRelease(CLAIM_SPEED, owner))
	{
		new Float:speed = get_cvar_float("sv_maxspeed");
		if (speed <= 0.0)
			speed = 320.0;

		for (new id = 1; id <= get_maxplayers(); id++)
		{
			if (IsBotAlive(id))
				set_user_maxspeed(id, speed);
		}
	}

	ClaimRelease(CLAIM_HEALTH, owner);
	ClaimRelease(CLAIM_WEAPONS, owner);
	ClaimRelease(CLAIM_GLOW, owner);
}

/* The kill feed is the mode's controller: the juggernaut role moves to its killer and an infected knife
   converts the victim. Damage is not touched here - that is OnTakeDamage. */
public OnDeathMsg()
{
	new killer = read_data(1);
	new victim = read_data(2);

	if (killer <= 0 || victim <= 0 || killer == victim)
		return;

	if (g_heroActive && g_heroToKiller && victim == g_heroBot)
		g_heroNext = IsBotAlive(killer) ? killer : 0;

	if (!g_outbreakActive || !IsInfected(killer) || IsInfected(victim))
		return;

	// Only a knife carries the infection: the viewer has to see the rule, not guess it.
	if (get_user_weapon(killer) == CSW_KNIFE)
		InfectBot(victim);
}

/* Paid knife damage: the hero's swipe and the infected knife are what the viewer paid for, everything
   else keeps its own damage. One hook, two rules, no interference between them. */
public OnTakeDamage(victim, inflictor, attacker, Float:damage, damagebits)
{
	if (attacker <= 0 || !IsBotAlive(attacker))
		return HAM_IGNORED;

	if (get_user_weapon(attacker) != CSW_KNIFE)
		return HAM_IGNORED;

	if (g_heroActive && g_heroKnife > 0 && attacker == g_heroBot)
	{
		SetHamParamFloat(4, float(g_heroKnife));
		return HAM_HANDLED;
	}

	if (g_outbreakActive && g_infectKnife > 0 && IsInfected(attacker))
	{
		SetHamParamFloat(4, float(g_infectKnife));
		return HAM_HANDLED;
	}

	return HAM_IGNORED;
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
