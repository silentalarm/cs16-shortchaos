/**
 * stream_cam - the game server directs the camera of the autonomous stream client.
 *
 * Why the server and not the client: the capture client is a normal player that never presses a
 * key, so it cannot know whether the bot it follows is alive, and a client-side spec_next timer
 * kept parking the picture on a dead body (or on the "choose a team" VGUI panel, which is what
 * froze the first live stream). The server knows who is alive and who is shooting, so it points
 * the camera itself through the observer entity fields.
 *
 * What it does:
 *   - recognises the stream client by nickname (stcam_spectator) and keeps it on the SPECTATOR team,
 *     re-sending `jointeam 6` right after the connect, which is the only way to close the team menu;
 *   - keeps ONE target for a while instead of hopping every few seconds: the previous version
 *     re-picked the busiest bot every 8 s, and on a 20-bot server that reads as the camera
 *     teleporting around the map. A target now only changes when it dies, when it has been
 *     standing still, or when the hold time is up;
 *   - shows the action in third person (chase locked: the bot model with its weapon in hand is always
 *     visible). A first-person window is available as an opt-in cvar (stcam_pov): after the followed
 *     bot gets a kill the client is put into its own in-eye spectator mode for stcam_pov_sec seconds.
 *     It is client side on purpose - the older server-side version faked a view model with
 *     WeaponList + CurWeapon and every cut read on screen as the camera glitching; off by default;
 *   - feeds the client the observed bot's health and armour, because a spectator has no player state
 *     of its own: without this the HUD shows an empty health bar. The same values are repeated as
 *     one HUD line together with the nickname, so the stream carries readable numbers at 720p;
 *   - drags the invisible spectator entity along with the target and re-writes the observer
 *     mode/target ten times a second: the engine builds the client's PVS from that origin, and a
 *     once-a-second copy let the model disappear while the bot crossed a doorway or a reset of the
 *     observer fields between director ticks;
 *
 * RCON contract (docs/runbook.md):
 *   amx_stcam status -> "stream_cam status: enabled=1 interval=25.0 mode=1 spectator=<name>
 *                        target=<name> candidates=<n> dwell=12.0 hp=<n> active=<mode>"
 *
 * cvars: stcam_enable 1, stcam_mode 1 (1 = chase locked, 2 = chase free), stcam_dwell 6.0,
 *        stcam_idle 5.0, stcam_interval 25.0 (max hold on one target), stcam_avoid_repeat 1,
 *        stcam_spectator "StreamCam", stcam_hud 1, stcam_heartbeat 60.0,
 *        stcam_pov 0 (1 = cut to first person after a kill), stcam_pov_sec 2.5.
 */
#include <amxmodx>
#include <fakemeta>
#include <cstrike>
#include <fun>

#define PLUGIN_NAME "Stream Camera"
#define PLUGIN_VERSION "0.4.0"

#define TASK_TICK 42001
#define TASK_FOLLOW 42002
#define MAX_PLAYERS 32
#define NAME_LEN 32
#define TEAM_SPECTATOR 3

// HL observer modes (m_iObserverMode). Named here so the include set stays minimal.
#define CAM_CHASE_LOCKED 1
// 4 = OBS_IN_EYE: the client looks through the target's eyes. The server owns this field and rewrites
// it ten times a second, which is why a client-side `spec_mode` request never survived - the first
// version of the in-eye window did exactly that and appeared to do nothing.
#define CAM_IN_EYE 4

new Float:g_prevOrigin[MAX_PLAYERS + 1][3];
new bool:g_hasOrigin[MAX_PLAYERS + 1];
new Float:g_activity[MAX_PLAYERS + 1];
new g_kills[MAX_PLAYERS + 1];
new g_lastKiller[MAX_PLAYERS + 1];

new g_camId;
new g_target;
new g_prevTarget;
new g_modeSent = -1;
new g_modeResets;
new g_targetResets;
new g_lastAppliedMode = -1;
new g_lastAppliedTarget;

