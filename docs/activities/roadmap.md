# Roadmap

The order of work, one stage per system. A stage is done only when its checklist is green: the
catalogue, the plugin, the tests, the image and the docs move together, because a code that works in
the game but is missing from `config/activities.json` is a code nobody can buy.

Legend: `[ ]` not started, `[x]` done, `[~]` in progress.

## Stage 0 — the foundation (no new activities)

Everything else stands on this: without it a second event cancels the first one's state.

- [x] claim layer in `donation_events`: `ClaimTake` / `ClaimRelease` / `ReleaseAllClaims` /
      `ClaimGravity` — the effective owner is the newest claim, and a release reports whether the
      caller may undo its state;
- [x] `EndEffectState` owns an undo for **every** code; the `CleanupActive()` fallback is gone (it
      stays only in `Round_End`, `ClearAll`, `plugin_end`);
- [x] parameters are snapshotted per command (`g_meteorRadius`, `g_meteorDamage`, `g_cannonHealth`,
      `g_redStockCues`), and a contract test refuses a `Param*` read inside a timer;
- [x] `MAX_EFFECTS` 30 → 56, task id ranges documented in the plugin header;
- [x] `amx_de status` reports a list (`active=a+b+c`) built by `ActiveList`;
- [x] the 17 removed codes are deleted from the catalogue *and* the plugin (2408 → 1690 lines);
- [x] tests: the catalogue count, the on-sale list, the claim/undo contract, the `status` parser;
- [x] `npm test` (295 green), `npm run typecheck`, image rebuilt, plugin compiled — the artifact is
      `donation_events.amxx` in `cs16-hlds:local`;
- [ ] live check on the running server: `amx_de codes` (six codes) and `amx_de status` with two
      effects armed at once.

**Done when:** the 6 kept codes are the whole catalogue, two effects run at once and the end of one
leaves the other intact.

## Stage 1 — the camera lock (`plugins/stream_cam`)

- [x] `amx_stcam lock <nick|#userid> [seconds]` (20 s default, 600 s ceiling), plus `amx_stcam unlock`;
- [x] the director stops picking a new target while a lock is active: `PickTarget` refuses, and the
      dwell/hold rules are skipped (`!CameraLocked(now)`), so a paid cut is not re-rolled on a timer;
- [x] a lock that outlives its owner is dropped on death, on disconnect and on round start
      (`ReleaseLock` is the single exit), and the bot keeps the frame for one more dwell when the
      clock runs out instead of being cut on the tick it expires;
- [x] `stream_cam status` reports `locked=<name|none> lock_left=<sec>`, and the panel reaches the lock
      through `POST /api/camera` (`{ "target": "Mr Smith", "seconds": 45 }`, `{ "release": true }`),
      recorded in `admin_actions` as `camera_lock`;

**Done when:** the panel can cut to a chosen bot for 20 s and the director does not fight it. Built:
298 tests green, plugin recompiled; the live cut on a running server is the first thing stage 2 checks.

## Stage 2 — S1 round modes (6 codes)

- [x] the hero system: `baseHealth + perBot × alive bots`, a fixed weapon, the knife damage rewritten
      in `Ham_TakeDamage`, ×speed, red glow, and the camera locked with `amx_stcam lock` (stage 1);
- [x] the role moves to a new bot when the hero dies (`TaskHeroGuard`, task 4801), with the numbers
      snapshotted - a replacement must not be a cheaper fight;
- [x] `nemesis` and `survivor` on sale, each with a 60 second bed in `src/music.ts` (a 15 second loop
      under a minute of round is 45 seconds of silence);
- [x] `EndHero` releases health/speed/glow/weapons/camera through the claim layer, `ResetEventState`
      drops the guard task and unlocks the camera on a full reset;
- [x] the four other codes of the system: `outbreak` (a third of the field infected, a knife kill
      converts and the respawn hook re-arms the victim), `juggernaut` (the role goes to its killer),
      `sniper` (one bot, an AWP and five rounds; a kill pays a round back, and the shot that empties the
      budget takes the launcher away - the budget is counted in shots because `csdm_lite` refills every
      reserve once a second) and `chaos_plague` (boss + infection + a forced `juggernaut`); `sniper` replaced
      `assassin` on 2026-10-31, see the note in `catalogue.md`;
