/**
 * chaos_core - the "chaos mod": a weighted effect every N seconds, each with an explicit revert.
 *
 * Contract (RCON / server_cmd):
 *   amx_chaos status              -> "chaos: enabled=1 active=<n> level=<n> interval=<s> running=<code,...>"
 *   amx_chaos force [code]        -> run one effect now (random when no code); ignores the interval
 *   amx_chaos stop                -> stop every running effect
 *   amx_chaos level <n>           -> how many effects may run at once (1..MAX_ACTIVE)
 *   amx_chaos interval <sec>      -> seconds between effects (0 turns the timer off)
 *
 * Design rules, learned the hard way on this server:
 * - every effect is a start/stop pair, so nothing can leak into the next round or the next map;
 * - plugin_end stops everything, because a map change unloads the plugin while its cvars stay set;
 * - one file, not two: a separate chaos_effects module would need cross-plugin natives, and a
 *   single registry with one run loop is easier to prove correct.
 *
 * THE TIMER IS OFF BY DEFAULT (`chaos_interval 0`, pinned in `infra/server.cfg`). The free event
 * clock belongs to the control API (`config/auto-events.json`, `src/auto-events.ts`): it is the only
 * side that knows what a donation just did, it is announced on the picture, and it keeps its cursor
 * in SQLite. Two randomisers running side by side - this timer every 45 s and that rotation every
 * 180 s - is what made the stream look like two mechanisms fighting over the screen (docs/runbook.md,
 * "who owns the free events"). What is left here is `amx_chaos force <code>`: the chaos meter's
 * fallback for an empty `chaos` list, and the operator's own dice.
 */
#include <amxmodx>
#include <fakemeta>
#include <fun>

#define PLUGIN_NAME "Chaos Core"
#define PLUGIN_VERSION "1.0.0"

#define MAX_EFFECTS 8
#define MAX_ACTIVE 2
#define CODE_LEN 24

// Bots never exceed this: one slot of the 22 is the spectator camera.
#define MAX_BOTS 21
// Safety limits for the world cvars an effect may touch.
#define SAFE_MAXSPEED_MIN 100
#define SAFE_MAXSPEED_MAX 1500
#define SAFE_GRAVITY_MIN 50
#define SAFE_GRAVITY_MAX 2000

new g_code[MAX_EFFECTS][CODE_LEN];
new g_start[MAX_EFFECTS][CODE_LEN];
new g_stop[MAX_EFFECTS][CODE_LEN];
new g_weight[MAX_EFFECTS];
new Float:g_duration[MAX_EFFECTS];
new g_count;

new g_active[MAX_EFFECTS];
new g_activeCount;
new g_lastIndex = -1;

new g_cvarEnabled;
new g_cvarInterval;
new g_cvarLevel;

new g_savedMaxspeed;
new g_savedGravity;
// What this plugin itself wrote: a restore is only allowed while the cvar still holds that value, so
// a paid effect that changed it in the meantime is not silently cancelled (see StopSpeed/StopGravity).
new g_writtenMaxspeed;
new g_writtenGravity;
new bool:g_maxspeedSaved;
new bool:g_gravitySaved;
new bool:g_vampire;

new g_timerTask;
// The interval the running timer was started with: a self-rescheduling task needs to know whether
// someone changed the cvar behind its back.
new g_timerInterval;

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-youtube");
	register_srvcmd("amx_chaos", "CmdChaos");

	g_cvarEnabled = register_cvar("chaos_enabled", "1");
	// 0: the timer is off by default - the free clock is the control API's. `amx_chaos interval <sec>`
	// still arms it for a manual session, `amx_chaos force` ignores the interval either way.
	// A 45 here is what the old stream ran with, and it fired a second, unannounced event between
	// every two slots of the rotation.
	g_cvarInterval = register_cvar("chaos_interval", "0");
	g_cvarLevel = register_cvar("chaos_level", "1");

	register_event("DeathMsg", "OnDeathMsg", "a");

	RegisterChaos("speed", "StartSpeed", "StopSpeed", 30, 20.0);
	RegisterChaos("gravity", "StartGravity", "StopGravity", 30, 20.0);
	RegisterChaos("knives", "StartKnives", "StopKnives", 25, 15.0);
	RegisterChaos("awp", "StartAwp", "StopAwp", 20, 15.0);
	RegisterChaos("juggernaut", "StartJuggernaut", "StopJuggernaut", 20, 20.0);
	RegisterChaos("vampire", "StartVampire", "StopVampire", 15, 30.0);

	StartTimer();
	log_amx("loaded, %d effects, interval %d", g_count, get_cvar_num("chaos_interval"));
}

