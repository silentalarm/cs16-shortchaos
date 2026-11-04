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
 *
 * Compiler trap: this amxxpc build (1.10.0.5487) aborts with std::bad_alloc instead of a readable error
 * on an escaped double quote inside a log_amx/Announce format string. Use single quotes in the format,
 * or log the value unquoted.
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
/* 32, not 24: the registry copies handler names with `copy(dest, CODE_LEN - 1, ...)`, and `copy`
   keeps a terminator, so a 24 byte buffer truncated `EffectAnnouncerCountdown` (23) to 22 and
   `callfunc_begin` failed with "callfunc_end called without callfunc_begin". */
#define CODE_LEN 32
#define KEY_LEN 20
/* 48 holds a `text=` phrase of 40 characters (the catalogue's `maxPhraseLength`) with room to spare. */
#define VALUE_LEN 48
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
/* The per-bot velocity `invert_velocity` rewrites every tick. The claim is what tells the undo of one
   run that a newer run owns the field, so it may not flip the direction back under it. */
#define CLAIM_VELOCITY 8
#define CLAIM_COUNT 9
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

/* A grenade in a bot's hand never goes off on its own: YaPB does not use the grenade slot (measured on
   the live server - zero grenade events in a minute with twenty bots holding one), so the party throws
   its own. This is the "endless HE" the announcement promises, and with no knife in the field it is
   also the whole show, hence the short cadence. */
#define HE_BLAST_TICKS 2
#define HE_BLAST_RADIUS 300
#define HE_BLAST_DAMAGE 15
/* One in reserve, refilled every 0.5 s: a thrown grenade leaves the weapon entity in the inventory with
   no rounds, so a bot that is only "given the grenade once" throws exactly one per party. Two rounds so
   a bot still has one in hand between two passes of the task. */
#define HE_PARTY_GRENADES 2
new g_heBlastTicks;
/* Counted so the log says whether the bots really throw: "the field threw 40 grenades" and "the event's
   own blast fired 26 times" are two very different events to watch, and only one of them is a party. */
new g_heThrown;
/* 33 = the engine's 32 player slots plus the world, spelled out because MAX_SLOTS is defined further
   down this file and a Pawn `#define` has to be seen before it is used. */
new bool:g_heArmed[33];

/* MELEE MODE. `yb_stab_close_enemies` is 0 in yapb.cfg on purpose (a bot that stabs while holding a
   rifle reads as broken), and with every gun stripped it also stops the knife from ever swinging:
   measured on the stream, he_party produced 0 kills in 60 s, and 5 knife kills in 30 s once the cvar
   was set to 1 by hand. The flag is derived from the field instead of remembered per event, so every
   code that strips weapons inherits it, and a map change (which re-executes yapb.cfg and resets the
   cvar) repairs itself within a second. */
#define TASK_MELEE_WATCH 4917
#define MELEE_WATCH_TICK 1.0
new bool:g_meleeMode;

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
#if !defined TE_SMOKE
#define TE_SMOKE 5
#endif

new g_cannonBot;
new bool:g_cannonActive;
/* `one_bullet` is a rule about every bot's ammo and it holds for the whole clock, so the respawn has to know
   it is still running: a bot that dies mid-event comes back with csdm_lite's full rifle otherwise. */
new bool:g_oneBulletActive;
/* The health the cannon bot had before it was buffed: "restore what it was" is part of what the
   viewer buys, and a 1000 HP bot that keeps the number after the clock is a bug you can see.
   `g_cannonHealth` is the buff itself, captured from the command: ArmGlassCannon runs again from the
   ammo task when the hero dies, and by then the parameter table belongs to another donation. */
new g_cannonSavedHealth;
new g_cannonHealth = 1000;
/* The clock of the run, snapshotted for the camera lock for the same reason the health is: ArmGlassCannon
   runs again from the ammo task when the carrier dies, and by then the parameter table has moved on. */
new g_cannonSeconds = 15;

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
/* 0 = draw the red glow, 1..255 = semi-transparent (255 is invisible). No code uses the alpha right now
   (`assassin` was the silhouette and `sniper` replaced it): the machinery stays because a hero the viewer
   cannot see is not a hero, and the next mode that needs a silhouette should not re-invent this. */
new g_heroAlpha;
/* Where the role goes when the hero dies: 0 = a random bot, 1 = the killer (`juggernaut`: the bot that
   killed the boss becomes the boss, which is the whole point of the mode). */
new bool:g_heroToKiller;
new g_heroNext;

/* The hero's own look (`infra/models/player/`): a re-skin of a stock soldier per mode, written as new
   files by the model builders in `infra/models/build`. GoldSrc dies on a precache of a missing .mdl
   (`Mod_LoadModel: ... not found` is a FATAL ERROR and the server restarts in a loop), so each file is
   checked before it is precached and the mode then runs on the stock soldier instead of taking the server
   down. `g_heroLookSet` is what tells the undo whether the model on the slot is this file's:
   `cs_reset_user_model` lifts the model lock of *anybody*, and the hex_wave chicken on the same bot must
   not be taken off by a hero's clock. */
#define NEMESIS_MODEL "nemesis"
#define SURVIVOR_MODEL "survivor"
#define NEMESIS_MODEL_PATH "models/player/nemesis/nemesis.mdl"
#define SURVIVOR_MODEL_PATH "models/player/survivor/survivor.mdl"
new bool:g_nemesisLook;
new bool:g_survivorLook;
new bool:g_heroLookSet;
/* The clock the hero event took, in seconds. The camera lock is handed the same number, so the picture
   stays on the hero for exactly as long as the role exists even when the undo never runs. */
new g_heroSeconds = 60;

/* `sniper` is a hero mode with a budget instead of a knife: one bot, an AWP, `rounds` shots, a kill pays
   one back. The budget is counted in *shots*, not in ammo, because csdm_lite refills every bot's reserve
   once a second (`csdm_lite_ammo_reserve`) - a "five rounds" promise kept in the clip would be refilled
   inside a second and the promise would be a lie. When the budget is gone the launcher is taken away, so
   the viewer sees the knife fight start instead of an AWP that never runs dry. */
#define SNIPER_ROUNDS_DEFAULT 5
#define SNIPER_ROUNDS_MAX 10
/* The same classname the bazooka uses as its trigger: one AWP, two paid uses. */
#define SNIPER_WEAPON "weapon_awp"
new g_sniperRounds = SNIPER_ROUNDS_DEFAULT;
new g_sniperLeft;
new bool:g_sniperArmed;
new g_sniperShots;
new g_sniperKills;

/* Outbreak: every bot carries a flag, a knife kill converts the victim and the respawn hook re-arms it.
   A flag and not a health value: csdm_lite re-arms on every spawn, so the only thing that has to survive
   a death is "this bot is on the infected side". */
#define MAX_SLOTS 33
new g_infected[MAX_SLOTS];
new bool:g_outbreakActive;
/* Like `g_heroCode`: which code runs the infection right now. A newer outbreak ends the running one, and
   the ended run's clock still fires later - it must not clear the infected flags of the newer run. */
new g_outbreakCode[CODE_LEN];
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
/* ---------- S2 classes: one applier, five presets ----------
   A class re-speccs a part of the field instead of picking a hero: N bots get a health pool, a run
   speed multiplier, a gravity, a regeneration rate and a knockback. The five catalogue codes are five
   rows of numbers on one function, because five handlers with the same body are five places for the
   same bug (docs/activities/systems.md, S2).

   The state is shared by all five codes the way the hero state is shared by the four round modes: a
   newer class event replaces the older one for the bots it picks, and the claim layer decides who owns
   health, speed and gravity. */
#define TASK_CLASS_REGEN 4802
/* `count` is a parameter, so the picked list needs a ceiling of its own; the catalogue stays far below
   it (5 raptors, 4 brutes, 4 regenerators). */
#define MAX_CLASS_BOTS 16
/* Regeneration without a health ceiling turns a 45 second event into a bot that leaves the round with
   1500 HP nobody paid for; `regenerators` is the code that carries no explicit health. */
#define REGEN_CEIL 1000
/* Extra push per point of damage from the class's knockback, and the ceiling on the resulting speed: an
   uncapped impulse puts a bot inside geometry, and a bot outside the map is not a class, it is a
   missing player. */
#define KNOCKBACK_SCALE 2.0
#define KNOCKBACK_CAP 400.0

new g_classBots[MAX_CLASS_BOTS];
new g_classBotCount;
/* Knockback is the one class parameter a live round can only guess at, so the run counts what it did:
   the summary in EndClass answers "was anything actually thrown" without a picture, and
   `capped` says whether the ceiling of `KNOCKBACK_CAP` was the thing in effect. */
new g_classPushes;
new g_classCappedPushes;

/* ---------- S4 skills: state ---------- */

/* A skill does not need a class or a hero to exist: each of the five owns its own clock and its own
   claims, and two of them can be on the field at once. Task ids stay in the 48xx block. */
#define TASK_CHAIN 4811
#define TASK_BLINK 4812
#define TASK_ROULETTE 4813
#define HEX_MODEL_PATH "models/player/chicken/chicken.mdl"
#define HEX_SPEED 0.6
#define BLINK_MIN_DIST 50.0
#define BLINK_MAX_DIST 600.0
#define ROULETTE_INVISIBLE 0
#define ROULETTE_SPEED 1
#define ROULETTE_HEALTH 2
#define ROULETTE_DEAGLE 3
#define ROULETTE_POWERS 4
#define ROULETTE_HEALTH_HP 500
#define ROULETTE_SPEED_MULT 2.0
#define ROULETTE_ALPHA 60

new bool:g_hexActive;
new g_hexBot;
new g_hexModel[VALUE_LEN];
/* The costume needs a .mdl that the image does not ship yet, and GoldSrc dies on a missing precache
   (`Mod_LoadModel: not found` is a FATAL ERROR), so the costume is opt-in on the file existing and the
   hex works without it. */
new bool:g_hexCostume;
/* The clock of the run, for the camera lock: ArmHexed runs again on every respawn, and by then the
   parameter table belongs to another donation. */
new g_hexSeconds = 20;

new g_beamSprite;

new bool:g_chainActive;
new g_chainTargets = 3;
new g_chainDamage = 40;
/* Same reason as the blink counters: a bolt nobody sees hit anything is a bolt nobody can prove. */
new g_chainBolts;
new g_chainHits;

new bool:g_blinkActive;
new Float:g_blinkDistance = 200.0;
/* Counted the way the class knockback is: a blink that lands is indistinguishable from one the engine
   snapped back, so the run reports how many of its attempts actually moved a bot. */
new g_blinkMoved;
new g_blinkTried;

new bool:g_rouletteActive;
new bool:g_rouletteFired;
new g_rouletteBot;
new g_roulettePower = -1;
new g_rouletteSavedHealth;

new bool:g_auraActive;
new g_auraShare = 50;

/* ---------- S3 items: state ---------- */

/* Fire grenades: the field keeps HE grenades in hand, and a blast sets its victim on fire. The burn is
   per slot because two bots can burn at once, and its task is the only clock in the plugin that outlives
   a single bot. */
#define TASK_FIRE_PARTY 4814
#define TASK_BURN 4815
#define TASK_FIRE_SPARK 4819
#define BURN_TICK 1.0
#define FIRE_MAX_DAMAGE 500
#define FIRE_MAX_BURN 60
/* The same trap he_party was fixed for: a thrown grenade leaves the weapon entity in the inventory with
   no rounds in it, so `user_has_weapon` keeps answering yes and a bot armed once throws exactly one
   grenade for the whole event. What is endless is the reserve, topped up on every pass of
   TaskFireParty - two rounds, so a bot still has one in hand between two passes of the task. */
#define FIRE_PARTY_GRENADES 2

/* Both grenade codes have the same open half: YaPB keeps a grenade in hand and never throws it (measured
   with an HE over 30 s - nobody burned). So neither event can wait for a bot's arm. Each gets a spark of its
   own: one blast every SPARK_PERIOD next to a random bot, so what the viewer paid for happens on the field
   whether or not a bot decides to throw. The real path stays wired in both - a thrown HE still arrives as
   `DMG_BLAST`, a thrown flashbang still arrives through the grenade scan - the spark is only a second source
   of the same fact, never a second implementation of the effect. */
#define SPARK_PERIOD 4.0
#define SPARK_RADIUS_DEFAULT 300
#define SPARK_MAX_RADIUS 512
#define FIRE_SPARK_DAMAGE 10
#define SPARK_SOUND "weapons/hegrenade-1.wav"

new bool:g_fireActive;
new g_fireDamage = 60;
new g_fireBurn = 15;
/* The radius of the spark's blast, snapshotted from the command for the same reason as g_meteorRadius: the
   timer fires long after the parameter table belongs to somebody else. */
new g_fireRadius = SPARK_RADIUS_DEFAULT;
new g_fireTicks[MAX_SLOTS];
/* Counted for the same reason the knockback and the blinks are: "nothing caught fire" and "the fire did
   nothing" are the same log line otherwise. */
new g_fireIgnited;
new g_fireTicksApplied;
/* Grenades the bots actually threw, counted the way he_party counts them: a bot armed on one pass and
   holding no rounds on the next has let go of it. Without this the end line cannot tell "the reserve
   refill works" from "the field never opened its hand", and the difference is the whole activity. */
new g_fireThrown;
new bool:g_fireArmed[MAX_SLOTS];

/* Freeze grenades: a flashbang deals no damage, so `DMG_BLAST` in OnTakeDamage - the trigger the fire
   event leans on - never sees it. The engine leaves one trace instead: a thrown grenade is a `grenade`
   entity whose `pev_dmgtime` is its own detonation, and it is removed in the same frame it goes off. So a
   quarter-second scan remembers every live flashbang with its last origin, and a remembered one that is
   gone *after* its fuse is a detonation at that origin. The detection is therefore up to 0.25 s late, which
   the effect hides: the freeze is a state the viewer reads a second later, not a frame. */
#define TASK_FLASH_PARTY 4816
#define TASK_FLASH_SCAN 4817
#define TASK_THAW 4818
#define TASK_FLASH_SPARK 4820
#define FLASH_SCAN 0.25
#define THAW_TICK 0.5
#define FLASH_SOUND "weapons/flashbang-1.wav"
/* The freeze's own sample, rendered at image build time (`src/sound.ts` + `infra/sounds/generate.ts`) and
   shipped in `cstrike/sound/freeze/`. A flashbang bang is a flash, not ice, and the event sells ice; the
   stock sample stays as the fallback, because a tree built without the generator must still have a bang. */
#define FREEZE_SOUND "freeze/ice_crack.wav"
#define FREEZE_SOUND_PATH "sound/freeze/ice_crack.wav"
new bool:g_freezeIce;
/* More grenades in the air than this at once would need twenty bots throwing inside one stride; the scan
   looks at the first sixteen and the rest are still tracked on the next pass. */
#define FLASH_MAX_TRACKED 16
#define FREEZE_MAX_SECONDS 30
#define FREEZE_MAX_RADIUS 512

new bool:g_freezeActive;
new g_freezeSeconds = 6;
new Float:g_freezeRadius = 300.0;
/* A per-slot countdown in THAW_TICK steps, like the burn: a second blast catches an overlapping group, and
   a bot re-frozen while it still stands must not thaw on the older countdown. */
new g_freezeTicks[MAX_SLOTS];
/* Counted for the same reason the burns, the blinks and the bolts are: a flashbang nobody threw and a blast
   that caught nobody read as the same silent event otherwise. */
new g_freezeBlasts;
new g_freezeCaught;
/* What the previous scan saw: entity index, last origin, and the fuse it held. The fuse is part of the
   identity - the engine hands the slot of a detonated grenade to the next one. */
new g_flashEnt[FLASH_MAX_TRACKED];
new Float:g_flashOrigin[FLASH_MAX_TRACKED][3];
new Float:g_flashFuse[FLASH_MAX_TRACKED];
new g_flashCount;

/* ---------- S3 items: the bazooka, a weapon the bot fires ----------
   A custom weapon entity (`zp_extra_bazooka`, docs/activities/assets.md) is not reachable from a plugin:
   YaPB picks what to shoot from its own weapon list, and nothing in that list is ours, so an entity of our
   own would sit in the inventory and never be pressed. The launcher is therefore a stock weapon the bot AI
   already knows - `weapon_awp`, one shot per bolt cycle - with three changes on top of it:

     - the model in the hand. The engine draws a player's third-person weapon from the player's own
       `weaponmodel` field (the `p_` model), so that field is rewritten to `models/p_bazooka.mdl` from a
       tick. One write is not enough: the game puts the real model back on every switch and every spawn,
       and the launcher would be off the screen the first time the bot reaches for its knife;
     - the trigger: the engine's own `Ham_Weapon_PrimaryAttack`, so the bot aims and fires by itself;
     - the shell: the AWP's bullet is thrown away (`Ham_TraceAttack` is superceded for the carrier) and a
       rocket flies from the muzzle along the bot's view instead - it explodes on the first thing it meets
       and the blast does the killing. Without that the bot is a sniper holding a prop.

   Both models are made in this repository (`infra/models/build/bazooka.mjs`), so there is no pack and no
   licence to chase. Task ids stay in the 48xx block. */
#define TASK_BAZOOKA_DRESS 4826
#define TASK_BAZOOKA_ROCKET 4827
#define BAZOOKA_MODEL "models/p_bazooka.mdl"
#define BAZOOKA_WEAPON "weapon_awp"
/* What the model field has to be put back to when the clock runs out. The game precaches every weapon
   model when it starts, so this name is the one its own arming would have written. */
#define BAZOOKA_AWP_MODEL "models/p_awp.mdl"
/* Four times a second: fast enough that a weapon switch is corrected before the viewer reads it, slow
   enough that rewriting one field costs nothing. */
#define BAZOOKA_DRESS_TICK 0.25
/* Flight step. 0.05 s at BAZOOKA_SPEED is 45 units a step - the length of a bot - so nothing is skipped. */
#define BAZOOKA_ROCKET_TICK 0.05
#define BAZOOKA_SPEED 900.0
/* 40 steps is two seconds of flight; a rocket still in the air after that has crossed the whole map. */
#define BAZOOKA_TICKS 40
#define MAX_ROCKETS 4
#define BAZOOKA_DAMAGE_DEFAULT 500
#define BAZOOKA_RADIUS_DEFAULT 320
#define BAZOOKA_RADIUS_MAX 512
/* The blast weakens with distance but never to nothing: a rocket that lands and leaves everybody standing
   is a dud the viewer sees. */
#define BAZOOKA_MIN_DAMAGE 40
#define BAZOOKA_BLAST_SOUND "weapons/c4_explode1.wav"

new g_bazookaModel;
/* `pev_weaponmodel` is a *string* index (ALLOC_STRING in the game DLL), not a precache index, and an
   AllocString per tick would keep growing the engine's string table: both indexes are taken once, at
   precache. */
new g_bazookaModelString;
new g_bazookaAwpModelString;
new bool:g_bazookaActive;
new g_bazookaBot;
new g_rocketEnt[MAX_ROCKETS];
new Float:g_rocketVelocity[MAX_ROCKETS][3];
new g_rocketOwner[MAX_ROCKETS];
new g_rocketTicks[MAX_ROCKETS];
/* Counted for the same reason the knockback and the blinks are: without them "the bot never fired" and
   "the rocket hit a wall" are the same empty log line. */
new g_rocketFired;
new g_rocketBlasts;
new g_rocketHits;
/* A repeating task on a fixed id cannot be started twice on some AMXX builds, so the tick is started by the
   first rocket in the air and removes itself when the last one is gone. */
new bool:g_rocketTick;
/* The damage and the radius of one rocket, snapshotted from the command: the tick fires long after the
   parameter table belongs to somebody else. */
new g_rocketDamage = BAZOOKA_DAMAGE_DEFAULT;
new g_rocketRadius = BAZOOKA_RADIUS_DEFAULT;

/* ---------- S5 chases: five rules the viewer reads in three seconds ----------
   Four of them need no state beyond the field itself; `guntrain` and `head_hunter` keep a per-slot number,
   and both are cleared by a full reset because a slot is not a person. Task ids stay in the 48xx block. */
#define TASK_HILL 4821
#define TASK_MARK 4822
#define TASK_MARK_GLOW 4823
#define TASK_DUEL 4824
#define TASK_STATUE 4825
/* Both sights need a pass fast enough that a freeze reads as "he looked at him", and slow enough that the
   double loop of traces (N x N, twenty bots) never costs a frame. */
#define SIGHT_TICK 0.5
#define HILL_TICK 0.5
#define TRAIN_MAX_LADDER 8
#define TRAIN_NAME_LEN 16
#define HILL_MAX_RADIUS 512
#define MARK_MAX_HOLD 60
#define DUEL_MAX_HEALTH 100
#define DUEL_GAP 64.0

new bool:g_trainActive;
new g_trainLadder[TRAIN_MAX_LADDER][TRAIN_NAME_LEN];
new g_trainCount;
new g_trainLevel[MAX_SLOTS];
/* A bot that reached the knife keeps its announcement: the winner check alone repeated it every time another
   bot got there first and this one killed again. */
new g_trainTop[MAX_SLOTS];
new g_trainPromotions;
new g_trainWinner;

new bool:g_statueActive;
new g_statueHeld[MAX_SLOTS];
new g_statueFrozen;

new bool:g_markActive;
new g_markBot;
new g_markHold = 15;
new g_markReward[VALUE_LEN];
/* Countdown in SIGHT_TICK steps for the gold shell of a bot that took the mark: the weapon goes with the
   body, the glow is render state and has to be taken off by hand. */
new g_markGlow[MAX_SLOTS];
new g_markRewards;

new bool:g_hillActive;
new Float:g_hillCentre[3];
new Float:g_hillRadius = 200.0;
new Float:g_hillHold = 3.0;
new g_hillHealth = 300;
new Float:g_hillDwell[MAX_SLOTS];
new g_hillBuffed[MAX_SLOTS];
new g_hillTaken;

new bool:g_duelBellActive;
new g_bellHealth = 1;
new g_duels;

/* ---------- S6 physics: rules of the world, not of a bot ----------
   Six codes, one stage (docs/activities/roadmap.md, stage 7). They are the cheapest effects on the
   server - no model, no costume, two stock sounds - and the easiest to leave behind: a gravity cvar
   and a per-tick velocity flip outlive every round if their task is dropped without an undo. Task
   ids stay in the 48xx block, and every number a timer needs is snapshotted in the handler. */
#define TASK_AIRSTRIKE 4830
#define TASK_WEAPON_RAIN 4831
#define TASK_QUAKE 4832
#define TASK_FIRE_RING 4833
#define TASK_INVERT 4834
#define TASK_GRAVITY_KNIVES 4835

/* Airstrike: ten blasts walk in from a ring 600 units out, one every 0.4 s, so the last one lands on
   the leader the first one was aimed at. */
#define AIR_TICK 0.4
#define AIR_RING_RADIUS 600.0
#define AIR_MAX_STRIKES 20
#define AIR_MAX_DAMAGE 500
#define AIR_MAX_RADIUS 512
#define AIR_MIN_RADIUS 50
#define AIR_SOUND "ambience/thunder_clap.wav"

/* Weapon rain: five boxes is the hard cap - llvmpipe renders every extra model on the CPU. */
#define RAIN_MAX_DROPS 5
#define RAIN_MAX_ENTITIES 5
#define RAIN_HEIGHT 220.0

#define QUAKE_MAX_FORCE 1200
#define QUAKE_MIN_FORCE 50
#define QUAKE_MAX_SPEED 900.0
#define QUAKE_MIN_PERIOD 0.2
#define QUAKE_MAX_PERIOD 5.0

#define RING_MIN_RADIUS 50.0
#define RING_MAX_RADIUS 1024.0
#define RING_MAX_DAMAGE 100
#define RING_MAX_SHRINK 200
#define RING_MIN_SHRINK 1
#define RING_MIN_PERIOD 0.2
#define RING_MAX_PERIOD 5.0

#define INVERT_MIN_PERIOD 0.05
#define INVERT_MAX_PERIOD 2.0

#define KNIVES_MIN_GRAVITY 50
#define KNIVES_MAX_GRAVITY 800

new bool:g_airActive;
new g_airStrikes;
new g_airLeft;
new g_airDamage;
new g_airRadius;
new Float:g_airFrom[3];
new Float:g_airTarget[3];
new g_airBursts;
new g_airHits;

new bool:g_rainActive;
new g_rainLeft;
new g_rainSpawned;
new g_rainEnts[RAIN_MAX_ENTITIES];

new bool:g_quakeActive;
new Float:g_quakeForce;
new Float:g_quakePeriod;
new g_quakeTicks;
new g_quakeShoves;

new bool:g_ringActive;
new Float:g_ringCentre[3];
new Float:g_ringRadius;
new Float:g_ringShrink;
new Float:g_ringPeriod;
new g_ringDamage;
new g_ringScorched;
new g_ringBurnt[MAX_SLOTS];

