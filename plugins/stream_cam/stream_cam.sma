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
 *     visible) and cuts into the followed bot's eyes for the moments that matter: `stcam_eye 1` opens
 *     that first person window when the bot SHOOTS (`stcam_eye_sec` after the last round, capped by
 *     `stcam_eye_max`, then the same `stcam_eye_sec` back in third person so the picture alternates
 *     instead of strobing), `stcam_eye 2` holds it for as long as the target lives (the switch the
 *     picture is judged by), and the older `stcam_pov` opens it on a kill;
 *     The gun in that window comes from this plugin: a spectator's own `viewmodel` field is empty, so
 *     ApplyViewmodel() writes the followed bot's v_ model into it - the same field the game DLL writes
 *     for a real player. Its shoot/reload animation is relayed from the bot's `pev_weaponanim`
 *     (SVC_WEAPONANIM), because the client holds no weapon and the game DLL never sends it one. The
 *     older attempt faked the model with WeaponList + CurWeapon, which the client accepts and does not
 *     draw;
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
 *                        target=<name> candidates=<n> dwell=12.0 hp=<n> active=<mode> ar=<n>
 *                        pov=<0|1> pov_active=<0|1> eye=<0|1|2> vmodel=<0|1> eye_active=<0|1>
 *                        eye_cuts=<n> eye_ammo=<n> eye_btn=<n> locked=<name|none> lock_left=<sec>"
 *   amx_stcam lock <nick|#userid> [seconds] -> holds the camera on that bot, 20 s by default
 *   amx_stcam unlock                        -> gives the camera back to the director
 *   amx_stcam cmd <client command> [arg]    -> types a client command into the camera client
 *
 * The lock exists for the paid round modes (docs/activities/systems.md, S1): the director follows the
 * busiest bot, which is right for a free-for-all and wrong for a 60 second boss, where the money buys
 * shots of *that* bot. A lock ends with its clock, the death of its bot, a disconnect or `unlock`.
 *
 * cvars: stcam_enable 1, stcam_mode 1 (1 = chase locked, 2 = chase free), stcam_dwell 6.0,
 *        stcam_idle 5.0, stcam_interval 25.0 (max hold on one target), stcam_avoid_repeat 1,
 *        stcam_spectator "StreamCam", stcam_hud 1, stcam_heartbeat 60.0,
 *        stcam_pov 0 (1 = cut to first person after a kill), stcam_pov_sec 2.5,
 *        stcam_eye 1 (0 = third person only, 1 = first person when the bot shoots, 2 = held while the
 *        target lives), stcam_eye_sec 2.0 (hold after the last shot, and the pause before the next
 *        cut), stcam_eye_max 5.0 (ceiling on one continuous window, 0 = no ceiling).
 */
#include <amxmodx>
#include <fakemeta>
#include <cstrike>
#include <fun>

#define PLUGIN_NAME "Stream Camera"
#define PLUGIN_VERSION "0.6.0"

#define TASK_TICK 42001
#define TASK_FOLLOW 42002
#define MAX_PLAYERS 32
#define NAME_LEN 32
#define TEAM_SPECTATOR 3

// stcam_eye: the first person lens. 0 leaves the picture in third person, 1 opens the window when the
// followed bot shoots (the action camera), 2 holds it for as long as the target lives (the switch the
// picture is judged by - one bot, one continuous cut, nothing to tune).
#define EYE_OFF 0
#define EYE_ACTION 1
#define EYE_ALWAYS 2

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

// The camera lock (stage 1 of docs/activities/roadmap.md). While it runs the director ignores its own
// dwell and hold rules; it is dropped by its clock, by the death of its bot, by a disconnect, by
// `amx_stcam unlock`, and by the full reset in OnRoundStart.
new g_lockTarget;
new Float:g_lockUntil;
#define LOCK_MAX_SECONDS 600.0
#define LOCK_DEFAULT_SECONDS 20.0

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
new cvar_eye;
new cvar_eyeSec;
new cvar_eyeMax;