- [x] the infection is a per-slot flag, not a health value: csdm_lite gives the bot a rifle half a
      second after it dies, so only a flag survives the death the conversion depends on;
- [~] the nemesis' own look: **the models are made** - `infra/models/build/nemesis.mjs` re-skins the game's
      own soldier and knife into `models/player/nemesis/nemesis.mdl` and `models/p_nemesis_knife.mdl` (new
      files; the stock ones are only read), PASS on `check`, both copied into the image and synced into the
      volume under `models/player/`. **The plugin hook is not in yet**: `cs_set_user_model` +
      `pev_weaponmodel` in `ArmHero`/`TaskKitSweep`/`EndHero` made amxxpc abort with `std::bad_alloc`, and
      the first root cause found on the way was a stray duplicated comment block after `KitWeapon`'s header
      (fixed). What is left is a bisect of the remaining four hooks against the local compiler harness
      (`.tmp-amxx/probe3.sh`: amxxpc out of the pinned AMXX archives, run in `amxxpc-runner:local`) - every
      probe is 20 seconds instead of a two-minute image build;
- [ ] the rest of the model pack: `survivor`/`juggernaut` still wear stock uniforms, and the zombie set
      (`zombie_source`, S7) is still unwritten (S7);
- [x] the newer run replaces the older one here too: `StartHero`/`StartOutbreak` end the running code
      before taking over, and `EndHero`/`EndOutbreak` ignore a code that is not the one on screen - a
      `nemesis` bought over a `survivor` used to lose its camera lock and its health claim to the
      survivor's clock, and a second `outbreak` lost its infected flags to the previous run's clock.
      Verified on the test server: `nemesis` -> `survivor` 21 s later logged `hero 'nemesis' is not the
      running one, nothing to undo` and the survivor ran to its own timer; `outbreak` -> `chaos_plague`
      logged the same for the infection while the plague kept converting bots;

**Done when:** a boss round ends on its clock in front of the camera, twice in a row, with no stuck bot.
All six codes are in the plugin and on sale; what is left is the live round and the models.

## Stage 3 — S2 classes (5 codes)

- [x] one parameterised applier (`count`, `health`, `speed`, `gravity`, `regen`, `knockback`): `StartClass`
      / `ArmClass` / `EndClass` in `donation_events`, five thin handlers that pass their numbers;
- [x] respawn re-application (health and gravity do not survive death on their own): the per-slot flag is
      read by `OnPlayerSpawn` and the class shape is re-applied by `ReArmOnSpawn` through `ArmClass`;
- [x] the five codes on sale at 50 RUB with their own music beds (`src/music.ts`, 45 s and 30 s);
- [x] the newer run replaces the older one: `StartClass` ends the running class before it takes over, and
      `EndClass` ignores a code that is not the one shaping the field - without that guard the replaced
      run's clock cleared the flags and the regeneration task of the run on screen. Verified on the test
      server: `raptors` -> `runners` 22 s later logged `class 'raptors' is not the running one` and the
      runners ran to their own clock, with no error in the AMXX log;
- [x] `knockback` as a capped impulse (`PushBot`) instead of a damage multiplier, and the run reports
      what it did - `class 'brutes' ended: 507 knockback(s), 178 at the cap` - because a push leaves no
      other trace: the bot stands where it lands and the log says nothing. Live at `knockback=400`:
      fy_iceworld 507 impulses in 45 s, 178 of them at the 400 u/s ceiling, fy_aztec 296 with 182 at it,
      and nobody left the map - zero `worldspawn` suicides inside either run (the only ones in the
      window came from the map change itself). The field stayed at 18-20 bots, which is YaPB filling a
      freshly loaded map, not bots disappearing;
- [x] smoke test on all seven maps: `scripts/map-walk.ts` walks the rotation and fires one activity per
      map (`nemesis`, `raptors`, `outbreak`, `jumpers`, `runners`, `brutes knockback=400`,
      `regenerators`). All seven started with their own CRC (`fy_iceworld`, `fy_pool_day`, `fy_snow`,
      `fy_buzzkill`, `fy_simpsons`, `fy_aztec`, `fy_dustworld`), every activity applied to 17-20 live
      bots, 20 bots still on the server afterwards, no `error_*.log` and no `TEX_InitFromWad` in the
      console. The walk is a committed tool, not a one-off: it fails non-zero when a map does not load
      or an activity does not start;