new bool:g_invertActive;
new Float:g_invertPeriod;
new g_invertFlips;

new bool:g_knivesActive;
new g_knivesGravity;

/* ---------- S8 sound: the broadcast's own audio ----------
   These four codes do not live in the game's sound system: GoldSrc plays only precached files, so a
   custom cue would have to ship inside the client. The game side prints the line and takes the
   `CLAIM_AUDIO` so two paid sound events cannot own the bed at once; the actual audio is a request
   file for `infra/stream/voice.sh` (`src/voice.ts`), which is the only place the mix exists. */
#define TASK_COUNTDOWN 4840
#define COUNTDOWN_FROM 3
#define QUOTE_MAX_LEN 60

new bool:g_countdownActive;
new g_countdownLeft;

new bool:g_quotesActive;

new bool:g_sirenActive;
new bool:g_musicSwapActive;

new bool:g_classActive;
/* Which of the five codes shapes the field right now. A newer class event ends the running one before it
   takes over, and the ended run's clock still fires later: without this code that stale clock would
   reset the flags and the regeneration task of the run that is on screen. */
new g_classCode[CODE_LEN];
new g_classHealth;
new g_classRegen;
new Float:g_classSpeed = 1.0;
/* Knockback and gravity as integer percents: both are multipliers of a whole resource, and comparing a
   float with 1.0 in a damage hook is a comparison that silently fails. */
new g_classKnockback = 100;
new g_classGravity = 100;
/* Per slot, like the infection flag: a class bot has to come back with the class shape after the
   csdm_lite respawn, and the health it had before the buff is what the clock puts back. */
new g_classPicked[MAX_SLOTS];
new g_classSavedHealth[MAX_SLOTS];





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

	// The spawn hook a bot also goes through. ResetHUD above is the event path, and on the stream it was not
	// enough: a hero came back holding csdm_lite's rifle. Both paths schedule the same re-arm, and a repeated
	// schedule only replaces its own countdown.
	RegisterHam(Ham_Spawn, "player", "OnSpawnHam");

	// The bazooka (S3): the bot's own trigger launches the rocket, and the hitscan behind that trigger is
	// dropped - a 500 damage blast plus an AWP headshot is a sniper with a prop, not a launcher.
	RegisterHam(Ham_Weapon_PrimaryAttack, BAZOOKA_WEAPON, "OnBazookaAttack");
	RegisterHam(Ham_TraceAttack, "player", "OnTraceAttack");
	// The sniper (S1): the same AWP, and the shot that spends one of its five rounds.
	RegisterHam(Ham_Weapon_PrimaryAttack, SNIPER_WEAPON, "OnSniperAttack");

	// The hero modes (S1 of docs/activities/systems.md): one bot carries the round.
	RegisterDonationEffect("nemesis", "EffectNemesis");
	RegisterDonationEffect("survivor", "EffectSurvivor");
	RegisterDonationEffect("juggernaut", "EffectJuggernaut");
	RegisterDonationEffect("sniper", "EffectSniper");
	RegisterDonationEffect("outbreak", "EffectOutbreak");
	RegisterDonationEffect("chaos_plague", "EffectChaosPlague");

	// S2 classes: the same field with different numbers instead of one hero - no models, the movement
	// is what reads on the stream (docs/activities/systems.md, S2).
	RegisterDonationEffect("raptors", "EffectRaptors");
	RegisterDonationEffect("brutes", "EffectBrutes");
	RegisterDonationEffect("runners", "EffectRunners");
	RegisterDonationEffect("jumpers", "EffectJumpers");
	RegisterDonationEffect("regenerators", "EffectRegenerators");

	RegisterDonationEffect("he_party", "EffectHeParty");

	// The 2025-10 event set: 50 RUB each, 15 seconds each, one in the frame at a time.
	RegisterDonationEffect("glass_cannon", "EffectGlassCannon");
	RegisterDonationEffect("meteor_shower", "EffectMeteorShower");
	RegisterDonationEffect("red_light", "EffectRedLight");
	RegisterDonationEffect("lightsaber_duel", "EffectLightsaberDuel");
	RegisterDonationEffect("one_bullet", "EffectOneBullet");

	// S4 skills: the five codes of docs/activities/systems.md, S4. No new asset is needed by four of
	// them; `hex_wave` wants a chicken model and says so in its log line.
	RegisterDonationEffect("hex_wave", "EffectHexWave");
	RegisterDonationEffect("chain_lightning", "EffectChainLightning");
	RegisterDonationEffect("blink_bots", "EffectBlinkBots");
	RegisterDonationEffect("hero_roulette", "EffectHeroRoulette");
	RegisterDonationEffect("vampiric_aura", "EffectVampiricAura");

	// S3 items, in the roadmap's order: the two grenade codes first, the custom weapons once their
	// entities and models exist.
	RegisterDonationEffect("fire_grenades", "EffectFireGrenades");
	RegisterDonationEffect("freeze_nades", "EffectFreezeNades");
	RegisterDonationEffect("bazooka_drop", "EffectBazookaDrop");

	// S5 chases: rules the viewer reads in three seconds, no model and no sound of their own.
	RegisterDonationEffect("guntrain", "EffectGunTrain");
	RegisterDonationEffect("statues", "EffectStatues");
	RegisterDonationEffect("head_hunter", "EffectHeadHunter");
	RegisterDonationEffect("king_of_the_hill", "EffectKingOfTheHill");
	RegisterDonationEffect("duel_bell", "EffectDuelBell");

	// S6 physics: six codes that change the world's rules instead of a bot's numbers
	// (docs/activities/systems.md, S6). Two of them own a server-level resource, so they are the first
	// codes whose undo has to restore a cvar rather than a per-bot value.
	RegisterDonationEffect("airstrike", "EffectAirstrike");
	RegisterDonationEffect("weapon_rain", "EffectWeaponRain");
	RegisterDonationEffect("quake", "EffectQuake");
	RegisterDonationEffect("fire_ring", "EffectFireRing");
	RegisterDonationEffect("invert_velocity", "EffectInvertVelocity");
	RegisterDonationEffect("low_gravity_knives", "EffectLowGravityKnives");

	// S8 sound: the game prints and claims, the broadcast container speaks (src/voice.ts). No game
	// asset is needed by any of the four, which is why they are the cheapest codes in the catalogue.
	RegisterDonationEffect("announcer_countdown", "EffectAnnouncerCountdown");
	RegisterDonationEffect("quotes_pack", "EffectQuotesPack");
	RegisterDonationEffect("siren", "EffectSiren");
	RegisterDonationEffect("music_swap", "EffectMusicSwap");

	// The knife rule of every knife-only event: see TASK_MELEE_WATCH.
	StartMeleeWatch();

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
	// The two grenade sparks play the stock bang of the grenade they stand in for; a file missing here is a
	// silent blast, and both were checked against the image (sound/weapons/flashbang-1.wav, hegrenade-1.wav).
	precache_sound(SPARK_SOUND);
	precache_sound(FLASH_SOUND);

	// The freeze's own sample. `precache_sound` on a missing file is not fatal in GoldSrc, so the file is
	// checked and the event falls back to the stock bang it was using before the ice existed.
	g_freezeIce = file_exists(FREEZE_SOUND_PATH) != 0;
	if (g_freezeIce)
		precache_sound(FREEZE_SOUND);
	else
		log_amx("freeze_nades: %s is not in the image, the blast uses the stock flashbang bang", FREEZE_SOUND_PATH);

	// S4: the bolt between chained bots is a stock sprite. The hex costume is a different case - a missing
	// .mdl is not a soft failure in GoldSrc, it is `FATAL ERROR (shutting down): Mod_LoadModel: ... not
	// found`, which takes the server into a restart loop. So the file is checked first and precached only
	// when it is there; the costume then appears by itself once the model is in the image.
	precache_model("sprites/laserbeam.spr");
	g_beamSprite = precache_model("sprites/laserbeam.spr");

	g_hexCostume = file_exists(HEX_MODEL_PATH) != 0;
	if (g_hexCostume)
		precache_model(HEX_MODEL_PATH);
	else
		log_amx("hex_wave: %s is not in the image, the hex runs without the costume", HEX_MODEL_PATH);

	// The two hero looks, checked the same way and for the same reason. These are files this repository
	// makes, so a missing one means the image was built from an older tree: the event says so once, here,
	// and then runs with the soldier the game already has.
	g_nemesisLook = file_exists(NEMESIS_MODEL_PATH) != 0;
	if (g_nemesisLook)
		precache_model(NEMESIS_MODEL_PATH);
	else
		log_amx("nemesis: %s is not in the image, the hero wears the stock soldier", NEMESIS_MODEL_PATH);

	g_survivorLook = file_exists(SURVIVOR_MODEL_PATH) != 0;
	if (g_survivorLook)
		precache_model(SURVIVOR_MODEL_PATH);
	else
		log_amx("survivor: %s is not in the image, the hero wears the stock soldier", SURVIVOR_MODEL_PATH);

	// The launcher's own model, made here rather than bought. Same rule as the costume above: a missing .mdl
	// is `Mod_LoadModel: ... not found` at precache, which takes the server into a restart loop, so the file
	// is checked first and the event then says it has nothing to carry.
	g_bazookaModel = file_exists(BAZOOKA_MODEL) != 0 ? precache_model(BAZOOKA_MODEL) : 0;
	if (!g_bazookaModel)
		log_amx("bazooka_drop: %s is not in the image, the launcher has no model in hand", BAZOOKA_MODEL);
	else
	{
		g_bazookaModelString = engfunc(EngFunc_AllocString, BAZOOKA_MODEL);
		g_bazookaAwpModelString = engfunc(EngFunc_AllocString, BAZOOKA_AWP_MODEL);
	}

	// The rocket's blast. A sample that is not precached is a silent explosion, so it goes here.
	precache_sound(BAZOOKA_BLAST_SOUND);
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

	if (equal(code, "nemesis") || equal(code, "survivor") || equal(code, "juggernaut") || equal(code, "sniper"))
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

	if (equal(code, "raptors") || equal(code, "brutes") || equal(code, "runners") || equal(code, "jumpers") || equal(code, "regenerators"))
	{
		// The five presets share one applier and one undo; EndClass asks the claim layer whether this
		// event still owns the numbers it wrote.
		EndClass(code);
		return;
	}

	if (equal(code, "hex_wave"))
	{
		EndHexWave();
		return;
	}

	if (equal(code, "chain_lightning"))
	{
		EndChainLightning();
		return;
	}

	if (equal(code, "blink_bots"))
	{
		EndBlinkBots();
		return;
	}

	if (equal(code, "hero_roulette"))
	{
		EndHeroRoulette();
		return;
	}

	if (equal(code, "vampiric_aura"))
	{
		EndVampiricAura();
		return;
	}

	if (equal(code, "fire_grenades"))
	{
		EndFireGrenades();
		return;
	}

	if (equal(code, "freeze_nades"))
	{
		EndFreezeNades();
		return;
	}

	if (equal(code, "bazooka_drop"))
	{
		EndBazookaDrop();
		return;
	}

	if (equal(code, "guntrain"))
	{
		EndGunTrain();
		return;
	}

	if (equal(code, "statues"))
	{
		EndStatues();
		return;
	}

	if (equal(code, "head_hunter"))
	{
		EndHeadHunter();
		return;
	}

	if (equal(code, "king_of_the_hill"))
	{
		EndKingOfTheHill();
		return;
	}

	if (equal(code, "duel_bell"))
	{
		EndDuelBell();
		return;
	}

	if (equal(code, "airstrike"))
	{
		EndAirstrike();
		return;
	}

	if (equal(code, "weapon_rain"))
	{
		EndWeaponRain();
		return;
	}

	if (equal(code, "quake"))
	{
		EndQuake();
		return;
	}

	if (equal(code, "fire_ring"))
	{
		EndFireRing();
		return;
	}

	if (equal(code, "invert_velocity"))
	{
		EndInvertVelocity();
		return;
	}

	if (equal(code, "low_gravity_knives"))
	{
		EndLowGravityKnives();
		return;
	}

	if (equal(code, "announcer_countdown"))
	{
		EndAnnouncerCountdown();
		return;
	}

	if (equal(code, "quotes_pack"))
	{
		EndQuotesPack();
		return;
	}

	if (equal(code, "siren"))
	{
		EndSiren();
		return;
	}

	if (equal(code, "music_swap"))
	{
		EndMusicSwap();
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
		// One round in the clip and nothing in reserve: the next spawn hands the normal kit back, so there is
		// nothing to undo - only the flag that arms a respawn has to stop arming one.
		g_oneBulletActive = false;
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

/* A respawn is armed twice: at 0.3 s, and again at 0.9 s, because csdm_lite hands the bot its rifle about
   half a second after the death and would undo the first pass. The late schedule carries a shifted task id so
   the two countdowns do not overwrite each other. Declared here, before both users: a pawn symbol has to be
   defined above the line that reads it. */
#define REARM_LATE 100
#define REARM_LATE_DELAY 0.9

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

	// The 0.3 s re-arm the duel schedules for this spawn, and its late pass.
	remove_task(id);
	remove_task(id + REARM_LATE);
	ClearGlow(id);

	// A slot is not a person: a freeze countdown left on it would thaw, or strip the glow of, the next
	// occupant, which never stood in the blast.
	g_freezeTicks[id] = 0;

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
	{
		g_heBlastTicks = 0;
		g_heThrown = 0;
		for (new slot = 0; slot < MAX_SLOTS; slot++)
			g_heArmed[slot] = false;
		set_task(0.5, "TaskHeParty", TASK_HE_PARTY, "", 0, "b");
	}

	log_amx("he_party: grenades only, +%d s (total %d s)", seconds, g_hePartyTicks / 2);
}

public TaskHeParty()
{
	if (!g_hePartyActive)
		return;

	DisarmField();

	// The party's own grenade: see HE_BLAST_* above. Rare enough to stay readable (one blast every
	// three seconds), and the knife fight is what carries the minute.
	g_heBlastTicks++;
	if (g_heBlastTicks >= HE_BLAST_TICKS)
	{
		g_heBlastTicks = 0;
		HePartyBlast();
	}

	g_hePartyTicks = g_hePartyTicks - 1;
	if (g_hePartyTicks > 0)
		return;

	g_hePartyActive = false;
	remove_task(TASK_HE_PARTY);
	Announce("HE GRENADES ARE OVER");
	// Nothing to restore: the bots keep the knife until they die, and the next spawn gives them a
	// real weapon again through csdm_lite.
	log_amx("he_party: over, %d grenades thrown by the bots, the next spawn arms them again", g_heThrown);
}

/* Every alive bot: a grenade and nothing else. The whole weapon list is walked, not the weapon in hand:
   a rifle left in the backpack comes out the moment the bot sees somebody. No knife on purpose - the
   event is "HE grenades only", and a knife in a bot's hand is what a viewer reads as a broken knife
   round instead of a grenade party. */
stock DisarmField()
{
	new disarmed;

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		// HasGun() is about guns; the knife has to be asked for separately, because it is not a gun and
		// the engine hands it back with the kit.
		if (HasGun(id) || user_has_weapon(id, CSW_KNIFE))
		{
			StripWeapons(id);
			disarmed++;
		}

		// The grenade is re-given after it is thrown, which is the "endless" part of the activity. Asking
		// for the weapon alone is not enough: a thrown grenade leaves the entity in the inventory with no
		// rounds in it, so `user_has_weapon` keeps answering yes and a bot throws exactly one grenade per
		// party (measured on the stream). The reserve is topped up on every pass instead.
		new ammo = cs_get_user_bpammo(id, CSW_HEGRENADE);
		if (!user_has_weapon(id, CSW_HEGRENADE))
			give_item(id, "weapon_hegrenade");

		// A bot that was armed on the previous pass and has no rounds now has thrown its grenade.
		if (g_heArmed[id] && ammo < 1)
			g_heThrown++;

		g_heArmed[id] = true;
		cs_set_user_bpammo(id, CSW_HEGRENADE, HE_PARTY_GRENADES);

		// The hand, not only the inventory. csdm_lite arms every respawn with a knife plus a rifle, the
		// strip above takes the rifle and leaves the knife, and the engine keeps whatever the bot last
		// held - on the stream that read as "the party is over, everyone runs with a knife". Switching
		// the slot is a console command the game DLL executes for a fake client too, so the grenade is
		// what the picture shows even though YaPB never pulls the trigger on it.
		if (get_user_weapon(id) != CSW_HEGRENADE)
			engclient_cmd(id, "weapon_hegrenade");

		// A flashbang next to the HE: two throwables make YaPB reach for one twice as often, and the pop
		// is the second kind of bang a viewer sees on a party.
		if (!user_has_weapon(id, CSW_FLASHBANG))
			give_item(id, "weapon_flashbang");
		cs_set_user_bpammo(id, CSW_FLASHBANG, HE_PARTY_GRENADES);
	}

	if (disarmed > 0)
		log_amx("he_party: %d bots disarmed to grenades", disarmed);
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
		// The party hands out a flashbang as well: it is a throwable, not a gun, and stripping it every
		// pass would be the churn the disarm loop exists to avoid.
		if (weapons[i] == CSW_FLASHBANG)
			continue;
		return true;
	}

	return false;
}

/* One blast of the party's own: the TE_EXPLOSION a viewer reads as an HE, the stock grenade bang, and
   `DMG_BLAST` on everybody inside the radius. Same shape as the fire_grenades spark, because the reason
   is the same: the bot never lets go of the grenade it is holding. */
stock HePartyBlast()
{
	new pivot = PickRandomBot();
	if (!pivot)
		return;

	new Float:center[3];
	pev(pivot, pev_origin, center);

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

	PlaySoundAt(center, SPARK_SOUND, CHAN_AUTO, PITCH_NORM);

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:where[3];
		pev(id, pev_origin, where);
		if (get_distance_f(center, where) > float(HE_BLAST_RADIUS))
			continue;

		ExecuteHamB(Ham_TakeDamage, id, 0, 0, float(HE_BLAST_DAMAGE), DMG_BLAST);
	}
}

/* Flips `yb_stab_close_enemies` with the field, once a second for the life of the server: twenty bots
   without a gun are a knife event, and the cvar is the only thing that makes them swing. */
stock StartMeleeWatch()
{
	if (task_exists(TASK_MELEE_WATCH))
		return;

	set_task(MELEE_WATCH_TICK, "TaskMeleeWatch", TASK_MELEE_WATCH, "", 0, "b");
	log_amx("melee watch: every %.1f s, flips yb_stab_close_enemies with the field", MELEE_WATCH_TICK);
}

public TaskMeleeWatch()
{
	new alive;
	new knives;

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		alive++;
		// A gun in the backpack counts: a bot holding a knife with a rifle behind it is not a knife event.
		if (!HasGun(id))
			knives++;
	}

	// Half the field on a knife and nothing else is a knife event; one disarmed bot is a bot that
	// picked up a box. The two flags keep it on for the whole of a knife event: a second between two
	// respawns can leave three armed bots on the field, and the rule must not blink off for it.
	new bool:want = (g_hePartyActive || g_knivesActive || (alive > 0 && knives * 2 >= alive));
	if (want == g_meleeMode)
		return;

	g_meleeMode = want;
	// Through the engine's command path, not `set_cvar_num`: a direct cvar write is invisible to YaPB,
	// which reads the value the engine last *executed* (measured - the cvar read back as 1 while the bots
	// kept standing still, and the same value sent as a console command had them stabbing within seconds).
	server_cmd("yb_stab_close_enemies %d", want ? 1 : 0);
	log_amx("melee: %d of %d bots on knives, yb_stab_close_enemies=%d", knives, alive, want ? 1 : 0);
}

/* ---------- respawn hooks ---------- */

/* csdm_lite re-arms every respawn with a random weapon, so without this a bot that respawns mid-duel
   would break the "knives only" rule on its first death. The short delay is what puts this after
   csdm_lite's own arming, which runs in the same respawn. The re-arm is a public task because
   set_task can only call a public, and the task id is the player id so `client_disconnected` can
   drop it with the same `remove_task(id)`. */
public OnPlayerSpawn(id)
{
	if (!g_duelActive && !g_outbreakActive && !g_classActive && !g_hexActive && !g_knivesActive && !g_heroActive)
		return;

	if (!is_user_connected(id) || !is_user_bot(id))
		return;

	// The infection is the reason this hook now fires on every respawn: csdm_lite hands the bot a rifle
	// half a second after it died, and an infected bot has to come back with a knife. A class bot has
	// the same problem on another axis: health, speed and gravity are per-spawn values. The hex is the
	// third case - csdm_lite gives the chicken a rifle and the server's own run speed back. Low gravity
	// knives is the fourth: a rifle on the field ends that event for the bot holding it.
	// The hero is the fifth and the one the stream complained about: a boss that comes back holding
	// csdm_lite's rifle is not the boss the viewer paid for. The launcher is the sixth and the same story
	// on another axis: the bazooka is a weapon now, so the respawn has to arm it again or the bot comes
	// back holding the rifle and the event has nothing to fire.
	if (g_duelActive || IsInfected(id) || IsClassed(id) || (g_hexActive && id == g_hexBot) || g_knivesActive || (g_heroActive && id == g_heroBot) || (g_bazookaActive && id == g_bazookaBot) || (g_cannonActive && id == g_cannonBot) || g_trainActive || g_oneBulletActive)
	{
		set_task(0.3, "ReArmOnSpawn", id);
		// And again before the moment csdm_lite re-arms the bot: its rifle arrives about half a second after
		// the death, so a single pass can be undone by the plugin that respawned it.
		set_task(REARM_LATE_DELAY, "ReArmOnSpawn", id + REARM_LATE);
	}
}

/* The engine's own spawn, which a bot goes through every time csdm_lite respawns it. Same scheduling as the
   HUD event above; the two together cover a client that resets its HUD late and one that does not. */
public OnSpawnHam(id)
{
	OnPlayerSpawn(id);
	return HAM_IGNORED;
}

public ReArmOnSpawn(id)
{
	// The late pass carries its own task id: a player id is 1..32 and these are 1..32 shifted, so the two
	// schedules cannot overwrite each other's countdown.
	if (id > REARM_LATE)
		id -= REARM_LATE;

	if (!IsBotAlive(id))
		return;
	// The hero's kit outranks everything below it: that bot was armed by the newest paid rule, and the
	// role (and its weapon) is what the viewer is watching. ArmHero re-locks the camera as well, which the
	// death released.
	if (g_heroActive && id == g_heroBot)
	{
		ArmHero(id);
		// Counted, like every other "cannot be seen in the log" fact: a hero that comes back with csdm_lite's
		// rifle and one that comes back with its own look the same in a kill line.
		log_amx("%s: bot %d re-armed after respawn", g_heroCode, id);
		return;
	}

	// The infection outranks everything below: an infected bot keeps its knife and its health even mid-duel,
	// and the claim layer decides whose numbers win when both events are running.
	if (g_outbreakActive && IsInfected(id))
	{
		ArmInfected(id);
		return;
	}

	// The class comes next: it is the field-wide rule of the running event.
	if (IsClassed(id))
	{
		ArmClass(id, false);
		return;
	}

	// A hexed bot keeps the costume and the speed, and loses the rifle csdm_lite just handed it.
	if (g_hexActive && id == g_hexBot)
	{
		ArmHexed(id, false);
		return;
	}

	// The cannon is a role like the hero: one bot with the M249, the health and the glow. A respawn puts
	// csdm_lite's random rifle and 100 HP in its place, and `g_cannonHealth` was snapshotted at the start
	// because by now the parameter table belongs to somebody else.
	if (g_cannonActive && id == g_cannonBot)
	{
		ArmGlassCannon(id);
		return;
	}

	// The launcher: the bazooka is a stock weapon with our model and our rocket on top, so the re-arm is
	// the same one the first spawn gets. csdm_lite's random rifle would otherwise be what the camera sees.
	if (g_bazookaActive && id == g_bazookaBot)
	{
		ArmBazooka(id);
		return;
	}

	// The ladder: the rung is per slot, so the bot comes back on the rung it earned instead of the bottom
	// one. `ClaimTake` answers whether the ladder still owns the weapon pool at all - a newer weapon event
	// takes it, and then re-arming would be two paid rules fighting over one bot.
	if (g_trainActive && ClaimTake(CLAIM_WEAPONS, FindEffect("guntrain"), 1))
	{
		new level = g_trainLevel[id];
		if (level < 0 || level >= g_trainCount)
			level = 0;

		StripWeapons(id);
		give_item(id, g_trainLadder[level]);
		give_item(id, "weapon_knife");
		return;
	}

	// `one_bullet` is an ammo rule, not a kit, and it holds for the whole clock: a bot that died and came
	// back gets the one round it would have had if it had stayed alive.
	if (g_oneBulletActive)
		OneBulletArm(id);

	if (g_duelActive)
		DuelArm(id);

	// The knife rule of the running physics event outranks the duel's: the newest paid rule wins.
	if (g_knivesActive)
		ArmKnives(id);
}

