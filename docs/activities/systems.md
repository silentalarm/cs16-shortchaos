# The nine systems

Each system is one mechanic with parameters; a code in the catalogue is a preset of those
parameters. Sections follow the same shape: the idea and where it comes from, how it is built on
GoldSrc/AMXX, the parameters, the codes, the assets, what it has to claim, and what must be measured
before it is called done.

## Cross-cutting rules (they apply to every system below)

1. **One owner per resource.** `sv_gravity`, maxspeed, health, weapon pool, glow, freeze, damage
   rule, bot model, name, audio bed and camera are *resources*. An effect claims a resource and
   releases it on its own clock; when two effects want the same one the newest wins, and it wins by
   *ending* the run it replaced (`StartClass`, `StartHero`, `StartOutbreak` end the running code before
   they take over), so the replaced run's clock finds a code that is no longer current and does nothing
   instead of undoing numbers it no longer owns. That is the difference between "parallel" and "the
   last effect to end resets everything", which is what `EndEffectState`'s `CleanupActive()` fallback
   still does for the 18 legacy codes. Not built yet: a release puts the base value back and does not
   re-apply the claim still underneath, so two effects on one resource end the older one rather than
   degrade it.
2. **Parameters are per command, not per timer.** `g_paramKeys`/`g_paramValues` are overwritten by the
   next `amx_de` line, so a timer that fires later must read a snapshot taken in the handler.
   `red_light` already had to do this (`g_redStockCues`); every new code inherits the rule.
3. **A clock is mandatory for anything that lasts.** `csdm_lite` respawns every bot in half a second,
   so `Round_End` almost never arrives: `StartEffectTimer(code, EffectSeconds(...))` is the normal
   end, and `Round_End` / `amx_de clear` / `plugin_end` are only the fallback.
4. **Task id ranges.** `4013` HE party, `4021` donor tag, `4500 + registry index` effect clocks
   (the registry will hold 56), `4701+` existing per-effect tasks, **`4800+` for everything new**. A
   per-player timer needs an id→task map, because `client_disconnected` calls `remove_task(id)`.
5. **The camera is a resource too.** A round mode without a camera cut is money paid for shots taken
   off screen — the reason `sniper_moment` was rejected. `amx_stcam lock <#userid> <seconds>` with a
   priority is the first stage of the roadmap, before any S1 code.
6. **Never cluster models in one frame area.** `crowd_pile` froze the capture client twice: llvmpipe
   renders on the CPU. Every system that adds models adds vertices — see the FPS check in `assets.md`.

## S1 — round modes (Zombie Plague)

**Idea.** The most popular CS 1.6 mod sells a *premise* for a whole round, not an effect: one bot
becomes a boss, a third of the field starts infected, one bot is a survivor. The viewer gets a story
with a beginning and an end, and the camera has a hero to follow.

**Source values** (Zombie Plague server tables): Boss Nemesis 30 000 HP + 1 500 per opponent, knife
250 damage, ×1.3 speed; Hero Survivor 2 500 HP + 75 per opponent; Outbreak starts about 33 %
infected; the Assassin is semi-invisible and fights with a knife. The constants are adapted to twenty
bots and a 60 s clock — 30 000 HP does not die inside a minute, so the health is
`baseHealth + perBot × alive bots` with the numbers from `catalogue.md`.

**Mechanic.** `cs_set_user_model` for the mode's model, `Ham_TakeDamage` for the boss knife,
`set_user_maxspeed` for the speed, a clock task for the end, `amx_stcam lock` for the camera.
Conversion in `outbreak` is `DeathMsg`: if the killer carries the infection flag, the victim rejoins
on the infected side with the zombie model and the infected health.

**Parameters.** `baseHealth`, `perBot`, `knife`, `speed`, `share`, `health`, `weapon`, `alpha`,
`chaos`.

**Codes.** `nemesis`, `survivor`, `outbreak`, `juggernaut`, `assassin`, `chaos_plague`.

**Assets.** Zombie player models, knife hit sounds, an announcer sting (see `assets.md`).

**Claims.** health (per bot), speed, model, camera, weapon pool.

