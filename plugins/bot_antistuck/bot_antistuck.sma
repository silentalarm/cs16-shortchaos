/**
 * bot_antistuck - the safety net for a bot that grinds into a wall.
 *
 * The cause of the wall walking was fixed elsewhere: the bot could not write its path matrix
 * (docs/runbook.md, "Why the bots walked into walls"), so every round it rebuilt its routes and guessed
 * which connections are clear. This plugin handles what is left, and it exists for one reason - two paid
 * activities move a bot off the navigation graph:
 *   - `blink_bots` (donation_events) blinks bots forward along their view, and
 *   - `duel_bell` drops two bots somewhere around the middle of the map.
 * A bot whose origin is not on a graph node has no route to anywhere: YaPB walks it into the nearest
 * wall and keeps pushing, which on a 9:16 stream is the one picture nobody forgives.
 *
 * What it does, per bot, every 0.5 s:
 *   1. nothing, unless the bot is alive, on the ground, and moved less than `bot_antistuck_units` (24)
 *      units since the previous scan;
 *   2. nothing, unless it has been like that for `bot_antistuck_secs` (1.5 s) *and* a trace
 *      `bot_antistuck_wall` (48) units ahead along its view hits a **wall** - a vertical surface. That
 *      test is what keeps a bot which holds an angle (`yb_camping_allowed 1`) out of here: it looks at a
 *      doorway with open space in front of it, not at a wall 48 units away;
 *   2b. the wall test has one blind spot, measured on the stream: a bot backed into a corner or standing
 *      on a ledge has its wall **behind** it, so the front trace sees an open room and the bot stood
 *      there for 8.4 s and 10.4 s before it happened to turn. Camping is the reason the test is strict,
 *      and camping is bounded: `yb_camping_time_max` is 12 s, so after `bot_antistuck_patience` (14 s) of
 *      no movement nobody is holding an angle any more. Past that point four traces are cast instead of
 *      one and the bot is shoved towards the most open direction - which is why the patience has to stay
 *      **above** `yb_camping_time_max`, or campers start being shoved out of their angle;
 *   3. shove: the velocity is set away from the wall (its normal) plus a jump, at most once per
 *      `bot_antistuck_cooldown` (3 s) per bot. A bot's own usercmd overwrites velocity on the next tick,
 *      so this has to be a real kick - a nudge of a few units is gone before the engine moves anybody;
 *      that is also why the shove is re-applied every 0.05 s for 0.3 s (the vertical part only on the
 *      first tick). A single write was measured to be a bot hopping in place against the wall.
 *
 * The first `NUDGE_LOG_LIMIT` (20) shoves of a plugin load are written to the AMXX log, so the net can be
 * watched without RCON: `antistuck: shoved <name> at <x> <y> <z> after <n> s`. It is a witness, not a rate -
 * the counter is not reset by a map change, so 20 lines mean "at least 20 since the last restart" and
 * `amx_antistuck` (server_print, `nudged=`) is the number to compare.
 *
 * A teleport is deliberately not used, not even as a fallback: `set_user_origin` was measured in this
 * project already (docs/runbook.md, "the respawn meat grinder") - the bot's graph keeps pointing where it
 * was and it freezes for the rest of the round, 3 kills in 90 s against 149 in 60 s. With
 * `bot_antistuck_respawn 1` the fallback after `bot_antistuck_stuck_secs` (10 s) of no progress is
 * `user_kill(id, 1)` (silent: no death message, no frag), and csdm_lite - which respawns every dead bot
 * after `csdm_lite_delay` (0.5 s) - brings it back on a spawn point, which *is* on the graph.
 * Off by default: a false positive is a bot dropping dead on camera for no visible reason.
 *
 * Contract (RCON):
 *   amx_antistuck -> bot_antistuck: nudged=<n> respawned=<n> armed=<0|1>
 *
 * Cvars: bot_antistuck_enabled (1), bot_antistuck_units (24), bot_antistuck_secs (1.5),
 * bot_antistuck_wall (48), bot_antistuck_cooldown (3.0), bot_antistuck_nudge (140) - the shove speed,
 * bot_antistuck_jump (200) - its vertical part, bot_antistuck_respawn (0), bot_antistuck_stuck_secs (10.0),
 * bot_antistuck_patience (14.0) - how long a bot may stand before the wall test stops being trusted.
 */
#include <amxmodx>
#include <fakemeta>