new Float:g_dwellUntil;
new Float:g_holdUntil;
new Float:g_idleSince;
new Float:g_nextHeartbeat;

new cvar_enabled;
new cvar_mode;
new cvar_dwell;
new cvar_idle;
new cvar_interval;
new cvar_avoidRepeat;
new cvar_specName;
new cvar_hud;
new cvar_heartbeat;
new cvar_pov;
new cvar_povSec;

// In-eye window: the client is put into its own "first person" spectator mode for a couple of seconds
// after the followed bot gets a kill. Client side, not server side: a spectator has no view model of
// its own, and the old server-side version had to fake one (WeaponList + CurWeapon) which flickered.
new bool:g_povActive;
new Float:g_povUntil;

new g_msgHealth;
new g_msgArmor;

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-youtube");

	cvar_enabled     = register_cvar("stcam_enable", "1");
	cvar_mode        = register_cvar("stcam_mode", "1");
	cvar_dwell       = register_cvar("stcam_dwell", "6.0");
	cvar_idle        = register_cvar("stcam_idle", "5.0");
	cvar_interval    = register_cvar("stcam_interval", "25.0");
	cvar_avoidRepeat = register_cvar("stcam_avoid_repeat", "1");
	cvar_specName    = register_cvar("stcam_spectator", "StreamCam");
	// 0 by default: the picture panel is drawn outside the game by the control API (src/ui), and a
	// hudmessage on top of it would only duplicate (and, at a 1 Hz refresh with a fade-in, flicker).
	// 1 brings the old in-game block back as a fallback for a server without the panel.
	cvar_hud         = register_cvar("stcam_hud", "0");
	cvar_heartbeat   = register_cvar("stcam_heartbeat", "60.0");
	// First person, off by default: 1 cuts the client into the followed bot's eyes for
	// stcam_pov_sec seconds after that bot gets a kill. It is a client mode (spec_mode), so nothing
	// has to be faked server side - and turning it off is one cvar.
	cvar_pov         = register_cvar("stcam_pov", "0");
	cvar_povSec      = register_cvar("stcam_pov_sec", "2.5");

	// What the panel outside the game reads every second: the bot on camera and its state as
	// single tokens (spaces become underscores, like team_war does for nicknames).
	register_cvar("stcam_name", "-");
	register_cvar("stcam_hp", "0");
	register_cvar("stcam_ar", "0");

	register_srvcmd("amx_stcam", "CmdStreamCam");

	// DeathMsg carries player indices, unlike the death log line, where they hide behind names.
	register_event("DeathMsg", "EventDeathMsg", "a");
	register_logevent("OnRoundStart", 2, "1=Round_Start");

	g_msgHealth = get_user_msgid("Health");
	g_msgArmor  = get_user_msgid("ArmorValue");

	set_task(1.0, "TaskTick", TASK_TICK, "", 0, "b");
	// The PVS anchor follows the bot much faster than the director logic; see TaskFollow().
	set_task(0.1, "TaskFollow", TASK_FOLLOW, "", 0, "b");

	log_amx("loaded %s: mode %d, hold %.0fs, dwell %.0fs", PLUGIN_VERSION,
		get_pcvar_num(cvar_mode), get_pcvar_float(cvar_interval), get_pcvar_float(cvar_dwell));
}