**Done when:** the five codes are one function and a table, not five handlers. Built: one applier, five
rows, `npm test` green, plugin compiled into the image (27 097 B in the `cs16-hlds:local` build, which
the entrypoint syncs into the volume on every start, so a rebuild is now the whole deploy). All five
codes are checked: the seven maps are walked with one activity each, the swapped-out run is proven a
no-op on a live server, and knockback is counted rather than guessed. Left for a watched round: whether
YaPB still reads as jumping *sanely* at 58 % gravity - the walk shows it jumps, not whether it looks like
a bunny.

## Stage 4 — S4 skills (5 codes)

- [x] five handlers in `donation_events`, each with its own clock, its claim and its undo branch:
      `hex_wave`, `chain_lightning`, `blink_bots`, `hero_roulette`, `vampiric_aura`;
- [x] `chain_lightning` draws `TE_BEAMPOINTS` between the bots it damages and deals through
      `Ham_TakeDamage`, and the run logs `N bolt(s), M bot(s) hit` so a bolt nobody can see is still
      countable. Live: `chain_lightning ended: 6 bolt(s), 18 bot(s) hit` - 20 s at a 3 s period is six
      bolts, and three targets a bolt is eighteen hits, so nothing was skipped;
- [x] `blink_bots` traces with `EngFunc_TraceLine` before `EngFunc_SetOrigin`, refuses a landing whose
      feet are `CONTENTS_SOLID` and a blink that stops before half the distance, and logs
      `N of M blink(s) landed` - the engine snaps a bad origin back without an error, so the count is
      the only evidence the skill did anything. Live: `80 of 95 blink(s) landed`, and the 15 refusals are
      the wall the trace was there to stop;
- [x] `hero_roulette` picks its power at arm time, applies it 6-12 s later and announces nothing before
      that; `pool` is a list of names from the catalogue, so switching a power off needs no recompile.
      Live: `'invisible' armed on bot 20, fires in 10.2 s`, then `hero_roulette ended: 'invisible' had
      been on the field`;
- [x] `vampiric_aura` heals in `Ham_TakeDamage` at `share` percent of the damage, capped at
      `REGEN_CEIL` - the same ceiling the regeneration class uses;
- [~] the chicken model: `hex_wave` works without it (weapons stripped, 60 % speed, a yellow glow, and
      the costume name plus `no model in the image` in the log), and the costume switches on by itself
      when `models/player/chicken/chicken.mdl` lands in the image. The guard is not cosmetic: precaching
      a .mdl that is not there is **`FATAL ERROR (shutting down): Mod_LoadModel: ... not found`** on
      GoldSrc and the server goes into a restart loop - measured, on the first run of this code. So the
      file is checked with `file_exists` before `precache_model`, and a contract test keeps that order;

**Done when:** the chicken shows up on the stream and the bot gets its model and weapons back afterwards.
All five codes are in the plugin, in the catalogue as `ready`, and checked on the test server: `amx_de
codes` lists them, each clock ends on its own, and the undo path runs with no AMXX error log. Three of
them now run in the free rotation (`chain_lightning`, `hero_roulette`, `vampiric_aura`); `hex_wave`
waits for the chicken `.mdl` and `blink_bots` stays out because a teleport leaves the bot with a stale
goal (`docs/runbook.md`, "bot_antistuck"). What is missing is the on-sale step once the picture is
confirmed.

## Stage 5 — S3 items (5 codes)