#define PLUGIN_NAME "Bot Antistuck"
// 1.1.0: the corner case (`bot_antistuck_patience`). The load line in the AMXX log is how a running server
// says which build it is, so a behaviour change has to move it.
#define PLUGIN_VERSION "1.1.0"

// get_maxplayers() is 32 here, and slot 32 is a real slot: the arrays are sized for it.
#define MAX_SLOTS 33

// The scan period owns the time bookkeeping, so it is a constant and not a cvar: a slower scan misses a
// bot that grinds for a second, and a faster one only re-reads the same origin.
#define SCAN_INTERVAL 0.5

// Our own task id: csdm_lite and map_duel already use id 0 for their clocks.
#define TASK_SCAN 4700

// One shove task per bot, offset by the slot: TASK_SHOVE + id stays inside 4701..4733.
#define TASK_SHOVE 4701
#define SHOVE_STEPS 6
#define SHOVE_INTERVAL 0.05

// Enough shove lines to see the net firing in `docker logs`, few enough not to push the kills out of
// the tail of it.
#define NUDGE_LOG_LIMIT 20

// The trace starts at chest height: from the feet it hits the ground brush of a slope, and from the eyes
// it clears low walls the bot is actually stuck on.
#define TRACE_HEIGHT 28.0

// A surface whose normal is this close to vertical is a floor, a ceiling or a steep slope, not a wall.
#define WALL_NORMAL_Z 0.5

new g_cvarEnabled, g_cvarUnits, g_cvarStill, g_cvarWall, g_cvarCooldown;
new g_cvarNudge, g_cvarJump, g_cvarRespawn, g_cvarStuck, g_cvarPatience;

new bool:g_tracked[MAX_SLOTS];
new Float:g_lastOrigin[MAX_SLOTS][3];
new Float:g_stillSecs[MAX_SLOTS];
new Float:g_lastShove[MAX_SLOTS];

new g_nudged, g_respawned;

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-youtube");
	register_srvcmd("amx_antistuck", "CmdAntiStuck");

	g_cvarEnabled = register_cvar("bot_antistuck_enabled", "1");
	g_cvarUnits = register_cvar("bot_antistuck_units", "24");
	g_cvarStill = register_cvar("bot_antistuck_secs", "1.5");
	g_cvarWall = register_cvar("bot_antistuck_wall", "48");
	g_cvarCooldown = register_cvar("bot_antistuck_cooldown", "3.0");
	g_cvarNudge = register_cvar("bot_antistuck_nudge", "140");
	g_cvarJump = register_cvar("bot_antistuck_jump", "200");
	g_cvarRespawn = register_cvar("bot_antistuck_respawn", "0");
	g_cvarStuck = register_cvar("bot_antistuck_stuck_secs", "10.0");
	// Above `yb_camping_time_max` (12 s in infra/entrypoint.sh) on purpose: the wall test is skipped past
	// this point, and a camper that never moves would otherwise be shoved out of a legitimate angle.
	g_cvarPatience = register_cvar("bot_antistuck_patience", "14.0");

	set_task(SCAN_INTERVAL, "TaskScan", TASK_SCAN, "", 0, "b");
	// The interval is spelled out rather than formatted: amxxpc passes a float *constant* to a vararg
	// function wrong and the line read "scan every 0.4 s" for a 0.5 s task.
	log_amx("loaded %s: scan every 0.5 s, wall within %d units", PLUGIN_VERSION, get_pcvar_num(g_cvarWall));
}

public client_disconnected(id, bool:drop, message[], maxlen)
{
	ResetBot(id);
}