public client_putinserver(id)
{
	g_hasOrigin[id] = false;
	g_activity[id] = 0.0;
	g_kills[id] = 0;
	g_lastKiller[id] = 0;

	if (!IsStreamClient(id))
		return;

	g_camId = id;
	g_target = 0;
	g_prevTarget = 0;
	g_dwellUntil = 0.0;
	g_holdUntil = 0.0;
	g_idleSince = 0.0;
	g_nextHeartbeat = 0.0;
	g_modeSent = -1;
	g_modeResets = 0;
	g_targetResets = 0;
	g_lastAppliedMode = -1;
	g_lastAppliedTarget = 0;

	new name[NAME_LEN];
	get_user_name(id, name, charsmax(name));
	log_amx("stream client is on the server: %s", name);

	// The client opens its "SELECT TEAM" VGUI panel the moment it receives a team of 0, and it never
	// closes that panel when the team changes afterwards: verified on the live stream that
	// `jointeam 6`, `menuselect 6` and `cancelselect` all left it on screen while the server already
	// reported the client as SPECTATOR. Assigning the team here runs before "entered the game", so
	// the first TeamInfo the client sees already says SPECTATOR and the panel does not open at all.
	cs_set_user_team(id, CS_TEAM_SPECTATOR);

	// Belt and braces for the case where the client still shows the panel: a jointeam is what the
	// SPECTATE button itself sends.
	set_task(1.0, "TaskJoinSpectator", id);
	set_task(4.0, "TaskJoinSpectator", id);
	set_task(9.0, "TaskJoinSpectator", id);
	set_task(15.0, "TaskJoinSpectator", id);
}

public client_disconnected(id)
{
	if (id == g_camId)
	{
		g_camId = 0;
		g_target = 0;
		g_prevTarget = 0;
		g_dwellUntil = 0.0;
		g_holdUntil = 0.0;
		g_idleSince = 0.0;
		g_modeSent = -1;
		g_povActive = false;
	}
	if (id == g_target)
		g_target = 0;

	g_hasOrigin[id] = false;
	g_activity[id] = 0.0;
	g_kills[id] = 0;
	g_lastKiller[id] = 0;
}

public TaskJoinSpectator(id)
{
	if (!is_user_connected(id) || !IsStreamClient(id))
		return;

	client_cmd(id, "jointeam 6");
}

public TaskTick()
{
	if (!get_pcvar_num(cvar_enabled))
		return;

	if (g_camId > 0 && !IsStreamClient(g_camId))
		g_camId = 0;

	if (!g_camId)
		g_camId = FindStreamClient();

	if (!g_camId)
	{
		g_target = 0;
		return;
	}

	// Self-healing: the team can be reset by a map change or a late join, and a client without a
	// team is a client with the "SELECT TEAM" panel on screen.
	if (get_user_team(g_camId) != TEAM_SPECTATOR)
	{
		cs_set_user_team(g_camId, CS_TEAM_SPECTATOR);
		client_cmd(g_camId, "jointeam 6");
	}

	new Float:now = get_gametime();
	UpdateActivity();

	// Close the in-eye window on time, and never leave the client in first person when the camera is
	// about to follow somebody else.
	if (g_povActive && now >= g_povUntil)
		LeavePov();

	if (!IsPlayable(g_target))
	{
		// The followed bot died: the viewer was just watching his killer, so stay with him.
		new killer = (g_target > 0) ? g_lastKiller[g_target] : 0;
		PickTarget("target is gone", IsPlayable(killer) ? killer : 0);
	}
	else if (now >= g_dwellUntil)
	{
		if (g_idleSince > 0.0 && now - g_idleSince >= get_pcvar_float(cvar_idle))
			PickTarget("target is standing still", 0);
		else if (now >= g_holdUntil)
			PickTarget("hold time is up", 0);
	}

	if (g_target > 0)
	{
		ApplyCamera();
		FeedHud();
	}

	Heartbeat(now);
}

/**
 * The engine builds the PVS from the spectator's own origin, and a camera entity parked at the map
 * origin stops receiving updates for a bot that walks away. A once-a-second copy was still too
 * coarse: the bot crossed a portal between ticks and the client stopped getting its model, which
 * reads on stream as the character blinking out. The observer fields are re-applied here ten times
 * a second as well, because a mode/target reset between director ticks also hides the model while
 * the HUD (sent straight to the client) still names the same bot. ApplyCamera() does the work so a
 * fresh target is anchored in the tick it is picked.
 */