- [x] `fire_grenades`: the field keeps HE grenades in hand (twice a second, like the HE party) and every
      bot a blast catches burns for `burn` seconds at `damage` a tick, with an orange shell. The trigger
      is the engine's own `DMG_BLAST` flag in the damage hook, not a scan for grenade entities: the
      engine already resolved the explosion, and a scan is a second guess at the same fact with a frame
      of lag on it. The run logs `N bot(s) burned, M tick(s) of fire`, and the undo drops every task and
      every countdown, so a bot cannot leave the map on fire. Measured live: with a `meteor_shower`
      providing the blasts, `30 bot(s) burned, 425 tick(s) of fire` in 30 s - the whole path works. But
      over 30 s of grenades alone **nobody burned**: YaPB bots hold an HE and never throw it. So the event
      now carries a blast of its own: `TaskFireSpark` drops one explosion every 4 s next to a random bot,
      `radius` wide, at `FIRE_SPARK_DAMAGE` - and it is labelled `DMG_BLAST` through `Ham_TakeDamage`, so
      the ignition stays in the one hook the meteor path already proved. A thrown HE is still a blast; it
      is simply not the only one. Live on `fy_iceworld` (2026-10-31): `fire_grenades ended: 18 bot(s)
      burned, 230 tick(s) of fire` inside its 30 s clock, `amx_de status` back to `active=none` on the
      timer and no new line in the AMXX error log - the event's own spark ignites the field, which the
      grenade-only run never did. `TaskFireParty` handed the grenade out once, and a thrown HE keeps the
      weapon entity in the inventory with an empty reserve, so a bot threw exactly one per event - the
      same bug `he_party` was fixed for; the reserve is now refilled on every 0.5 s pass
      (`FIRE_PARTY_GRENADES`), so the field keeps throwing while the clock runs, and the end line carries
      the count that proves it: live on `fy_iceworld` (2026-11-02) `fire_grenades ended: 18 bot(s) burned,
      144 tick(s) of fire, 96 grenade(s) thrown` in 30 s - 96 throws where the one-pass version could only
      manage one per bot. Left: the on-sale step, and it wants a stream watch, not another server run;
- [x] `freeze_nades`: the field keeps flashbangs in hand and a flashbang that goes off freezes every bot in
      `radius` for `freeze` seconds under a blue shell. The trigger cannot be `DMG_BLAST` - a flashbang deals
      no damage and never reaches `OnTakeDamage` - so a 0.25 s scan reads the `grenade` entities themselves:
      each live flashbang is remembered with its last origin and its `pev_dmgtime`, and one that is gone
      within a stride of its own fuse is a detonation at that origin. `TaskFlashSpark` adds the same half as
      the fire event: one pulse every 4 s on a random bot, the stock `weapons/flashbang-1.wav` as its bang,
      and the same `FlashBlast` the scan calls, so there is one freeze path with two sources. The undo drops
      the four tasks, every countdown and the claim, and the log always reports `N blast(s) seen, M bot(s)
      frozen`, so a run where nothing happened says so. Live on `fy_snow` (2026-10-31): `freeze_nades
      ended: 21 blast(s) seen, 41 bot(s) frozen`, `active=none` on the clock. The event's own pulse is one
      blast every 4 s, so seven of the twenty-one; the other fourteen arrived through the grenade scan, so
      that branch is not idle. The log cannot tell a bot throw from a live grenade the engine cleared, and
      it does not have to: the count the viewer gets is the 41 freezes. Left: the on-sale step and a stream
      watch;