stock RegisterChaos(const code[], const startFn[], const stopFn[], weight, Float:duration)
{
	if (g_count >= MAX_EFFECTS)
	{
		log_amx("effect registry is full, %s dropped", code);
		return 0;
	}

	copy(g_code[g_count], CODE_LEN - 1, code);
	copy(g_start[g_count], CODE_LEN - 1, startFn);
	copy(g_stop[g_count], CODE_LEN - 1, stopFn);
	g_weight[g_count] = weight;
	g_duration[g_count] = duration;
	g_count++;
	return 1;
}

stock FindEffect(const code[])
{
	for (new i = 0; i < g_count; i++)
	{
		if (equali(g_code[i], code))
			return i;
	}
	return -1;
}

/* ---------- scheduler ---------- */

/* One-shot task that re-arms itself. The "b" (repeat) flag of set_task measured 15 s between ticks
   while chaos_interval was 45, and a self-scheduling task makes the period readable in the code
   instead of depending on that flag. */
stock StartTimer()
{
	if (g_timerTask)
	{
		remove_task(g_timerTask);
		g_timerTask = 0;
	}

	new interval = get_cvar_num("chaos_interval");
	g_timerInterval = interval;

	if (interval < 5 || !get_cvar_num("chaos_enabled"))
		return;

	g_timerTask = 1000;
	set_task(Float:interval, "ChaosTick", g_timerTask);
}

public ChaosTick(taskid)
{
	// Re-arm first: an effect handler must never be able to break the loop.
	new interval = get_cvar_num("chaos_interval");
	if (!get_cvar_num("chaos_enabled") || interval < 5)
	{
		g_timerTask = 0;
		return;
	}

	if (interval != g_timerInterval)
	{
		StartTimer();
		return;
	}

	set_task(Float:interval, "ChaosTick", g_timerTask);

	new level = get_cvar_num("chaos_level");
	if (level < 1)
		level = 1;
	if (level > MAX_ACTIVE)
		level = MAX_ACTIVE;

	if (g_activeCount >= level)
		return;

	StartEffect(PickWeighted());
}

/* Weighted pick: a bigger weight is simply a bigger share of the total, so adding an effect never
   changes the odds of the others by more than its own share. Never repeats the previous effect. */
stock PickWeighted()
{
	new total;
	new i;

	for (i = 0; i < g_count; i++)
	{
		if (i != g_lastIndex && !g_active[i])
			total = total + g_weight[i];
	}

	if (total <= 0)
		return -1;

	new roll = random(total);
	new running;

	for (i = 0; i < g_count; i++)
	{
		if (i == g_lastIndex || g_active[i])
			continue;

		running = running + g_weight[i];
		if (roll < running)
			return i;
	}

	return -1;
}

stock StartEffect(index)
{
	if (index < 0 || index >= g_count || g_active[index])
		return 0;

	g_active[index] = 1;
	g_activeCount++;
	g_lastIndex = index;

	if (!callfunc_begin(g_start[index]))
	{
		log_amx("effect '%s' has no public %s", g_code[index], g_start[index]);
		g_active[index] = 0;
		g_activeCount--;
		return 0;
	}
	callfunc_end();

	new Float:duration = g_duration[index];
	set_task(duration, "StopEffectTask", index + 1);
	log_amx("chaos: '%s' started for %.0fs", g_code[index], duration);
	return 1;
}

public StopEffectTask(taskid)
{
	StopEffect(taskid - 1);
}