/* ---------- the kit lock: an event that armed a bot keeps that weapon ----------
   Three things break a paid weapon on a csdm_lite server, and they are one rule: csdm_lite hands the bot
   a random rifle on every respawn, the bot picks one off the floor, and the boxes the dead leave behind
   are there to be picked up. While an event owns a bot's kit, the weapon in its hands is the event's, a
   weaponbox cannot be taken, and the boxes are swept off the floor. A nemesis with an AWP is a nemesis
   the viewer will not read.
   `KitWeapon` is the only place that answers "what should this bot be holding": a new code that arms a bot
   adds one branch there and inherits the lock, the sweep and the pickup refusal. */
#define TASK_KIT_SWEEP 4829
#define KIT_SWEEP_TICK 0.5
new bool:g_kitSweep;
/* Counted like every other unseen fact: "the field obeyed" and "nobody noticed" look the same in a log. */
new g_kitRestored;
new g_kitSwept;

/* What the running events say this bot holds, if anything. */
stock bool:KitWeapon(id, out[], len)
{
	// The knife rules of the field: the duel and the physics event. The HE party is a grenade rule and
	// comes first: the kit lock hands the grenade back, not a knife, or a viewer reads a knife round.
	if (g_hePartyActive)
	{
		copy(out, len, "weapon_hegrenade");
		return true;
	}

	if (g_duelActive || g_knivesActive)
	{
		copy(out, len, "weapon_knife");
		return true;
	}

	if (g_heroActive && id == g_heroBot)
	{
		copy(out, len, g_heroWeapon);
		return true;
	}

	if (g_bazookaActive && id == g_bazookaBot)
	{
		copy(out, len, BAZOOKA_WEAPON);
		return true;
	}

	if (g_cannonActive && id == g_cannonBot)
	{
		copy(out, len, "weapon_m249");
		return true;
	}

	// The ladder is per slot and the rung is the weapon: a climber that picks up somebody else's rifle is
	// back at the bottom of the ladder in the viewer's eyes.
	if (g_trainActive)
	{
		new level = g_trainLevel[id];
		if (level < 0 || level >= g_trainCount)
			level = 0;

		copy(out, len, g_trainLadder[level]);
		return true;
	}

	out[0] = '^0';
	return false;
}

stock bool:IsKitLocked(id)
{
	new wanted[VALUE_LEN];
	return KitWeapon(id, wanted, charsmax(wanted));
}

/* Whether the bot's locked kit is exactly this weapon class. The AWP handlers ask this before letting a
   shot through: a bot on a locked kit may not fire anything else, and an AWP is the one weapon where
   waiting for the sweep costs a kill. */
stock bool:IsKitWeapon(id, const weapon[])
{
	new wanted[VALUE_LEN];
	if (!KitWeapon(id, wanted, charsmax(wanted)))
		return false;

	return equali(wanted, weapon) != 0;
}

/* Whether the bot is on a locked kit and holds something else right now. The damage hook asks this: a
   rifle csdm_lite handed out must not be able to kill while the half-second sweep counts down. */
stock bool:KitMismatch(id)
{
	new wanted[VALUE_LEN];
	if (!KitWeapon(id, wanted, charsmax(wanted)))
		return false;

	new wantId = get_weaponid(wanted);
	if (wantId <= 0)
		return false;

	return get_user_weapon(id) != wantId;
}

/* Puts the event's weapon back in the bot's hands. Called from the weapon-switch event (the engine's own
   signal that the bot now holds something else) and from the respawn hook. */
stock EnforceKit(id)
{
	new wanted[VALUE_LEN];
	if (!KitWeapon(id, wanted, charsmax(wanted)))
		return;

	StartKitSweep();

	new wantId = get_weaponid(wanted);
	if (wantId <= 0)
		return;

	if (get_user_weapon(id) == wantId)
		return;

	StripWeapons(id);
	// The HE party's kit is the grenade alone: a knife beside it is exactly what the event took away.
	if (wantId != CSW_HEGRENADE)
		give_item(id, "weapon_knife");
	if (wantId != CSW_KNIFE && wantId != CSW_HEGRENADE)
		give_item(id, wanted);
	engclient_cmd(id, wanted);

	g_kitRestored++;
	// The knife rules fire on every respawn of twenty bots, so they are counted instead of logged; a role
	// weapon is rare enough that the line is worth reading.
	if (wantId != CSW_KNIFE)
		log_amx("kit lock: bot %d back on %s", id, wanted);
}

stock StartKitSweep()
{
	if (g_kitSweep)
		return;

	g_kitSweep = true;
	set_task(KIT_SWEEP_TICK, "TaskKitSweep", TASK_KIT_SWEEP, "", 0, "b");
}

/* Sweeps the dropped weapons off the floor while any bot is on a locked kit, and stops itself the moment
   nobody is: twenty bots leave a box per death, and a box on the floor is a rifle one walk away from the
   event. */
public TaskKitSweep()
{
	new locked;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (IsBotAlive(id) && IsKitLocked(id))
			locked++;
	}

	if (!locked)
	{
		g_kitSweep = false;
		remove_task(TASK_KIT_SWEEP);
		log_amx("kit lock: over, %d weapon(s) put back, %d box(es) swept", g_kitRestored, g_kitSwept);
		g_kitRestored = 0;
		g_kitSwept = 0;
		return;
	}

	// The kit is enforced from here, not from the weapon-switch event: `CurWeapon` is a *client* event and
	// YaPB bots never send it - measured live on 2026-10-31, a `nemesis` with 13 500 HP killed with an AWP
	// forty seconds into its own knife round. A server-side pass over the locked bots is the only thing that
	// sees a rifle the engine handed out.
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (IsBotAlive(id) && IsKitLocked(id))
			EnforceKit(id);
	}

	// The list is walked with a cap: an entity removed inside `FindEntityByString` can hand the same slot
	// back, and an uncapped loop on a map full of boxes is a server stall.
	new ent = -1;
	new steps;
	while ((ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "weaponbox")) > 0 && steps < 64)
	{
		engfunc(EngFunc_RemoveEntity, ent);
		g_kitSwept++;
		steps++;
	}
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
	else if (equal(code, "airstrike") || equal(code, "quake"))
		// The air raid and the earthquake open on the stock thunder: S8 will give them a siren of their
		// own, and until then a paid physics event still has an opener the stream can hear.
		copy(sound, charsmax(sound), "ambience/thunder_clap.wav");
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

	// A hero mode holds a bot's health, its model and the camera; a full reset gives all three back, and
	// `amx_stcam unlock` is idempotent when nothing was held. The look is taken off here as well as in
	// EndHero, because a reset drops every task without running the effects' own undos.
	remove_task(TASK_HERO_GUARD);
	UndressHeroModel();
	g_heroActive = false;
	g_heroBot = 0;
	g_heroSavedHealth = 0;
	g_heroCode[0] = '^0';
	// The sniper's budget lives with the hero: a flag left on would spend rounds of an event nobody bought.
	g_sniperLeft = 0;
	g_sniperArmed = false;
	g_sniperShots = 0;
	g_sniperKills = 0;
	server_cmd("amx_stcam unlock");

	// The infection is a flag per bot, so a reset has to walk the slots or an infected bot comes back
	// as one on the next respawn without any event running.
	g_outbreakActive = false;
	g_outbreakCode[0] = '^0';
	for (new id = 0; id < MAX_SLOTS; id++)
		g_infected[id] = 0;
	g_heroNext = 0;

	// The classes write per-bot gravity and run speed and keep a flag per slot; a full reset drops both,
	// or the next map inherits a 0.58 gravity on slots the plugin no longer owns.
	remove_task(TASK_CLASS_REGEN);
	g_classActive = false;
	g_classBotCount = 0;
	g_classCode[0] = '^0';
	for (new id = 0; id < MAX_SLOTS; id++)
	{
		g_classPicked[id] = 0;
		g_classSavedHealth[id] = 0;
	}
	ResetBotGravity();

	// The skills: a dropped task with a live flag is a bot that stays a chicken on the next map, and
	// the costume and the render mode both survive death, so they are taken off here as well.
	remove_task(TASK_CHAIN);
	remove_task(TASK_BLINK);
	remove_task(TASK_ROULETTE);
	if (g_hexActive && g_hexBot > 0 && g_hexCostume && is_user_connected(g_hexBot))
		cs_reset_user_model(g_hexBot);
	g_hexActive = false;
	g_hexBot = 0;
	g_chainActive = false;
	g_blinkActive = false;
	g_blinkMoved = 0;
	g_blinkTried = 0;
	g_rouletteActive = false;
	g_rouletteFired = false;
	g_rouletteBot = 0;
	g_rouletteSavedHealth = 0;
	g_auraActive = false;

	// The burn is a per-slot countdown with its own task: dropped here, or a bot keeps losing 60 hp a
	// second on the next map with no event on the field to explain it.
	remove_task(TASK_FIRE_PARTY);
	remove_task(TASK_BURN);
	remove_task(TASK_FIRE_SPARK);
	g_fireActive = false;
	g_fireIgnited = 0;
	g_fireTicksApplied = 0;
	g_fireThrown = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
	{
		g_fireTicks[id] = 0;
		g_fireArmed[id] = false;
	}

	// The freeze is the same shape: a dropped task with a live flag is a bot that cannot move on the next
	// map with nothing on the field to thaw it, and a remembered grenade from the old map would fire at its
	// old origin.
	remove_task(TASK_FLASH_PARTY);
	remove_task(TASK_FLASH_SCAN);
	remove_task(TASK_THAW);
	remove_task(TASK_FLASH_SPARK);
	g_freezeActive = false;
	g_freezeBlasts = 0;
	g_freezeCaught = 0;
	g_flashCount = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
		g_freezeTicks[id] = 0;

	// The five chases: a dropped task with a live flag is a mark that follows a bot onto the next map, a hill
	// that keeps paying out, or a freeze on sight nobody can undo. ThawAll and the glow reset below cover the
	// two that write render state and FL_FROZEN; the numbers are dropped here.
	remove_task(TASK_HILL);
	remove_task(TASK_MARK);
	remove_task(TASK_MARK_GLOW);
	remove_task(TASK_DUEL);
	remove_task(TASK_STATUE);
	g_trainActive = false;
	g_trainPromotions = 0;
	g_trainWinner = 0;
	g_statueActive = false;
	g_statueFrozen = 0;
	g_markActive = false;
	g_markBot = 0;
	g_markRewards = 0;
	g_markReward[0] = '^0';
	g_hillActive = false;
	g_hillTaken = 0;
	g_duelBellActive = false;
	g_duels = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
	{
		g_trainLevel[id] = 0;
		g_trainTop[id] = 0;
		g_statueHeld[id] = 0;
		g_markGlow[id] = 0;
		g_hillDwell[id] = 0.0;
		g_hillBuffed[id] = 0;
	}

	// S6 physics: every one of these writes a cvar, a velocity or an entity, so a dropped task with a
	// live flag is a permanent moon-walk or a weapon box nobody removes. The claims were dropped by
	// CleanupActive before this call, and RestoreGravity already ran there.
	if (g_rainActive)
		EndWeaponRain();
	remove_task(TASK_AIRSTRIKE);
	remove_task(TASK_WEAPON_RAIN);
	remove_task(TASK_QUAKE);
	remove_task(TASK_FIRE_RING);
	remove_task(TASK_INVERT);
	remove_task(TASK_GRAVITY_KNIVES);
	g_airActive = false;
	g_airStrikes = 0;
	g_airLeft = 0;
	g_airBursts = 0;
	g_airHits = 0;
	g_quakeActive = false;
	g_quakeTicks = 0;
	g_quakeShoves = 0;
	g_ringActive = false;
	g_ringScorched = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
		g_ringBurnt[id] = 0;
	g_invertActive = false;
	g_invertFlips = 0;
	g_knivesActive = false;
	g_knivesGravity = 0;

	// S8 sound: a dropped countdown task with a live flag would keep printing numbers on the next map.
	remove_task(TASK_COUNTDOWN);
	g_countdownActive = false;
	g_countdownLeft = 0;
	g_quotesActive = false;
	g_sirenActive = false;
	g_musicSwapActive = false;

	// The launcher: its dress tick, its rockets in the air and the model field it rewrote are the event's. A
	// map change with the tick still running would leave a bot wearing a launcher model on the next map, and
	// a rocket entity would stay in the air forever.
	if (g_bazookaActive)
		EndBazookaDrop();
	remove_task(TASK_BAZOOKA_DRESS);
	EndBazookaRockets();

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
	// The kit lock's sweep: a dropped weapon on the next map is a box nobody sweeps, and its task would
	// walk the entity list for ever.
	remove_task(TASK_KIT_SWEEP);
	g_kitSweep = false;
	g_kitRestored = 0;
	g_kitSwept = 0;

	// The ammo rule of `one_bullet`: a flag left on would arm every respawn on the next map.
	g_oneBulletActive = false;
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
	// Read before the bot is armed: ArmGlassCannon hands the camera its lock, and the parameter table is
	// only this donation's inside this call.
	g_cannonSeconds = floatround(EffectSeconds(EVENT_SECONDS));
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

	// The camera follows the cannon, and follows it again after a death: the lock the role took went out
	// with the body it was taken for.
	LockCameraOn(id, g_cannonSeconds);

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

/* A weapon switch that is not the event's weapon. The engine tells us the bot now holds something else,
   and the answer is the same for every code that arms a bot: the kit goes back. `lightsaber_duel` keeps
   its own branch because its log line is what the live checks read. */
public OnCurWeapon(id)
{
	if (!is_user_alive(id))
		return;

	if (g_duelActive)
	{
		new weapon = read_data(2);
		if (weapon == CSW_KNIFE || weapon == 0)
			return;

		StripWeapons(id);
		give_item(id, "weapon_knife");
		engclient_cmd(id, "weapon_knife");
		log_amx("lightsaber_duel: weapon %d taken from bot %d", weapon, id);
		return;
	}

	EnforceKit(id);
}

/* `weaponbox` is a dropped weapon. While any event owns a bot's kit it is not picked up: HAM_SUPERCEDE
   leaves it on the ground untouched, and the sweep removes it a moment later. Players (the spectator
   camera) are not affected. */
public OnWeaponBoxTouch(ent, id)
{
	if (id <= 0 || id > get_maxplayers())
		return HAM_IGNORED;
	if (!is_user_bot(id) || !is_user_alive(id))
		return HAM_IGNORED;

	if (!IsKitLocked(id))
		return HAM_IGNORED;

	return HAM_SUPERCEDE;
}

/* One round in the clip, none in reserve: the first shot is the event, everything after it is a knife
   fight. The clock exists so the effect has the same length as the rest of the set. */
public EffectOneBullet()
{
	BeginEvent("one_bullet");

	g_oneBulletActive = true;

	new bots;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		OneBulletArm(id);
		bots++;
	}

	StartEffectTimer("one_bullet", EffectSeconds(EVENT_SECONDS));
	log_amx("one_bullet: %d bots down to one round", bots);
	DonorSay("ONE BULLET EACH");
}

/* One round in the clip and nothing in reserve, for one bot. A stock of its own because two paths apply the
   same rule: the handler for every bot alive when the money arrives, and the respawn for a bot csdm_lite
   arms again half a second after it died. */