public TaskFollow()
{
	if (!get_pcvar_num(cvar_enabled) || g_camId <= 0 || !IsPlayable(g_target))
		return;

	// Count resets for the heartbeat: a non-zero value proves the engine dropped the observer state
	// between ticks, a zero value points at the renderer/PVS instead. Compare with the last value we
	// applied, not with g_target, so our own director switch is not mistaken for an engine reset.
	if (pev(g_camId, pev_iuser1) != g_lastAppliedMode)
		g_modeResets++;
	if (pev(g_camId, pev_iuser2) != g_lastAppliedTarget)
		g_targetResets++;

	ApplyCamera();
}

stock SyncCameraOrigin()
{
	// The player origin sits exactly on the floor brush. A PVS built from a point in a solid leaf is
	// empty, and the client freezes with the bot gone, so the anchor is lifted to eye level first;
	// the lower offsets are fallbacks for a low ceiling or a crouched bot. The client camera itself
	// still targets the bot, so this only changes which leaf the server uses for entity updates.
	new Float:origin[3];
	new Float:probe[3];
	new Float:offsets[3] = {28.0, 16.0, 0.0};

	pev(g_target, pev_origin, origin);
	for (new i = 0; i < 3; i++)
	{
		probe[0] = origin[0];
		probe[1] = origin[1];
		probe[2] = origin[2] + offsets[i];
		// CONTENTS_SOLID is -2 in the GoldSrc SDK; kept numeric to keep the include set minimal.
		if (engfunc(EngFunc_PointContents, probe) != -2)
		{
			set_pev(g_camId, pev_origin, probe);
			return;
		}
	}

	set_pev(g_camId, pev_origin, origin);
}

/**
 * Chase locked (third person), one target, no mode switching. The whole observer state is rewritten
 * ten times a second from TaskFollow(): cheaper than tracking every state change, and it heals a
 * mode or target the engine or the client reset behind our back.
 */
stock ApplyCamera()
{
	// pev_iuser1 is m_iObserverMode, pev_iuser2 is m_hObserverTarget (HL SDK entity fields).
	// The in-eye window is a change of that same field: the client asks, the server decides.
	new mode = (g_povActive && get_pcvar_num(cvar_pov)) ? CAM_IN_EYE : get_pcvar_num(cvar_mode);
	set_pev(g_camId, pev_iuser1, mode);
	set_pev(g_camId, pev_iuser2, g_target);

	// Anchor the new target at once; TaskFollow() keeps it in the PVS between director ticks.
	SyncCameraOrigin();

	g_modeSent = mode;
	g_lastAppliedMode = mode;
	g_lastAppliedTarget = g_target;
}

/**
 * A spectator has no health of its own, so the stock health bar is empty. Both the vanilla messages
 * and one readable line are sent: the vanilla bar is what the client already draws, the line is what
 * survives a 720p YouTube frame. The weapon is not part of the line on purpose - in third person the
 * bot model already holds it, and the ammo lookups were the calls that could abort the whole update
 * (`cs_get_user_bpammo` on a knife raises "Invalid weapon id").
 */
/**
 * The bot on camera as three cvars the panel can read.
 *
 * A nickname with a space cannot travel through a console line or a cvar query, so spaces become
 * underscores here and the reader turns them back - the same contract team_war uses for its tops.
 */
stock PublishTarget(hp, armor)
{
	new name[NAME_LEN];
	if (g_target > 0 && is_user_connected(g_target))
		get_user_name(g_target, name, charsmax(name));
	else
		copy(name, charsmax(name), "-");

	ReplaceSpaces(name, charsmax(name));

	new value[8];
	format(value, charsmax(value), "%d", hp);
	set_cvar_string("stcam_hp", value);
	format(value, charsmax(value), "%d", armor);
	set_cvar_string("stcam_ar", value);
	set_cvar_string("stcam_name", name);
}

stock ReplaceSpaces(text[], length)
{
	for (new i = 0; i < length && text[i] != '^0'; i++)
	{
		if (text[i] == ' ')
			text[i] = '_';
	}
}

/**
 * Cuts the client into the target's eyes: the flag flips and the observer mode is re-applied at once,
 * so the cut lands in the same frame instead of the next director tick. ApplyCamera() owns the field
 * the engine actually reads (pev_iuser1); a client-side `spec_mode` request loses that race, which is
 * why it is not used here.
 */