/* The first person weapon of a spectator. GoldSrc draws a player's view model from that player's own
   `viewmodel` field (cl.local.viewmodel inside the engine), and a client that joined as SPECTATOR has
   none - it holds nothing, so the in-eye camera shows empty hands. The director writes the view model
   of the weapon the followed BOT holds into that field instead (the very field the game DLL writes for
   a real player in DefaultDeploy) and clears it again for the chase camera, because the renderer draws
   the view entity whenever it is set, in any observer mode.
   
   Stock weapons only: both string indexes are taken once, in plugin_precache(), because an
   AllocString per tick would keep growing the engine's string table. */
#define MAX_VMODELS 31
#define VMODEL_LEN 32
/* Indexed by the CSW_ weapon id from cstrike.inc (1 = P228 ... 30 = P90); 0 and 2 are unused. The
   stem is enough for both names: models/p_<stem>.mdl is the model in the hand and
   models/v_<stem>.mdl the first person one. Weapon ids are used instead of parsing the player's
   `weaponmodel` field because that field is a string *index* on the wire - fakemeta hands it back as
   a number, not as a name (measured: `raw=[-44181529]`). */
new const g_weaponModel[MAX_VMODELS][] =
{
	"",             // 0
	"p228",         // 1
	"",             // 2
	"scout",        // 3
	"hegrenade",    // 4
	"xm1014",       // 5
	"c4",           // 6
	"mac10",        // 7
	"aug",          // 8
	"smokegrenade", // 9
	"elite",        // 10
	"fiveseven",    // 11
	"ump45",        // 12
	"sg550",        // 13
	"galil",        // 14
	"famas",        // 15
	"usp",          // 16
	"glock18",      // 17
	"awp",          // 18
	"mp5",          // 19
	"m249",         // 20
	"m3",           // 21
	"m4a1",         // 22
	"tmp",          // 23
	"g3sg1",        // 24
	"flashbang",    // 25
	"deagle",       // 26
	"sg552",        // 27
	"ak47",         // 28
	"knife",        // 29
	"p90"           // 30
};
/* Precache index of each v_ model is not needed: the field takes the ALLOC_STRING index. */
new g_vmodelString[MAX_VMODELS];
/* What is on the camera client right now, and which client slot it was written to - a reconnect
   arrives with a different id and must not be skipped by this cache. */
new g_viewmodelApplied;
new g_viewmodelAppliedFor;

// In-eye window: the client is put into its own "first person" spectator mode. One window, two
// triggers - a shot fired by the followed bot (stcam_eye 1) and a kill (stcam_pov) - because two
// separate windows would fight over the same observer field. Client side, not server side: a
// spectator has no view model of its own, and ApplyViewmodel() is what puts the bot's gun in it.
//
// The window has a floor and a ceiling: stcam_eye_sec after the last shot, and the same time in third
// person before the next cut (the alternation is what makes it read as a camera cut and not a strobe),
// while stcam_eye_max caps one continuous window so a bot with a full magazine cannot own the lens.
new bool:g_povActive;
new Float:g_povUntil;
new Float:g_povSince;
new Float:g_eyeQuietUntil;
new g_eyeCuts;
new g_eyeAmmoCuts;
new g_eyeButtonCuts;

// Shot detector. A shot is the one thing that takes a round out of the clip, so the clip count of the
// weapon the bot holds is the primary signal; the IN_ATTACK button is the fallback for the weapons
// that spend nothing (knife, grenades, the last round) and the way to find out whether a YaPB fake
// client reports its buttons at all - `amx_stcam status` counts both, separately.
new g_fireWeapon;
new g_fireClip;
new bool:g_fireValid;
new g_fireButton;

// Last SVC_WEAPONANIM relayed to the camera client (-1 = nothing yet, so the first anim always goes).
new g_eyeAnim = -1;
// Set in the tick a shot was detected: only that tick relays an animation, see TaskFollow().
new g_firePulse;

new g_msgHealth;
new g_msgArmor;

