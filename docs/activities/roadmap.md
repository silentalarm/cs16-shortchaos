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

- [ ] zombie model pack in the image, precached, applied and reset;
- [ ] health scaling `baseHealth + perBot × alive bots`, boss knife, speed, camera lock;
- [ ] `outbreak` conversion on `DeathMsg`;
- [ ] `chaos_plague` calls `amx_chaos force`;
- [ ] on sale: `nemesis`, `survivor` first, the other four after the first pair is stable.

**Done when:** a boss round ends on its clock in front of the camera, twice in a row, with no stuck bot.

## Stage 3 — S2 classes (5 codes)

- [ ] one parameterised applier (`count`, `health`, `speed`, `gravity`, `regen`, `knockback`);
- [ ] respawn re-application (health and gravity do not survive death on their own);
- [ ] smoke test on all seven maps.

**Done when:** the five codes are one function and a table, not five handlers.

## Stage 4 — S4 skills (5 codes)

- [ ] chicken model in the image; `hex_wave` with a proper reset;
- [ ] `chain_lightning` beams and damage;
- [ ] `blink_bots` with a trace, no bot inside geometry;
- [ ] `hero_roulette` pool of four, hidden until it fires;
- [ ] `vampiric_aura` in `Ham_TakeDamage`.

**Done when:** the chicken shows up on the stream and the bot gets its model and weapons back afterwards.

## Stage 5 — S3 items (5 codes)

- [ ] the bazooka entity first, measured against `csdm_lite` respawn;
- [ ] fire and freeze grenades (burn task, `FL_FROZEN` plus sprite);
- [ ] plasma rifle and laser mines only if the bazooka is stable.

**Done when:** one custom weapon survives a full respawn cycle and its model is visible in the stream.

## Stage 6 — S5 chases (5 codes)

- [ ] `guntrain` ladder with per-bot progress and the panel showing the leader;
- [ ] `statues` line-of-sight freeze;
- [ ] `head_hunter`, `king_of_the_hill`;
- [ ] `duel_bell` teleports, verified on all seven maps.

**Done when:** every one of them runs for its whole clock with no bot stuck outside the map.

## Stage 7 — S6 physics (6 codes)

- [ ] `airstrike` converging strikes;
- [ ] `weapon_rain` with the 5-entity cap;
- [ ] `quake`, `fire_ring`, `invert_velocity`, `low_gravity_knives`;
- [ ] `sv_gravity` restored after `amx_de clear`, verified over RCON.

**Done when:** none of the six survives its clock — no permanent gravity, no permanent velocity flip.

## Stage 8 — S8 sound (4 codes)

- [ ] siren and countdown through `infra/sounds` → WAV → `voice.sh`;
- [ ] `quotes_pack` through the TTS path (`src/voice.ts`), subtitle in chat;
- [ ] `music_swap` with the audio-bed claim;
- [ ] levels checked with `node scripts/wav-levels.ts`.

**Done when:** two sound events in the same second do not clip the mix.

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