stock StopEffect(index)
{
	if (index < 0 || index >= g_count || !g_active[index])
		return 0;

	if (callfunc_begin(g_stop[index]))
		callfunc_end();

	g_active[index] = 0;
	if (g_activeCount > 0)
		g_activeCount--;
	log_amx("chaos: '%s' stopped", g_code[index]);
	return 1;
}

public plugin_end()
{
	StopAll();
}

/* A player slot is reused by the next connection, so nothing that this plugin tied to an id may
   survive the disconnect. The effects themselves are server-wide cvars (speed, gravity) or one-shot
   arming, but the render state is per player: a shell left on a dropped id follows the slot into the
   next bot, and a timer keyed by that id fires on a stranger.
 *
 * The three extra parameters are part of the AMXX forward
 * (`client_disconnected(id, bool:drop, message[], maxlen)`); a shorter parameter list makes amxxpc
 * abort with std::bad_alloc instead of a readable error. */
public client_disconnected(id, bool:drop, message[], maxlen)
{
	if (id < 1 || id > get_maxplayers())
		return;

	remove_task(id);
	set_user_rendering(id);
	log_amx("client %d left, its render state is reset", id);
}

/* A map change or a server restart must not leave a modified cvar behind: the effects live in the
   cvars of the engine, not in this plugin, so they would survive the unload. */
stock StopAll()
{
	for (new i = 0; i < g_count; i++)
		StopEffect(i);
}

/* The bot plugin owns the quota; reassert the limit so a bot_rain activity cannot oversubscribe. */
public OnNewRound()
{
	new quota = get_cvar_num("yb_quota");
	if (quota > MAX_BOTS)
	{
		set_cvar_num("yb_quota", MAX_BOTS);
		log_amx("chaos: bot quota %d clamped to %d", quota, MAX_BOTS);
	}
}

/* ---------- command interface ---------- */

public CmdChaos(id, level, cid)
{
	new command[16];
	read_argv(1, command, charsmax(command));

	if (equal(command, "status") || command[0] == '^0')
	{
		new list[192];
		for (new i = 0; i < g_count; i++)
		{
			if (!g_active[i])
				continue;
			if (list[0] != '^0')
				add(list, charsmax(list), ",");
			add(list, charsmax(list), g_code[i]);
		}
		if (list[0] == '^0')
			copy(list, charsmax(list), "none");

		server_print("chaos: enabled=%d active=%d level=%d interval=%d running=%s",
			get_cvar_num("chaos_enabled"), g_activeCount, get_cvar_num("chaos_level"),
			get_cvar_num("chaos_interval"), list);
		return PLUGIN_HANDLED;
	}

	if (equal(command, "force"))
	{
		new code[CODE_LEN];
		read_argv(2, code, charsmax(code));

		new index = -1;
		if (code[0] != '^0')
		{
			index = FindEffect(code);
			if (index < 0)
			{
				log_amx("chaos: unknown effect '%s'", code);
				server_print("chaos: unknown effect %s", code);
				return PLUGIN_HANDLED;
			}
		}
		else
		{
			index = PickWeighted();
		}

		if (index < 0)
		{
			server_print("chaos: nothing to run");
			return PLUGIN_HANDLED;
		}

		// A forced effect replaces whatever is running: the buyer paid for something visible now.
		StopAll();
		StartEffect(index);
		server_print("chaos: forced %s", g_code[index]);
		return PLUGIN_HANDLED;
	}

	if (equal(command, "stop"))
	{
		StopAll();
		server_print("chaos: stopped");
		return PLUGIN_HANDLED;
	}

	if (equal(command, "level"))
	{
		new raw[8];
		read_argv(2, raw, charsmax(raw));
		if (raw[0] != '^0')
		{
			new value = str_to_num(raw);
			if (value < 1)
				value = 1;
			if (value > MAX_ACTIVE)
				value = MAX_ACTIVE;
			set_cvar_num("chaos_level", value);
		}
		server_print("chaos: level=%d", get_cvar_num("chaos_level"));
		return PLUGIN_HANDLED;
	}

	if (equal(command, "interval"))
	{
		new raw[8];
		read_argv(2, raw, charsmax(raw));
		if (raw[0] != '^0')
		{
			new value = str_to_num(raw);
			if (value < 0)
				value = 0;
			if (value > 600)
				value = 600;
			set_cvar_num("chaos_interval", value);
			StartTimer();
		}
		server_print("chaos: interval=%d", get_cvar_num("chaos_interval"));
		return PLUGIN_HANDLED;
	}

	server_print("chaos: usage: amx_chaos status|force|stop|level|interval");
	return PLUGIN_HANDLED;
}