public TaskScan()
{
	if (!get_pcvar_num(g_cvarEnabled))
	{
		// Keep the baselines moving: otherwise every bot looks stuck on the first scan after re-arming.
		ForgetAll();
		return;
	}

	new Float:units = get_pcvar_float(g_cvarUnits);
	new Float:stillLimit = get_pcvar_float(g_cvarStill);
	new Float:cooldown = get_pcvar_float(g_cvarCooldown);
	new Float:stuckLimit = get_pcvar_float(g_cvarStuck);
	new allowRespawn = get_pcvar_num(g_cvarRespawn);
	new Float:now = get_gametime();

	// Only bots: a human in the frame is driving, and shoving them would be a bug you can feel.
	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (!is_user_connected(id) || !is_user_alive(id) || !is_user_bot(id))
		{
			ResetBot(id);
			continue;
		}

		new Float:origin[3];
		pev(id, pev_origin, origin);

		if (!g_tracked[id])
		{
			Remember(id, origin);
			continue;
		}

		// Airborne: a jump is movement, and a bot in the air is not grinding anything.
		if (!(pev(id, pev_flags) & FL_ONGROUND))
		{
			Remember(id, origin);
			g_stillSecs[id] = 0.0;
			continue;
		}

		new Float:step = VectorDistance(origin, g_lastOrigin[id]);
		Remember(id, origin);

		if (step > units)
		{
			g_stillSecs[id] = 0.0;
			continue;
		}

		g_stillSecs[id] += SCAN_INTERVAL;

		if (g_stillSecs[id] < stillLimit)
			continue;

		new Float:normal[3];
		new bool:blind = false;

		if (!WallAhead(id, normal))
		{
			// The blind spot: a wall behind the bot (a corner, a ledge) leaves the front trace open, and the
			// front trace is what keeps a camper out. A camper never stands past `yb_camping_time_max`
			// (12 s) - its stillness resets the moment it moves - so past `bot_antistuck_patience` nobody
			// is holding an angle and the direction is chosen by the room around the bot instead.
			if (g_stillSecs[id] < get_pcvar_float(g_cvarPatience))
				continue;

			if (!FreeDirection(id, normal))
				continue;

			blind = true;
		}

		if (now - g_lastShove[id] < cooldown)
			continue;

		g_lastShove[id] = now;
		g_nudged++;
		Shove(id, normal);

		if (g_nudged <= NUDGE_LOG_LIMIT)
		{
			new name[32], Float:origin[3];
			get_user_name(id, name, charsmax(name));
			pev(id, pev_origin, origin);

			// The suffix is what tells the two cases apart in the log: a bot shoved off a wall it was
			// facing, and one freed from a corner the wall test could not see. Built as an array, not as a
			// ternary: amxxpc rejects a string choice inside a vararg list.
			new suffix[24];
			if (blind)
				copy(suffix, charsmax(suffix), " (no wall in view)");
			else
				suffix[0] = '^0';

			log_amx("antistuck: shoved %s at %.0f %.0f %.0f after %.1f s%s", name, origin[0], origin[1],
				origin[2], g_stillSecs[id], suffix);
		}

		if (allowRespawn && g_stillSecs[id] >= stuckLimit)
		{
			// Silent kill (flag 1: no death message, no frag): csdm_lite respawns the dead on a spawn point
			// 0.5 s later, and a spawn point is on the graph. Losing the kit costs one magazine; standing
			// in a wall costs the whole round.
			user_kill(id, 1);
			g_respawned++;

			new name[32];
			get_user_name(id, name, charsmax(name));
			log_amx("unstick: %s stood against a wall for %.1f s, killed for a respawn", name, g_stillSecs[id]);
		}
	}
}
/**
 * True when a wall sits within `bot_antistuck_wall` units in front of the bot's view; that wall's normal
 * is written to `normal` and becomes the direction to shove away from.
 */
stock bool:WallAhead(id, Float:normal[3])
{
	new Float:origin[3], Float:angles[3];
	pev(id, pev_origin, origin);
	pev(id, pev_v_angle, angles);

	new Float:reach = get_pcvar_float(g_cvarWall);
	new Float:yaw = angles[1];

	new Float:start[3], Float:end[3];
	start[0] = origin[0];
	start[1] = origin[1];
	start[2] = origin[2] + TRACE_HEIGHT;

	end[0] = start[0] + floatcos(yaw, degrees) * reach;
	end[1] = start[1] + floatsin(yaw, degrees) * reach;
	end[2] = start[2];

	new trace = create_tr2();
	engfunc(EngFunc_TraceLine, start, end, IGNORE_MONSTERS, id, trace);

	new Float:fraction;
	get_tr2(trace, TR_flFraction, fraction);
	get_tr2(trace, TR_vecPlaneNormal, normal);
	free_tr2(trace);

	// Nothing in reach: a bot standing in the open, or holding an angle across the room.
	if (fraction >= 1.0)
		return false;

	return floatabs(normal[2]) < WALL_NORMAL_Z;
}

/**
 * The direction with the most room around the bot, for the case the front trace cannot see: a bot backed
 * into a corner or standing on a ledge has its wall behind it. Four traces at chest height, the longest
 * fraction wins, and the vector it writes is the one to shove along - a direction, not a wall normal,
 * because there is no wall to take a normal from.
 *
 * Returns false when every direction is blocked, which means the bot is in a space too tight to be shoved
 * out of: a kick in a guessed direction only pushes it further into geometry and makes the picture worse.
 */