stock EnterPov()
{
	if (g_camId <= 0 || g_povActive || !get_pcvar_num(cvar_pov))
		return;

	g_povActive = true;
	g_povUntil = get_gametime() + get_pcvar_float(cvar_povSec);
	ApplyCamera();
}

/** Back to the chase camera the stream runs on. Safe to call when the window is not open. */
stock LeavePov()
{
	if (!g_povActive)
		return;

	g_povActive = false;
	if (g_camId > 0)
		ApplyCamera();
}

stock FeedHud()
{
	new hp = get_user_health(g_target);
	new armor = get_user_armor(g_target);

	// Published for the panel drawn outside the game (src/ui): the picture must not depend on the
	// in-game line, which is off by default.
	PublishTarget(hp, armor);

	if (g_msgHealth)
	{
		message_begin(MSG_ONE_UNRELIABLE, g_msgHealth, _, g_camId);
		write_byte(hp > 255 ? 255 : (hp < 0 ? 0 : hp));
		message_end();
	}

	if (g_msgArmor)
	{
		message_begin(MSG_ONE_UNRELIABLE, g_msgArmor, _, g_camId);
		write_byte(armor < 0 ? 0 : (armor > 255 ? 255 : armor));
		message_end();
	}

	if (!get_pcvar_num(cvar_hud))
		return;

	new name[NAME_LEN];
	get_user_name(g_target, name, charsmax(name));

	// One block near the top of the frame: the team race is two lines above the nickname/HP line.
	// The anchor is a fraction of the *render* height, and the encoder cuts the client's two 20%
	// spectator bands off before scaling, so anything at or above 0.20 is clipped: 0.20 lost the tops
	// of the glyphs, 0.12 disappeared into the band. 0.24 is the anchor the single line used and it
	// stayed whole; the block only grows downwards from it.
	//
	// One message, not one per plugin: this client renders a single hudmessage, so the score block
	// plugins/team_war used to send on its own channel was overwritten by this line every second.
	// team_war now publishes the numbers as cvars and this is the only place that draws them.
	new scoreT[8];
	new scoreCt[8];
	new topT[NAME_LEN];
	new topCt[NAME_LEN];
	new text[192];

	get_cvar_string("team_war_t", scoreT, charsmax(scoreT));
	get_cvar_string("team_war_ct", scoreCt, charsmax(scoreCt));
	get_cvar_string("team_war_top_t", topT, charsmax(topT));
	get_cvar_string("team_war_top_ct", topCt, charsmax(topCt));

	if (get_cvar_pointer("team_war_t") && scoreT[0] && topT[0])
		format(text, charsmax(text), "T %s : %s CT^nTOP T %s  |  TOP CT %s^n%s   %d HP   %d AR",
			scoreT, scoreCt, topT, topCt, name, hp, armor);
	else
		format(text, charsmax(text), "%s   %d HP   %d AR", name, hp, armor);

	set_hudmessage(255, 255, 255, -1.0, 0.24, 0, 0.0, 1.6, 0.1, 0.2, 3);
	show_hudmessage(g_camId, "%s", text);
}

/**
 * The capture watchdog restarts the client when its log goes quiet for two minutes, and bot chat
 * used to keep that log alive. With chat disabled this line does it, and it doubles as the answer
 * to "which bot is on screen right now" in `docker logs`.
 */
stock Heartbeat(Float:now)
{
	new Float:every = get_pcvar_float(cvar_heartbeat);
	if (every <= 0.0 || now < g_nextHeartbeat || g_camId <= 0)
		return;

	g_nextHeartbeat = now + every;

	new name[NAME_LEN] = "none";
	new hp;
	new Float:origin[3];
	new feet = 0;
	if (g_target > 0 && is_user_connected(g_target))
	{
		get_user_name(g_target, name, charsmax(name));
		hp = get_user_health(g_target);
		pev(g_target, pev_origin, origin);
		feet = (engfunc(EngFunc_PointContents, origin) == -2) ? 1 : 0;
	}

	client_print(g_camId, print_console, "[stcam] target=%s hp=%d resets=%d/%d feet=%d", name, hp, g_modeResets, g_targetResets, feet);
}