**Measure.** Does a 60 s boss round actually end? If a Nemesis survives the clock every time, add a
damage ramp (+10 % incoming damage every 10 s) rather than a bigger knife: the viewer has to see the
ending.

## S2 — classes and archetypes (Zombie Plague classes)

**Idea.** The same mod on another axis: instead of one hero the whole field is re-specced — five fast
raptors, four slow brutes, everyone at 75 HP. Cheap to build (no new models) and it reads instantly,
because the movement changes before anything else.

**Source values.** Raptor 3 000 HP / 120 % speed / 160 % knockback; Tank 7 000 HP / 90 % / 55 %
knockback; Regenerator 35 HP/s; Jumper 58 % gravity; Runner 75 HP / 112 % speed.

**Mechanic.** One parameterised applier: pick N random bots, set health, `set_user_maxspeed`,
`pev_gravity`, arm a regen task. Knockback is added in `Ham_TakeDamage` by pushing the victim away
from the attacker.

**Parameters.** `count`, `health`, `speed`, `gravity`, `regen`, `knockback`.

**Codes.** `raptors`, `brutes`, `runners`, `jumpers`, `regenerators`.

**Assets.** Nothing beyond stock; the raptor growl is optional.

**Claims.** health, speed, gravity, regen rate. Two class events at the same time must not multiply:
the newer one replaces the older one for the bots it picks.

**Measure.** Bots with an overridden `pev_gravity`: does YaPB still jump sanely, and does the value
survive death and respawn the way maxspeed does?

## S3 — special items (Zombie Plague extras)

**Idea.** The item layer is what makes one ZP round different from the next: a bazooka in one bot's
hands, grenades that burn, mines on the ground. These are the clips people cut.

**Mechanic.** The two hard ones are custom weapons. `zp_extra_bazooka`, `zp_extra_plasmagun` and
`zp_extra_lasermine` are the reference implementations: a real entity with `v_`/`w_`/`p_` models,
fired from `Ham_Weapon_PrimaryAttack`, never `give_item`. Build the bazooka first and measure; if the
entity path is unstable on ReGameDLL, downgrade to `weapon_m249` with a bigger radius and keep the
model work for later. Fire and freeze are the easy half: an HE that sets a burn task (`60 damage a
tick`, orange sprite) and a flashbang that applies `FL_FROZEN` plus an ice sprite.

**Parameters.** `damage`, `radius`, `recharge`, `ammo`, `burn`, `freeze`, `count`, `period`.

**Codes.** `fire_grenades`, `freeze_nades`, `bazooka_drop`, `plasma_rifle`, `laser_mines`.

**Assets.** `v_`/`w_`/`p_` models for the bazooka and the plasma rifle, a mine sprite, fire and freeze
sprites (`sprites/zerogxplode.spr` is already precached), burn and freeze sounds.

**Claims.** weapon pool, the hero slot (camera), and for the mines their own entity list.

**Measure.** Does the bazooka entity survive `csdm_lite` re-arming? A custom weapon and a respawn
plugin fight over the weapon slots — that is the known failure mode, and it is why this system comes
after S1 and S2 and not before.

## S4 — skills (Warcraft 3 FT / Superhero)

**Idea.** WC3 FT and Superhero turned a shooter into a skill sandbox: chain lightning, hex, blink,
vampiric aura. As a donation the point is the visible absurdity — a bot turning into a chicken is the
funniest frame CS 1.6 can produce, and it costs one model.

**Mechanic.** `hex_wave` is `cs_set_user_model("chicken")` + `StripWeapons` + `set_user_maxspeed` on a
clock; `chain_lightning` is `TE_BEAMPOINTS` plus `Ham_TakeDamage` on up to three bots; `blink_bots` is
`trace_line` forward and then `set_user_origin`; `hero_roulette` picks one of four buffs and announces
nothing until it fires, because the surprise is the product; `vampiric_aura` heals the attacker inside
`Ham_TakeDamage` (`share` percent, capped at max health).

**Parameters.** `targets`, `damage`, `period`, `distance`, `pool`, `share`, `model`.