stock bool:FreeDirection(id, Float:direction[3])
{
	new Float:origin[3];
	pev(id, pev_origin, origin);

	new Float:reach = get_pcvar_float(g_cvarWall);
	new Float:best = -1.0;
	new trace = create_tr2();

	for (new step = 0; step < 4; step++)
	{
		new Float:yaw = float(step) * 90.0;

		new Float:start[3], Float:end[3];
		start[0] = origin[0];
		start[1] = origin[1];
		start[2] = origin[2] + TRACE_HEIGHT;

		end[0] = start[0] + floatcos(yaw, degrees) * reach;
		end[1] = start[1] + floatsin(yaw, degrees) * reach;
		end[2] = start[2];

		engfunc(EngFunc_TraceLine, start, end, IGNORE_MONSTERS, id, trace);

		new Float:fraction;
		get_tr2(trace, TR_flFraction, fraction);

		if (fraction > best)
		{
			best = fraction;
			direction[0] = floatcos(yaw, degrees);
			direction[1] = floatsin(yaw, degrees);
			direction[2] = 0.0;
		}
	}

	free_tr2(trace);

	// 0.35 of the reach is ~17 units of room for a 48 unit trace: a shove of `bot_antistuck_nudge` speed
	// needs at least a body's width to land in.
	return best > 0.35;
}

/**
 * Kicks the bot away from the wall and up, then repeats the horizontal part for SHOVE_STEPS ticks. The
 * bot's own usercmd replaces the velocity on the next tick, so the first write on its own only ever
 * produced a hop in place; the repeat is what actually moves it out of the corner.
 */
stock Shove(id, const Float:normal[3])
{
	ApplyShove(id, normal, true);

	new params[1];
	params[0] = id;
	set_task(SHOVE_INTERVAL, "TaskShove", TASK_SHOVE + id, params, 1, "a", SHOVE_STEPS);
}

public TaskShove(taskid)
{
	new id = taskid - TASK_SHOVE;
	if (!is_user_alive(id) || !get_pcvar_num(g_cvarEnabled))
		return;

	// Re-traced rather than remembered: a bot that turned away, jumped clear or walked off the wall has
	// nothing left to be shoved away from, and the kick stops there. The corner case is re-checked the same
	// way the scan checks it, or the repeat ticks of a `no wall in view` shove would all bail out and the
	// kick would never be applied.
	new Float:normal[3];
	if (!WallAhead(id, normal))
	{
		if (g_stillSecs[id] < get_pcvar_float(g_cvarPatience))
			return;

		if (!FreeDirection(id, normal))
			return;
	}

	ApplyShove(id, normal, false);
}

stock ApplyShove(id, const Float:normal[3], bool:vertical)
{
	new Float:velocity[3];
	velocity[0] = normal[0] * get_pcvar_float(g_cvarNudge);
	velocity[1] = normal[1] * get_pcvar_float(g_cvarNudge);
	velocity[2] = vertical ? get_pcvar_float(g_cvarJump) : 0.0;
	set_pev(id, pev_velocity, velocity);
}

stock Remember(id, const Float:origin[3])
{
	g_lastOrigin[id][0] = origin[0];
	g_lastOrigin[id][1] = origin[1];
	g_lastOrigin[id][2] = origin[2];
	g_tracked[id] = true;
}

stock ResetBot(id)
{
	g_tracked[id] = false;
	g_stillSecs[id] = 0.0;
	g_lastShove[id] = 0.0;
}

stock ForgetAll()
{
	for (new id = 1; id < MAX_SLOTS; id++)
		ResetBot(id);
}

stock Float:VectorDistance(const Float:a[3], const Float:b[3])
{
	new Float:dx = a[0] - b[0];
	new Float:dy = a[1] - b[1];
	new Float:dz = a[2] - b[2];
	return floatsqroot(dx * dx + dy * dy + dz * dz);
}

/**
 * One line for the panel and for a hand check from RCON: how often the safety net fired on this map.
 */
public CmdAntiStuck(id, level, cid)
{
	server_print("bot_antistuck: nudged=%d respawned=%d armed=%d", g_nudged, g_respawned,
		get_pcvar_num(g_cvarEnabled));
	return PLUGIN_HANDLED;
}