- [x] `bazooka_drop`: the launcher is a weapon the bot fires. A custom weapon entity is not reachable from
      a plugin - YaPB picks what to shoot from its own weapon list and nothing in that list is ours - so
      the carrier is armed with `weapon_awp` (one shot per bolt cycle, which is the launcher's rhythm) and
      three things are put on top of it: **the model** (the engine draws a player's third-person weapon
      from that player's `weaponmodel` field, so `models/p_bazooka.mdl` is written into the field every
      0.25 s - the game puts the AWP's own model back on every switch and every spawn, which is why one
      write was not enough and why the earlier prop read as a launcher floating over the bot), **the
      trigger** (`Ham_Weapon_PrimaryAttack` on the carrier's `weapon_awp`, so the bot aims and fires by
      itself) and **the shell** (the AWP's bullet is superceded in `Ham_TraceAttack`, and a rocket - the
      `zerogxplode` sprite, additive, 900 u/s - flies along the view and explodes on the first thing it
      meets, `damage` 500 in `radius` 320 with falloff, through `Ham_TakeDamage` and `DMG_BLAST`, so the
      kill is the blast and not the hitscan). Both models are made in this repository (SMAK, MIT, PASS on
      `smak check --engine goldsrc`). The run logs `N rocket(s) fired, M blast(s), K bot(s) hit`, the
      respawn hook re-arms the carrier and the role moves to a living bot on each death, and the undo
      drops the dress tick, every rocket in the air and the model field. The first live run (2026-10-31)
      said the rocket was there but *invisible* - 0.6 of sprite scale next to a 72 unit bot - so the rocket
      now carries a beam trail from step to step, a flash and a muzzle streak at launch, and every blast
      draws its own radius as a `Shockwave()` ring; the same run measured the carrier dying on its own
      explosion six times in 45 s, so the owner is out of its own blast. The second run showed the sprite
      itself as a **black square** (an entity does not animate a sprite, and frame 0 of `zerogxplode` is
      black), so the rocket has no model at all now: it is the collider, and what the viewer sees is the
      beam streak. And the launcher in the hand sat at the bot's feet: the engine draws a player's weapon
      model in the model's own space, and the stock p_ files put their geometry at the hand's rest position
      (`HAND` in `infra/models/build/bazooka.mjs`), which is where the mesh is built now. The on-sale step
      is done (2026-11-01: `enabled: true`, 30 s); left: a stream watch, because the launcher in the hand
      and the carrier's rockets are still unconfirmed by eye;
- [ ] plasma rifle and laser mines only if the bazooka is stable.

**Done when:** one custom weapon survives a full respawn cycle and its model is visible in the stream.
`fire_grenades` is the first code of the system and it needs no new asset.

## Stage 6 — S5 chases (5 codes)

- [x] `guntrain` ladder with per-bot progress: the rung is per slot and survives death - the respawn branch
      re-arms the bot with `g_trainLadder[g_trainLevel[id]]` and only while `ClaimTake` says the ladder still
      owns the weapon pool, so a newer weapon event is not fought over. Every rung is
      checked by `IsSafeWeapon` before `give_item`, the promotion is counted, and the leader is announced in
      chat and the AMXX log - the panel line is not wired yet (it would need a cvar and a `game-poller` read);
- [x] `statues` line-of-sight freeze: one pass traces the whole field (`CanSee`, eye to chest, 0.98) and
      freezes every bot somebody can see, then thaws the ones nobody does. The freeze is the shared
      `CLAIM_FREEZE`, so `red_light` and `freeze_nades` cannot fight it: the newest claim owns the field;
- [x] `head_hunter`: the mark wears a red shell, moves every `period`, and its killer gets `reward` plus a
      gold shell that is counted down and taken off. The reward weapon itself lives with the body - csdm_lite
      respawns a bot seconds after the death that pays here, so "until death" is the honest bound in the
      catalogue's `hold`;
- [x] `king_of_the_hill`: the hill is the average of the alive bots at start, not the geometric centre
      (`fy_aztec`'s centre is a building); a continuous `hold` inside `radius` pays `health` HP and an M249,
      and leaving resets the clock. Claims health and weapons;
- [~] `duel_bell` teleports: both spots are checked with `EngFunc_PointContents` before `EngFunc_SetOrigin`,
      and a pair with no free spot skips the ring instead of dropping a bot into a wall. Verified on one map
      live; the seven-map walk for this code is still open (the smoke test in `scripts/map-walk.ts` walks the
      pool, and this stage's `Done when` asks for it on all seven);

**Done when:** every one of them runs for its whole clock with no bot stuck outside the map.

## Stage 7 — S6 physics (6 codes)

- [x] `airstrike` converging strikes;
- [x] `weapon_rain` with the 5-entity cap;
- [x] `quake`, `fire_ring`, `invert_velocity`, `low_gravity_knives`;
- [x] `sv_gravity` restored after `amx_de clear`, verified over RCON.

**Done when:** none of the six survives its clock — no permanent gravity, no permanent velocity flip.

Built: each code owns a 48xx task and a branch in `EndEffectState`; `invert_velocity` takes
`CLAIM_VELOCITY` and gives the field one last flip when its claim is the newest, `low_gravity_knives`
writes `sv_gravity` through `ClaimGravity` and restores the base only when it is the top claim; the
five boxes of `weapon_rain` are `armoury_entity` weapons (`cs_set_armoury_type` + a hand-set world
model, because the native does not touch the model) and are removed with the clock. 310 tests green,
plugin compiles.

Live on `fy_iceworld` (2026-10-31): `amx_de codes` lists 35 codes; `airstrike` landed 10 of 10 strikes
and hit 14 bots; `weapon_rain` dropped 5 boxes; `quake` ran 15 ticks and 200 shoves; `invert_velocity`
made 701 flips and ended on its clock; `fire_ring` caught 10 bots and ended on its clock;
`low_gravity_knives` took `sv_gravity` 800 → 150 → 800 both on its own 5 s clock and on `amx_de clear`;
`amx_de status` reported `active=none` at the end. No AMXX runtime errors in the log.

## Stage 8 — S8 sound (4 codes)

- [x] siren and countdown, synthesised on the broadcast side (no asset file, no licence);
- [x] `quotes_pack` through the TTS path (`src/voice.ts`), subtitle in chat;
- [x] `music_swap` with the audio-bed claim;
- [x] levels checked with `node scripts/wav-levels.ts`.

**Done when:** two sound events in the same second do not clip the mix.

Built: the game side prints the line and takes `CLAIM_AUDIO`, the broadcast side owns the mix.
`siren` and `music_swap` are two new beds in `TRACKS` (`src/music.ts`), rendered at image build like
the other seventeen; the siren needed `gain: 2.5`, because a track with no bass and no drums measured
8 dB under its neighbours. `announcer_countdown` schedules four TTS cues (`countdownCues`) on the
same one-second ticks the plugin uses for its chat numbers. `quotes_pack` speaks the viewer's phrase
after the announcement, sanitised to the same ASCII form the chat shows, and falls back to a built-in
pack when a panel run carries no message.

Two events in the same second cannot clip: `voice.sh` keeps exactly one bed (`start_music` kills the
previous pid) and plays speech and cues sequentially through the poll loop, so a second bed replaces
the first instead of stacking on it.

Measured on the generated files: `siren.wav` 15.00 s, mean -18.3 dBFS, peak 0.522; `music_swap.wav`
20.00 s, mean -18.7, peak 0.725; `default.wav` mean -19.7, peak 0.519 - every bed within ~1.5 dB of
its neighbours. The plugin was live-run on `fy_iceworld`: `amx_de codes` lists 39 codes; the countdown
logged 2, 1 and FIGHT and ended on its own 10 s clock; `quotes_pack text=HELLO_WORLD` printed
`said HELLO WORLD` (the RCON token's underscores become spaces); `siren` and `music_swap` started and
`amx_de status` listed them together; `amx_de clear` left `active=none`. The stream image was rebuilt:
`siren.wav` (661 544 B) and `music_swap.wav` (882 044 B) are in `/usr/share/cs16/music`, and
`espeak-ng`/`paplay` are on the image. No live broadcast was started for this stage.

## Stage 9 — S9 ffmpeg meta (5 codes)

- [ ] prototype one filter driven by `sendcmd` on the real 720p pipeline;
- [ ] measure `docker stats` and the watchdog with the filter on;
- [ ] then `slowmo_stream`, `upside_down`, `dvd_screensaver`, `fake_crash`, `credits`;
- [ ] `fake_crash` marked as a simulation on screen.

**Done when:** a filter runs for 15 s without the watchdog reporting `frozen: true`.

## Stage 10 — S7 models (3 codes)

- [ ] measure the CPU envelope with one pack before shipping any of them;
- [ ] `zombie_skin`, `chicken_plague`, `model_madness`;
- [ ] fall back to the lighter pack if the envelope is exceeded.

**Done when:** twenty bots in custom models keep the stream inside its CPU budget.

## After the 44 are in

- [ ] decide price and rarity (`weight` in the schema, or waves of 10–12 enabled entries);
- [ ] the `boss_finale` accumulation bar described in `docs/events.md`;
- [ ] YouTube chat voting for the next event — the hook that made ChaosModV a format;
- [ ] rewrite `docs/events.md` and the `docs/runbook.md` sections that still describe the 2025-10 set.

## Definition of done (every stage)

1. `npm test` green, `npm run typecheck` clean;
2. the plugin compiles (`infra/build-hlds.sh`; needs Docker);
3. `amx_de codes` lists the new codes, and firing one from the panel shows it;
4. the stream survives the event: no `frozen: true`, no growing `logAgeSec`, no stuck bot;
5. `docs/activities/catalogue.md` status updated, this file ticked;
6. one line in the commit message naming the system, not the code.