**Codes.** `hex_wave`, `chain_lightning`, `blink_bots`, `hero_roulette`, `vampiric_aura`.

**Assets.** Chicken model (CSO/ZP pack), a lightning sound, a hex sound.

**Claims.** model, health, speed, damage rule.

**Measure.** `set_user_origin` into geometry: a blink that lands a bot inside a wall is a stuck bot
for the rest of the event. Trace first and skip the bot when the destination is solid. The engine also
likes to snap a moved bot back — the same trap `set_user_origin` had in `docs/events.md`. Measured on the
test server: `precache_model` of a `.mdl` that is not in the image is not a warning, it is
`FATAL ERROR (shutting down): Mod_LoadModel: ... not found` and a restart loop, so any model a code can
name has to pass `file_exists` before it is precached.

## S5 — chases and arenas (GunGame, Hide'n'Seek, arena formats)

**Idea.** The formats that held CS 1.6 servers for years without any custom content: a weapon ladder,
freeze-on-sight, a marked target, a contested point, a duel. All of them are rules the viewer can
follow in three seconds — the best possible property for a stream nobody narrates.

**Mechanic.** `guntrain` needs a per-bot kill counter and a ladder from `params.ladder`, re-arming the
bot on `DeathMsg`; the panel prints the leader. `statues` traces between bots (`trace_line`) and
freezes the one that is looked at. `head_hunter` marks a bot (glow + name) and hands the killer an AWP
for `hold` seconds. `king_of_the_hill` is a distance check plus a 3 s hold timer, and `duel_bell`
teleports two bots to the map centre every `period` seconds.

**Parameters.** `ladder`, `reward`, `hold`, `period`, `radius`, `health`.

**Codes.** `guntrain`, `statues`, `head_hunter`, `king_of_the_hill`, `duel_bell`.

**Assets.** None; stock weapons and glows only.

**Claims.** weapon pool (the ladder), health, speed, camera (a duel cut), and for `guntrain` the
`team_war` score if the panel is showing it.

**Measure.** Teleporting (`duel_bell`, and later `blink_bots`) on all seven maps in `infra/maps`:
bots that land in a wall or under the floor never come back. Smoke test with `scripts/ui-preview.ts`
plus a live `amx_de` run on each map before the code goes on sale.

## S6 — world and physics (ChaosModV)

**Idea.** ChaosModV's most memorable effects are the ones that change the *world's rules* instead of
the player's stats: Airstrike Inbound, Vehicle Rain, Earthquake, Low Gravity, Invert Current Velocity.
The viewer instantly understands "the map is against them now".

**Mechanic.** `airstrike` is ten scheduled `TE_EXPLOSION` plus radius damage, converging on the frag
leader. `weapon_rain` spawns `armoury_entity` weapons one at a time (five maximum — every extra entity
is a model in the frame). `quake` writes `pev_velocity` on every alive bot every 0.7 s. `fire_ring`
damages everyone further from the centre than a shrinking radius. `invert_velocity` negates
`pev_velocity` on a fast timer, which makes forward input go backwards. `low_gravity_knives` is
`sv_gravity` plus the knife pool.

**Parameters.** `strikes`, `damage`, `radius`, `count`, `period`, `force`, `shrink`, `gravity`.

**Codes.** `airstrike`, `weapon_rain`, `quake`, `fire_ring`, `invert_velocity`,
`low_gravity_knives`.

**Assets.** `sprites/zerogxplode.spr` and the stock thunder sound are already precached; the siren
comes from S8.

**Claims.** gravity, health, weapon pool, and for `invert_velocity` the per-bot velocity each tick
(it has to be released on the clock, or the bot keeps moon-walking).

**Measure.** `sv_gravity` is a server cvar: two gravity events at once must serialise through the claim
layer, and `plugin_end` must restore the original even if the container is stopped mid-event. Check
the restore by reading `sv_gravity` over RCON after `amx_de clear`.

## S7 — models

**Idea.** A model swap is the cheapest way to change the whole picture: the same fight, but twenty
zombies, or half the field running around as chickens.