/**
 * The v_ models the camera may name in its own `viewmodel` field. GoldSrc resolves that field to a
 * precache index when it sends the client data, and a name that was never precached resolves to 0:
 * no gun at all. Missing .mdl files are fatal for the map load, so this is the stock set that ships
 * with cstrike/models (checked against the image: `ls /hlds/cstrike/models | grep '^v_'`).
 */
public plugin_precache()
{
	new name[VMODEL_LEN];

	for (new weapon = 1; weapon < MAX_VMODELS; weapon++)
	{
		if (!g_weaponModel[weapon][0])
			continue;

		// The v_ model is precached because the field is resolved to a precache index on the wire.
		format(name, charsmax(name), "models/v_%s.mdl", g_weaponModel[weapon]);
		precache_model(name);
		g_vmodelString[weapon] = engfunc(EngFunc_AllocString, name);
	}
}

public plugin_init()
{
	register_plugin(PLUGIN_NAME, PLUGIN_VERSION, "cs16-shortchaos");

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
	// The other trigger of the same window, off by default: 1 cuts the client into the followed bot's
	// eyes for stcam_pov_sec seconds after that bot gets a kill. Kept next to stcam_eye instead of
	// being folded into it, because a kill cut and a shooting cut answer different questions and both
	// end up in the same observer field.
	cvar_pov         = register_cvar("stcam_pov", "0");
	cvar_povSec      = register_cvar("stcam_pov_sec", "2.5");
	// 1 = the action camera: the lens opens when the followed bot SHOOTS and closes stcam_eye_sec after
	// the last round (capped by stcam_eye_max), then it stays in third person for the same stcam_eye_sec
	// before it may cut again. 2 = held for as long as the target lives (the switch the picture is
	// judged by). Both are the same observer field as the kill window above.
	cvar_eye         = register_cvar("stcam_eye", "1");
	cvar_eyeSec      = register_cvar("stcam_eye_sec", "2.0");
	// Ceiling on one continuous first person window: a bot spraying a full magazine must not hold the
	// picture in its eyes for twenty seconds. 0 disables the ceiling.
	cvar_eyeMax      = register_cvar("stcam_eye_max", "5.0");

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
	ResetEyeState();

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
		g_eyeQuietUntil = 0.0;
		ResetEyeTracking();
	}
	if (id == g_target)
		g_target = 0;
	if (id == g_lockTarget)
		ReleaseLock("the locked bot left");

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
	// The client library decides handedness for the spectator's own view model on its own: a v_ model
	// drawn mirrored reads on screen as "the gun is in the left hand". userconfig.cfg sets both cvars,
	// but the engine rewrites config.cfg on exit and the capture container restarts often, so the client
	// is told again here - once per join, not per frame.
	client_cmd(id, "cl_righthand 1; r_drawviewmodel 1");
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
	// about to follow somebody else. TaskFollow() closes it much faster (ten times a second); this is
	// the backstop for a camera whose follow task died.
	if (g_povActive && now >= g_povUntil)
		LeavePov("the window ran out");

	// A lock that ran out keeps the current picture for one more dwell instead of cutting on the tick it
	// expires: somebody paid for that bot, and the viewer is still watching it.
	if (g_lockTarget > 0 && now >= g_lockUntil)
	{
		ReleaseLock("the lock ran out");
		g_dwellUntil = now + get_pcvar_float(cvar_dwell);
		g_holdUntil = now + get_pcvar_float(cvar_interval);
	}

	if (!IsPlayable(g_target))
	{
		// A lock whose bot died or left is dropped before the director picks a replacement: PickTarget
		// refuses to move a locked camera, so a lock left behind here would freeze the picture.
		if (g_lockTarget > 0 && g_lockTarget == g_target)
			ReleaseLock("the locked bot is gone");

		// The followed bot died: the viewer was just watching his killer, so stay with him.
		new killer = (g_target > 0) ? g_lastKiller[g_target] : 0;
		PickTarget("target is gone", IsPlayable(killer) ? killer : 0);
	}
	else if (!CameraLocked(now) && now >= g_dwellUntil)
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
	if (!get_pcvar_num(cvar_enabled) || g_camId <= 0)
		return;

	// The lens is a tenth-of-a-second thing: it opens on a shot and closes on its own clock here, not
	// on the one second director tick. Called before the target check, so a window whose bot just died
	// still closes instead of leaving the camera in a corpse's eyes until the next Tick.
	UpdateEye();

	if (!IsPlayable(g_target))
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
	new mode = EyeWanted() ? CAM_IN_EYE : get_pcvar_num(cvar_mode);
	set_pev(g_camId, pev_iuser1, mode);
	set_pev(g_camId, pev_iuser2, g_target);

	// Every cut into the eyes repeats the handedness: the client re-applies its own default when the
	// observer mode changes, and the mirrored v_ model is what the stream showed as a left hand.
	if (mode == CAM_IN_EYE && g_lastAppliedMode != CAM_IN_EYE)
		client_cmd(g_camId, "cl_righthand 1; r_drawviewmodel 1");

	// The client draws its OWN view model, not the target's: first person needs that field filled
	// with the bot's weapon, third person needs it empty again.
	ApplyViewmodel(mode);

	// Anchor the new target at once; TaskFollow() keeps it in the PVS between director ticks.
	SyncCameraOrigin();

	g_modeSent = mode;
	g_lastAppliedMode = mode;
	g_lastAppliedTarget = g_target;
}