/**
 * Movement score per player: distance travelled since the previous second, with decay, so a bot
 * that sprinted once does not own the camera until the end of the round.
 */
stock UpdateActivity()
{
	new Float:origin[3];

	for (new id = 1; id <= MAX_PLAYERS; id++)
	{
		if (!IsPlayable(id))
		{
			g_hasOrigin[id] = false;
			g_activity[id] = (g_activity[id] > 0.5) ? (g_activity[id] - 0.5) : 0.0;
			continue;
		}

		pev(id, pev_origin, origin);
		if (!g_hasOrigin[id])
		{
			g_prevOrigin[id][0] = origin[0];
			g_prevOrigin[id][1] = origin[1];
			g_prevOrigin[id][2] = origin[2];
			g_hasOrigin[id] = true;
			continue;
		}

		new Float:delta = vector_distance(origin, g_prevOrigin[id]);
		g_prevOrigin[id][0] = origin[0];
		g_prevOrigin[id][1] = origin[1];
		g_prevOrigin[id][2] = origin[2];

		g_activity[id] = g_activity[id] * 0.75 + delta;

		// Standing still is the one thing a stream cannot show: remember when the target last moved.
		if (id == g_target && delta > 2.0)
			g_idleSince = get_gametime();
	}
}

/**
 * Picks the next target. `preferred` (the killer of the previous target) gets a large bonus so the
 * cut feels like a continuation and not a jump; the bot that was on screen before is penalised so
 * the camera does not bounce between two bots.
 */
stock PickTarget(const reason[], preferred)
{
	new best;
	new candidates;
	new Float:bestScore = -1.0;

	// A cut to another bot must not happen inside a first-person window: the client would be left
	// looking through the eyes of somebody the panel no longer names.
	LeavePov();

	for (new id = 1; id <= MAX_PLAYERS; id++)
	{
		if (!IsPlayable(id))
			continue;

		candidates++;

		new Float:score = g_activity[id] + float(g_kills[id]) * 40.0;

		if (get_pcvar_num(cvar_avoidRepeat) && id == g_prevTarget)
			score -= 1000.0;
		if (id == preferred)
			score += 500.0;

		if (score > bestScore)
		{
			bestScore = score;
			best = id;
		}
	}

	if (!best)
		return;

	new previous[NAME_LEN] = "none";
	if (g_target > 0 && is_user_connected(g_target))
		get_user_name(g_target, previous, charsmax(previous));

	g_prevTarget = g_target;
	g_target = best;

	new Float:now = get_gametime();
	g_dwellUntil = now + get_pcvar_float(cvar_dwell);
	g_holdUntil = now + get_pcvar_float(cvar_interval);
	g_idleSince = now;
	g_modeSent = -1;

	new name[NAME_LEN];
	get_user_name(best, name, charsmax(name));
	log_amx("camera target %s (%s, score %.0f, was %s, candidates %d)",
		name, reason, bestScore, previous, candidates);
}

public EventDeathMsg()
{
	new killer = read_data(1);
	new victim = read_data(2);
	new bool:headshot = read_data(3) ? true : false;

	if (victim > 0 && victim <= MAX_PLAYERS && killer > 0 && killer <= MAX_PLAYERS)
		g_lastKiller[victim] = killer;

	if (killer <= 0 || killer > MAX_PLAYERS || killer == victim)
		return;

	g_kills[killer] += headshot ? 2 : 1;

	// The viewer has just watched this bot kill somebody: cut into its eyes for a moment. Opt-in
	// (stcam_pov, 0 by default) - the chase camera stays the default picture.
	if (killer == g_target)
		EnterPov();
}