**Mechanic.** `cs_set_user_model` for every alive bot (and for a bot that respawns during the event,
so the swap has to be re-applied in the respawn hook, exactly like `he_party` re-arms the field).
Reset with `cs_reset_user_model` on the clock and in `ClearAll`.

**Parameters.** `model`, `share`, `pack`.

**Codes.** `zombie_skin`, `chicken_plague`, `model_madness`.

**Assets.** The three model packs in `assets.md`. This is the system that must be measured first and
shipped last: it is the only one that changes the rendering cost of every frame.

**Claims.** model (per bot).

**Measure.** `docker stats` and the watchdog's `logAgeSec` with the models on, on the heaviest map
(`fy_simpsons`). Target: the same CPU envelope as the stock models within ~10 %. If a pack does not
fit, prefer `zombie_classic` (fewer polys) over `zombie_source` — the viewer cannot tell the difference
at 720p, and the stream can.

## S8 — sound and announcer

**Idea.** Audio is what makes a paid moment feel like an event: an announcer counting down, a siren
before the strike, a laugh after a stupid death. It is also the cheapest system in the plan — no
models, no engine tricks.

**Mechanic.** Two paths, and they must not be mixed. *Game* sounds are `precache_sound` +
`emit_sound(0, CHAN_AUTO, …)` — stock files only, because a missing custom file is silent. *Stream*
sounds are files in `infra/sounds`, rendered to WAV at image build, played by `infra/stream/voice.sh`
into the same null sink `ffmpeg` records. `params.sound` / `params.music` already exist in the
catalogue and are dropped from the RCON line on purpose (`src/command.ts`).

**Parameters.** `sound`, `music`, `onlyMusic`, `maxPhraseLength`.

**Codes.** `announcer_countdown`, `quotes_pack`, `siren`, `music_swap`.

**Assets.** Siren, countdown voice, TTS quotes — all through the existing `src/voice.ts` +
`infra/stream/voice.sh` pipeline, peak-normalised at build time.

**Claims.** the audio bed: one music bed at a time, cues may overlap it, but two `music_swap` events
must not fight (newest wins, the older one is ended).

**Measure.** Two events with sound in the same second must not double the loudness — check the audio
levels with `node scripts/wav-levels.ts` and listen to the recorded `STREAM_OUTPUT` file.

## S9 — stream meta effects (ffmpeg)

**Idea.** ChaosModV's Misc/Screen category — DVD Screensaver, Deep Fried, Need Glasses, Blackout,
Fake Crash, Roll Credits — is the part viewers quote. On this stream the same effects can be done
*outside* the game: `ffmpeg` already composes the final frame and draws the panel with `drawtext`
layers that re-read their text files every frame (`reload=1`).

**Mechanic.** The filter graph is built once in `infra/stream/entrypoint.sh` (`VF`), so a dynamic
effect needs one of: a filter whose options are driven by `sendcmd` from a file (the cheapest), or a
second filter stage fed through a pipe (more CPU). Only filters that can be enabled or reconfigured at
runtime are usable: `rotate`, `crop`, `boxblur`, `eq`, `scale`, `drawtext`, `setpts`, `atempo`. A
`vflip` cannot be toggled — `rotate=PI` can.

**Parameters.** `factor` (slow motion), and nothing else: the rest are on/off.

**Codes.** `slowmo_stream`, `upside_down`, `dvd_screensaver`, `fake_crash`, `credits`.

**Assets.** None on the game side. `fake_crash` needs an error-window image rendered into the graph
(or a `drawtext` rectangle, which costs nothing and cannot be mistaken for a real crash).

**Claims.** the video and audio pipeline — one meta effect at a time, and never during a real
incident: a fake crash while the stream is genuinely down is a disaster for trust. The panel keeps
drawing, and `fake_crash` labels itself with a small "SIMULATION" marker.

**Measure.** `docker stats` with each filter enabled, on the real 720p pipeline. The container already
sits at 220–230 % CPU; if a filter pushes it into the watchdog's `frozen: true`, the filter is out.
This system is a prototype until its CPU cost is measured — that is why it is the last stage.