stock OneBulletArm(id)
{
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

public EffectSniper()
{
	BeginEvent("sniper");

	// The budget is read before the hero is armed: ArmHero puts the role on the bot, and the rounds are a
	// part of the role - a bot that respawns gets a fresh five, exactly like a fresh magazine.
	g_sniperRounds = ParamInt("rounds", SNIPER_ROUNDS_DEFAULT);
	if (g_sniperRounds < 1)
		g_sniperRounds = SNIPER_ROUNDS_DEFAULT;
	if (g_sniperRounds > SNIPER_ROUNDS_MAX)
		g_sniperRounds = SNIPER_ROUNDS_MAX;

	if (!StartHero("sniper", SNIPER_WEAPON))
	{
		log_amx("sniper: no bots are connected");
		return;
	}

	StartEffectTimer("sniper", EffectSeconds(45.0));
	log_amx("sniper: bot %d, %d round(s), %d hp, camera locked", g_heroBot, g_sniperRounds, g_heroHealth);
	DonorSay("ONE BOT, ONE AWP, FIVE ROUNDS");
}

/* The launcher in the sniper's hands: the budget as clip ammo and an empty reserve. Two callers - the start
   of the event, and every respawn, because the role is a weapon and csdm_lite re-arms the slot after a
   death. */
stock SniperArm(id)
{
	if (!IsBotAlive(id))
		return;

	g_sniperLeft = g_sniperRounds;
	g_sniperArmed = true;
	SniperTopUp(id);
}

/* The clip follows the budget and the reserve stays empty. The reserve is the number that matters:
   csdm_lite tops it up once a second, so a budget kept only in the reserve would be a full AWP before the
   viewer saw the first reload. */
stock SniperTopUp(id)
{
	new weapon = FindWeaponEntity(id, SNIPER_WEAPON);
	if (weapon <= 0)
		return;

	cs_set_user_bpammo(id, CSW_AWP, 0);
	if (g_sniperLeft > 0)
		cs_set_weapon_ammo(weapon, g_sniperLeft);
}

/* The trigger of the AWP. The shot is the engine's business - the bolt cycle, the bang and the damage are
   what an AWP does; what the event adds is the budget. */
public OnSniperAttack(weapon)
{
	new owner = pev(weapon, pev_owner);
	if (owner > 0 && IsBotAlive(owner) && IsKitLocked(owner) && !IsKitWeapon(owner, SNIPER_WEAPON))
	{
		EnforceKit(owner);
		return HAM_SUPERCEDE;
	}

	if (!g_sniperArmed || !g_heroActive || !equali(g_heroCode, "sniper"))
		return HAM_IGNORED;

	if (pev(weapon, pev_owner) != g_heroBot)
		return HAM_IGNORED;

	g_sniperShots++;
	g_sniperLeft--;

	if (g_sniperLeft > 0)
	{
		SniperTopUp(g_heroBot);
		return HAM_IGNORED;
	}

	// Out of rounds: the launcher goes and the rest of the event is a knife fight. Taking the AWP away is
	// what makes the promise hold - left dry, csdm_lite would refill it inside a second.
	g_sniperArmed = false;
	StripWeapons(g_heroBot);
	give_item(g_heroBot, "weapon_knife");
	engclient_cmd(g_heroBot, "weapon_knife");
	Announce("THE SNIPER IS OUT OF ROUNDS");
	log_amx("sniper: %d shot(s) spent, the AWP is off the field", g_sniperShots);
	return HAM_IGNORED;
}

/* A kill buys a round back: five shots that have to count are the loop of the mode, and the count in the
   log is what says whether the trap worked. */
stock SniperReward()
{
	g_sniperKills++;

	if (!g_sniperArmed || g_sniperLeft >= g_sniperRounds)
		return;

	g_sniperLeft++;
	SniperTopUp(g_heroBot);
	Announce("A KILL BUYS A ROUND");
	log_amx("sniper: kill %d, %d round(s) left", g_sniperKills, g_sniperLeft);
}

/* The weapon entity a bot carries: `pev_owner` is the player, and the classname is the weapon class. */
stock FindWeaponEntity(id, const classname[])
{
	new ent = -1;
	while ((ent = engfunc(EngFunc_FindEntityByString, ent, "classname", classname)) > 0)
	{
		if (pev(ent, pev_owner) == id)
			return ent;
	}
	return 0;
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
	// A fixed code, not the plugin's dice. `amx_chaos force` without an argument picks one of six
	// effects, and two of them - `knives` (weight 25) and `awp` (20 of 140) - call RearmAll:
	// strip_user_weapons on every alive bot. The boss of this very wave carries a knife, so roughly a
	// third of the plagues ended by disarming their own boss a second after it started.
	// `juggernaut` composes instead: it only raises health, so the wave gets more of what it is.
	server_cmd("amx_chaos force juggernaut");

	StartEffectTimer("chaos_plague", EffectSeconds(60.0));
	DonorSay("CHAOS PLAGUE: EVERYTHING AT ONCE");
}

stock bool:StartHero(const code[], const weapon[])
{
	// A newer hero event replaces the running one: the older hero gives its health, its glow and the
	// camera back here, instead of leaving a 13 500 HP bot on the field until its own clock is ignored.
	if (g_heroActive)
		EndHero(g_heroCode);

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

	// The clock is read here, once: the guard task, the camera lock and the replay of the role on another
	// bot all need it long after the parameter table belongs to the next donation.
	g_heroSeconds = floatround(EffectSeconds(60.0));

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

	// Semi-transparent instead of a glow: `alpha` was the silhouette of the assassin mode, and the machinery
	// stays for the next hero that has to be hard to see without being invisible. No code sets it today, so
	// every hero on sale draws the red shell the viewer can follow - except the two that bring their own
	// body. A glow shell is drawn over the model, not around it: on the stream the nemesis and the survivor
	// came out as the same solid red silhouette, and the repaint in `infra/models/player/` could not be seen
	// at all, which reads as "the textures do not apply to the model". A mode with its own look is followed
	// by that look instead (and the camera is locked on the hero for the whole event anyway).
	if (g_heroAlpha > 0)
		set_user_rendering(id, kRenderFxNone, 0, 0, 0, kRenderTransAlpha, g_heroAlpha);
	else if (!HeroOwnLook())
		set_user_rendering(id, kRenderFxGlowShell, 255, 0, 0, kRenderNormal, 20);

	// The sniper's budget is a part of the role like the health: a hero that comes back from a death (or a
	// role that moves to another bot) carries a fresh five, or the event ends with its first kill.
	if (equali(g_heroCode, "sniper"))
		SniperArm(id);

	// The look comes after the weapons: cs_set_user_model rebuilds the player model around the weapon the
	// bot holds, so a model set before the kit arrives is a body the engine redraws with the wrong hand.
	DressHeroModel(id);
	LockCameraOn(id, g_heroSeconds);
}

/* Whether the hero of the running event brings its own body (`infra/models/player/`). Asked before
   `DressHeroModel` runs, so it cannot read `g_heroLookSet`: it is the same two questions that function
   asks - the mode is one of the two with a model, and the file was found and precached at start. A mode
   without a look keeps the red shell that makes it followable. */
stock bool:HeroOwnLook()
{
	if (equali(g_heroCode, "nemesis"))
		return g_nemesisLook;

	if (equali(g_heroCode, "survivor"))
		return g_survivorLook;

	return false;
}

/* Puts the hero's own look on the bot. ArmHero is the only way into the role - the event start, the role
   moving to another bot and every respawn all go through it - so the look survives a death for the same
   reason the health does. */
stock DressHeroModel(id)
{
	if (id <= 0 || !is_user_connected(id))
		return;

	if (equali(g_heroCode, "nemesis") && g_nemesisLook)
		cs_set_user_model(id, NEMESIS_MODEL, true);
	else if (equali(g_heroCode, "survivor") && g_survivorLook)
		cs_set_user_model(id, SURVIVOR_MODEL, true);
	else
		return;

	g_heroLookSet = true;
	log_amx("%s: bot %d wears the %s model", g_heroCode, id, g_heroCode);
}

/* Takes the hero's look off the bot that wears it. One stock for the three ways out - the effect's clock,
   a full reset, and the role moving to another bot - because a player model is render state on the slot:
   the bot that was the nemesis keeps the skin after it respawns, and resetting only the *new* hero leaves
   a second nemesis on the field for the rest of the map. */
stock UndressHeroModel()
{
	if (g_heroLookSet && g_heroBot > 0 && is_user_connected(g_heroBot))
		cs_reset_user_model(g_heroBot);

	g_heroLookSet = false;
}

/* Hands the camera to the bot an event landed on: the money bought that bot's shots, and the director
   follows whoever looks busiest (docs/activities/roadmap.md, stage 1).

   The target goes out as `#userid`, not as a nickname. `amx_stcam lock` resolves a name against the player
   list of the *other* plugin, and a name is not stable: a space arrives as an underscore, the donor tag
   renames the bot at the top of the board, and a bot whose own nick has an underscore never matches at all.
   The measured consequence on the stream was an event that ran, a lock in the log, and a picture that
   stayed on the director's bot: the camera "ignoring" a paid hero. The userid is one token that cannot be
   mangled. `seconds` is the event's own clock, so a lock whose undo never runs expires by itself instead of
   holding somebody else's hero off the screen. */
stock LockCameraOn(id, seconds)
{
	if (id <= 0 || !is_user_connected(id))
		return;

	if (seconds < 1)
		seconds = 1;

	new userid = get_user_userid(id);
	server_cmd("amx_stcam lock #%d %d", userid, seconds);

	new name[VALUE_LEN];
	get_user_name(id, name, charsmax(name));
	log_amx("camera lock: %s (#%d) for %d s", name, userid, seconds);
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

	// The dead bot loses the look before the role moves: `cs_set_user_model` is per slot and survives a
	// respawn, so a carrier that dies mid-event would come back wearing the nemesis skin with no event
	// left to take it off.
	UndressHeroModel();

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

	// A clock of a run a newer hero event already ended: the `g_hero*` state and the claim stack belong to
	// the hero on screen now, and an unlock here would cut the camera off that bot.
	if (!equali(g_heroCode, code))
	{
		log_amx("hero '%s' is not the running one, nothing to undo", code);
		return;
	}

	remove_task(TASK_HERO_GUARD);

	// The look goes with the role. A player model is render state on the slot and outlives a clock on its
	// own, and a bot that keeps the nemesis' skin after the event is the bug the costume rule exists for.
	// Only when this file set it: the reset lifts the model lock of anybody, and the hex_wave chicken on
	// the same slot must not be taken off by a hero's clock.
	UndressHeroModel();

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

	// The counts go out with the role: "five rounds spent, one kill" and "five rounds spent, five kills"
	// look the same on the kill feed, and only the log can say which trap the viewer watched.
	if (equal(code, "sniper"))
		log_amx("sniper ended: %d shot(s) spent, %d kill(s), %d round(s) left",
			g_sniperShots, g_sniperKills, g_sniperLeft);

	g_heroActive = false;
	g_heroBot = 0;
	g_heroSavedHealth = 0;
	g_heroCode[0] = '^0';
	g_sniperLeft = 0;
	g_sniperArmed = false;
	g_sniperShots = 0;
	g_sniperKills = 0;
}

/* ---------- outbreak: a knife kill converts the victim (S1) ---------- */

stock bool:StartOutbreak(const code[])
{
	// Same rule as the heroes and the classes: the newer infection ends the running one, so its flags,
	// its glow and its speed claim are given back here and not by a clock that no longer owns them.
	if (g_outbreakActive)
		EndOutbreak(g_outbreakCode);

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
	copy(g_outbreakCode, CODE_LEN - 1, code);

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

	// A clock of an infection a newer run already ended: the flags and the glow under them are the new
	// run's, and clearing them here would end the infection a viewer just paid for.
	if (!equali(g_outbreakCode, code))
	{
		log_amx("outbreak '%s' is not the running one, nothing to undo", code);
		return;
	}

	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (g_infected[id] && is_user_connected(id))
			ClearGlow(id);
		g_infected[id] = 0;
	}

	g_outbreakActive = false;
	g_outbreakCode[0] = '^0';

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

/* ---------- S2 classes: five presets, one applier (docs/activities/systems.md) ---------- */
/*
 * A class changes the field instead of picking a hero: N random bots - or everybody, when `count` is 0 -
 * get a health pool, a run speed multiplier, a gravity, a regeneration rate and a knockback. The five
 * catalogue codes differ in their numbers and not in their code, which is the point: five handlers with
 * the same body are five places for the same bug.
 */

public EffectRaptors()
{
	BeginEvent("raptors");

	if (!StartClass("raptors", 5, 3000, 1.2, 1.0, 0, 160))
	{
		log_amx("raptors: no bots are connected");
		return;
	}

	StartEffectTimer("raptors", EffectSeconds(45.0));
	DonorSay("FIVE RAPTORS: FAST AND THROWN FAR");
}

public EffectBrutes()
{
	BeginEvent("brutes");

	if (!StartClass("brutes", 4, 7000, 0.9, 1.0, 0, 55))
	{
		log_amx("brutes: no bots are connected");
		return;
	}

	StartEffectTimer("brutes", EffectSeconds(45.0));
	DonorSay("FOUR BRUTES: SLOW AND HARD TO PUSH");
}

public EffectRunners()
{
	BeginEvent("runners");

	if (!StartClass("runners", 0, 75, 1.15, 1.0, 0, 100))
	{
		log_amx("runners: no bots are connected");
		return;
	}

	StartEffectTimer("runners", EffectSeconds(45.0));
	DonorSay("EVERYBODY RUNS: 75 HP AND FASTER");
}

public EffectJumpers()
{
	BeginEvent("jumpers");

	if (!StartClass("jumpers", 0, 0, 1.0, 0.58, 0, 100))
	{
		log_amx("jumpers: no bots are connected");
		return;
	}

	StartEffectTimer("jumpers", EffectSeconds(30.0));
	DonorSay("LOW GRAVITY, EVERYBODY JUMPS");
}

public EffectRegenerators()
{
	BeginEvent("regenerators");

	if (!StartClass("regenerators", 4, 0, 1.0, 1.0, 35, 100))
	{
		log_amx("regenerators: no bots are connected");
		return;
	}

	StartEffectTimer("regenerators", EffectSeconds(45.0));
	DonorSay("FOUR REGENERATORS: 35 HP A SECOND");
}

/* The applier. The six arguments are the defaults of the preset that called it, and every one of them
   can be overridden by the command: the panel retunes a code without a recompile. `count` 0 means the
   whole field, which is what `runners` and `jumpers` sell. */
stock bool:StartClass(const code[], count, health, Float:speed, Float:gravity, regen, knockback)
{
	// A newer class event replaces the one that is still running: the older run is undone here, with its
	// claims released and its bots put back, instead of being left for its own clock to undo underneath
	// this one. A second donation of the same code is a re-roll and goes through the same path, or the
	// bots would keep the class health as the value to restore at the end.
	if (g_classActive)
		EndClass(g_classCode);

	new alive[MAX_SLOTS];
	new total;

	for (new id = 1; id <= get_maxplayers() && total < MAX_SLOTS - 1; id++)
	{
		if (IsBotAlive(id))
			alive[total++] = id;
	}

	if (total == 0)
		return false;

	g_classHealth = ParamInt("health", health);
	g_classRegen = ParamInt("regen", regen);

	g_classKnockback = ParamInt("knockback", knockback);
	if (g_classKnockback < 0)
		g_classKnockback = 0;
	if (g_classKnockback > 400)
		g_classKnockback = 400;

	g_classSpeed = ParamFloat("speed", speed);
	if (g_classSpeed < 0.1)
		g_classSpeed = 0.1;
	if (g_classSpeed > 4.0)
		g_classSpeed = 4.0;

	new Float:gravityValue = ParamFloat("gravity", gravity);
	if (gravityValue < 0.1)
		gravityValue = 0.1;
	if (gravityValue > 2.0)
		gravityValue = 2.0;
	g_classGravity = floatround(gravityValue * 100.0);

	// `count` above the size of the field is the field: a viewer who paid for five raptors on a server of
	// three bots gets three, and nobody gets the same bot twice.
	new wanted = ParamInt("count", count);
	if (wanted <= 0 || wanted > total)
		wanted = total;
	if (wanted > MAX_CLASS_BOTS)
		wanted = MAX_CLASS_BOTS;

	// A newer class event replaces the older one for the bots it picks: the flags of the previous run go
	// first, or a slot that is no longer picked keeps re-arming itself after every respawn.
	for (new id = 0; id < MAX_SLOTS; id++)
	{
		g_classPicked[id] = 0;
		g_classSavedHealth[id] = 0;
	}

	g_classActive = true;
	g_classBotCount = 0;
	// The run reports what its knockback did, because nothing else can: a push that lands a bot on the
	// floor and one that lands it off the map read the same in the log.
	g_classPushes = 0;
	g_classCappedPushes = 0;
	copy(g_classCode, CODE_LEN - 1, code);

	while (g_classBotCount < wanted)
	{
		new pick = alive[random(total)];
		if (pick <= 0 || g_classPicked[pick])
			continue;

		g_classPicked[pick] = 1;
		g_classBots[g_classBotCount++] = pick;
	}

	new owner = FindEffect(code);
	if (g_classHealth > 0)
		ClaimTake(CLAIM_HEALTH, owner, g_classHealth);

	if (g_classSpeed != 1.0)
	{
		ClaimTake(CLAIM_SPEED, owner, floatround(g_classSpeed * 100.0));
		// The shared "speed was touched" flag is what ResetBotSpeed reads on a full reset: a run speed is
		// a per-bot field here, and it survives both death and respawn.
		g_speedBoosted = true;
	}

	// Only a preset that actually changes gravity claims it; otherwise the claim would sit on top of a
	// value an effect that does own gravity never wrote.
	if (g_classGravity != 100)
		ClaimTake(CLAIM_GRAVITY, owner, g_classGravity);

	for (new i = 0; i < g_classBotCount; i++)
		ArmClass(g_classBots[i], true);

	remove_task(TASK_CLASS_REGEN);
	if (g_classRegen > 0)
		set_task(1.0, "TaskClassRegen", TASK_CLASS_REGEN, "", 0, "b");

	log_amx("%s: %d of %d bots, %d hp, x%.2f speed, %d%% gravity, %d hp/s, knockback %d",
		code, g_classBotCount, total, g_classHealth, g_classSpeed, g_classGravity, g_classRegen, g_classKnockback);
	return true;
}

stock bool:IsClassed(id)
{
	return g_classActive && id > 0 && id < MAX_SLOTS && g_classPicked[id] != 0;
}

/* Puts the class shape on one bot. `first` marks the moment the event starts: only then is the health
   the bot had before the buff worth keeping, because a re-arm after a respawn would record the class
   health as the value to put back. */
stock ArmClass(id, bool:first)
{
	if (id <= 0 || id >= MAX_SLOTS || !IsBotAlive(id))
		return;

	if (first)
	{
		g_classSavedHealth[id] = get_user_health(id);
		if (g_classSavedHealth[id] < 1)
			g_classSavedHealth[id] = 100;
	}

	if (g_classHealth > 0)
		set_user_health(id, g_classHealth);

	new Float:speed = get_cvar_float("sv_maxspeed");
	if (speed <= 0.0)
		speed = 320.0;
	set_user_maxspeed(id, speed * g_classSpeed);

	// A per-bot gravity, not `sv_gravity`: the field keeps its own physics and the cvar stays the
	// server's. `jumpers` is the only preset that changes it.
	set_user_gravity(id, float(g_classGravity) / 100.0);
}

/* Ends a class event. Only the effect that still owns a resource puts it back: another class event or a
   duel may have taken the same numbers since. */
stock EndClass(const code[])
{
	new owner = FindEffect(code);

	// A clock of a run a newer class event already ended: it owns nothing any more, and the flags, the
	// regeneration task and the saved health under `g_classPicked` now belong to the run on screen.
	if (!equali(g_classCode, code))
	{
		log_amx("class '%s' is not the running one, nothing to undo", code);
		return;
	}

	remove_task(TASK_CLASS_REGEN);

	// The releases happen once, outside the loop: ClaimRelease pops the entry, so a call per bot would
	// answer "not the owner" from the second slot on and leave the field shaped like a class.
	new bool:healthOwned = ClaimRelease(CLAIM_HEALTH, owner);
	new bool:speedOwned = ClaimRelease(CLAIM_SPEED, owner);
	new bool:gravityOwned = ClaimRelease(CLAIM_GRAVITY, owner);

	new Float:speed = get_cvar_float("sv_maxspeed");
	if (speed <= 0.0)
		speed = 320.0;

	for (new id = 0; id < MAX_SLOTS; id++)
	{
		if (!g_classPicked[id])
			continue;

		// Health is a spawn value: only a bot that is still alive can keep the pool it was given.
		if (healthOwned && g_classSavedHealth[id] > 0 && is_user_alive(id))
			set_user_health(id, g_classSavedHealth[id]);

		// Speed and gravity survive death, so they go back on every slot the event touched.
		if (is_user_connected(id))
		{
			if (speedOwned)
				set_user_maxspeed(id, speed);
			if (gravityOwned)
				set_user_gravity(id, 1.0);
		}

		g_classPicked[id] = 0;
		g_classSavedHealth[id] = 0;
	}

	g_classActive = false;
	g_classBotCount = 0;

	// Said at the end, not per hit: a fight logs this line once, and it is the only place where
	// "knockback 400" turns into "it moved 137 bots, 12 of them at the cap".
	if (g_classKnockback > 0)
		log_amx("class '%s' ended: %d knockback(s), %d at the cap", code, g_classPushes, g_classCappedPushes);

	// Cleared last on purpose: `code` can be this very array (StartClass hands its own code in), so a
	// line logged after the clear would print an empty name.
	g_classCode[0] = '^0';
}

/* Gravity is a per-bot field in this system and not the cvar, so a full reset walks the slots. */
stock ResetBotGravity()
{
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (is_user_connected(id))
			set_user_gravity(id, 1.0);
	}
}

/* Regeneration: HP a second for the picked bots, never above the class health - or REGEN_CEIL for a
   preset that has none. The rate is a snapshot: reading `regen=` here would heal the bots of whatever
   donation arrived last (docs/activities/systems.md, cross-cutting rule 2). */
public TaskClassRegen()
{
	if (!g_classActive || g_classRegen <= 0)
	{
		remove_task(TASK_CLASS_REGEN);
		return;
	}

	new ceiling = g_classHealth > 0 ? g_classHealth : REGEN_CEIL;

	for (new i = 0; i < g_classBotCount; i++)
	{
		new id = g_classBots[i];
		if (id <= 0 || !IsBotAlive(id))
			continue;

		new health = get_user_health(id) + g_classRegen;
		if (health > ceiling)
			health = ceiling;
		set_user_health(id, health);
	}
}

/* ---------- S4 skills: the handlers ---------- */

/* HEX WAVE. One bot stops being a soldier. The costume is the joke, so it is applied only when the model
   is in the image; without it the hex still strips the bot, slows it to 60 % and glows it yellow, which
   is what the viewer sees instead of a chicken. */
public EffectHexWave()
{
	BeginEvent("hex_wave");

	ParamCopy("model", g_hexModel, charsmax(g_hexModel), "chicken");

	new bot = PickRandomBot();
	if (!bot)
	{
		log_amx("hex_wave: no bots are alive");
		return;
	}

	g_hexActive = true;
	g_hexBot = bot;
	g_hexSeconds = floatround(EffectSeconds(20.0));

	new owner = FindEffect("hex_wave");
	ClaimTake(CLAIM_SPEED, owner, floatround(HEX_SPEED * 100.0));
	ClaimTake(CLAIM_GLOW, owner, 1);
	ClaimTake(CLAIM_WEAPONS, owner, 1);

	// The shared "speed was touched" flag is what a full reset reads: a hexed bot that keeps 192 u/s
	// after `amx_de clear` is the same bug the classes had before they took the claim.
	g_speedBoosted = true;

	ArmHexed(bot, true);

	new name[NICK_LEN];
	get_user_name(bot, name, charsmax(name));
	Announce("%s IS THE %s", name, g_hexModel);

	StartEffectTimer("hex_wave", EffectSeconds(20.0));
	DonorSay("THE HEX IS LOOSED");
}

stock ArmHexed(id, bool:first)
{
	if (g_hexCostume)
		cs_set_user_model(id, g_hexModel);

	StripWeapons(id);
	set_user_maxspeed(id, HexSpeed());
	set_user_rendering(id, kRenderFxGlowShell, 255, 255, 0, kRenderNormal, 18);

	// The chicken is the joke, and a joke off camera is a line in the log: the lock follows the bot the
	// event landed on, and follows it again after a respawn.
	LockCameraOn(id, g_hexSeconds);

	if (first)
	{
		log_amx("hex_wave: bot %d is '%s' (%s), x%.2f speed", id, g_hexModel,
			g_hexCostume ? "model in the image" : "no model in the image, glow only", HEX_SPEED);
	}
}

stock Float:HexSpeed()
{
	new Float:speed = get_cvar_float("sv_maxspeed");
	if (speed <= 0.0)
		speed = 320.0;

	return speed * HEX_SPEED;
}

stock EndHexWave()
{
	new owner = FindEffect("hex_wave");
	new bool:speedOwned = ClaimRelease(CLAIM_SPEED, owner);
	new bool:glowOwned = ClaimRelease(CLAIM_GLOW, owner);
	ClaimRelease(CLAIM_WEAPONS, owner);

	if (g_hexBot > 0 && is_user_connected(g_hexBot))
	{
		// The costume is render-side state and survives death, so it comes off a slot that is not alive
		// too. Health is not touched by this code, and the weapons are handed back by csdm_lite on the
		// next respawn: re-arming a corpse would only fight the engine.
		if (g_hexCostume)
			cs_reset_user_model(g_hexBot);

		if (speedOwned)
		{
			new Float:speed = get_cvar_float("sv_maxspeed");
			if (speed <= 0.0)
				speed = 320.0;
			set_user_maxspeed(g_hexBot, speed);
		}

		if (glowOwned)
			ClearGlow(g_hexBot);
	}

	g_hexActive = false;
	g_hexBot = 0;
}

/* CHAIN LIGHTNING. A bolt every `period` hops through `targets` bots from a random start, drawn between
   the bots it actually damages. The damage goes through Ham_TakeDamage with the start bot as the
   attacker, so the kill feed and every other rule on the server stay in force. */
public EffectChainLightning()
{
	BeginEvent("chain_lightning");

	g_chainTargets = ParamInt("targets", 3);
	if (g_chainTargets < 1)
		g_chainTargets = 1;
	if (g_chainTargets > 5)
		g_chainTargets = 5;

	g_chainDamage = ParamInt("damage", 40);
	if (g_chainDamage < 1)
		g_chainDamage = 1;

	new Float:period = ParamFloat("period", 3.0);
	if (period < 1.0)
		period = 1.0;

	if (!PickRandomBot())
	{
		log_amx("chain_lightning: no bots are alive");
		return;
	}

	g_chainActive = true;
	g_chainBolts = 0;
	g_chainHits = 0;

	ClaimTake(CLAIM_HEALTH, FindEffect("chain_lightning"), 1);
	set_task(period, "TaskChainBolt", TASK_CHAIN, "", 0, "b");
	StartEffectTimer("chain_lightning", EffectSeconds(20.0));
	log_amx("chain_lightning: %d bots a bolt, %d damage, every %.1f s", g_chainTargets, g_chainDamage, period);
	DonorSay("LOOK UP");
}

public TaskChainBolt()
{
	if (!g_chainActive)
	{
		remove_task(TASK_CHAIN);
		return;
	}

	ChainBolt();
}

stock ChainBolt()
{
	new from = PickRandomBot();
	if (!from)
		return;

	new hit[MAX_SLOTS];
	hit[from] = 1;

	new current = from;
	new Float:origin[3];
	pev(current, pev_origin, origin);
	origin[2] += 36.0;
	g_chainBolts++;

	for (new step = 0; step < g_chainTargets; step++)
	{
		new next = FindNearestUnhit(current, hit);
		if (!next)
			break;

		hit[next] = 1;

		new Float:where[3];
		pev(next, pev_origin, where);
		where[2] += 36.0;
		DrawBeam(origin, where);

		ExecuteHamB(Ham_TakeDamage, next, from, from, float(g_chainDamage), DMG_SHOCK);
		g_chainHits++;

		origin[0] = where[0];
		origin[1] = where[1];
		origin[2] = where[2];
		current = next;
	}
}

/* The same walk as FindNearestBot, but a bot this bolt already hit is not a candidate: a chain that
   returns to its own source is two bots and one beam. */
stock FindNearestUnhit(id, hit[])
{
	new Float:origin[3];
	new Float:candidate[3];
	pev(id, pev_origin, origin);

	new best;
	new Float:bestDistance = 99999.0;

	for (new other = 1; other <= get_maxplayers(); other++)
	{
		if (other == id || hit[other] || !IsBotAlive(other))
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

/* TE_BEAMPOINTS with the stock laser sprite, precached in plugin_precache(). A zero index means the
   sprite is missing and the bolt would be invisible, so it is skipped instead of drawn as nothing.
   The colour is a parameter because one helper draws three things: the chain lightning bolt (blue), the
   rocket's own trail (orange) and the shockwave ring of an explosion. */
stock DrawBeamColour(const Float:start[3], const Float:end[3], red, green, blue, life = 8, width = 8)
{
	if (!g_beamSprite)
		return;

	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_BEAMPOINTS);
	write_coord(floatround(start[0]));
	write_coord(floatround(start[1]));
	write_coord(floatround(start[2]));
	write_coord(floatround(end[0]));
	write_coord(floatround(end[1]));
	write_coord(floatround(end[2]));
	write_short(g_beamSprite);
	write_byte(0);
	write_byte(0);
	write_byte(life);
	write_byte(width);
	write_byte(0);
	write_byte(red);
	write_byte(green);
	write_byte(blue);
	write_byte(200);
	write_byte(0);
	message_end();
}

stock DrawBeam(const Float:start[3], const Float:end[3])
{
	DrawBeamColour(start, end, 180, 220, 255);
}

/* ---------- sound anchors: entity 0 is the world origin, not "everywhere" ----------
   `emit_sound(0, ...)` emits from the world and ATTN_NORM then fades the sample with the distance from
   (0 0 0) - on a fight-yard map the grenade bang arrived quieter than a footstep, while the stream log
   showed it as played. A sound therefore comes from a small invisible entity parked where the thing
   happened. Four are created on first use and reused in a ring: removing an entity cuts its own sample, and
   one per bang would churn the entity list for the whole event. */
#define SOUND_ANCHORS 4
new g_soundAnchor[SOUND_ANCHORS];
new g_soundAnchorNext;

stock PlaySoundAt(const Float:origin[3], const sample[], channel = CHAN_AUTO, pitch = PITCH_NORM)
{
	new slot = g_soundAnchorNext;
	g_soundAnchorNext = (g_soundAnchorNext + 1) % SOUND_ANCHORS;

	new ent = g_soundAnchor[slot];
	if (ent <= 0)
	{
		// Created on first use: an entity made in plugin_init exists before the world has its own, and on
		// some builds that is an edict which never emits a sample.
		ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
		if (ent <= 0)
		{
			// No anchor: the world origin is wrong, but silence is worse than a quiet bang.
			emit_sound(0, channel, sample, VOL_NORM, ATTN_NORM, 0, pitch);
			return;
		}

		set_pev(ent, pev_solid, SOLID_NOT);
		set_pev(ent, pev_movetype, MOVETYPE_NONE);
		g_soundAnchor[slot] = ent;
	}

	// SetOrigin rather than `pev_origin`: the engine relinks the edict, and `emit_sound` reads the origin the
	// entity was linked at.
	engfunc(EngFunc_SetOrigin, ent, origin);
	emit_sound(ent, channel, sample, VOL_NORM, ATTN_NORM, 0, pitch);
}

/* The shockwave of an explosion: a ring of beams on the blast's own radius, so the viewer reads how far
   the damage reaches instead of guessing at it from the sprite. Built from `TE_BEAMPOINTS` - the one beam
   message this set already uses live - and not from `TE_BEAMCYLINDER`, whose byte layout has never been
   verified on this server: a temp entity with the wrong byte count desynchronises every client, which is
   a full server of disconnected players, not a cosmetic bug. */
#define SHOCKWAVE_SEGMENTS 12
#define SHOCKWAVE_LIFE 8
stock Shockwave(const Float:origin[3], Float:radius, red, green, blue)
{
	new Float:step = 360.0 / float(SHOCKWAVE_SEGMENTS);
	new Float:from[3], Float:to[3];
	new Float:angle;

	for (new i = 0; i < SHOCKWAVE_SEGMENTS; i++)
	{
		angle = step * float(i);
		from[0] = origin[0] + floatcos(angle, degrees) * radius;
		from[1] = origin[1] + floatsin(angle, degrees) * radius;
		from[2] = origin[2] + 8.0;

		angle += step;
		to[0] = origin[0] + floatcos(angle, degrees) * radius;
		to[1] = origin[1] + floatsin(angle, degrees) * radius;
		to[2] = from[2];

		DrawBeamColour(from, to, red, green, blue, SHOCKWAVE_LIFE, 10);
	}
}

/* The ice of the freeze: shard columns standing in the blast, pale blue and leaning inwards, plus the ring
   that says how far it reaches. Beams and not sprites - a sprite hung on an entity draws as a black square
   (docs/activities/assets.md) - and no new asset: the laser sprite is already precached. Without this the
   freeze reads as "the bots stopped", which is also what a stuck server looks like. */
#define ICE_SHARDS 6
stock IceShards(const Float:center[3], Float:radius)
{
	new Float:step = 360.0 / float(ICE_SHARDS);
	new Float:reach = radius * 0.45;

	for (new i = 0; i < ICE_SHARDS; i++)
	{
		new Float:angle = step * float(i) + 12.0;
		new Float:from[3], Float:to[3];

		from[0] = center[0] + floatcos(angle, degrees) * reach;
		from[1] = center[1] + floatsin(angle, degrees) * reach;
		from[2] = center[2] - 34.0;

		to[0] = center[0] + floatcos(angle, degrees) * (reach * 0.55);
		to[1] = center[1] + floatsin(angle, degrees) * (reach * 0.55);
		to[2] = center[2] + 30.0 + float(i) * 6.0;

		DrawBeamColour(from, to, 200, 240, 255, 12, 14);
	}
}

stock EndChainLightning()
{
	remove_task(TASK_CHAIN);

	// The health a bolt took comes back with the next spawn, so the release is the whole undo: it tells
	// the layer that the field's health is free again for whatever runs next.
	ClaimRelease(CLAIM_HEALTH, FindEffect("chain_lightning"));

	if (g_chainBolts > 0)
		log_amx("chain_lightning ended: %d bolt(s), %d bot(s) hit", g_chainBolts, g_chainHits);

	g_chainActive = false;
}

/* BLINK. Every bot jumps `distance` units the way it faces. The destination is traced first: a bot put
   inside geometry is stuck for the rest of the event, and the engine snaps a bad origin back anyway,
   which reads as "the skill does nothing" rather than as an error. */
public EffectBlinkBots()
{
	BeginEvent("blink_bots");

	g_blinkDistance = ParamFloat("distance", 200.0);
	if (g_blinkDistance < BLINK_MIN_DIST)
		g_blinkDistance = BLINK_MIN_DIST;
	if (g_blinkDistance > BLINK_MAX_DIST)
		g_blinkDistance = BLINK_MAX_DIST;

	new Float:period = ParamFloat("period", 4.0);
	if (period < 1.0)
		period = 1.0;

	if (!PickRandomBot())
	{
		log_amx("blink_bots: no bots are alive");
		return;
	}

	g_blinkActive = true;
	g_blinkMoved = 0;
	g_blinkTried = 0;

	set_task(period, "TaskBlink", TASK_BLINK, "", 0, "b");
	StartEffectTimer("blink_bots", EffectSeconds(20.0));
	log_amx("blink_bots: %.0f units every %.1f s", g_blinkDistance, period);
	DonorSay("KEEP YOUR EYES ON THE FLOOR");
}

public TaskBlink()
{
	if (!g_blinkActive)
	{
		remove_task(TASK_BLINK);
		return;
	}

	BlinkAll();
}

stock BlinkAll()
{
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		g_blinkTried++;
		if (BlinkBot(id))
			g_blinkMoved++;
	}
}