/* ---------- effects: one start/stop pair each ---------- */

public StartSpeed()
{
	if (!g_maxspeedSaved)
	{
		g_savedMaxspeed = get_cvar_num("sv_maxspeed");
		g_maxspeedSaved = true;
	}

	new value = 900;
	if (value < SAFE_MAXSPEED_MIN)
		value = SAFE_MAXSPEED_MIN;
	if (value > SAFE_MAXSPEED_MAX)
		value = SAFE_MAXSPEED_MAX;
	set_cvar_num("sv_maxspeed", value);
	g_writtenMaxspeed = value;
}

public StopSpeed()
{
	if (!g_maxspeedSaved)
		return;

	// Put the base back only if the cvar still holds what this effect wrote. `donation_events` owns
	// `sv_gravity` through a claim stack and a paid effect may legitimately have written the speed
	// since; restoring a stale value here would cancel something somebody paid for, which is the
	// visible "my effect disappeared" half of the two-mechanisms bug.
	if (get_cvar_num("sv_maxspeed") == g_writtenMaxspeed)
		set_cvar_num("sv_maxspeed", g_savedMaxspeed);

	g_maxspeedSaved = false;
}

public StartGravity()
{
	if (!g_gravitySaved)
	{
		g_savedGravity = get_cvar_num("sv_gravity");
		g_gravitySaved = true;
	}

	new value = 200;
	if (value < SAFE_GRAVITY_MIN)
		value = SAFE_GRAVITY_MIN;
	if (value > SAFE_GRAVITY_MAX)
		value = SAFE_GRAVITY_MAX;
	set_cvar_num("sv_gravity", value);
	g_writtenGravity = value;
}

public StopGravity()
{
	if (!g_gravitySaved)
		return;

	// Same rule as StopSpeed, and this is the pair that actually bit: `low_gravity_knives` captures
	// its base through donation_events' claim stack, so a restore from here lands on top of a value
	// somebody paid for and leaves the server on a gravity nobody chose.
	if (get_cvar_num("sv_gravity") == g_writtenGravity)
		set_cvar_num("sv_gravity", g_savedGravity);

	g_gravitySaved = false;
}

public StartKnives()
{
	RearmAll("weapon_knife");
}

public StopKnives()
{
	// Nothing to revert: the next spawn brings the engine's own loadout back.
}

public StartAwp()
{
	RearmAll("weapon_awp");
}

public StopAwp()
{
}

public StartJuggernaut()
{
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (IsBotAlive(id))
			set_user_health(id, 300);
	}
}

public StopJuggernaut()
{
}

public StartVampire()
{
	g_vampire = true;
}

public StopVampire()
{
	g_vampire = false;
}

/* The only effect that needs a per-kill hook: it is a flag checked in OnDeathMsg, so there is no
   cvar to restore and nothing to leak. */
public OnDeathMsg()
{
	if (!g_vampire)
		return;

	new killer = read_data(1);
	if (killer < 1 || !is_user_connected(killer) || !is_user_alive(killer))
		return;

	new health = get_user_health(killer) + 25;
	if (health > 300)
		health = 300;
	set_user_health(killer, health);
}

stock RearmAll(const weapon[])
{
	new count;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		strip_user_weapons(id);
		give_item(id, "weapon_knife");
		give_item(id, weapon);
		count++;
	}
	log_amx("chaos: %d bots rearmed with %s", count, weapon);
}

stock bool:IsBotAlive(id)
{
	if (!is_user_alive(id))
		return false;
	return is_user_bot(id) != 0;
}