/**
 * Fills or clears the camera client's own `viewmodel` field: that is what the engine turns into the
 * first person weapon, and a spectator's is always empty. Called from ApplyCamera(), so the chase
 * camera clears it in the same tick the mode changes - the renderer draws the view entity whenever it
 * is set, whatever observer mode is on, and a leftover gun would float in the middle of third person.
 */
stock ApplyViewmodel(mode)
{
	new string = (mode == CAM_IN_EYE) ? VModelIndexFor(g_target) : 0;

	if (string == g_viewmodelApplied && g_camId == g_viewmodelAppliedFor)
		return;

	set_pev(g_camId, pev_viewmodel, string);
	g_viewmodelApplied = string;
	g_viewmodelAppliedFor = g_camId;

	// A new model starts at its own sequence 0, so the animation relay has to send again instead of
	// trusting the last index it forwarded for the previous weapon.
	g_eyeAnim = -1;

	// Only the "a gun is on" direction is logged: a bot switching weapons flaps the field to nothing
	// for a tick or two, and that is not worth a console line each time.
	if (string)
	{
		new weapon = cs_get_user_weapon(g_target);
		server_print("stream_cam viewmodel: %s (mode %d)",
			(weapon > 0 && weapon < MAX_VMODELS) ? g_weaponModel[weapon] : "?", mode);
	}
}

/**
 * The view model index for the weapon the target holds, or 0 when there is nothing to draw: no
 * weapon, or one the table does not know (a custom weapon entity of our own would land here).
 *
 * The table is by weapon id, not by the bot's `weaponmodel` field: that field is a string index on
 * the wire and fakemeta hands it back as a number, and the engine allocated it from a pool the
 * plugin cannot map back to a name.
 *
 * Known cosmetic gap: the S3 launcher is `weapon_awp` with the hand model swapped (see
 * plugins/donation_events), so in first person it shows the AWP view model. A `v_bazooka.mdl` is what
 * would fix that, and it does not exist yet (docs/activities/assets.md).
 */