stock bool:BlinkBot(id)
{
	new Float:origin[3], Float:angles[3];
	pev(id, pev_origin, origin);
	pev(id, pev_v_angle, angles);

	new Float:start[3], Float:destination[3];
	start[0] = origin[0];
	start[1] = origin[1];
	start[2] = origin[2] + 24.0;
	destination[0] = start[0] + floatcos(angles[1], degrees) * g_blinkDistance;
	destination[1] = start[1] + floatsin(angles[1], degrees) * g_blinkDistance;
	destination[2] = start[2];

	new trace = create_tr2();
	engfunc(EngFunc_TraceLine, start, destination, IGNORE_MONSTERS, id, trace);

	new Float:fraction;
	get_tr2(trace, TR_flFraction, fraction);

	new Float:landing[3];
	get_tr2(trace, TR_vecEndPos, landing);
	free_tr2(trace);

	// Halfway is the least that reads as a teleport: stopping at the first wall would move the bot a few
	// units and look like nothing happened, which is the outcome the trace exists to avoid.
	if (fraction < 0.5)
		return false;

	landing[2] -= 24.0;

	// The feet need free space too: the trace stops on the face of a wall, but a brush edge or a
	// func_door can still leave the destination solid and the engine then snaps the bot back.
	if (engfunc(EngFunc_PointContents, landing) == CONTENTS_SOLID)
		return false;

	engfunc(EngFunc_SetOrigin, id, landing);

	// Keeping the old velocity would carry the bot back into the wall it just blinked past.
	new Float:still[3];
	set_pev(id, pev_velocity, still);
	return true;
}

stock EndBlinkBots()
{
	remove_task(TASK_BLINK);

	if (g_blinkTried > 0)
		log_amx("blink_bots ended: %d of %d blink(s) landed", g_blinkMoved, g_blinkTried);

	g_blinkActive = false;
	g_blinkMoved = 0;
	g_blinkTried = 0;
}

/* HERO ROULETTE. The power is chosen when the event starts and applied seconds later: the surprise is
   the product, and a chat line that reads "somebody is about to be invisible" turns the reveal into a
   reaction shot. The chosen power is written to the log and only there. */
public EffectHeroRoulette()
{
	BeginEvent("hero_roulette");

	g_roulettePower = RoulettePick(RoulettePool());
	if (g_roulettePower < 0)
	{
		log_amx("hero_roulette: the pool names no power");
		return;
	}

	new bot = PickRandomBot();
	if (!bot)
	{
		log_amx("hero_roulette: no bots are alive");
		return;
	}

	g_rouletteActive = true;
	g_rouletteFired = false;
	g_rouletteBot = bot;
	g_rouletteSavedHealth = 0;

	// The camera goes on the candidate when it is picked, not when the power fires: the reveal is the
	// product, and a cut ten seconds later shows the aftermath instead of the moment.
	LockCameraOn(bot, floatround(EffectSeconds(45.0)));

	new Float:delay = random_float(6.0, 12.0);
	set_task(delay, "TaskRoulette", TASK_ROULETTE);
	StartEffectTimer("hero_roulette", EffectSeconds(45.0));

	new power[16];
	RouletteName(g_roulettePower, power, charsmax(power));
	log_amx("hero_roulette: '%s' armed on bot %d, fires in %.1f s", power, bot, delay);
	DonorSay("SOMETHING IS COMING");
}

public TaskRoulette()
{
	if (!g_rouletteActive)
	{
		remove_task(TASK_ROULETTE);
		return;
	}

	RouletteFire();
}

stock RouletteFire()
{
	if (!IsBotAlive(g_rouletteBot))
	{
		g_rouletteBot = PickRandomBot();
		if (!g_rouletteBot)
			return;
	}

	g_rouletteFired = true;

	new owner = FindEffect("hero_roulette");
	ClaimTake(CLAIM_HEALTH, owner, 1);
	ClaimTake(CLAIM_SPEED, owner, 1);
	ClaimTake(CLAIM_GLOW, owner, 1);

	new name[NICK_LEN];
	get_user_name(g_rouletteBot, name, charsmax(name));

	switch (g_roulettePower)
	{
		case ROULETTE_INVISIBLE:
		{
			set_user_rendering(g_rouletteBot, kRenderFxNone, 0, 0, 0, kRenderTransAlpha, ROULETTE_ALPHA);
			Announce("%s HAS GONE INVISIBLE", name);
		}
		case ROULETTE_SPEED:
		{
			new Float:speed = get_cvar_float("sv_maxspeed");
			if (speed <= 0.0)
				speed = 320.0;
			set_user_maxspeed(g_rouletteBot, speed * ROULETTE_SPEED_MULT);
			g_speedBoosted = true;
			Announce("%s IS TWICE AS FAST", name);
		}
		case ROULETTE_HEALTH:
		{
			g_rouletteSavedHealth = get_user_health(g_rouletteBot);
			if (g_rouletteSavedHealth < 1)
				g_rouletteSavedHealth = 100;
			set_user_health(g_rouletteBot, ROULETTE_HEALTH_HP);
			Announce("%s NOW HAS %d HP", name, ROULETTE_HEALTH_HP);
		}
		case ROULETTE_DEAGLE:
		{
			give_item(g_rouletteBot, "weapon_deagle");
			cs_set_user_bpammo(g_rouletteBot, CSW_DEAGLE, 200);
			Announce("%s HAS AN ENDLESS DEAGLE", name);
		}
	}

	new power[16];
	RouletteName(g_roulettePower, power, charsmax(power));
	log_amx("hero_roulette: '%s' fired on bot %d", power, g_rouletteBot);
}

/* `pool` is a list of names, not an index: the catalogue can turn a power off without a recompile, and an
   unknown word is skipped instead of turning into a power nobody asked for. The list arrives as
   `power1=.. power4=..`, one token per name, because the engine splits an RCON line at commas - the
   comma-joined string this used to read only ever arrived as its first entry. */
stock RoulettePool()
{
	new mask;
	new key[KEY_LEN];
	new value[KEY_LEN];

	for (new i = 1; i <= ROULETTE_POWERS; i++)
	{
		format(key, charsmax(key), "power%d", i);
		if (!ParamCopy(key, value, charsmax(value), ""))
			continue;

		for (new power = 0; power < ROULETTE_POWERS; power++)
		{
			new name[16];
			RouletteName(power, name, charsmax(name));
			if (!equali(value, name))
				continue;
			mask |= (1 << power);
			break;
		}
	}

	// No list at all is "the whole pool": an event that pays for a random power and then names no power is a
	// donation that shows nothing.
	if (mask == 0)
	{
		log_amx("hero_roulette: no power list in the command, the whole pool is in");
		mask = (1 << ROULETTE_POWERS) - 1;
	}

	return mask;
}

stock RoulettePick(mask)
{
	new allowed[ROULETTE_POWERS];
	new count;

	for (new power = 0; power < ROULETTE_POWERS; power++)
	{
		if (mask & (1 << power))
			allowed[count++] = power;
	}

	if (count == 0)
		return -1;

	return allowed[random(count)];
}

/* The names live in a table, not in a `return "..."`: Pawn infers a function's return type from its first
   return statement, and an array literal has no size to infer. */
stock RouletteName(power, out[], len)
{
	new const names[ROULETTE_POWERS][] = {"invisible", "speed", "health", "deagle"};

	if (power >= 0 && power < ROULETTE_POWERS)
		copy(out, len, names[power]);
	else
		copy(out, len, "none");
}

stock EndHeroRoulette()
{
	remove_task(TASK_ROULETTE);

	new owner = FindEffect("hero_roulette");
	new bool:speedOwned = ClaimRelease(CLAIM_SPEED, owner);
	new bool:glowOwned = ClaimRelease(CLAIM_GLOW, owner);
	new bool:healthOwned = ClaimRelease(CLAIM_HEALTH, owner);

	if (g_rouletteBot > 0 && is_user_connected(g_rouletteBot))
	{
		if (speedOwned)
		{
			new Float:speed = get_cvar_float("sv_maxspeed");
			if (speed <= 0.0)
				speed = 320.0;
			set_user_maxspeed(g_rouletteBot, speed);
		}

		// ClearGlow drops the invisibility render mode too: an alpha of 60 that outlives its clock is a
		// bot the viewer cannot see for the rest of the map.
		if (glowOwned)
			ClearGlow(g_rouletteBot);

		// Health is a spawn value: only a bot that is still alive keeps the pool it was given.
		if (healthOwned && g_rouletteSavedHealth > 0 && is_user_alive(g_rouletteBot))
			set_user_health(g_rouletteBot, g_rouletteSavedHealth);
	}

	// A roulette whose timer never fired is a paid event with nothing in it, and the chat cannot tell
	// the difference from one that did: the log can.
	if (g_rouletteFired)
	{
		new power[16];
		RouletteName(g_roulettePower, power, charsmax(power));
		log_amx("hero_roulette ended: '%s' had been on the field", power);
	}
	else
	{
		log_amx("hero_roulette ended: the power never fired");
	}

	g_rouletteActive = false;
	g_rouletteFired = false;
	g_rouletteBot = 0;
	g_rouletteSavedHealth = 0;
}

/* VAMPIRIC AURA. A rule, not a state: the healing lives in OnTakeDamage and only its clock and its claim
   live here. The ceiling is the one the regeneration class uses - a 30 second aura without one turns the
   field into bots nobody can kill, which is not what "50 % of the damage" sells. */
public EffectVampiricAura()
{
	BeginEvent("vampiric_aura");

	g_auraShare = ParamInt("share", 50);
	if (g_auraShare < 1)
		g_auraShare = 1;
	if (g_auraShare > 100)
		g_auraShare = 100;

	if (!PickRandomBot())
	{
		log_amx("vampiric_aura: no bots are alive");
		return;
	}

	g_auraActive = true;
	ClaimTake(CLAIM_HEALTH, FindEffect("vampiric_aura"), 1);
	StartEffectTimer("vampiric_aura", EffectSeconds(30.0));
	log_amx("vampiric_aura: %d%% of the damage comes back as health, ceiling %d", g_auraShare, REGEN_CEIL);
	DonorSay("EVERY HIT FEEDS");
}

stock AuraHeal(attacker, Float:damage)
{
	if (attacker <= 0 || !IsBotAlive(attacker))
		return;

	new gain = floatround(damage * float(g_auraShare) / 100.0);
	if (gain < 1)
		return;

	new health = get_user_health(attacker) + gain;
	if (health > REGEN_CEIL)
		health = REGEN_CEIL;
	set_user_health(attacker, health);
}

stock EndVampiricAura()
{
	ClaimRelease(CLAIM_HEALTH, FindEffect("vampiric_aura"));
	g_auraActive = false;
}

/* FIRE GRENADES. The field keeps HE grenades in hand, and whatever a blast catches burns: `damage` a
   second for `burn` seconds, with an orange shell so the fire is visible from the chase camera. The
   trigger is the engine's own `DMG_BLAST` flag in the damage hook, not a grenade entity tracker - the
   engine already resolves the explosion, and a scan for `grenade` entities would be a second guess at
   the same fact with a frame of lag on it. */
public EffectFireGrenades()
{
	BeginEvent("fire_grenades");

	g_fireDamage = ParamInt("damage", 60);
	if (g_fireDamage < 1)
		g_fireDamage = 1;
	if (g_fireDamage > FIRE_MAX_DAMAGE)
		g_fireDamage = FIRE_MAX_DAMAGE;

	g_fireBurn = ParamInt("burn", 15);
	if (g_fireBurn < 1)
		g_fireBurn = 1;
	if (g_fireBurn > FIRE_MAX_BURN)
		g_fireBurn = FIRE_MAX_BURN;

	g_fireRadius = ParamInt("radius", SPARK_RADIUS_DEFAULT);
	if (g_fireRadius < 50)
		g_fireRadius = 50;
	if (g_fireRadius > SPARK_MAX_RADIUS)
		g_fireRadius = SPARK_MAX_RADIUS;

	if (!PickRandomBot())
	{
		log_amx("fire_grenades: no bots are alive");
		return;
	}

	g_fireActive = true;
	g_fireIgnited = 0;
	g_fireTicksApplied = 0;
	g_fireThrown = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
	{
		g_fireTicks[id] = 0;
		g_fireArmed[id] = false;
	}

	new owner = FindEffect("fire_grenades");
	ClaimTake(CLAIM_WEAPONS, owner, 1);
	ClaimTake(CLAIM_HEALTH, owner, 1);

	// Twice a second, like the HE party: the grenade is the trigger, so the field has to keep throwing
	// them, and a thrown grenade is gone from the inventory the moment it leaves the hand.
	set_task(0.5, "TaskFireParty", TASK_FIRE_PARTY, "", 0, "b");
	set_task(BURN_TICK, "TaskBurn", TASK_BURN, "", 0, "b");
	// The field's own blast: the grenade in a bot's hand is the premise, this is what makes the event happen
	// when the bot never lets go of it.
	set_task(SPARK_PERIOD, "TaskFireSpark", TASK_FIRE_SPARK, "", 0, "b");

	StartEffectTimer("fire_grenades", EffectSeconds(30.0));
	log_amx("fire_grenades: HE on the field, %d damage a tick for %d s, a blast every %.1f s in %d units",
		g_fireDamage, g_fireBurn, SPARK_PERIOD, g_fireRadius);
	DonorSay("EVERYTHING BURNS");
}

public TaskFireParty()
{
	if (!g_fireActive)
	{
		remove_task(TASK_FIRE_PARTY);
		return;
	}

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new ammo = cs_get_user_bpammo(id, CSW_HEGRENADE);

		if (!user_has_weapon(id, CSW_HEGRENADE))
			give_item(id, "weapon_hegrenade");

		// Armed on the previous pass and dry now: the bot threw it. The count is the only proof there
		// is that the field is really throwing and not just holding - see g_fireThrown.
		if (g_fireArmed[id] && ammo < 1)
			g_fireThrown++;
		g_fireArmed[id] = true;

		// The weapon alone is not enough: a thrown grenade stays in the inventory with an empty reserve,
		// so a bot handed one exactly once throws one grenade and then stands there for the rest of the
		// event. The reserve is refilled on every pass, which is what makes the field keep throwing
		// while the clock runs.
		cs_set_user_bpammo(id, CSW_HEGRENADE, FIRE_PARTY_GRENADES);
	}
}

/* One blast of the event's own, every SPARK_PERIOD, next to a bot the camera is already on. The damage is
   small and `DMG_BLAST` is the same label a thrown HE carries, so the burn comes from OnTakeDamage - the
   path that was measured with meteor_shower providing the blasts, not a second ignition of its own. */
public TaskFireSpark()
{
	if (!g_fireActive)
	{
		remove_task(TASK_FIRE_SPARK);
		return;
	}

	new pivot = PickRandomBot();
	if (!pivot)
		return;

	new Float:center[3];
	pev(pivot, pev_origin, center);

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

	// Emitted from the blast, not from the world: `emit_sound(0, ...)` plays at the map origin and the
	// distance from there fades the bang out, which is why a grenade the whole field could see went unheard.
	PlaySoundAt(center, SPARK_SOUND, CHAN_AUTO, PITCH_NORM);

	// Read from the snapshot, not from the parameter table: this runs from a timer, long after the command.
	new radius = g_fireRadius;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:where[3];
		pev(id, pev_origin, where);
		if (get_distance_f(center, where) > float(radius))
			continue;

		ExecuteHamB(Ham_TakeDamage, id, 0, 0, float(FIRE_SPARK_DAMAGE), DMG_BLAST);
	}
}

stock IgniteBot(id)
{
	if (id <= 0 || id >= MAX_SLOTS || !IsBotAlive(id))
		return;

	// Counted only on the first spark: a bot caught by a second grenade is the same burning bot, and a
	// count that double-counted would read as twice the field.
	if (g_fireTicks[id] == 0)
		g_fireIgnited++;

	g_fireTicks[id] = g_fireBurn;
	set_user_rendering(id, kRenderFxGlowShell, 255, 120, 0, kRenderNormal, 20);
}

public TaskBurn()
{
	if (!g_fireActive)
	{
		remove_task(TASK_BURN);
		return;
	}

	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (g_fireTicks[id] <= 0)
			continue;

		// A dead bot stops burning: the countdown belongs to the body that was on fire, not to the slot,
		// and csdm_lite hands that slot a fresh bot half a second later.
		if (!IsBotAlive(id))
		{
			g_fireTicks[id] = 0;
			continue;
		}

		ExecuteHamB(Ham_TakeDamage, id, 0, 0, float(g_fireDamage), DMG_BURN);
		g_fireTicks[id]--;
		g_fireTicksApplied++;

		if (g_fireTicks[id] == 0)
			ClearGlow(id);
	}
}

stock EndFireGrenades()
{
	remove_task(TASK_FIRE_PARTY);
	remove_task(TASK_BURN);
	remove_task(TASK_FIRE_SPARK);

	new owner = FindEffect("fire_grenades");
	ClaimRelease(CLAIM_WEAPONS, owner);
	ClaimRelease(CLAIM_HEALTH, owner);

	// Every burning bot stops burning: an event that ends while a bot is on fire leaves it losing health
	// with nothing on the field to explain why.
	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (g_fireTicks[id] > 0 && is_user_connected(id))
			ClearGlow(id);
		g_fireTicks[id] = 0;
	}

	// Always, not only on a hit: "nothing caught fire" is a result the operator has to be able to read, the
	// same reason `freeze_nades` reports its own count unconditionally. The throw count sits next to the
	// burns because the two answer different questions: whether the field threw, and whether it burned.
	log_amx("fire_grenades ended: %d bot(s) burned, %d tick(s) of fire, %d grenade(s) thrown",
		g_fireIgnited, g_fireTicksApplied, g_fireThrown);

	g_fireActive = false;
	g_fireIgnited = 0;
	g_fireTicksApplied = 0;
}

/* FREEZE GRENADES. The field keeps flashbangs in hand, and a flashbang that goes off freezes every bot
   inside `radius` for `freeze` seconds under a blue shell. There is no damage hook to lean on here - a
   flashbang never reaches OnTakeDamage - so the trigger is the grenade entity itself, scanned on a clock:
   see the TASK_FLASH_SCAN block above for why that is the only fact the engine leaves behind. */
public EffectFreezeNades()
{
	BeginEvent("freeze_nades");

	g_freezeSeconds = ParamInt("freeze", 6);
	if (g_freezeSeconds < 1)
		g_freezeSeconds = 1;
	if (g_freezeSeconds > FREEZE_MAX_SECONDS)
		g_freezeSeconds = FREEZE_MAX_SECONDS;

	new radius = ParamInt("radius", 300);
	if (radius < 50)
		radius = 50;
	if (radius > FREEZE_MAX_RADIUS)
		radius = FREEZE_MAX_RADIUS;
	g_freezeRadius = float(radius);

	if (!PickRandomBot())
	{
		log_amx("freeze_nades: no bots are alive");
		return;
	}

	g_freezeActive = true;
	g_freezeBlasts = 0;
	g_freezeCaught = 0;
	g_flashCount = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
		g_freezeTicks[id] = 0;

	new owner = FindEffect("freeze_nades");
	ClaimTake(CLAIM_FREEZE, owner, 1);
	ClaimTake(CLAIM_WEAPONS, owner, 1);

	// Half a second, like the HE party: a thrown flashbang leaves the inventory, so the field has to be
	// re-armed for a blast to be possible at all.
	set_task(0.5, "TaskFlashParty", TASK_FLASH_PARTY, "", 0, "b");
	set_task(FLASH_SCAN, "TaskFlashScan", TASK_FLASH_SCAN, "", 0, "b");
	set_task(THAW_TICK, "TaskThaw", TASK_THAW, "", 0, "b");
	// Same reason as the fire spark: the flashbang in a bot's hand is the premise, the pulse is the event.
	set_task(SPARK_PERIOD, "TaskFlashSpark", TASK_FLASH_SPARK, "", 0, "b");

	StartEffectTimer("freeze_nades", EffectSeconds(30.0));
	log_amx("freeze_nades: flashbangs on the field, %d s of freeze in %.0f units", g_freezeSeconds, g_freezeRadius);
	DonorSay("EVERYTHING FREEZES");
}

public TaskFlashParty()
{
	if (!g_freezeActive)
	{
		remove_task(TASK_FLASH_PARTY);
		return;
	}

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		if (!user_has_weapon(id, CSW_FLASHBANG))
			give_item(id, "weapon_flashbang");
	}
}

/* One pulse of the event's own, every SPARK_PERIOD, on a random bot. The bang is the flashbang's own sound
   played from that bot, because without a grenade in the picture the sound is what says "something went
   off"; the freeze itself is the same FlashBlast a real flashbang calls. */
public TaskFlashSpark()
{
	if (!g_freezeActive)
	{
		remove_task(TASK_FLASH_SPARK);
		return;
	}

	new pivot = PickRandomBot();
	if (!pivot)
		return;

	new Float:center[3];
	pev(pivot, pev_origin, center);

	// The bang is the freeze's own ice, played from the point of the blast: the event sells ice, not a flash,
	// and entity 0 would put the sample at the map origin where nobody stands (see PlaySoundAt). The pitch is
	// varied so four pulses in one run do not read as one sample on repeat.
	PlaySoundAt(center, g_freezeIce ? FREEZE_SOUND : FLASH_SOUND, CHAN_AUTO, 88 + random_num(0, 24));
	FlashBlast(center);
}

/* The trigger. Each pass does two things: it records what is in the air (entity index, origin, fuse), and it
   compares that with the previous pass. A remembered flashbang that is no longer there, with a fuse that has
   run out within this stride, is a detonation at the last origin it was seen at. */
public TaskFlashScan()
{
	if (!g_freezeActive)
	{
		remove_task(TASK_FLASH_SCAN);
		return;
	}

	new Float:now = get_gametime();

	new seenEnt[FLASH_MAX_TRACKED];
	new Float:seenOrigin[FLASH_MAX_TRACKED][3];
	new Float:seenFuse[FLASH_MAX_TRACKED];
	new seenCount;

	new ent;
	while (seenCount < FLASH_MAX_TRACKED && (ent = engfunc(EngFunc_FindEntityByString, ent, "classname", "grenade")) > 0)
	{
		if (!IsFlashGrenade(ent))
			continue;

		new Float:fuse = Float:pev(ent, pev_dmgtime);
		// Without a fuse the grenade is not armed yet; with a fuse in the future it is still in the air.
		if (fuse <= 0.0)
			continue;

		new Float:origin[3];
		pev(ent, pev_origin, origin);

		seenEnt[seenCount] = ent;
		seenOrigin[seenCount][0] = origin[0];
		seenOrigin[seenCount][1] = origin[1];
		seenOrigin[seenCount][2] = origin[2];
		seenFuse[seenCount] = fuse;
		seenCount++;
	}

	for (new i = 0; i < g_flashCount; i++)
	{
		if (FlashStillThere(i, seenEnt, seenFuse, seenCount))
			continue;

		// Gone at or within one stride of its own fuse: the entity left the world for some other reason (a
		// round restart, a map change, a plugin clearing grenades) if its fuse was still further out, and
		// freezing the field for that would be a lie.
		if (g_flashFuse[i] > now + FLASH_SCAN)
			continue;

		FlashBlast(g_flashOrigin[i]);
	}

	g_flashCount = seenCount;
	for (new i = 0; i < seenCount; i++)
	{
		g_flashEnt[i] = seenEnt[i];
		g_flashOrigin[i][0] = seenOrigin[i][0];
		g_flashOrigin[i][1] = seenOrigin[i][1];
		g_flashOrigin[i][2] = seenOrigin[i][2];
		g_flashFuse[i] = seenFuse[i];
	}
}