public OnRoundStart()
{
	for (new id = 1; id <= MAX_PLAYERS; id++)
		g_kills[id] = 0;

	// A new round is a clean cut: whoever looks busiest right now gets the camera.
	if (g_camId > 0)
		PickTarget("round start", 0);
}

stock FindStreamClient()
{
	for (new id = 1; id <= MAX_PLAYERS; id++)
	{
		if (IsStreamClient(id))
			return id;
	}
	return 0;
}

/**
 * The client is a real (non-bot) connection whose nickname contains stcam_spectator. The
 * spectator-team check is a fallback for a renamed client: humans are not allowed on this server,
 * so a non-bot that is not playing can only be the camera.
 */
stock bool:IsStreamClient(id)
{
	if (id <= 0 || id > MAX_PLAYERS)
		return false;
	if (!is_user_connected(id) || is_user_bot(id) || is_user_hltv(id))
		return false;

	new name[NAME_LEN];
	new match[NAME_LEN];
	get_user_name(id, name, charsmax(name));
	get_pcvar_string(cvar_specName, match, charsmax(match));

	if (match[0] && containi(name, match) != -1)
		return true;

	return get_user_team(id) == TEAM_SPECTATOR;
}

stock bool:IsPlayable(id)
{
	if (id <= 0 || id > MAX_PLAYERS)
		return false;
	if (id == g_camId)
		return false;
	if (!is_user_connected(id) || !is_user_alive(id))
		return false;
	return true;
}

public CmdStreamCam(id, level, cid)
{
	new arg[16];
	read_argv(1, arg, charsmax(arg));

	if (equal(arg, "cmd"))
	{
		// Troubleshooting lever: `amx_stcam cmd <client command>` types a command into the camera
		// client. Needed because the "SELECT TEAM" VGUI panel is client-side and there is no other
		// way to find what closes it on a headless client. RCON-only, never reachable in game.
		new cmd[32], extra[32];
		read_argv(2, cmd, charsmax(cmd));
		read_argv(3, extra, charsmax(extra));

		if (!g_camId)
		{
			server_print("stream_cam: no camera client connected");
			return PLUGIN_HANDLED;
		}

		new line[72];
		if (extra[0])
			formatex(line, charsmax(line), "%s %s", cmd, extra);
		else
			copy(line, charsmax(line), cmd);

		client_cmd(g_camId, "%s", line);
		server_print("stream_cam: sent '%s' to the camera client", line);
		return PLUGIN_HANDLED;
	}

	if (!equal(arg, "status"))
	{
		server_print("stream_cam usage: amx_stcam status | amx_stcam cmd <client command> [arg]");
		return PLUGIN_HANDLED;
	}

	new spectator[NAME_LEN] = "none";
	new target[NAME_LEN] = "none";
	new hp;
	new armor;
	new candidates;

	if (g_camId > 0 && is_user_connected(g_camId))
		get_user_name(g_camId, spectator, charsmax(spectator));
	if (g_target > 0 && is_user_connected(g_target))
	{
		get_user_name(g_target, target, charsmax(target));
		hp = get_user_health(g_target);
		armor = get_user_armor(g_target);
	}

	// Values must stay single tokens: the panel parses this line with a regex.
	ReplaceSpaces(spectator, charsmax(spectator));
	ReplaceSpaces(target, charsmax(target));

	for (new i = 1; i <= MAX_PLAYERS; i++)
	{
		if (IsPlayable(i))
			candidates++;
	}

	// One line, key=value, no spaces inside values: docs/runbook.md greps exactly this.
	server_print("stream_cam status: enabled=%d interval=%.1f mode=%d spectator=%s target=%s candidates=%d dwell=%.1f hp=%d active=%d ar=%d pov=%d pov_active=%d",
		get_pcvar_num(cvar_enabled), get_pcvar_float(cvar_interval), get_pcvar_num(cvar_mode),
		spectator, target, candidates,
		get_pcvar_float(cvar_dwell), hp, g_modeSent, armor,
		get_pcvar_num(cvar_pov), g_povActive ? 1 : 0);

	return PLUGIN_HANDLED;
}