stock VModelIndexFor(id)
{
	if (id <= 0 || id > MAX_PLAYERS || !is_user_connected(id))
		return 0;

	new weapon = cs_get_user_weapon(id);
	if (weapon <= 0 || weapon >= MAX_VMODELS || !g_weaponModel[weapon][0])
		return 0;

	return g_vmodelString[weapon];
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
 * The first person lens, once per follow tick.
 *
 * Two jobs, both on the ten-a-second clock because a camera cut that waits for the one second
 * director tick is a cut the viewer sees as late:
 *   - close an open window the moment its clock runs out;
 *   - watch the followed bot for a shot (stcam_eye 1) and relay its weapon animation while the window
 *     is open, so the gun in the picture shoots and reloads instead of standing still.
 *
 * stcam_eye 0 does nothing here at all, and 2 (the judging switch) needs no trigger: ApplyCamera()
 * reads EyeWanted() and stays in the eyes while the target lives.
 */
stock UpdateEye()
{
	new Float:now = get_gametime();

	if (g_povActive && now >= g_povUntil)
		LeavePov("the window ran out");

	if (get_pcvar_num(cvar_eye) != EYE_ACTION || !IsPlayable(g_target))
	{
		// The detector only runs in the action mode, so whatever it remembered from the last time is a
		// reading of a moment nobody was watching: the first shot after the mode is switched back on
		// would look like a burst that started during the pause.
		ResetEyeTracking();
		return;
	}

	WatchFire();

	// Only a shot is relayed. The bot's own sequence index flaps between idle and reload on a real
	// server, and the client - holding a model but no weapon state - then loops whatever it was last
	// sent: on the live stream that read as a gun reloading non-stop in first person.
	if (g_povActive && g_firePulse)
		RelayWeaponAnim();

	g_firePulse = 0;
}

/**
 * Decides whether the bot on camera just pulled the trigger.
 *
 * The primary signal is the clip: firing is the only thing that takes a round out of it, a reload
 * takes from the reserve and a weapon switch changes the id - both are filtered by storing the id the
 * last reading belongs to. The IN_ATTACK button is the second signal: it covers the weapons that spend
 * nothing (knife, grenades, the last round of a magazine) and it is the only way to learn whether a
 * YaPB fake client reports buttons at all. It is read as an edge, not a level: a held trigger must not
 * re-open the lens on every tick.
 *
 * Both counters end up in `amx_stcam status` (eye_ammo, eye_btn) on purpose: which signal fires on a
 * live server is not documented anywhere, and one number per trigger answers it without a debugger.
 */
stock WatchFire()
{
	new clip, reserve;
	new weapon = get_user_weapon(g_target, clip, reserve);

	new bool:byAmmo = (g_fireValid && weapon == g_fireWeapon && clip < g_fireClip);

	new buttons = pev(g_target, pev_button);
	new bool:byButton = ((buttons & IN_ATTACK) != 0 && !g_fireButton);

	g_fireButton = (buttons & IN_ATTACK) ? 1 : 0;
	g_fireWeapon = weapon;
	g_fireClip = clip;
	g_fireValid = (weapon > 0);

	if (!byAmmo && !byButton)
		return;

	if (byAmmo)
		g_eyeAmmoCuts++;
	if (byButton)
		g_eyeButtonCuts++;

	// The fire animation is relayed in this very tick, and the last index is forgotten so a burst of
	// identical frames (every shot of the same gun carries the same sequence) still restarts on the
	// client instead of being deduplicated away.
	g_firePulse = 1;
	g_eyeAnim = -1;

	EnterPov(byAmmo ? "shot" : "trigger", get_pcvar_float(cvar_eyeSec));
}

/**
 * Repeats the bot's weapon animation to the camera client.
 *
 * A spectator holds no weapon, so the game DLL never sends it SVC_WEAPONANIM: the v_ model this plugin
 * put in its `viewmodel` field is drawn, and it is drawn frozen. The bot's own `pev_weaponanim` is the
 * sequence index the game DLL sent to the bot, and the camera holds the same model - so relaying it on
 * change replays the shot, the reload and the deploy in the picture. `pev_body` comes along because
 * some view models use it for the variant (a scoped AWP, a CT/USP skin).
 */
stock RelayWeaponAnim()
{
	new anim = pev(g_target, pev_weaponanim);
	if (anim == g_eyeAnim)
		return;

	g_eyeAnim = anim;

	message_begin(MSG_ONE_UNRELIABLE, SVC_WEAPONANIM, _, g_camId);
	write_byte(anim);
	write_byte(pev(g_target, pev_body));
	message_end();
}

/**
 * Opens the first person window, or pushes its end out when one is already open.
 *
 * One window for both triggers on purpose: a cut on every round of a burst, or a kill cut inside a
 * shooting cut, would fight over the same observer field and read as flicker. The length is therefore
 * "the last trigger plus its hold", with two limits that make the alternation watchable:
 *   - a closed window stays closed for stcam_eye_sec (see LeavePov) - the viewer gets a real look at
 *     third person between two cuts instead of a strobe;
 *   - stcam_eye_max caps one continuous window, so a bot spraying a whole magazine hands the picture
 *     back on its own.
 *
 * ApplyCamera() owns the field the engine actually reads (pev_iuser1) and is called here, so the cut
 * lands in this frame instead of the next director tick; a client-side `spec_mode` request loses that
 * race, which is why it is not used.
 */
stock EnterPov(const reason[], Float:seconds)
{
	if (g_camId <= 0)
		return;

	new Float:now = get_gametime();
	new bool:opened = !g_povActive;

	if (opened)
	{
		if (now < g_eyeQuietUntil)
			return;

		g_povActive = true;
		g_povSince = now;
		g_povUntil = now;
		g_eyeCuts++;
	}

	if (now + seconds > g_povUntil)
		g_povUntil = now + seconds;

	new Float:ceiling = get_pcvar_float(cvar_eyeMax);
	if (ceiling > 0.0 && g_povUntil > g_povSince + ceiling)
		g_povUntil = g_povSince + ceiling;

	if (!opened)
		return;

	new name[NAME_LEN] = "none";
	if (g_target > 0 && is_user_connected(g_target))
		get_user_name(g_target, name, charsmax(name));

	log_amx("first person: %s (%.1fs, %s)", name, g_povUntil - now, reason);

	ApplyCamera();
}

/**
 * Back to the chase camera the stream runs on. Safe to call when the window is not open.
 *
 * The pause it sets is the other half of the alternation: stcam_eye_sec is both how long the lens stays
 * open after the last shot and how long it stays closed before the next cut. One number, so tuning the
 * rhythm is one cvar.
 */
stock LeavePov(const reason[])
{
	if (!g_povActive)
		return;

	g_povActive = false;
	g_eyeAnim = -1;

	new Float:quiet = get_pcvar_float(cvar_eyeSec);
	g_eyeQuietUntil = get_gametime() + (quiet > 0.0 ? quiet : 0.0);

	if (g_camId > 0)
		ApplyCamera();

	log_amx("first person closed: %s", reason);
}

/** Whether the observer mode should be in-eye right now: an open window, or the judging switch. */
stock bool:EyeWanted()
{
	return g_povActive || get_pcvar_num(cvar_eye) == EYE_ALWAYS;
}

/**
 * Forgets what the shot detector knew. Called whenever the target changes: its clip count belongs to
 * somebody else, and keeping it would read the next reading as a shot and cut on a bot nobody chose.
 */
stock ResetEyeTracking()
{
	g_fireWeapon = 0;
	g_fireClip = 0;
	g_fireValid = false;
	g_fireButton = 0;
	g_eyeAnim = -1;
}

/** The whole lens state, for a fresh camera client: window closed, counters back to zero. */
stock ResetEyeState()
{
	g_povActive = false;
	g_povUntil = 0.0;
	g_povSince = 0.0;
	g_eyeQuietUntil = 0.0;
	g_eyeCuts = 0;
	g_eyeAmmoCuts = 0;
	g_eyeButtonCuts = 0;
	ResetEyeTracking();
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

/* ---------- camera lock ---------- */

stock bool:CameraLocked(Float:now)
{
	return g_lockTarget > 0 && now < g_lockUntil;
}

/* Drops the lock. Every path that can leave the camera without a target goes through here: its own
   clock, the death of the bot, a disconnect and `amx_stcam unlock`. */
stock ReleaseLock(const reason[])
{
	if (!g_lockTarget)
		return;

	log_amx("camera lock released: %s", reason);
	g_lockTarget = 0;
	g_lockUntil = 0.0;
}

/**
 * Resolves the argument of `amx_stcam lock` to a connected player.
 *
 * Three shapes, because three callers exist: the panel knows a nickname, the control API may pass a
 * userid (`#12` or a bare `12`), and a human at the console types whatever they remember. A nickname
 * arrives with underscores whenever it came from a status line, so they are read back as spaces.
 */
stock FindTargetPlayer(const arg[])
{
	if (arg[0] == '^0')
		return 0;

	if (arg[0] == '#')
		return FindByUserId(str_to_num(arg[1]));

	if (IsAllDigits(arg))
		return FindByUserId(str_to_num(arg));

	new wanted[NAME_LEN];
	copy(wanted, charsmax(wanted), arg);
	for (new i = 0, len = strlen(wanted); i < len; i++)
	{
		if (wanted[i] == '_')
			wanted[i] = ' ';
	}

	for (new id = 1; id <= MAX_PLAYERS; id++)
	{
		if (!is_user_connected(id))
			continue;

		new name[NAME_LEN];
		get_user_name(id, name, charsmax(name));
		if (equali(name, wanted))
			return id;
	}

	return 0;
}

stock FindByUserId(userid)
{
	if (userid <= 0)
		return 0;

	for (new id = 1; id <= MAX_PLAYERS; id++)
	{
		if (is_user_connected(id) && get_user_userid(id) == userid)
			return id;
	}

	return 0;
}

stock bool:IsAllDigits(const text[])
{
	new len = strlen(text);
	if (len == 0)
		return false;

	for (new i = 0; i < len; i++)
	{
		if (text[i] < '0' || text[i] > '9')
			return false;
	}

	return true;
}

/**
 * Picks the next target. `preferred` (the killer of the previous target) gets a large bonus so the
 * cut feels like a continuation and not a jump; the bot that was on screen before is penalised so
 * the camera does not bounce between two bots.
 */
stock PickTarget(const reason[], preferred)
{
	// A lock owns the camera: the director only answers when there is none. Every caller that can end a
	// lock (death, disconnect, its own clock) releases it before asking for a new target, so a paid cut
	// still ends when its hero dies instead of freezing the picture.
	if (CameraLocked(get_gametime()))
		return;

	new best;
	new candidates;
	new Float:bestScore = -1.0;

	// A cut to another bot must not happen inside a first-person window: the client would be left
	// looking through the eyes of somebody the panel no longer names. The shot detector is reset in the
	// same place - the new bot's clip count is not a reading of the old one.
	LeavePov("the target changed");
	ResetEyeTracking();

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

	// The bot on camera is what the money bought: when it dies the lock dies with it, and the next tick
	// cuts to the killer the way the director normally would. Holding a corpse would be worse than a cut.
	if (victim == g_lockTarget)
		ReleaseLock("the locked bot died");

	if (killer <= 0 || killer > MAX_PLAYERS || killer == victim)
		return;

	g_kills[killer] += headshot ? 2 : 1;

	// The viewer has just watched this bot kill somebody: cut into its eyes for a moment. Opt-in
	// (stcam_pov, 0 by default) - the chase camera stays the default picture. The window itself is
	// shared with the shooting trigger of stcam_eye, so a kill inside an open window only extends it.
	if (killer == g_target && get_pcvar_num(cvar_pov))
		EnterPov("kill", get_pcvar_float(cvar_povSec));
}

public OnRoundStart()
{
	for (new id = 1; id <= MAX_PLAYERS; id++)
		g_kills[id] = 0;

	// A paid lock does not survive the round: a round mode ends with Round_End, and a lock left behind
	// would hold the camera on a bot nobody is paying for any more. PickTarget refuses while locked, so
	// the release has to come first.
	ReleaseLock("round start");

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

	if (equal(arg, "lock"))
	{
		// `amx_stcam lock <nick|#userid> [seconds]`: holds the camera on one bot. This is the command a
		// paid round mode sends right after its own `amx_de`, and the reason it exists is that the
		// director's idea of an interesting bot and the viewer's are not always the same bot.
		new who[NAME_LEN];
		new raw[16];
		read_argv(2, who, charsmax(who));
		read_argv(3, raw, charsmax(raw));

		new Float:seconds = LOCK_DEFAULT_SECONDS;
		if (raw[0] != '^0')
			seconds = str_to_float(raw);
		if (seconds < 1.0)
			seconds = 1.0;
		if (seconds > LOCK_MAX_SECONDS)
			seconds = LOCK_MAX_SECONDS;

		new target = FindTargetPlayer(who);
		if (!target)
		{
			server_print("stream_cam: no such player '%s'", who);
			return PLUGIN_HANDLED;
		}

		if (!IsPlayable(target))
		{
			// Dead, on the spectator team, or the camera client itself: following it would freeze the
			// picture on nothing, and a lock is exactly what would keep it there.
			server_print("stream_cam: '%s' cannot be followed", who);
			return PLUGIN_HANDLED;
		}

		g_lockTarget = target;
		g_lockUntil = get_gametime() + seconds;

		// Applied in this call, not on the next director tick: the API sends the lock and the event in
		// the same second, and a second of the wrong bot is what this command exists to prevent. A first
		// person window on the previous bot is closed here for the same reason - the paid cut must not
		// start in somebody else's eyes.
		LeavePov("the camera was locked on another bot");
		ResetEyeTracking();

		g_prevTarget = g_target;
		g_target = target;
		g_dwellUntil = g_lockUntil;
		g_holdUntil = g_lockUntil;
		g_idleSince = get_gametime();
		g_modeSent = -1;
		ApplyCamera();

		new name[NAME_LEN];
		get_user_name(target, name, charsmax(name));
		log_amx("camera lock: '%s' for %.1f s", name, seconds);
		ReplaceSpaces(name, charsmax(name));
		server_print("stream_cam locked target=%s seconds=%.1f", name, seconds);
		return PLUGIN_HANDLED;
	}

	if (equal(arg, "unlock"))
	{
		ReleaseLock("released by request");

		// The bot already on screen keeps it for one dwell instead of being cut in the same frame.
		new Float:now = get_gametime();
		g_dwellUntil = now + get_pcvar_float(cvar_dwell);
		g_holdUntil = now + get_pcvar_float(cvar_interval);
		server_print("stream_cam lock released");
		return PLUGIN_HANDLED;
	}

	if (!equal(arg, "status"))
	{
		server_print("stream_cam usage: amx_stcam status | amx_stcam lock <nick|#userid> [seconds] | amx_stcam unlock | amx_stcam cmd <client command> [arg]");
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

	// The lock is reported as a name and the seconds it has left: the panel needs both to say "the
	// camera is held on Nemesis for 42 s" and to notice a lock that should have ended.
	new locked[NAME_LEN] = "none";
	new Float:lockLeft = 0.0;
	if (g_lockTarget > 0)
	{
		lockLeft = g_lockUntil - get_gametime();
		if (lockLeft < 0.0)
			lockLeft = 0.0;
		if (is_user_connected(g_lockTarget))
			get_user_name(g_lockTarget, locked, charsmax(locked));
		ReplaceSpaces(locked, charsmax(locked));
	}

	// One line, key=value, no spaces inside values: docs/runbook.md greps exactly this. eye_ammo and
	// eye_btn are the two shot signals counted separately - the only way to tell from outside the game
	// which one a YaPB fake client actually reports.
	server_print("stream_cam status: enabled=%d interval=%.1f mode=%d spectator=%s target=%s candidates=%d dwell=%.1f hp=%d active=%d ar=%d pov=%d pov_active=%d eye=%d vmodel=%d eye_active=%d eye_sec=%.1f eye_cuts=%d eye_ammo=%d eye_btn=%d locked=%s lock_left=%.1f",
		get_pcvar_num(cvar_enabled), get_pcvar_float(cvar_interval), get_pcvar_num(cvar_mode),
		spectator, target, candidates,
		get_pcvar_float(cvar_dwell), hp, g_modeSent, armor,
		get_pcvar_num(cvar_pov), g_povActive ? 1 : 0,
		get_pcvar_num(cvar_eye), g_viewmodelApplied ? 1 : 0,
		EyeWanted() ? 1 : 0, get_pcvar_float(cvar_eyeSec), g_eyeCuts, g_eyeAmmoCuts, g_eyeButtonCuts,
		locked, lockLeft);

	return PLUGIN_HANDLED;
}