/* Same entity index *and* the same fuse. The index alone is not enough: the engine reuses the slot of a
   detonated grenade for the next one, and that one carries a fuse of its own. */
stock bool:FlashStillThere(index, const seenEnt[], const Float:seenFuse[], seenCount)
{
	for (new j = 0; j < seenCount; j++)
	{
		if (seenEnt[j] != g_flashEnt[index])
			continue;
		if (floatabs(seenFuse[j] - g_flashFuse[index]) > 0.1)
			continue;
		return true;
	}
	return false;
}

stock bool:IsFlashGrenade(ent)
{
	if (!pev_valid(ent))
		return false;

	new model[64];
	pev(ent, pev_model, model, charsmax(model));
	return containi(model, "flashbang") >= 0;
}

/* Everything inside `radius` of the blast stops moving for `freeze` seconds. The freeze is a resource: a
   newer event that owns it (red_light wants the whole field standing) is not touched here, the blast is
   dropped and the log says so. */
stock FlashBlast(const Float:center[3])
{
	new owner = FindEffect("freeze_nades");
	if (!ClaimTake(CLAIM_FREEZE, owner, 1))
	{
		log_amx("freeze_nades: the freeze belongs to a newer event, blast ignored");
		return;
	}

	new ticks = floatround(float(g_freezeSeconds) / THAW_TICK);
	if (ticks < 1)
		ticks = 1;

	new caught;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:where[3];
		pev(id, pev_origin, where);
		if (get_distance_f(center, where) > g_freezeRadius)
			continue;

		FreezeBot(id);
		// Re-armed, not stacked: two timeouts for one bot would thaw it on the first and leave the second
		// one to undo a freeze the bot no longer has.
		g_freezeTicks[id] = ticks;
		// Ice-white shell with a thin radius: the shell has to read as frost on the body, not as a red hero
		// glow, because the two are on screen at the same time in a chaos run.
		set_user_rendering(id, kRenderFxGlowShell, 170, 230, 255, kRenderNormal, 24);
		caught++;
	}

	g_freezeBlasts++;
	g_freezeCaught += caught;

	// The shockwave is the part that says "this far and no further": the freeze is invisible otherwise -
	// a bot that stops moving looks like a bot thinking. Ice blue, on the blast's own radius.
	Shockwave(center, g_freezeRadius, 120, 200, 255);
	// And the shards that make it ice instead of a smoke ring (IceShards).
	IceShards(center, g_freezeRadius);

	// And a white flash at the point of the bang, so the moment of the pulse is on screen even when the
	// bots it catches are off camera.
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_EXPLOSION);
	write_coord(floatround(center[0]));
	write_coord(floatround(center[1]));
	write_coord(floatround(center[2]));
	write_short(g_meteorSprite);
	write_byte(20);
	write_byte(18);
	write_byte(0);
	message_end();

	log_amx("freeze_nades: blast at %.0f %.0f %.0f froze %d bot(s)", center[0], center[1], center[2], caught);
}

/* The countdown. Every pass it also asks the claim layer who owns the freeze: if a newer event took the
   resource, the countdown stops thawing - the bots standing still are that event's rule, not this one's. */
public TaskThaw()
{
	if (!g_freezeActive)
	{
		remove_task(TASK_THAW);
		return;
	}

	new owner = FindEffect("freeze_nades");
	new bool:owns = ClaimTake(CLAIM_FREEZE, owner, 1);

	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (g_freezeTicks[id] <= 0)
			continue;

		// A dead bot stops being frozen: the countdown belongs to the body that stood in the blast, and
		// csdm_lite hands the slot a fresh bot half a second later.
		if (!IsBotAlive(id))
		{
			g_freezeTicks[id] = 0;
			continue;
		}

		g_freezeTicks[id]--;
		if (g_freezeTicks[id] > 0)
			continue;

		ClearGlow(id);
		if (owns)
			ThawBot(id);
	}
}

stock EndFreezeNades()
{
	remove_task(TASK_FLASH_PARTY);
	remove_task(TASK_FLASH_SCAN);
	remove_task(TASK_THAW);
	remove_task(TASK_FLASH_SPARK);

	new owner = FindEffect("freeze_nades");
	ClaimRelease(CLAIM_WEAPONS, owner);
	g_flashCount = 0;

	// The bots go back to moving only if this event still owns the freeze. A newer event that took the
	// resource thaws its own bots on its own clock; thawing them here would end somebody else's rule.
	new bool:top = ClaimRelease(CLAIM_FREEZE, owner);
	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (g_freezeTicks[id] > 0 && is_user_connected(id))
		{
			ClearGlow(id);
			if (top)
				ThawBot(id);
		}
		g_freezeTicks[id] = 0;
	}

	// Always, not only on a hit: "no blast was ever seen" is the measurement this half of the item needs,
	// because YaPB holds a flashbang exactly the way it holds an HE.
	log_amx("freeze_nades ended: %d blast(s) seen, %d bot(s) frozen", g_freezeBlasts, g_freezeCaught);

	g_freezeActive = false;
	g_freezeBlasts = 0;
	g_freezeCaught = 0;
}

/* BAZOOKA DROP. One bot, one launcher, the camera on it - and the launcher is a weapon the bot fires: see
   the note above TASK_BAZOOKA_DRESS for what "a weapon" means here and why an entity of our own is not it.
   The clock is the catalogue's 30 s, and the role moves to another bot when the carrier dies, so one
   purchase keeps a launcher on screen for the whole run. */
public EffectBazookaDrop()
{
	BeginEvent("bazooka_drop");

	if (!g_bazookaModel || !g_bazookaModelString)
	{
		log_amx("bazooka_drop: %s is not in the image, nothing to carry", BAZOOKA_MODEL);
		return;
	}

	new bot = PickRandomBot();
	if (!bot)
	{
		log_amx("bazooka_drop: no bots are alive");
		return;
	}

	// A newer run takes the field from the older one: the rockets in the air are cleared, the clock is
	// replaced below, and the older run's own clock ends it without touching the new carrier.
	EndBazookaRockets();

	// The numbers are the command's, read once: the rockets fly long after the parameter table belongs to
	// somebody else.
	g_rocketDamage = ParamInt("damage", BAZOOKA_DAMAGE_DEFAULT);
	if (g_rocketDamage < 1)
		g_rocketDamage = BAZOOKA_DAMAGE_DEFAULT;
	g_rocketRadius = ParamInt("radius", BAZOOKA_RADIUS_DEFAULT);
	if (g_rocketRadius < 1)
		g_rocketRadius = BAZOOKA_RADIUS_DEFAULT;
	if (g_rocketRadius > BAZOOKA_RADIUS_MAX)
		g_rocketRadius = BAZOOKA_RADIUS_MAX;

	g_bazookaActive = true;
	g_bazookaBot = bot;
	g_rocketFired = 0;
	g_rocketBlasts = 0;
	g_rocketHits = 0;

	ArmBazooka(bot);
	// One repeating task for the whole run: a resubmitted `set_task` on the same id is silently dropped by
	// some AMXX builds, so the dress tick is started once and only removed by the undo.
	remove_task(TASK_BAZOOKA_DRESS);
	set_task(BAZOOKA_DRESS_TICK, "TaskBazookaDress", TASK_BAZOOKA_DRESS, "", 0, "b");

	// The weapon pool and the camera are both taken. A field-wide rule that arrives later (the HE party's
	// disarm) keeps the bots it disarms: the dress tick only re-arms the carrier while this event still
	// owns the pool, which is the same rule every other event follows.
	new owner = FindEffect("bazooka_drop");
	ClaimTake(CLAIM_WEAPONS, owner, 1);
	ClaimTake(CLAIM_CAMERA, owner, 1);
	// The event's own clock, so the lock expires with the run even if the undo never fires.
	LockCameraOn(bot, floatround(EffectSeconds(30.0)));

	StartEffectTimer("bazooka_drop", EffectSeconds(30.0));
	log_amx("bazooka_drop: %s on bot %d, %d damage in %d units", BAZOOKA_WEAPON, bot, g_rocketDamage, g_rocketRadius);
	DonorSay("BAZOOKA ON THE FIELD");
}

/* The launcher's mechanics: the engine's own AWP, so the bot aims it and pulls the trigger by itself, plus
   enough spare rounds that a 30 second run cannot go dry in the middle. The model in the hand and the
   rocket on the trigger are this file's, not the weapon's - see the note above TASK_BAZOOKA_DRESS. */
stock ArmBazooka(id)
{
	if (!IsBotAlive(id))
		return;

	StripWeapons(id);
	give_item(id, "weapon_knife");
	give_item(id, BAZOOKA_WEAPON);
	cs_set_user_bpammo(id, CSW_AWP, 90);

	DressBazooka(id);
}

/* The in-hand model is the player's `weaponmodel` field, and the game rewrites it on every weapon switch and
   every spawn. Writing it here, and again every BAZOOKA_DRESS_TICK, is what makes the bot *hold* the
   launcher instead of wearing a prop that floats next to it. */
stock DressBazooka(id)
{
	if (!g_bazookaModelString || !IsBotAlive(id))
		return;

	set_pev(id, pev_weaponmodel, g_bazookaModelString);
}

public TaskBazookaDress()
{
	if (!g_bazookaActive)
	{
		remove_task(TASK_BAZOOKA_DRESS);
		return;
	}

	// The role moves to a living bot: a launcher on a corpse is a weapon nobody paid for. The new carrier is
	// armed here as well, because csdm_lite hands a respawned bot a random rifle.
	if (!IsBotAlive(g_bazookaBot))
	{
		new next = PickRandomBot();
		if (!next)
			return;

		log_amx("bazooka_drop: bot %d is gone, the launcher moves to %d", g_bazookaBot, next);
		g_bazookaBot = next;
		ArmBazooka(next);
		return;
	}

	// A field-wide weapon rule that arrived later owns the pool: re-arming under it would put two paid
	// events on screen fighting over one bot, and the newer one wins by design.
	if (!ClaimTake(CLAIM_WEAPONS, FindEffect("bazooka_drop"), 1))
		return;

	if (!user_has_weapon(g_bazookaBot, CSW_AWP))
	{
		// csdm_lite re-armed the slot, or the bot threw the launcher away for a pickup.
		ArmBazooka(g_bazookaBot);
		return;
	}

	// The launcher in hand and nothing else: a bot that reached for its knife keeps the knife.
	if (get_user_weapon(g_bazookaBot) == CSW_AWP)
		DressBazooka(g_bazookaBot);
}

/* The trigger. Registered on the one weapon the carrier is armed with, so the whole check is "is this the
   carrier": YaPB presses the button through the engine, the engine calls the weapon's PrimaryAttack, and
   that is this hook. The attack itself is left alone - the bolt cycle, the sound and the ammo are what give
   the launcher its rhythm; only the bullet it fires is dropped, in OnTraceAttack. */
public OnBazookaAttack(weapon)
{
	new id = pev(weapon, pev_owner);
	if (id <= 0 || !IsBotAlive(id))
		return HAM_IGNORED;

	// Any bot on a locked kit cannot fire a weapon that is not its kit. An AWP is the one that matters:
	// one shot from a nemesis with an AWP is a whole kill, and the half-second sweep would be half a second
	// too late for it.
	if (IsKitLocked(id) && !IsKitWeapon(id, BAZOOKA_WEAPON))
	{
		EnforceKit(id);
		return HAM_SUPERCEDE;
	}

	if (!g_bazookaActive || id != g_bazookaBot)
		return HAM_IGNORED;

	LaunchRocket(id);
	return HAM_IGNORED;
}

/* A rocket in the air: an `info_target` wearing the explosion sprite, additively blended, so it reads as a
   fireball without a projectile model of its own. It flies along the bot's view and explodes on the first
   thing its path meets. */
stock LaunchRocket(id)
{
	new slot = FreeRocketSlot();
	if (slot < 0)
		return;

	new Float:view[3], Float:origin[3], Float:direction[3];
	pev(id, pev_v_angle, view);
	pev(id, pev_origin, origin);
	angle_vector(view, ANGLEVECTOR_FORWARD, direction);

	// From the muzzle, not from the body: a rocket spawned inside the bot traces its own carrier first, and
	// the blast lands on the bot that fired it.
	origin[0] += direction[0] * 32.0;
	origin[1] += direction[1] * 32.0;
	origin[2] += direction[2] * 32.0 + 8.0;

	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "info_target"));
	if (ent <= 0)
	{
		log_amx("bazooka_drop: the engine refused the rocket entity");
		return;
	}

	// No model on the entity: it is the collider, and the rocket on screen is drawn from temp entities below.
	// It carried `sprites/zerogxplode.spr` first, and on the stream that sprite's first frame is a black
	// square - an entity does not animate a sprite unless the frame is driven, and the frame was left at 0.
	set_pev(ent, pev_solid, SOLID_NOT);
	set_pev(ent, pev_movetype, MOVETYPE_FLY);
	engfunc(EngFunc_SetOrigin, ent, origin);

	// The launch itself: a flash at the muzzle, so the shot is visible from the frame the trigger is
	// pressed and not from the moment the rocket is far enough away to be seen again.
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_EXPLOSION);
	write_coord(floatround(origin[0]));
	write_coord(floatround(origin[1]));
	write_coord(floatround(origin[2]));
	write_short(g_meteorSprite);
	write_byte(12);
	write_byte(20);
	write_byte(0);
	message_end();

	// And a beam along the launch direction: the muzzle streak of a rocket leaving the tube.
	new Float:ahead[3];
	ahead[0] = origin[0] + direction[0] * 96.0;
	ahead[1] = origin[1] + direction[1] * 96.0;
	ahead[2] = origin[2] + direction[2] * 96.0;
	DrawBeamColour(origin, ahead, 255, 190, 90, 4, 18);

	g_rocketEnt[slot] = ent;
	g_rocketVelocity[slot][0] = direction[0] * BAZOOKA_SPEED;
	g_rocketVelocity[slot][1] = direction[1] * BAZOOKA_SPEED;
	g_rocketVelocity[slot][2] = direction[2] * BAZOOKA_SPEED;
	g_rocketOwner[slot] = id;
	g_rocketTicks[slot] = BAZOOKA_TICKS;
	g_rocketFired++;

	// The tick runs only while a rocket is in the air: a timer alive for the whole event would spin on an
	// empty list twenty times a second for thirty seconds.
	if (!g_rocketTick)
	{
		g_rocketTick = true;
		set_task(BAZOOKA_ROCKET_TICK, "TaskBazookaRocket", TASK_BAZOOKA_ROCKET, "", 0, "b");
	}
}

stock FreeRocketSlot()
{
	for (new slot = 0; slot < MAX_ROCKETS; slot++)
	{
		if (g_rocketEnt[slot] <= 0)
			return slot;
	}
	return -1;
}

public TaskBazookaRocket()
{
	new left;

	for (new slot = 0; slot < MAX_ROCKETS; slot++)
	{
		if (g_rocketEnt[slot] <= 0)
			continue;

		if (!StepRocket(slot))
			left++;
	}

	if (left > 0)
		return;

	// Nothing in the air: the tick stops here, and the next shot starts it again.
	g_rocketTick = false;
	remove_task(TASK_BAZOOKA_ROCKET);
}

/* One flight step. Answers 1 when the rocket is gone - it exploded or ran out of fuel - and 0 while it is
   still flying. */
stock StepRocket(slot)
{
	new ent = g_rocketEnt[slot];
	new Float:from[3], Float:to[3];
	pev(ent, pev_origin, from);

	to[0] = from[0] + g_rocketVelocity[slot][0] * BAZOOKA_ROCKET_TICK;
	to[1] = from[1] + g_rocketVelocity[slot][1] * BAZOOKA_ROCKET_TICK;
	to[2] = from[2] + g_rocketVelocity[slot][2] * BAZOOKA_ROCKET_TICK;

	new trace = create_tr2();
	engfunc(EngFunc_TraceLine, from, to, IGNORE_GLASS, ent, trace);

	new Float:fraction;
	get_tr2(trace, TR_flFraction, fraction);
	new hit = get_tr2(trace, TR_pHit);

	new Float:landing[3];
	get_tr2(trace, TR_vecEndPos, landing);
	free_tr2(trace);

	// The carrier's own body is where the flight starts: the first trace can end on him, and a blast on the
	// bot that fired is not what the buyer paid for.
	if (hit == g_rocketOwner[slot])
		fraction = 1.0;

	if (fraction < 1.0)
	{
		BazookaBlast(landing, g_rocketOwner[slot]);
		RemoveRocket(slot);
		return 1;
	}

	engfunc(EngFunc_SetOrigin, ent, to);

	// The trail: a beam from where the rocket was to where it is now, drawn in the same step. This is the
	// rocket the viewer follows - an orange streak made of the one beam message this set already runs live,
	// with no sprite in it, because a sprite on a moving entity drew as a black square on the stream.
	DrawBeamColour(from, to, 255, 140, 40, 6, 14);
	// A second, thinner and brighter core, so the streak reads as a flame and not as a thin line.
	DrawBeamColour(from, to, 255, 230, 150, 4, 6);

	g_rocketTicks[slot]--;
	if (g_rocketTicks[slot] <= 0)
	{
		// Out of fuel over the map: it still goes off, or the viewer watches a rocket disappear.
		BazookaBlast(to, g_rocketOwner[slot]);
		RemoveRocket(slot);
		return 1;
	}

	return 0;
}

/* The blast: the sprite the rest of the set already uses, the stock C4 bang, and damage that falls off with
   distance. Ham_TakeDamage is the door every other event uses, and the attacker is the bot that fired, so the
   kill lands on its row of the scoreboard instead of on nobody. */
stock BazookaBlast(Float:origin[3], owner)
{
	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_EXPLOSION);
	write_coord(floatround(origin[0]));
	write_coord(floatround(origin[1]));
	write_coord(floatround(origin[2]));
	write_short(g_meteorSprite);
	write_byte(30);
	write_byte(15);
	write_byte(0);
	message_end();

	// Emitted from the world: the capture client listens from one position, and a sample a bot 400 units away
	// emits is a sample the stream never hears.
	emit_sound(0, CHAN_AUTO, BAZOOKA_BLAST_SOUND, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);

	new attacker = owner > 0 && is_user_connected(owner) ? owner : 0;
	new Float:radius = float(g_rocketRadius);

	// The radius in the catalogue, drawn on the ground: the ring is what makes "320 units" a thing the
	// viewer can see instead of a number in the panel.
	Shockwave(origin, radius, 255, 130, 30);

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		// The carrier is not caught by its own rocket. Measured on the stream (2026-10-31): with the owner in
		// the blast, a 45 s run moved the role six times - the bot fires at bot range, the explosion lands 40
		// units from him, and 500 damage inside 320 units kills him before the viewer sees a second shot. The
		// camera follows the carrier, so the paid picture has to survive its own weapon.
		if (id == owner)
			continue;

		new Float:where[3];
		pev(id, pev_origin, where);
		new Float:distance = get_distance_f(origin, where);
		if (distance > radius)
			continue;

		// Linear falloff down to BAZOOKA_MIN_DAMAGE at the rim: a flat 500 within 320 units kills the whole
		// field with one rocket, while a blast that does nothing at the rim is a dud the viewer sees.
		new Float:damage = float(g_rocketDamage) * (1.0 - distance / radius);
		if (damage < float(BAZOOKA_MIN_DAMAGE))
			damage = float(BAZOOKA_MIN_DAMAGE);

		ExecuteHamB(Ham_TakeDamage, id, 0, attacker, damage, DMG_BLAST);
		g_rocketHits++;
	}

	g_rocketBlasts++;
}

stock RemoveRocket(slot)
{
	if (g_rocketEnt[slot] > 0)
	{
		engfunc(EngFunc_RemoveEntity, g_rocketEnt[slot]);
		g_rocketEnt[slot] = 0;
	}

	g_rocketTicks[slot] = 0;
	g_rocketOwner[slot] = 0;
}

stock EndBazookaRockets()
{
	remove_task(TASK_BAZOOKA_ROCKET);
	g_rocketTick = false;

	for (new slot = 0; slot < MAX_ROCKETS; slot++)
		RemoveRocket(slot);
}

stock EndBazookaDrop()
{
	remove_task(TASK_BAZOOKA_DRESS);
	EndBazookaRockets();

	new owner = FindEffect("bazooka_drop");
	ClaimRelease(CLAIM_WEAPONS, owner);
	if (ClaimRelease(CLAIM_CAMERA, owner))
		server_cmd("amx_stcam unlock");

	// The model field belongs to the player, not to the event: a bot that keeps the launcher model after the
	// clock is a bazooka the viewer still sees. The engine's own value for the weapon in hand goes back, and
	// the next respawn would have done the same.
	if (g_bazookaBot > 0 && g_bazookaAwpModelString && is_user_connected(g_bazookaBot))
		set_pev(g_bazookaBot, pev_weaponmodel, g_bazookaAwpModelString);

	log_amx("bazooka_drop ended: %d rocket(s) fired, %d blast(s), %d bot(s) hit",
		g_rocketFired, g_rocketBlasts, g_rocketHits);

	g_bazookaActive = false;
	g_bazookaBot = 0;
	g_rocketFired = 0;
	g_rocketBlasts = 0;
	g_rocketHits = 0;
}

/* GUNTRAIN. A kill moves a bot one rung up the ladder in `params.ladder`: the bottom rung is handed out at
   the start with the old kit stripped, and every promotion replaces the whole kit, because a bot that keeps
   its rifle while "climbing" is a bot the viewer cannot read. The rung is per slot, so a bot that dies comes
   back on the rung it earned. */
public EffectGunTrain()
{
	BeginEvent("guntrain");

	g_trainCount = TrainReadLadder();
	if (g_trainCount < 2)
	{
		log_amx("guntrain: the ladder names %d weapon(s), there is nothing to climb", g_trainCount);
		return;
	}

	if (!PickRandomBot())
	{
		log_amx("guntrain: no bots are alive");
		return;
	}

	g_trainActive = true;
	g_trainPromotions = 0;
	g_trainWinner = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
	{
		g_trainLevel[id] = 0;
		g_trainTop[id] = 0;
	}

	ClaimTake(CLAIM_WEAPONS, FindEffect("guntrain"), 1);

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;
		StripWeapons(id);
		give_item(id, g_trainLadder[0]);
		give_item(id, "weapon_knife");
	}

	StartEffectTimer("guntrain", EffectSeconds(60.0));
	log_amx("guntrain: %d rungs, %s first, %s last", g_trainCount, g_trainLadder[0], g_trainLadder[g_trainCount - 1]);
	DonorSay("CLIMB THE LADDER");
}

/* The ladder arrives as `rung1=.. rung8=..`, one token per rung, and there is a measured reason for that:
   the RCON line is split by the engine at commas and colons, so a comma-joined list reaches the plugin as its
   first item only (`reward=weapon_awp,zzz` arrives as `weapon_awp` on the live server). A rung is a weapon
   name from the catalogue, so it passes the same check a `weapon=` parameter does before give_item sees it. */
stock TrainReadLadder()
{
	new key[KEY_LEN];
	new value[KEY_LEN];
	new count;

	for (new i = 0; i < TRAIN_MAX_LADDER; i++)
	{
		format(key, charsmax(key), "rung%d", i + 1);
		if (!ParamCopy(key, value, charsmax(value), ""))
			break;

		format(g_trainLadder[count], TRAIN_NAME_LEN - 1, "weapon_%s", value);
		if (IsSafeWeapon(g_trainLadder[count]))
			count++;
		else
			log_amx("guntrain: '%s' is not a weapon name, the rung is dropped", value);
	}

	return count;
}

/* The kill feed is the ladder's only controller: a bot moves up when it kills, and the top rung is where the
   knife is. The count is what the log answers "did anyone climb" with, since a rung is a weapon in the bot's
   hands and leaves no other trace. */
stock GunTrainKill(killer)
{
	if (!g_trainActive || !IsBotAlive(killer))
		return;

	new level = g_trainLevel[killer];
	if (level < g_trainCount - 1)
	{
		level++;
		g_trainLevel[killer] = level;
		g_trainPromotions++;
		StripWeapons(killer);
		give_item(killer, g_trainLadder[level]);
		give_item(killer, "weapon_knife");
	}

	if (level < g_trainCount - 1 || g_trainTop[killer])
		return;

	g_trainTop[killer] = 1;
	g_trainWinner = killer;
	new name[NICK_LEN];
	get_user_name(killer, name, charsmax(name));
	Announce("%s reached the knife", name);
	log_amx("guntrain: %s reached the top rung", name);
}

stock EndGunTrain()
{
	ClaimRelease(CLAIM_WEAPONS, FindEffect("guntrain"));

	log_amx("guntrain ended: %d promotion(s)%s", g_trainPromotions,
		g_trainWinner > 0 ? ", the knife was reached" : "");

	g_trainActive = false;
	g_trainPromotions = 0;
	g_trainWinner = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
	{
		g_trainLevel[id] = 0;
		g_trainTop[id] = 0;
	}
}

/* STATUES. Every pass the field is traced: a bot that any other bot can see stands still, and one that
   nobody can see walks again. This is the whole of Hide'n'Seek with no rule to explain, which is why it is
   in the catalogue at all. */
public EffectStatues()
{
	BeginEvent("statues");

	if (!PickRandomBot())
	{
		log_amx("statues: no bots are alive");
		return;
	}

	g_statueActive = true;
	g_statueFrozen = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
		g_statueHeld[id] = 0;

	ClaimTake(CLAIM_FREEZE, FindEffect("statues"), 1);
	set_task(SIGHT_TICK, "TaskStatues", TASK_STATUE, "", 0, "b");

	StartEffectTimer("statues", EffectSeconds(30.0));
	log_amx("statues: freeze on sight, a %.1f s pass", SIGHT_TICK);
	DonorSay("DON'T BE SEEN");
}

public TaskStatues()
{
	if (!g_statueActive)
	{
		remove_task(TASK_STATUE);
		return;
	}

	// A newer event that wants the field standing owns the freeze; this one then only stops acting.
	if (!ClaimTake(CLAIM_FREEZE, FindEffect("statues"), 1))
		return;

	// The whole field is measured before anyone is frozen: two bots looking at each other freeze on the same
	// pass instead of one of them walking out of the frame it was seen in.
	new watched[MAX_SLOTS];
	for (new id = 0; id < MAX_SLOTS; id++)
		watched[id] = 0;

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		for (new other = 1; other <= get_maxplayers(); other++)
		{
			if (other == id || !IsBotAlive(other))
				continue;
			if (!CanSee(other, id))
				continue;
			watched[id] = 1;
			break;
		}
	}

	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (watched[id] && IsBotAlive(id))
		{
			if (!g_statueHeld[id])
			{
				g_statueHeld[id] = 1;
				g_statueFrozen++;
				FreezeBot(id);
				set_user_rendering(id, kRenderFxGlowShell, 120, 200, 255, kRenderNormal, 20);
			}
			continue;
		}

		if (!g_statueHeld[id])
			continue;

		g_statueHeld[id] = 0;
		if (is_user_connected(id))
		{
			ClearGlow(id);
			ThawBot(id);
		}
	}
}

/* Line of sight between two bodies, eye to chest. 0.98 instead of 1.0: the engine stops the trace a hair
   short of the hitbox, and a strict comparison would read "seen" as "not seen" for a bot standing right on
   top of the other. */
stock bool:CanSee(watcher, target)
{
	new Float:eyes[3], Float:body[3];
	pev(watcher, pev_origin, eyes);
	pev(target, pev_origin, body);
	eyes[2] += 24.0;
	body[2] += 12.0;

	new trace = create_tr2();
	engfunc(EngFunc_TraceLine, eyes, body, IGNORE_MONSTERS, watcher, trace);

	new Float:fraction;
	get_tr2(trace, TR_flFraction, fraction);
	free_tr2(trace);

	return fraction >= 0.98;
}

stock EndStatues()
{
	remove_task(TASK_STATUE);

	new bool:top = ClaimRelease(CLAIM_FREEZE, FindEffect("statues"));
	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (!g_statueHeld[id])
			continue;

		if (is_user_connected(id))
		{
			ClearGlow(id);
			if (top)
				ThawBot(id);
		}
		g_statueHeld[id] = 0;
	}

	log_amx("statues ended: %d freeze(s) on sight", g_statueFrozen);
	g_statueActive = false;
	g_statueFrozen = 0;
}

/* HEAD HUNTER. One bot wears a red shell and a price on its head: whoever kills it gets `reward` and a gold
   shell for `hold` seconds, and the mark moves every `period` seconds so the hunt never settles. The reward
   weapon goes away with the body (csdm_lite respawns a bot within a second of the death that matters here);
   the gold shell is render state, so it is counted down and taken off by hand. */
public EffectHeadHunter()
{
	BeginEvent("head_hunter");

	ParamCopy("reward", g_markReward, charsmax(g_markReward), "weapon_awp");
	if (!IsSafeWeapon(g_markReward))
	{
		log_amx("head_hunter: '%s' is not a weapon name, the mark pays nothing", g_markReward);
		g_markReward[0] = '^0';
	}

	g_markHold = ParamInt("hold", 15);
	if (g_markHold < 1)
		g_markHold = 1;
	if (g_markHold > MARK_MAX_HOLD)
		g_markHold = MARK_MAX_HOLD;

	new period = ParamInt("period", 3);
	if (period < 1)
		period = 1;
	if (period > MARK_MAX_HOLD)
		period = MARK_MAX_HOLD;

	if (!PickRandomBot())
	{
		log_amx("head_hunter: no bots are alive");
		return;
	}

	g_markActive = true;
	g_markBot = 0;
	g_markRewards = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
		g_markGlow[id] = 0;

	ClaimTake(CLAIM_GLOW, FindEffect("head_hunter"), 1);
	ClaimTake(CLAIM_WEAPONS, FindEffect("head_hunter"), 1);

	HeadHunterMark();
	set_task(float(period), "TaskMark", TASK_MARK, "", 0, "b");
	set_task(SIGHT_TICK, "TaskMarkGlow", TASK_MARK_GLOW, "", 0, "b");

	StartEffectTimer("head_hunter", EffectSeconds(45.0));
	log_amx("head_hunter: the mark moves every %d s, the killer gets %s for %d s", period, g_markReward, g_markHold);
	DonorSay("A PRICE ON A HEAD");
}

public TaskMark()
{
	if (!g_markActive)
	{
		remove_task(TASK_MARK);
		return;
	}
	HeadHunterMark();
}

stock HeadHunterMark()
{
	// A bot still wearing the gold shell of its own reward keeps it: the mark is red, the reward is gold, and
	// clearing the wrong one would pay a bot and then take the payment off the screen.
	if (g_markBot > 0 && g_markBot < MAX_SLOTS && g_markGlow[g_markBot] == 0)
		ClearGlow(g_markBot);

	new bot = PickRandomBot();
	g_markBot = bot;
	if (!bot)
		return;

	set_user_rendering(bot, kRenderFxGlowShell, 255, 40, 40, kRenderNormal, 25);

	new name[NICK_LEN];
	get_user_name(bot, name, charsmax(name));
	Announce("MARKED: %s", name);
}

/* The marked body is dead: the killer is paid, and the next mark arrives on the period's next pass. */
stock HeadHunterKill(victim, killer)
{
	if (!g_markActive || victim != g_markBot)
		return;

	if (!IsBotAlive(killer))
	{
		log_amx("head_hunter: the mark died without a killer, nobody is paid");
		return;
	}

	if (g_markReward[0])
		give_item(killer, g_markReward);

	g_markGlow[killer] = floatround(float(g_markHold) / SIGHT_TICK);
	set_user_rendering(killer, kRenderFxGlowShell, 255, 200, 0, kRenderNormal, 20);
	g_markRewards++;

	new name[NICK_LEN];
	get_user_name(killer, name, charsmax(name));
	Announce("%s takes the mark", name);
	log_amx("head_hunter: the mark paid bot %d with %s", killer, g_markReward);
}

public TaskMarkGlow()
{
	if (!g_markActive)
	{
		remove_task(TASK_MARK_GLOW);
		return;
	}

	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (g_markGlow[id] <= 0)
			continue;

		// The countdown belongs to the body that was paid, and csdm_lite hands the slot a fresh bot.
		if (!IsBotAlive(id))
		{
			g_markGlow[id] = 0;
			continue;
		}

		g_markGlow[id]--;
		if (g_markGlow[id] == 0)
			ClearGlow(id);
	}
}

stock EndHeadHunter()
{
	remove_task(TASK_MARK);
	remove_task(TASK_MARK_GLOW);

	new owner = FindEffect("head_hunter");
	new bool:glowTop = ClaimRelease(CLAIM_GLOW, owner);
	ClaimRelease(CLAIM_WEAPONS, owner);

	if (glowTop)
	{
		for (new id = 1; id < MAX_SLOTS; id++)
		{
			if (g_markGlow[id] > 0 && is_user_connected(id))
				ClearGlow(id);
		}
		if (g_markBot > 0 && is_user_connected(g_markBot))
			ClearGlow(g_markBot);
	}

	log_amx("head_hunter ended: %d mark(s) paid", g_markRewards);

	g_markActive = false;
	g_markBot = 0;
	g_markRewards = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
		g_markGlow[id] = 0;
	g_markReward[0] = '^0';
}

/* KING OF THE HILL. The hill is the middle of the fight at the moment the event starts, not the geometric
   centre of the map: fy_aztec's centre is a building, and a hill nobody can stand on is a hill nobody can
   take. Holding it for `hold` seconds pays `health` HP and an M249, and leaving resets the clock - a hold
   that survives a walk to the other side of the map is not a hold. */
public EffectKingOfTheHill()
{
	BeginEvent("king_of_the_hill");

	new radius = ParamInt("radius", 200);
	if (radius < 50)
		radius = 50;
	if (radius > HILL_MAX_RADIUS)
		radius = HILL_MAX_RADIUS;
	g_hillRadius = float(radius);

	g_hillHold = float(ParamInt("hold", 3));
	if (g_hillHold < 1.0)
		g_hillHold = 1.0;
	if (g_hillHold > 30.0)
		g_hillHold = 30.0;

	g_hillHealth = ParamInt("health", 300);
	if (g_hillHealth < 100)
		g_hillHealth = 100;
	if (g_hillHealth > 2000)
		g_hillHealth = 2000;

	if (!AliveBotCentre(g_hillCentre))
	{
		log_amx("king_of_the_hill: no bot to put the hill under");
		return;
	}

	g_hillActive = true;
	g_hillTaken = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
	{
		g_hillDwell[id] = 0.0;
		g_hillBuffed[id] = 0;
	}

	ClaimTake(CLAIM_HEALTH, FindEffect("king_of_the_hill"), 1);
	ClaimTake(CLAIM_WEAPONS, FindEffect("king_of_the_hill"), 1);
	set_task(HILL_TICK, "TaskHill", TASK_HILL, "", 0, "b");

	StartEffectTimer("king_of_the_hill", EffectSeconds(60.0));
	log_amx("king_of_the_hill: hold %.1f s inside %.0f units at %.0f %.0f for %d HP",
		g_hillHold, g_hillRadius, g_hillCentre[0], g_hillCentre[1], g_hillHealth);
	DonorSay("TAKE THE HILL");
}

public TaskHill()
{
	if (!g_hillActive)
	{
		remove_task(TASK_HILL);
		return;
	}

	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (!IsBotAlive(id))
		{
			g_hillDwell[id] = 0.0;
			g_hillBuffed[id] = 0;
			continue;
		}

		new Float:origin[3];
		pev(id, pev_origin, origin);
		if (get_distance_f(g_hillCentre, origin) > g_hillRadius)
		{
			g_hillDwell[id] = 0.0;
			continue;
		}

		g_hillDwell[id] += HILL_TICK;
		if (g_hillDwell[id] < g_hillHold || g_hillBuffed[id])
			continue;

		g_hillBuffed[id] = 1;
		g_hillTaken++;
		set_user_health(id, g_hillHealth);
		give_item(id, "weapon_m249");
		set_user_rendering(id, kRenderFxGlowShell, 255, 200, 0, kRenderNormal, 20);
		Announce("THE HILL IS TAKEN");
		log_amx("king_of_the_hill: bot %d held the hill, %d HP and an M249", id, g_hillHealth);
	}
}

stock EndKingOfTheHill()
{
	remove_task(TASK_HILL);

	new owner = FindEffect("king_of_the_hill");
	ClaimRelease(CLAIM_HEALTH, owner);
	ClaimRelease(CLAIM_WEAPONS, owner);

	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (g_hillBuffed[id] && is_user_connected(id))
			ClearGlow(id);
		g_hillBuffed[id] = 0;
		g_hillDwell[id] = 0.0;
	}

	log_amx("king_of_the_hill ended: %d bot(s) took the hill", g_hillTaken);
	g_hillActive = false;
	g_hillTaken = 0;
}

/* DUEL BELL. Every `period` seconds two bots are dropped next to each other with `health` HP and a knife.
   Both destinations are checked against the engine's own idea of solid space first: a bot teleported into a
   wall never comes back, and the pair is what the viewer is looking at when it happens. */
public EffectDuelBell()
{
	BeginEvent("duel_bell");

	new period = ParamInt("period", 10);
	if (period < 2)
		period = 2;
	if (period > MARK_MAX_HOLD)
		period = MARK_MAX_HOLD;

	g_bellHealth = ParamInt("health", 1);
	if (g_bellHealth < 1)
		g_bellHealth = 1;
	if (g_bellHealth > DUEL_MAX_HEALTH)
		g_bellHealth = DUEL_MAX_HEALTH;

	if (!PickRandomBot())
	{
		log_amx("duel_bell: no bots are alive");
		return;
	}

	g_duelBellActive = true;
	g_duels = 0;

	ClaimTake(CLAIM_WEAPONS, FindEffect("duel_bell"), 1);
	ClaimTake(CLAIM_HEALTH, FindEffect("duel_bell"), 1);

	DuelBell();
	set_task(float(period), "TaskDuelBell", TASK_DUEL, "", 0, "b");

	StartEffectTimer("duel_bell", EffectSeconds(40.0));
	log_amx("duel_bell: a %d HP knife duel every %d s", g_bellHealth, period);
	DonorSay("THE BELL RINGS");
}

public TaskDuelBell()
{
	if (!g_duelBellActive)
	{
		remove_task(TASK_DUEL);
		return;
	}
	DuelBell();
}

stock DuelBell()
{
	new first = PickRandomBot();
	if (!first)
		return;

	new second;
	for (new attempt = 0; attempt < 8 && !second; attempt++)
	{
		new candidate = PickRandomBot();
		if (candidate && candidate != first)
			second = candidate;
	}

	if (!second)
		return;

	new Float:centre[3];
	if (!AliveBotCentre(centre))
		return;

	new Float:placeA[3], Float:placeB[3];
	new bool:placed = false;
	for (new attempt = 0; attempt < 6 && !placed; attempt++)
	{
		new Float:angle = random_float(0.0, 360.0);
		placeA[0] = centre[0] + floatcos(angle, degrees) * DUEL_GAP;
		placeA[1] = centre[1] + floatsin(angle, degrees) * DUEL_GAP;
		placeA[2] = centre[2];
		placeB[0] = centre[0] - floatcos(angle, degrees) * DUEL_GAP;
		placeB[1] = centre[1] - floatsin(angle, degrees) * DUEL_GAP;
		placeB[2] = centre[2];
		placed = SafeSpot(placeA) && SafeSpot(placeB);
	}

	if (!placed)
	{
		log_amx("duel_bell: no free spot around the middle, the bell is skipped");
		return;
	}

	DropForDuel(first, placeA);
	DropForDuel(second, placeB);

	g_duels++;
	log_amx("duel_bell: bots %d and %d at %.0f %.0f, %d HP each", first, second, centre[0], centre[1], g_bellHealth);
	Announce("DUEL");
	emit_sound(0, CHAN_AUTO, "events/task_complete.wav", VOL_NORM, ATTN_NORM, 0, PITCH_NORM);
}

stock DropForDuel(id, const Float:where[3])
{
	engfunc(EngFunc_SetOrigin, id, where);

	// Keeping the run velocity would carry the bot straight out of the duel it was dropped into.
	new Float:still[3];
	set_pev(id, pev_velocity, still);

	StripWeapons(id);
	give_item(id, "weapon_knife");
	set_user_health(id, g_bellHealth);
}

stock EndDuelBell()
{
	remove_task(TASK_DUEL);

	new owner = FindEffect("duel_bell");
	ClaimRelease(CLAIM_WEAPONS, owner);
	ClaimRelease(CLAIM_HEALTH, owner);

	log_amx("duel_bell ended: %d duel(s)", g_duels);
	g_duelBellActive = false;
	g_duels = 0;
}

/* ---------- S6 physics (docs/activities/systems.md, S6) ---------- */

/* AIRSTRIKE. `strikes` blasts walk in from a ring 600 units out: the first lands on the ring, the last
   on the frag leader. The leader is re-read on every pass, because a dead leader would be a strike
   aimed at a body that is already gone; `g_airFrom` is the only fixed point of the run. Radius damage
   goes through Ham_TakeDamage with DMG_BLAST, the same label a thrown HE carries, so another running
   event that watches explosions sees a real one. */
public EffectAirstrike()
{
	BeginEvent("airstrike");

	// A second airstrike replaces the first instead of leaving two converging barrages on the field.
	if (g_airActive)
		EndAirstrike();

	g_airStrikes = ParamInt("strikes", 10);
	if (g_airStrikes < 1)
		g_airStrikes = 1;
	if (g_airStrikes > AIR_MAX_STRIKES)
		g_airStrikes = AIR_MAX_STRIKES;

	g_airDamage = ParamInt("damage", 120);
	if (g_airDamage < 1)
		g_airDamage = 1;
	if (g_airDamage > AIR_MAX_DAMAGE)
		g_airDamage = AIR_MAX_DAMAGE;

	g_airRadius = ParamInt("radius", 300);
	if (g_airRadius < AIR_MIN_RADIUS)
		g_airRadius = AIR_MIN_RADIUS;
	if (g_airRadius > AIR_MAX_RADIUS)
		g_airRadius = AIR_MAX_RADIUS;

	new leader = FindLeaderBot();
	if (!leader)
		leader = PickRandomBot();
	if (!leader)
	{
		log_amx("airstrike: no bots are alive");
		return;
	}

	pev(leader, pev_origin, g_airTarget);
	new Float:angle = float(random(360));
	g_airFrom[0] = g_airTarget[0] + floatcos(angle, degrees) * AIR_RING_RADIUS;
	g_airFrom[1] = g_airTarget[1] + floatsin(angle, degrees) * AIR_RING_RADIUS;
	g_airFrom[2] = g_airTarget[2] + 200.0;

	g_airLeft = g_airStrikes;
	g_airBursts = 0;
	g_airHits = 0;
	g_airActive = true;

	set_task(AIR_TICK, "TaskAirstrike", TASK_AIRSTRIKE, "", 0, "b", g_airLeft);
	StartEffectTimer("airstrike", EffectSeconds(20.0));

	log_amx("airstrike: %d strike(s) of %d damage in %d units, coming from %.0f %.0f",
		g_airStrikes, g_airDamage, g_airRadius, g_airFrom[0], g_airFrom[1]);
	DonorSay("AIRSTRIKE INBOUND");
}

public TaskAirstrike()
{
	if (!g_airActive)
	{
		remove_task(TASK_AIRSTRIKE);
		return;
	}

	// The target moves with the field: a leader who died between two blasts hands the run to the next
	// bot on the scoreboard instead of leaving the last strikes on a corpse.
	new leader = FindLeaderBot();
	if (leader)
		pev(leader, pev_origin, g_airTarget);

	// The first blast sits on the ring, the last one on the target.
	new step = g_airStrikes - g_airLeft + 1;
	new Float:fraction = float(step) / float(g_airStrikes);
	new Float:pos[3];
	pos[0] = g_airFrom[0] + (g_airTarget[0] - g_airFrom[0]) * fraction;
	pos[1] = g_airFrom[1] + (g_airTarget[1] - g_airFrom[1]) * fraction;
	pos[2] = g_airFrom[2] + (g_airTarget[2] - g_airFrom[2]) * fraction;

	message_begin(MSG_BROADCAST, SVC_TEMPENTITY);
	write_byte(TE_EXPLOSION);
	write_coord(floatround(pos[0]));
	write_coord(floatround(pos[1]));
	write_coord(floatround(pos[2]));
	write_short(g_meteorSprite);
	write_byte(30);
	write_byte(15);
	write_byte(0);
	message_end();

	// Emitted from the world: the capture client listens from one position, and a sample a bot 400
	// units away emits is a sample the stream never hears.
	emit_sound(0, CHAN_AUTO, AIR_SOUND, VOL_NORM, ATTN_NORM, 0, PITCH_NORM);

	// Read from the snapshot, not from the parameter table: this runs from a timer, long after the
	// command that paid for it.
	new radius = g_airRadius;

	// Each strike draws the radius it damages: ten rings converging on the leader read as a barrage.
	Shockwave(pos, float(radius), 255, 150, 40);
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:where[3];
		pev(id, pev_origin, where);
		if (get_distance_f(pos, where) > float(radius))
			continue;

		ExecuteHamB(Ham_TakeDamage, id, 0, 0, float(g_airDamage), DMG_BLAST);
		g_airHits++;
	}

	g_airBursts++;
	g_airLeft--;

	// The run ends with its last blast, not with the catalogue clock: a 20 second status line over a
	// four second barrage reads as an effect still on screen when nothing is happening.
	if (g_airLeft <= 0)
		FinishEffect("airstrike");
}

stock EndAirstrike()
{
	remove_task(TASK_AIRSTRIKE);

	// Unconditional: "ten strikes, nobody hit" is a result the operator has to be able to read.
	log_amx("airstrike ended: %d of %d strike(s) landed, %d bot(s) hit", g_airBursts, g_airStrikes, g_airHits);

	g_airActive = false;
	g_airStrikes = 0;
	g_airLeft = 0;
	g_airBursts = 0;
	g_airHits = 0;
}


/* WEAPON RAIN. One `armoury_entity` every `period` seconds, `count` boxes in total, and never more than
   five on the map: every extra entity is a model llvmpipe draws on the CPU in every frame.
 * `cs_set_armoury_type` does not update the world model (the include says so in as many words), so the
   model is set by hand. Every file in this list ships with CS 1.6 and is already used by a death drop. */
new const RAIN_WEAPONS[] =
{
	CSW_AK47, CSW_M4A1, CSW_AWP, CSW_M249, CSW_MP5NAVY, CSW_XM1014, CSW_SCOUT, CSW_P90
};

public EffectWeaponRain()
{
	BeginEvent("weapon_rain");

	if (g_rainActive)
		EndWeaponRain();

	new count = ParamInt("count", 5);
	if (count < 1)
		count = 1;
	if (count > RAIN_MAX_DROPS)
		count = RAIN_MAX_DROPS;

	new Float:period = ParamFloat("period", 2.0);
	if (period < 0.5)
		period = 0.5;
	if (period > 10.0)
		period = 10.0;

	g_rainLeft = count;
	g_rainSpawned = 0;
	g_rainActive = true;
	for (new i = 0; i < RAIN_MAX_ENTITIES; i++)
		g_rainEnts[i] = 0;

	StartEffectTimer("weapon_rain", EffectSeconds(20.0));

	// The first box lands in this call: a paid effect that waits two seconds for its first frame reads
	// as a donation the server swallowed.
	DropRainWeapon();
	if (g_rainLeft > 0)
		set_task(period, "TaskWeaponRain", TASK_WEAPON_RAIN, "", 0, "b", g_rainLeft);

	log_amx("weapon_rain: %d box(es) every %.1f s, at most %d on the map", count, period, RAIN_MAX_ENTITIES);
	DonorSay("IT RAINS GUNS");
}

public TaskWeaponRain()
{
	if (!g_rainActive || g_rainLeft <= 0)
	{
		remove_task(TASK_WEAPON_RAIN);
		return;
	}

	DropRainWeapon();

	// The boxes stay on the ground for the rest of the clock: the loot is the event, not the drop. The
	// task stops as soon as every weapon has fallen.
	if (g_rainLeft <= 0)
		remove_task(TASK_WEAPON_RAIN);
}

stock DropRainWeapon()
{
	if (g_rainLeft <= 0)
		return;

	new bot = PickRandomBot();
	if (!bot)
	{
		log_amx("weapon_rain: no bot is alive to drop a weapon over");
		g_rainLeft = 0;
		return;
	}

	new weaponId = RAIN_WEAPONS[random(sizeof RAIN_WEAPONS)];

	new ent = engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, "armoury_entity"));
	if (ent > 0)
	{
		// The type goes in before Spawn: the entity builds its touch trigger and its count from the type
		// it already holds. The model is set afterwards, because the native leaves it alone.
		cs_set_armoury_type(ent, weaponId, 1);
		dllfunc(DLLFunc_Spawn, ent);

		new name[32], model[64];
		get_weaponname(weaponId, name, charsmax(name));
		format(model, charsmax(model), "models/w_%s.mdl", name[7]);
		engfunc(EngFunc_SetModel, ent, model);

		// From above the bot: the armoury entity floats down when it is not on the ground, which is the
		// whole picture the code sells.
		new Float:origin[3];
		pev(bot, pev_origin, origin);
		origin[2] += RAIN_HEIGHT;
		engfunc(EngFunc_SetOrigin, ent, origin);

		RememberRainEnt(ent);
		g_rainSpawned++;
	}
	else
	{
		log_amx("weapon_rain: the engine refused an armoury_entity");
	}

	g_rainLeft--;
}

stock RememberRainEnt(ent)
{
	for (new i = 0; i < RAIN_MAX_ENTITIES; i++)
	{
		if (g_rainEnts[i] == 0)
		{
			g_rainEnts[i] = ent;
			return;
		}
	}

	// The cap is the point of the code: the oldest box goes before a sixth model exists.
	if (pev_valid(g_rainEnts[0]))
		engfunc(EngFunc_RemoveEntity, g_rainEnts[0]);

	for (new i = 0; i < RAIN_MAX_ENTITIES - 1; i++)
		g_rainEnts[i] = g_rainEnts[i + 1];
	g_rainEnts[RAIN_MAX_ENTITIES - 1] = ent;
}

stock EndWeaponRain()
{
	remove_task(TASK_WEAPON_RAIN);

	// Boxes are models: left on the map after the clock they are a permanent cost on a software renderer.
	for (new i = 0; i < RAIN_MAX_ENTITIES; i++)
	{
		if (g_rainEnts[i] > 0 && pev_valid(g_rainEnts[i]))
			engfunc(EngFunc_RemoveEntity, g_rainEnts[i]);
		g_rainEnts[i] = 0;
	}

	log_amx("weapon_rain ended: %d weapon(s) dropped", g_rainSpawned);
	g_rainActive = false;
	g_rainLeft = 0;
	g_rainSpawned = 0;
}

/* QUAKE. Every `period` seconds every alive bot is shoved by a random horizontal impulse plus a small
   hop. Nothing is claimed: the velocity is written once per tick and the next tick of the same run
   overwrites it, so no other effect holds that resource - the undo is the task that stops writing. A
   ceiling keeps a stacked shove from launching a bot through the skybox. */
public EffectQuake()
{
	BeginEvent("quake");

	if (g_quakeActive)
		EndQuake();

	new force = ParamInt("force", 400);
	if (force < QUAKE_MIN_FORCE)
		force = QUAKE_MIN_FORCE;
	if (force > QUAKE_MAX_FORCE)
		force = QUAKE_MAX_FORCE;
	g_quakeForce = float(force);

	g_quakePeriod = ParamFloat("period", 0.7);
	if (g_quakePeriod < QUAKE_MIN_PERIOD)
		g_quakePeriod = QUAKE_MIN_PERIOD;
	if (g_quakePeriod > QUAKE_MAX_PERIOD)
		g_quakePeriod = QUAKE_MAX_PERIOD;

	g_quakeActive = true;
	g_quakeTicks = 0;
	g_quakeShoves = 0;

	set_task(g_quakePeriod, "TaskQuake", TASK_QUAKE, "", 0, "b");
	new Float:seconds = EffectSeconds(15.0);
	StartEffectTimer("quake", seconds);

	log_amx("quake: %.0f impulse every %.1f s for %.0f s", g_quakeForce, g_quakePeriod, seconds);
	DonorSay("EARTHQUAKE");
}

public TaskQuake()
{
	if (!g_quakeActive)
	{
		remove_task(TASK_QUAKE);
		return;
	}

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:velocity[3];
		pev(id, pev_velocity, velocity);

		new Float:angle = float(random(360));
		velocity[0] += floatcos(angle, degrees) * g_quakeForce;
		velocity[1] += floatsin(angle, degrees) * g_quakeForce;
		// A hop, not a jump: the shove is horizontal, the lift only makes it read as an earthquake.
		velocity[2] += g_quakeForce * 0.35;

		new Float:speed = floatsqroot(velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2]);
		if (speed > QUAKE_MAX_SPEED)
		{
			new Float:scale = QUAKE_MAX_SPEED / speed;
			velocity[0] *= scale;
			velocity[1] *= scale;
			velocity[2] *= scale;
		}

		set_pev(id, pev_velocity, velocity);
		g_quakeShoves++;
	}

	g_quakeTicks++;
}

stock EndQuake()
{
	remove_task(TASK_QUAKE);

	log_amx("quake ended: %d tick(s), %d shove(s)", g_quakeTicks, g_quakeShoves);
	g_quakeActive = false;
	g_quakeTicks = 0;
	g_quakeShoves = 0;
}

/* FIRE RING. A circle centred on the middle of the fight shrinks by `shrink` units every `period`, and
   every bot outside it burns. The start radius is the farthest bot, not a constant: a fixed 600 on
   fy_iceworld is a ring outside the map, and the event reads as nothing happening. */
public EffectFireRing()
{
	BeginEvent("fire_ring");

	if (g_ringActive)
		EndFireRing();

	g_ringDamage = ParamInt("damage", 5);
	if (g_ringDamage < 1)
		g_ringDamage = 1;
	if (g_ringDamage > RING_MAX_DAMAGE)
		g_ringDamage = RING_MAX_DAMAGE;

	new shrink = ParamInt("shrink", 40);
	if (shrink < RING_MIN_SHRINK)
		shrink = RING_MIN_SHRINK;
	if (shrink > RING_MAX_SHRINK)
		shrink = RING_MAX_SHRINK;
	g_ringShrink = float(shrink);

	g_ringPeriod = ParamFloat("period", 1.0);
	if (g_ringPeriod < RING_MIN_PERIOD)
		g_ringPeriod = RING_MIN_PERIOD;
	if (g_ringPeriod > RING_MAX_PERIOD)
		g_ringPeriod = RING_MAX_PERIOD;

	if (!AliveBotCentre(g_ringCentre))
	{
		log_amx("fire_ring: no bots are alive");
		return;
	}

	// The ring starts outside the field, so the first tick already has somebody to burn.
	g_ringRadius = RING_MIN_RADIUS;
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:origin[3];
		pev(id, pev_origin, origin);
		new Float:distance = get_distance_f(g_ringCentre, origin);
		if (distance > g_ringRadius)
			g_ringRadius = distance;
	}
	if (g_ringRadius > RING_MAX_RADIUS)
		g_ringRadius = RING_MAX_RADIUS;

	g_ringScorched = 0;
	for (new id = 0; id < MAX_SLOTS; id++)
		g_ringBurnt[id] = 0;
	g_ringActive = true;

	set_task(g_ringPeriod, "TaskFireRing", TASK_FIRE_RING, "", 0, "b");
	new Float:seconds = EffectSeconds(30.0);
	StartEffectTimer("fire_ring", seconds);

	log_amx("fire_ring: %.0f units shrinking by %.0f every %.1f s, %d damage, for %.0f s",
		g_ringRadius, g_ringShrink, g_ringPeriod, g_ringDamage, seconds);
	DonorSay("NOWHERE TO RUN");
}

public TaskFireRing()
{
	if (!g_ringActive)
	{
		remove_task(TASK_FIRE_RING);
		return;
	}

	g_ringRadius -= g_ringShrink;
	if (g_ringRadius < RING_MIN_RADIUS)
		g_ringRadius = RING_MIN_RADIUS;

	new Float:radius = g_ringRadius;
	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:origin[3];
		pev(id, pev_origin, origin);
		if (get_distance_f(g_ringCentre, origin) <= radius)
			continue;

		ExecuteHamB(Ham_TakeDamage, id, 0, 0, float(g_ringDamage), DMG_BURN);

		// Counted once per run and glowed only on the first burn: the shell is what makes the zone
		// readable, and re-setting it every second is render state written for nothing.
		if (!g_ringBurnt[id])
		{
			g_ringBurnt[id] = 1;
			g_ringScorched++;
		}
		set_user_rendering(id, kRenderFxGlowShell, 255, 80, 0, kRenderNormal, 20);
	}
}

stock EndFireRing()
{
	remove_task(TASK_FIRE_RING);

	for (new id = 1; id < MAX_SLOTS; id++)
	{
		if (g_ringBurnt[id] && is_user_connected(id))
			ClearGlow(id);
		g_ringBurnt[id] = 0;
	}

	log_amx("fire_ring ended: %d bot(s) caught outside the ring", g_ringScorched);
	g_ringActive = false;
	g_ringScorched = 0;
}

/* INVERT VELOCITY. Every `period` a bot's horizontal velocity is negated, so the direction it chose a
   moment ago is the direction it moves. The claim is the point: a released run flips the field one
   last time, which gives back the direction the engine was already carrying, and a second run's claim
   makes that last flip somebody else's business. */
public EffectInvertVelocity()
{
	BeginEvent("invert_velocity");

	if (g_invertActive)
		EndInvertVelocity();

	g_invertPeriod = ParamFloat("period", 0.2);
	if (g_invertPeriod < INVERT_MIN_PERIOD)
		g_invertPeriod = INVERT_MIN_PERIOD;
	if (g_invertPeriod > INVERT_MAX_PERIOD)
		g_invertPeriod = INVERT_MAX_PERIOD;

	g_invertFlips = 0;
	g_invertActive = true;

	ClaimTake(CLAIM_VELOCITY, FindEffect("invert_velocity"), 1);
	set_task(g_invertPeriod, "TaskInvertVelocity", TASK_INVERT, "", 0, "b");

	new Float:seconds = EffectSeconds(10.0);
	StartEffectTimer("invert_velocity", seconds);

	log_amx("invert_velocity: a flip every %.2f s for %.0f s", g_invertPeriod, seconds);
	DonorSay("EVERYTHING IN REVERSE");
}

public TaskInvertVelocity()
{
	if (!g_invertActive)
	{
		remove_task(TASK_INVERT);
		return;
	}

	FlipVelocities();
}

stock FlipVelocities()
{
	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:velocity[3];
		pev(id, pev_velocity, velocity);
		// z is left alone: a negated fall turns the map inside out and reads as a server crash, not as
		// a joke. The joke is horizontal.
		velocity[0] = -velocity[0];
		velocity[1] = -velocity[1];
		set_pev(id, pev_velocity, velocity);
		g_invertFlips++;
	}
}

stock EndInvertVelocity()
{
	remove_task(TASK_INVERT);

	new owner = FindEffect("invert_velocity");
	if (ClaimRelease(CLAIM_VELOCITY, owner))
		// One last flip gives the field back the direction it had before the run started; without it the
		// bots keep moon-walking until their next input overwrites the velocity.
		FlipVelocities();

	log_amx("invert_velocity ended: %d flip(s)", g_invertFlips);
	g_invertActive = false;
	g_invertFlips = 0;
}

/* LOW GRAVITY KNIVES. `sv_gravity` is a server cvar and the one resource that outlives a map change if
   nothing restores it, so it goes through the claim layer: the newest gravity event writes it, and only
   the owner may put the base value back. The weapon pool is the second claim, and a bot that respawns is
   re-armed with a knife by the same repeating pass he_party uses. */
public EffectLowGravityKnives()
{
	BeginEvent("low_gravity_knives");

	if (g_knivesActive)
		EndLowGravityKnives();

	g_knivesGravity = ParamInt("gravity", 150);
	if (g_knivesGravity < KNIVES_MIN_GRAVITY)
		g_knivesGravity = KNIVES_MIN_GRAVITY;
	if (g_knivesGravity > KNIVES_MAX_GRAVITY)
		g_knivesGravity = KNIVES_MAX_GRAVITY;

	new owner = FindEffect("low_gravity_knives");
	ClaimGravity(owner, g_knivesGravity);
	ClaimTake(CLAIM_WEAPONS, owner, 1);
	g_knivesActive = true;

	for (new id = 1; id <= get_maxplayers(); id++)
		ArmKnives(id);

	// Twice a second: csdm_lite hands a respawned bot a rifle, and a rifle on the field ends the event
	// for that bot.
	set_task(0.5, "TaskGravityKnives", TASK_GRAVITY_KNIVES, "", 0, "b");

	new Float:seconds = EffectSeconds(25.0);
	StartEffectTimer("low_gravity_knives", seconds);

	log_amx("low_gravity_knives: sv_gravity %d, knives only, for %.0f s", g_knivesGravity, seconds);
	DonorSay("MOON KNIVES");
}

public TaskGravityKnives()
{
	if (!g_knivesActive)
	{
		remove_task(TASK_GRAVITY_KNIVES);
		return;
	}

	for (new id = 1; id <= get_maxplayers(); id++)
		ArmKnives(id);
}

stock ArmKnives(id)
{
	if (!IsBotAlive(id))
		return;

	strip_user_weapons(id);
	give_item(id, "weapon_knife");
}

stock EndLowGravityKnives()
{
	remove_task(TASK_GRAVITY_KNIVES);

	new owner = FindEffect("low_gravity_knives");
	ClaimRelease(CLAIM_WEAPONS, owner);

	// Only the newest gravity owner may write the cvar: a release that is not the top leaves the value
	// the newer event applied. CleanupActive has RestoreGravity as the fallback for a full reset.
	new bool:restored = ClaimRelease(CLAIM_GRAVITY, owner);
	if (restored)
		RestoreGravity();

	log_amx("low_gravity_knives ended: sv_gravity %d (restored=%d)", get_cvar_num("sv_gravity"), restored);
	g_knivesActive = false;
	g_knivesGravity = 0;
}

/* ---------- S8 sound (docs/activities/systems.md, S8) ---------- */

/* ANNOUNCER COUNTDOWN. Three chat numbers and a "FIGHT", one per second; the broadcast says the same
   words on the same seconds (`countdownCues` in src/voice.ts). No game sound: a custom sample would
   have to be precached inside the client, and espeak-ng already reads it on the stream. */
public EffectAnnouncerCountdown()
{
	BeginEvent("announcer_countdown");

	if (g_countdownActive)
		EndAnnouncerCountdown();

	g_countdownLeft = COUNTDOWN_FROM;
	g_countdownActive = true;
	ClaimTake(CLAIM_AUDIO, FindEffect("announcer_countdown"), 1);

	Announce("%d", g_countdownLeft);
	// One task, one tick a second, `COUNTDOWN_FROM + 1` runs: the last one prints FIGHT and stops itself.
	set_task(1.0, "TaskCountdown", TASK_COUNTDOWN, "", 0, "b", COUNTDOWN_FROM + 1);

	new Float:seconds = EffectSeconds(10.0);
	StartEffectTimer("announcer_countdown", seconds);
	log_amx("announcer_countdown: %d..1 and FIGHT over %.0f s", COUNTDOWN_FROM, seconds);
}

public TaskCountdown()
{
	if (!g_countdownActive)
	{
		remove_task(TASK_COUNTDOWN);
		return;
	}

	g_countdownLeft--;
	if (g_countdownLeft > 0)
	{
		Announce("%d", g_countdownLeft);
		// Logged as well as printed: a bot chat line never reaches the server log, and "the countdown
		// did not count" and "the countdown was never bought" read the same without this line.
		log_amx("announcer_countdown: %d", g_countdownLeft);
		return;
	}

	Announce("FIGHT!");
	log_amx("announcer_countdown: FIGHT");
	g_countdownActive = false;
	remove_task(TASK_COUNTDOWN);
}

stock EndAnnouncerCountdown()
{
	remove_task(TASK_COUNTDOWN);
	ClaimRelease(CLAIM_AUDIO, FindEffect("announcer_countdown"));
	log_amx("announcer_countdown ended");
	g_countdownActive = false;
	g_countdownLeft = 0;
}

/* QUOTES PACK. One bot says a line: the subtitle is the chat line, the voice is the broadcast's TTS.
   `text=` arrives already sanitized by the control API; a panel run has no phrase, so the built-in pack
   answers. The clock only satisfies the contract - nothing of this event lasts. */
public EffectQuotesPack()
{
	BeginEvent("quotes_pack");

	if (g_quotesActive)
		EndQuotesPack();

	new phrase[QUOTE_MAX_LEN + 1];
	if (!ParamCopy("text", phrase, charsmax(phrase), ""))
		RandomQuote(phrase, charsmax(phrase));
	CleanPhrase(phrase);

	new speaker = PickRandomBot();
	new name[NICK_LEN];
	if (speaker)
		get_user_name(speaker, name, charsmax(name));
	else
		copy(name, charsmax(name), "BOT");

	g_quotesActive = true;
	// Single quotes in the format, never an escaped double quote: this amxxpc build aborts with
	// std::bad_alloc on an escaped quote inside a log_amx/Announce format (see the header).
	Announce("%s says: '%s'", name, phrase);
	log_amx("quotes_pack: <%s> said %s", name, phrase);
	StartEffectTimer("quotes_pack", EffectSeconds(5.0));
}

stock EndQuotesPack()
{
	log_amx("quotes_pack ended");
	g_quotesActive = false;
}

/* SIREN. The bed is generated on the stream side (`TRACKS.siren`), so the game only takes the audio
   claim and prints the line: GoldSrc cannot play a file it did not precache. */
public EffectSiren()
{
	BeginEvent("siren");

	if (g_sirenActive)
		EndSiren();

	g_sirenActive = true;
	ClaimTake(CLAIM_AUDIO, FindEffect("siren"), 1);

	new Float:seconds = EffectSeconds(15.0);
	StartEffectTimer("siren", seconds);
	log_amx("siren: air-raid bed for %.0f s, synthesised on the stream side", seconds);
	DonorSay("AIR RAID");
}

stock EndSiren()
{
	ClaimRelease(CLAIM_AUDIO, FindEffect("siren"));
	log_amx("siren ended");
	g_sirenActive = false;
}

/* MUSIC SWAP. The same shape as the siren: a second generated bed replaces the one that was playing,
   and the claim is what keeps an older sound event's clock from cutting the newer bed. */
public EffectMusicSwap()
{
	BeginEvent("music_swap");

	if (g_musicSwapActive)
		EndMusicSwap();

	g_musicSwapActive = true;
	ClaimTake(CLAIM_AUDIO, FindEffect("music_swap"), 1);

	new Float:seconds = EffectSeconds(20.0);
	StartEffectTimer("music_swap", seconds);
	log_amx("music_swap: the broadcast bed changes for %.0f s", seconds);
	DonorSay("NEW TRACK");
}

stock EndMusicSwap()
{
	ClaimRelease(CLAIM_AUDIO, FindEffect("music_swap"));
	log_amx("music_swap ended");
	g_musicSwapActive = false;
}

/* The built-in pack: a panel run has no viewer phrase, and an event with nothing to say is a refund.
   ASCII only, because GoldSrc chat cannot render anything else. A switch instead of a 2D table: the
   compiler that builds this file aborts on a jagged initialiser at this size. */
stock RandomQuote(dest[], len)
{
	switch (random(6))
	{
		case 0: copy(dest, len, "I'LL BE BACK");
		case 1: copy(dest, len, "MAY THE FORCE BE WITH YOU");
		case 2: copy(dest, len, "SAY HELLO TO MY LITTLE FRIEND");
		case 3: copy(dest, len, "HERE'S JOHNNY");
		case 4: copy(dest, len, "YOU SHALL NOT PASS");
		default: copy(dest, len, "WHY SO SERIOUS");
	}
}

/* The second gate on a phrase: the API sanitizes `text=` into one RCON token (spaces become
   underscores), the built-in pack is ours, and a panel run may still patch the parameter by hand.
   Underscores become spaces here - the subtitle must read like a sentence - and GoldSrc chat is ASCII,
   so anything else becomes '?'. */
stock CleanPhrase(text[])
{
	new length = strlen(text);
	for (new i = 0; i < length; i++)
	{
		new c = text[i];
		if (c == '_')
			text[i] = ' ';
		else if (c < 32 || c > 126)
			text[i] = '?';
	}
}

/* The middle of the fight: the average of the alive bots. Used by the hill and by the bell, because a
   geometric map centre is wrong on half the pool and a centre that moves with the field is a hill nobody can
   hold. */
stock bool:AliveBotCentre(Float:out[3])
{
	new bots;

	out[0] = 0.0;
	out[1] = 0.0;
	out[2] = 0.0;

	for (new id = 1; id <= get_maxplayers(); id++)
	{
		if (!IsBotAlive(id))
			continue;

		new Float:origin[3];
		pev(id, pev_origin, origin);
		out[0] += origin[0];
		out[1] += origin[1];
		out[2] += origin[2];
		bots++;
	}

	if (bots == 0)
		return false;

	out[0] /= float(bots);
	out[1] /= float(bots);
	out[2] /= float(bots);
	return true;
}

/* A point a body can stand in. The engine snaps a bot out of solid space without an error, and a duel that
   never happens reads exactly like a duel that was won in one frame. */
stock bool:SafeSpot(const Float:point[3])
{
	new Float:head[3];
	head[0] = point[0];
	head[1] = point[1];
	head[2] = point[2] + 32.0;

	if (engfunc(EngFunc_PointContents, point) == CONTENTS_SOLID)
		return false;
	if (engfunc(EngFunc_PointContents, head) == CONTENTS_SOLID)
		return false;

	return true;
}

/* Knockback: how far a hit throws a class bot. Horizontal, away from the attacker, capped at
   KNOCKBACK_CAP units a second. An impulse instead of a damage multiplier on purpose - a raptor that
   took 160 % damage would be a 3 000 HP bot that dies like a 1 875 HP one, and what the catalogue sells
   here is the movement. A bot thrown into a wall or off the map is not a class, it is a missing player. */
stock PushBot(victim, attacker, Float:damage)
{
	if (victim <= 0 || attacker <= 0 || victim == attacker || damage <= 0.0)
		return;

	new Float:attackerOrigin[3], Float:victimOrigin[3];
	pev(attacker, pev_origin, attackerOrigin);
	pev(victim, pev_origin, victimOrigin);

	new Float:dx = victimOrigin[0] - attackerOrigin[0];
	new Float:dy = victimOrigin[1] - attackerOrigin[1];
	new Float:length = floatsqroot(dx * dx + dy * dy);
	if (length < 1.0)
		return;

	new Float:push = damage * float(g_classKnockback) / 100.0 * KNOCKBACK_SCALE;
	if (push > KNOCKBACK_CAP)
	{
		push = KNOCKBACK_CAP;
		g_classCappedPushes++;
	}
	g_classPushes++;

	new Float:velocity[3];
	pev(victim, pev_velocity, velocity);
	velocity[0] += dx / length * push;
	velocity[1] += dy / length * push;
	set_pev(victim, pev_velocity, velocity);
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

	// S5 chases read the kill feed: the ladder promotes the killer, and whoever kills the mark is paid.
	if (g_trainActive)
		GunTrainKill(killer);
	if (g_markActive)
		HeadHunterKill(victim, killer);

	// The sniper's loop: a kill pays one round of the five back. Only the hero's own kill counts, and only
	// while the role is the sniper's.
	if (g_heroActive && equali(g_heroCode, "sniper") && killer == g_heroBot)
		SniperReward();

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
	// Knockback is read before the knife rules below: a class bot is thrown by every hit, not only by a
	// knife, and an early return here would shadow the whole class system on a rifle round.
	if (g_classActive && g_classKnockback != 100 && IsClassed(victim))
		PushBot(victim, attacker, damage);

	// Vampiric aura is a rule about who is healed, so it belongs here for the same reason: every hit
	// counts, and the damage itself is left alone - the aura gives health back, it does not take more.
	if (g_auraActive && g_auraShare > 0 && damage > 0.0)
		AuraHeal(attacker, damage);

	// Fire grenades: DMG_BLAST is the engine's own label for an explosion, so a blast while the event
	// runs is the trigger. No entity tracking, and it cannot miss an HE the engine itself resolves.
	if (g_fireActive && (damagebits & DMG_BLAST) && damage > 0.0)
		IgniteBot(victim);

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

/* The launcher's bullet, thrown away. Without this the bazooka bot is an AWP with a rocket on top: the
   hitscan would do the killing and the rocket would be decoration. Only while the launcher is in hand - a
   rifle the bot picked up off the ground keeps its own damage. */
public OnTraceAttack(victim, inflictor, attacker, Float:damage, Float:direction[3], trace, damagebits)
{
	// A bot on a locked kit cannot hurt anybody with a weapon that is not its kit. This is the shot itself,
	// not the sweep: measured live (2026-10-31) a nemesis with 13 500 HP took a kill with an AK between two
	// sweep passes, and half a second is long enough for a kill. The bullet is dropped and the kit goes
	// back; the knife does not trace, so a knife round never reaches this branch.
	if (attacker > 0 && IsBotAlive(attacker) && KitMismatch(attacker))
	{
		EnforceKit(attacker);
		return HAM_SUPERCEDE;
	}

	if (!g_bazookaActive || attacker != g_bazookaBot)
		return HAM_IGNORED;

	if (get_user_weapon(attacker) != CSW_AWP)
		return HAM_IGNORED;

	return HAM_SUPERCEDE;
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
