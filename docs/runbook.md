# Runbook

## Stages

1. activity catalogue (done): `config/activities.json`, `src/activities.ts`, `src/mapping.ts`;
2. DonationAlerts OAuth + poller, cooldowns, queue, RCON client, SQLite history;
3. pinned ReHLDS image + YaPB + `donation_events` Pawn plugin;
4. end-to-end: real 50 RUB donation -> activity in game -> row in DB;
5. stream: ffmpeg -> private YouTube RTMP;
6. VPS, backups, health checks.

## The team race (`plugins/team_war`)

The stream is a race between T and CT: which side puts more bots down before the map changes. The
score is counted by the plugin from `DeathMsg`, not read from the engine scoreboard, because the
engine subtracts a frag for a team kill and this server is free for all with friendly fire on
(`mp_friendlyfire 1`, `yb_csdm_mode 2`). **A team kill counts for the killer's team.**

The HUD block is drawn by **stream_cam**, not by team_war:

```
T 12 : 9 CT
TOP T Smith 7  |  TOP CT Neo 5
Smith 100 HP 0 AR
```

Why: this client renders a single hudmessage per tick. A second message from team_war, on its own
channel, was overwritten by the name/HP line every second - verified on frames, the block never
appeared. So team_war publishes the numbers as cvars (`team_war_t`, `team_war_ct`, `team_war_top_t`,
`team_war_top_ct`) once a second, and stream_cam puts them into the one message it already sends to
the camera, at y=0.24.

- the score survives rounds; a map change re-initialises the plugin, which is the only reset;
- 0.24 is the anchor the single line used and it stays whole: the encoder cuts the top 20% band and
  0.20 lost the glyph tops. The block grows downwards from that anchor;
- `team_war_name_len` (14) trims a long nickname so the CT half stays inside the frame;
- team_war writes `score: T n : m CT` to the log once a minute: the only trace of the race in the
  server log, and what tells an empty score apart from a plugin that stopped counting;
- without `team_war.amxx` stream_cam keeps its plain `name HP AR` line.

```
amx_team_war status   t=12 ct=9 top_t=Smith:7 top_ct=Neo:5   (spaces in names become underscores)
amx_team_war reset    drop every counter
```

Cvars: `team_war_name_len` (14) and the four published values above.

Deploying a plugin change: rebuild the image (`infra/build-image.ps1`), then **recreate** the
container - `docker restart` keeps the old image:

```powershell
./infra/build-image.ps1
./infra/compose.ps1 up -d --force-recreate hlds
```

The server entrypoint syncs `configs/` and `plugins/` from the image on every start ("configs and
plugins synced from the image"), so a stale volume is not a problem; a stale *container* is.

## Every activity applies at once

`amx_de <code>` runs its handler in the same RCON call: there is no round queue and no separate
"instant" list any more. A viewer has to see the effect while they are still watching.

- round effects still end with the round: `Round_End` restores `sv_gravity` and the bot quota and
  drops the bounty / hot-potato / boss state;
- `bot_nick` lives until a map change, `map_change` changes the map immediately;
- several effects can run at the same time; `amx_de status` reports the last applied code as
  `active`, and `queued=0` stays in the line only because the admin panel parses it;
- health, weapons and armour are reset by the next spawn, so only cvars and glows need cleanup.

The 110, 130, 170 and 230 RUB steps are free again: the zone activities that used them were removed.

## CSDM: compiled from source, never loaded (dead weight)

CSDM is built from source inside the image, not downloaded as a binary: the project publishes no
releases, so `infra/checksums.env` pins a commit tarball (`CSDM_URL`/`CSDM_SHA256`) and
`infra/build-csdm.sh` compiles five modules with the `amxxpc` that is already in the build stage.
Only `csdm_main`, `csdm_equip`, `csdm_spawn_preset`, `csdm_misc`, `csdm_protection` are built; `ffa`,
`itemmode`, `tickets` and `spawn_editor` stay out, because every extra plugin is another hook on
`DeathMsg`.

**None of them is loaded** (`infra/plugins.ini`): they require the `csdm_amxx` C++ module, which is
not built, so `csdm_lite` does the job instead. Nothing in the image reads CSDM's data either: the
`configs/csdm/<map>.spawns.cfg` presets were used by `csdm_lite` while random spawns existed, and that
code is gone (see "Spawn points" below). The whole CSDM stage is dead weight and is the next thing to
remove: `build-csdm.sh`, `infra/csdm.cfg`, the `CSDM_URL` pin and the `/opt/defaults/csdm` sync.

Everything the old CSDM setup did through `csdm.cfg` now lives in `csdm_lite` cvars:
`csdm_lite_delay` (0.5 s respawn), `csdm_lite_weapons` (the random primary), `csdm_lite_health`
(100) and `csdm_lite_protect` (one second of godmode, the equivalent of `[protection] time 1`).

`server.cfg` changed with it: `mp_roundtime 3`, `mp_freezetime 1`, `mp_timelimit 20` (the old
`0` meant dust2 never rotated) and `yb_chat 1` with `yb_chat_percent 3` - a silent bot-only server
reads as dead.

`csdm.cfg` and `configs/csdm/*.spawns.cfg` are synced over the volume on every start
(`/opt/defaults`), so an edited config reaches an existing container without a volume wipe. After
editing any of it: `infra/build-image.ps1` then `infra/compose.ps1 up -d --force-recreate hlds`.
A plain `docker restart` keeps the old image and the old config.

## chaos_core: the chaos mod

`plugins/chaos_core/chaos_core.sma` runs a weighted random effect every `chaos_interval` seconds.
Every effect is a **start/stop pair**, so nothing can leak into the next round or the next map.

| Effect | Weight | Duration | Start | Stop |
|---|---|---|---|---|
| `speed` | 30 | 20 s | `sv_maxspeed 900` | restore the saved value |
| `gravity` | 30 | 20 s | `sv_gravity 200` | restore the saved value |
| `knives` | 25 | 15 s | every bot: knife only | nothing, the next spawn resets it |
| `awp` | 20 | 15 s | every bot: AWP | nothing |
| `juggernaut` | 20 | 20 s | every bot: 300 HP | nothing |
| `vampire` | 15 | 30 s | flag on, killer heals 25 HP per kill | flag off |

Commands (RCON or `server_cmd`): `amx_chaos status`, `amx_chaos force [code]`, `amx_chaos stop`,
`amx_chaos level <1-2>`, `amx_chaos interval <sec>`.

Safety: `sv_maxspeed` is clamped to 100..1500 and `sv_gravity` to 50..2000 before they are written;
`plugin_end` stops every effect, because a map change unloads the plugin while the engine cvars stay
set; at most `MAX_ACTIVE` (2) effects run at once and the previous effect is never picked again
immediately.

**One file, not two.** The plan had `chaos_core` + `chaos_effects`; a second plugin would need
cross-plugin natives, and a single registry with one run loop is easier to prove. Split it only if
the effect list outgrows this file.

The donation bridge is `chaos_burst` (140 RUB, instant): `donation_events` runs `amx_chaos force`,
which stops whatever is running and starts one effect immediately - a buyer paid for something
visible now, not in 45 seconds.

Verified live: `amx_chaos force speed` logged `'speed' started for 20s`, then `'speed' stopped`
exactly 20 s later and the timer continued on its own (`'knives' started`, `20 bots rearmed with
weapon_knife`, `'gravity' started`).

The scheduler is a **one-shot task that re-arms itself**, not `set_task(..., "b")`: with the repeat
flag the observed cadence did not follow `chaos_interval` (45 s gave starts 15 s apart), and a
self-scheduling task makes the period explicit. `ChaosTick` re-arms before doing anything else, so a
misbehaving effect can never stop the loop, and it restarts itself when someone changes
`chaos_interval` over RCON. Verified with `amx_chaos interval 10`: effects then started every ten
seconds, one at a time (level 1), each for its own duration.

## The respawn "meat grinder": csdm_lite

`plugins/csdm_lite/csdm_lite.sma` is the mode: on `DeathMsg` it waits `csdm_lite_delay` (0.5 s),
respawns the bot with `ExecuteHamB(Ham_CS_RoundRespawn)`, strips its weapons and gives one random
primary from `csdm_lite_weapons` (`ak47,m4a1,awp,xm1014,p90,mp5navy`), plus one second of
`set_user_godmode`. Only bots are respawned: the spectator camera is a client too, and moving it on
every bot death would take the picture off its target.

Verified on the live server: `csdm_lite_debug 1` over RCON then two minutes of log gave
`respawns=12`, `kills=31`; with the plugin off the same window had 2 kills in four minutes. The
respawn count is lower than the kill count on purpose - if the round ends first, the engine respawns
the bot and the task returns early without logging.

Cvars: `csdm_lite_enabled` (1), `csdm_lite_delay` (0.5), `csdm_lite_weapons`, `csdm_lite_health`
(100), `csdm_lite_protect` (1), `csdm_lite_debug` (0). The weapon list is re-read only at plugin
load, so changing it means `amx_reload` or a container restart.

### Spawn points: the map's own

Random spawn points across the map were built, measured, and then **deleted** from the plugin: a bot
that appears off the bot's navigation graph cannot build a path and stands still.

| Attempt | What happened | Kills |
|---|---|---|
| `set_user_origin` on respawn + round start | YaPB keeps the navigation node from the old place, cannot build a path, the bot stands still: 18 of 20 bots never fired a shot | 3 in 90 s |
| extra spawn entities from the CSDM preset (the engine spawns them) | same freeze: the points are not on YaPB's graph | 8 in 45 s |
| control: normal team spawns, FFA on | bots run and fight | 149 in 60 s |

The teams meet at their own spawns, so the picture keeps moving without random points - the grinder
only has to bring a dead bot back, which it does (`ExecuteHamB(Ham_CS_RoundRespawn)`). If the idea is
ever revived, it needs node data first, and the pinned bot cannot supply it:

- `YAPB_URL` pins `yapb-4.4.957-linux.tar.xz`, and 4.4.957 exports **no AMXX natives at all**: its
  `src/module.cpp` only implements the internal `IYaPBModule` interface, there is no `ext/amxx`, and
  the archive ships no `yapb.inc`;
- the node API (`yb_get_nearest_node`, `yb_get_node_origin`, `yb_get_node_link_count`) exists only on
  the `master` line, published as the **Continuous Build** pre-release, whose asset is rebuilt on
  every push - so a SHA256 pin would drift;
- the shipped `.graph` files are a compressed `bstor` blob (`magic`, `version`, `compressed_size`,
  `uncompressed_size`), not a flat node dump, so they cannot be parsed instead.

Two compiler traps found on the way, both `std::bad_alloc` with no diagnostics: a **char literal such
as `'\r'`** (compare with `line[i] <= ' '`) and **`engfunc(EngFunc_SetAngle, ...)`** (use
`set_pev(entity, pev_angles, ...)`). At runtime, `engfunc(EngFunc_CreateEntity, classname)` ends in
`Run time error 10`; the working call is
`engfunc(EngFunc_CreateNamedEntity, engfunc(EngFunc_AllocString, classname))`.

### Free for all: friendly fire + YaPB FFA mode, teams kept

The stream is a deathmatch: every bot shoots every bot. Two pieces are needed, and one thing must
not be done:

| Piece | Where | Why |
|---|---|---|
| `mp_friendlyfire 1` + `mp_tkpunish 0` | `infra/server.cfg` | damage between teammates is the point, and the default `mp_tkpunish 1` slays the killer for a team kill |
| `yb_csdm_mode 2` | `infra/server.cfg` | 2 = CSDM and FFA: bots ignore teams when picking a target. Without it a bot never fires at a teammate |
| **not** `yb_join_team "ct"` | `infra/server.cfg` | pinning everybody to one team empties the other side; the engine then keeps most bots dead and idle. Measured: 0-1 kills per 40 s with one team against 90 per 40 s with two |

Shipped and verified on the live server: bots join both teams, and the kill feed shows
`<CT> killed <CT>` and `<TERRORIST> killed <TERRORIST>` next to the normal cross-team kills - 149
kills in one minute. The teams stay because the engine needs them, but nobody on the server is safe.

Consequence worth knowing: on a team kill CS subtracts a frag, so the scoreboard runs negative and
`FindLeaderBot()` (used by `bounty` and `curse_leader`) means "the least punished", not "the best".
`curse_leader` stopped printing the frag count for this reason.

### Why full CSDM is not used

CSDM is built from source (`infra/checksums.env` pins the commit `3df2741b` tarball,
`infra/build-csdm.sh` compiles five modules with `amxxpc`) but **not loaded**: CSDM 2.x is a Pawn layer
*plus* a C++ AMXX module (`csdm_amxx`), and its plugins refuse to start without it -

```
[AMXX] Plugin "csdm_main.amxx" failed to load: Module/Library "csdm" required for plugin.
```

Building that module needs HLSDK headers and a 32-bit toolchain. The five `.amxx` files therefore sit
unused in the image and are commented out in `infra/plugins.ini`; delete `infra/build-csdm.sh` and the
`CSDM_*` lines if the extra build step ever gets in the way.

### Reading the logs correctly (two traps)

1. `[META] ERROR: dll: Not loading plugin 'CStrike'; already loaded (status=running)` followed by
   `Failed to load plugin 'cstrike_amxx_i386.so'` is **benign**: AMXX asks Metamod to load a module
   that Metamod already loaded, and Metamod answers with an error code. `cstrike` and `hamsandwich`
   do run.
2. `Auto-restarting the server on crash` is `hlds_run`'s startup banner, printed on every start, not
   evidence of a crash. Real crashes show `restarts` in `docker inspect` or a missing killfeed.

### amxxpc aborts with SIGABRT and no diagnostics

`ExecuteHamB` lives in **hamsandwich**, not fakemeta. Without `#include <hamsandwich>` amxxpc aborts
(`Aborted (core dumped)`, exit 134) instead of reporting an undefined symbol. The `hamsandwich` module
must also be enabled in `configs/modules.ini` (done with a `sed` in `infra/Dockerfile`).

The same abort with `terminate called after throwing an instance of 'std::bad_alloc'` comes from a
string literal glued to a string `#define`: `log_amx("loaded " PLUGIN_VERSION ": ok")` kills the
compiler. Use a format string and pass the macro as an argument instead. `plugins/team_war` hit this
on its first build; the fix is one line and the compiler says nothing useful, so it is listed here.

To iterate on a plugin without rebuilding the image, take `amxxpc` + `amxxpc32.so` out of
`infra/.cache/amxmodx-*-base-linux.tar.gz`, run them inside the `cs16-hlds:local` container (it has
the 32-bit libs and the headers) and compile one `.sma`. A full image build takes half a minute, this
takes three seconds.

## Phase 0: what the bot plugin actually exposes

Verified against YaPB 4.4.957 on the live server (`meta list`, `yb` help output):

- `yb_debug_goal <node>`, `yb_freeze_bots`, `yb_csdm_mode`, `yb_ignore_objectives`, `yb_ignore_enemies`,
  `yb_object_pickup_radius`, `yb_quota`, `yb_difficulty` exist as server commands/cvars.
- The AMXX module with per-bot natives (`yb_set_bot_goal_origin` and friends) is **not** in the pinned
  release: `ext/amxx` is absent from 4.4.957 and the `extras` archives contain bots only. The natives
  would need a 4.8 build from source.
- Therefore no `config/nodes.json`: nothing needs graph node ids. `csdm_lite` lets the engine place the
  bots on the map's own spawns, and `team_war` only reads kills.

Still unverified: whether `yb_debug_goal <node>` makes the whole flock converge (would be used to
pull the crowd into the ring), and whether `yb fun <mode>` restores gravity on map change.

## The donation overlay

`src/overlay.ts` writes three lines that the encoder draws over the picture with ffmpeg `drawtext`:

```
DONATE IN CHAT -> CHANGE THE GAME
LAST: Vasya 130 RUB - BOT RAIN
NEXT: 50 BOT NICKNAME | 60 MEAT ROUND
```

- the control API rewrites `overlay.txt` + `overlay.json` on every poll tick (`OVERLAY_DIR`, inside
  compose the `overlay-data` volume at `/app/overlay`);
- the capture container reads `/overlay/overlay.txt` (`STREAM_OVERLAY_TXT`) with `reload=1`, so a
  donation shows up within one poll without restarting ffmpeg;
- always three lines: a changing line count would make the block jump, and `textfile` keeps viewer
  nicknames out of the filter graph entirely. `%` and `\` are stripped because drawtext expands them
  even in file content;
- the layer switches itself off when the text file is missing or the image has no font (both are
  logged at start); `fonts-dejavu-core` is baked into `infra/stream/Dockerfile`;
- the control API runs as root and writes `overlay.txt` as 0644, so the capture container (uid
  10002) can read it but not create it: if the control API never ran, there is no overlay. That is
  deliberate - one writer, no lost updates;
- knobs: `STREAM_OVERLAY_FONTSIZE` (26), `STREAM_OVERLAY_MARGIN` (150 px from the bottom in the
  vertical layout, 24 in 16:9), `STREAM_OVERLAY_FONT`.

Checking the picture without going live:

```powershell
$env:STREAM_OUTPUT='/game/.stream/overlay-test.mkv'; $env:STREAM_RECORD_SEC='25'
./infra/compose.ps1 run --rm -e STREAM_OUTPUT -e STREAM_RECORD_SEC stream
docker run --rm -v cs16-youtube_client-data:/data -v "${PWD}/out:/out" --entrypoint ffmpeg `
  cs16-stream:local -y -ss 20 -i /data/.stream/overlay-test.mkv -frames:v 1 /out/frame.png
```

## The cheap personal activities

Three cheap activities exist for the "first payment" tier: they change one bot at once, like every
other activity - there is no round queue to skip any more.

| Code | Price | Command | What happens |
|---|---|---|---|
| `bless_bot` | 55 | `amx_de bless_bot health=250 weapon=weapon_deagle nick=vasya` | a random bot gets 250 HP, the weapon, a blue glow and the buyer's name in chat for 20 s |
| `bot_phrase` | 65 | `amx_de bot_phrase text=privet_kak_dela` | a random bot says the buyer's message; underscores arrive as spaces |
| `curse_leader` | 80 | `amx_de curse_leader health=25 nick=kolya` | the bot with the most frags drops to 25 HP, knife only, red glow |

The glow is removed by a 20 s timer (`ClearGlow`); health and weapons reset on the next spawn, so
there is nothing else to clean up and none of them can leak into the next round.

`bot_phrase` is the only activity that carries viewer text. RCON cannot hold spaces, so
`src/command.ts` (`sanitizePhrase`) transliterates it and joins the words with `_`, which stays a
single `[A-Za-z0-9_.-]` token; the plugin turns `_` back into spaces before printing. A message with
nothing printable left is dropped entirely and the plugin prints nothing instead of the buyer's
junk. An activity opts into this by declaring `maxPhraseLength` in its params.

## The round fights: bounty, hot potato, boss raid

Three activities follow the kill feed for the rest of the round. They apply at once and are dropped
with the round, together with the cvars they touched.

| Code | Price | Command | What happens |
|---|---|---|---|
| `bounty` | 105 | `amx_de bounty health=150 reward=weapon_deagle nick=vasya` | the bot with the most frags gets 150 HP and a gold glow; the bot that kills it gets the reward weapon and chat names the killer |
| `hot_potato` | 125 | `amx_de hot_potato health=25 nick=kolya` | a random bot becomes the potato: knife only, 25 HP, orange glow; the bot that kills the holder inherits it |
| `boss_raid` | 185 | `amx_de boss_raid bosses=2 bossHealth=1500 bossWeapon=weapon_m249 gruntWeapon=weapon_deagle nick=petya` | N bots become bosses (1500 HP, M249, 100 armour, red glow), everyone else gets a deagle and 50 armour; each boss kill is announced |

One `DeathMsg` handler serves all three, and `ClearFightState()` drops their state on round end,
`amx_de clear` and plugin end. Only the glow has to be removed by hand: health, weapons and armour
are reset by the next spawn.

Traps worth remembering:

- a boss is re-armed on every spawn (`ResetHUD` -> a 0.3 s task -> `BossArm`), because `csdm_lite`
  gives every respawned bot a random primary. Without it the raid is over after the first boss
  death and reads as an ordinary round. The delay is what puts the re-arm after `csdm_lite`'s own
  arming;
- the potato cannot be passed to a dead player: a suicide or a fall ends it with a message instead
  of leaving the glow on a corpse;
- the bounty goes on the leader on purpose. With a 0.5 s respawn a random target dies within
  seconds, before a viewer has read the price;
- `g_bosses[]` is emptied with the round, so a reused player id cannot inherit somebody else's
  boss state.

## A paid activity that hits a cooldown is queued, not dropped

`src/queue.ts` + `drainQueue()` in `src/poller.ts`:

- a donation blocked by a cooldown is stored as `queued` and the activity waits for its window;
- `drainQueue()` runs at the start of every poll tick, before fresh donations;
- the cooldown is re-checked at apply time, so a waiting `map_change` cannot restart the map twice;
- the wait is bounded (`maxWaitMs`, 15 min) and the queue is capped (32 entries, oldest evicted);
- statuses: `queued` -> `applied`, `expired` (`queue_expired` / `queue_evicted`) or `failed`
  (`activity_disabled`, RCON error); the old `cooldown` value still appears in rows written before
  the queue existed, and is what the admin panel (no queue injected) keeps producing on purpose.

Log events: `donation.queued`, `donation.dequeued`, `donation.queue_expired`, `donation.queue_failed`,
`queue.evicted`, `queue.drained`.

## Local smoke run (no server, no money)

```powershell
$env:DA_MOCK='1'; $env:DB_PATH='data/smoke.db'
npm run fake-donation -- --amount 49  --user Skupoy   # rejected, below_minimum
npm run fake-donation -- --amount 120 --user Vasya    # amx_de bot_rain extraBots=6 maxBots=24
$env:POLL_ONCE='1'; npm start
node -e "import('./src/db.ts').then(m => { const s = new m.Store('data/smoke.db'); console.log(s.recent()); s.close(); })"
```

Expected log lines: `donation.rejected`, `rcon.dry_run`, `donation.applied`, `poll.done`.
A second pass with the same DB must report `cursor` equal to the last id and process nothing.

## Connecting the real account

1. register an application in DonationAlerts, redirect URI `http://127.0.0.1:4318/oauth/callback`;
2. put `DA_CLIENT_ID` / `DA_CLIENT_SECRET` into `.env` (never into git);
3. `npm run oauth-login`, open the printed URL, approve, tokens land in `data/da-token.json`;
4. set `DA_MOCK=0`, `npm start`: access tokens are refreshed five minutes before expiry;
5. if the app is rejected or scopes are missing, the API answers 401 and the poll logs
   `poll.error` — nothing is applied to the game.

## Changing a price

1. edit `price` in `config/activities.json` (keep prices unique and >= `minAmount`);
2. `npm test` — the catalogue test asserts 14 activities, unique prices and sorted order;
3. restart the control API. The Pawn plugin does not care about prices.

## Adding an activity

1. `config/activities.json`: unique `code`, `price`, `duration`, `rounds: 1` or `null`,
   `params` for the effect arguments;
2. plugin: write the handler and call `RegisterDonationEffect("<code>", handler)`;
3. `npm test`, rebuild the image, check `amx_de codes` lists the new code;
4. if the plugin does not know the code, the API disables it on startup instead of
   failing mid-stream — that mismatch is visible in the logs on purpose.

## Stage 3: the game image

```powershell
./infra/update-checksums.ps1          # official GitHub assets -> infra/checksums.env (SHA256)
# pin the resolved tags in infra/components.json when it says "pin this tag"
docker buildx build --build-arg-file infra/checksums.env -t cs16-hlds:local .
./infra/verify-image.ps1              # must pass before the image is allowed near a stream
docker compose -f infra/docker-compose.yml up -d hlds
docker logs -f cs16-youtube-hlds-1
```

Expected in the log: Metamod loaded, `yapb_mm_i386.so` loaded, `donation_events loaded, API 1,
10 activities`. Then from the host:

```powershell
node -e "import('./src/rcon.ts').then(async m => console.log(await m.execOnce({host:'127.0.0.1',port:27015,password:process.env.RCON_PASSWORD},'amx_de codes')))"
```

Acceptance for stage 3: `amx_de codes` lists the 10 codes, `amx_de knives_only` makes the bots
drop their weapons immediately, `amx_de map_change maps=de_dust2` changes the map.

Known unknowns to settle on the first real build (each one fails loudly, none fails silently):
archive layout inside the ReHLDS/ReGameDLL/Metamod-R/YaPB zips, exact YaPB cvar names
(`yb_quota` / `yb_difficulty` are tried first, PodBot names second), and the Pawn compile itself.

### Findings from the first real build (2026-10-25)

- `update-checksums.ps1` pinned: ReHLDS 3.15.0.896, ReGameDLL 5.30.0.814, Metamod-R 1.3.0.149,
  AMX Mod X 1.10.0.5487, YaPB 4.4.957 (`yapb-4.4.957-linux.tar.xz`).
- `amxxpc` is a 32-bit binary that `dlopen`s `amxxpc32.so` from the current directory: compile
  from `addons/amxmodx/scripting` and make sure `libc6-i386` is installed. The plugin compiles.
- YaPB ships `addons/yapb/bin/yapb.so`; the archive already mirrors `cstrike/`, so it unpacks over it.
  Its cvars are confirmed from `conf/yapb.cfg`: `yb_quota`, `yb_quota_mode`, `yb_difficulty`.
- Bots play 10 vs 10: `yb_quota 20` and `yb_autovacate 0`, because the stream camera is a real
  connection and vacating a bot for it would leave 10 vs 9. `MAXPLAYERS=22` (20 bots + camera +
  one spare) or the camera cannot join at all.
- Bot chat and radio are off (`yb_radio_mode 0`, `yb_chat 0`, `yb_chat_percent 0`,
  `yb_display_welcome_text 0`): on a stream it is noise over the picture, and the watchdog log is
  kept alive by the `stream_cam` heartbeat instead.
- Metamod-R reads the game DLL from `addons/metamod/config.ini` (`gamedll dlls/cs.so`), not from
  `liblist.gam`, once `liblist.gam` points at Metamod itself.
- **Resolved: ReHLDS 3.15 + current depot.** `engine_i486.so: undefined symbol:
  SteamGameServer_Init` — Valve bumped the Steamworks SDK and the shipped `steamclient.so`
  stopped exporting that symbol. Valve still serves the pre-25th-anniversary build as the
  `steam_legacy` branch: the build pins app 90 depot 4 manifest `8690279432129063737`
  (`STEAM_LEGACY_MANIFEST`) and lays those engine libraries *over* the chosen engine set,
  keeping ReHLDS' own `engine_i486.so`. ReHLDS' bundled `proxy.so` dies with
  `Unable to initialize Steam` against the current steamclient, so the legacy helper
  libraries must win. `WITH_REHLDS` defaults to 1 and the stack boots (verified live).
- **GoldSrc rcon is not the Source binary protocol.** Packets with int32 size/id/type are
  silently ignored (rcon login timeouts). The real wire format is text:
  `challenge rcon` -> `challenge rcon <n>`, then `rcon <n> "<password>" <command>`, answered
  with `'l' + output`. `src/rcon.ts` implements that, and `amx_de codes` on the live server
  returned all 10 codes.
- Metamod-R still needs ReHLDS: with the stock engine it reports `Couldn't get DLL API from !`,
  so `WITH_REGAMEDLL=1` stays off until ReGameDLL is verified separately.
- ReHLDS build order matters: HLDS -> ReHLDS engine set -> legacy libraries (skipping
  `engine_i486.so`). Copying the legacy set *before* ReHLDS brings back its bundled
  `proxy.so` and the engine dies with `Unable to initialize Steam`. Related: the engine
  dlopen()s `$HLDS/.steam/sdk32/steamclient.so` before Steam init, so the build also copies
  the legacy `libsteam_api.so` there — without it the first boot fails and `hlds_run`
  silently restarts once.
- Verified on the rebuilt image: `plugin.contract_ok` (10 activities), a 100 RUB mock
  donation ran `awp_only`, and the plugin reported `awp_only: 8 bots rearmed with AWP`
  in the same call (that build still had the round queue, since removed).
- `verify-image.ps1` scans with `--ignore-unfixed`: 59 HIGH/CRITICAL findings in the Debian
  base layer have no fix for bookworm (util-linux, zlib), so they cannot be patched here.
  A finding *with* a fix still fails the gate, because that would mean a skipped update.

## Streaming

`npm run stream -- --print` shows the ffmpeg command without running it (the key is masked).
The supervisor restarts ffmpeg with exponential backoff (1 s, 2 s, 4 s ... capped at 30 s),
gives up after 10 consecutive restarts, and logs `stream.started`, `stream.exited`,
`stream.restart_in`, `stream.gave_up`, `stream.progress` (frame/fps/bitrate).

Verification without a key: `STREAM_OUTPUT=data/smoke.flv`, `STREAM_SOURCE=test`,
`npm run stream -- --duration 10` must exit 0 and leave a playable file.

Open question for the live stream: the game server is headless, so something has to render the
game. Either a CS 1.6 client on the streaming machine (desktop capture of its window) or a
headless client on Xvfb. Until that is decided the pipeline is verified with the `test` source.

### Ingest: RTMPS on 443, because plain RTMP is often dropped

`rtmp://a.rtmp.youtube.com/live2` (port 1935) failed on a normal home connection: TCP connect
succeeds, then ffmpeg reports `Cannot read RTMP handshake response` after ~1 s, while TLS to
`a.rtmps.youtube.com:443` works from the same machine. The 1537-byte RTMP handshake packet never
gets an answer, so the flow is cut after the handshake — an ISP-level block of the RTMP protocol,
not a wrong key (a wrong key is answered with a handshake and then a publish error).

- `compose` therefore sets `STREAM_RTMP=rtmps://a.rtmps.youtube.com:443/live2` explicitly
  (override with `RTMP_INGEST_URL`), shadowing the older `STREAM_RTMP` line in an existing `.env`;
- `src/stream.ts` uses the same default for the desktop CLI;
- to check the path without touching the channel, push to a dummy key:
  `ffmpeg -f lavfi -i testsrc -t 2 -c:v libx264 -f flv rtmps://a.rtmps.youtube.com/live2/xxx`.
  A working path prints the publish command in `-loglevel trace`; only then does YouTube close it.
- the stream key itself is masked in the container log by `mask_stream_key` in
  `infra/stream/entrypoint.sh`: ffmpeg copies its stderr into `docker logs`, and its errors carry
  the full publish URL.

## Autonomous capture (infra/stream)

Proven in the container (Debian trixie, i386 runtime, Xvfb + Mesa llvmpipe + ffmpeg):

- Xvfb starts and `ffmpeg -f x11grab` reads from `:99`; a 10 s grab produced a valid
  1280x720@30 H.264 file, so the capture path is fine;
- the engine (`xash3d` loader + `libxash.so`) renders: with `+map de_dust2` the frame is a real
  3D view (mean luma 38.9), so GL/llvmpipe work on the CPU;
- CS16Client's `cstrike/cl_dlls/client.so` loads under trixie (glibc 2.41). Valve's own
  `client.so` cannot: it needs `SteamInternal_ContextInit` from a Steam session;
- the HLDS engine libraries (`libsteam_api.so`) must **not** be on `LD_LIBRARY_PATH`: they shadow
  the system `libgcc_s.so.1` and the loader then fails with `GCC_7.0.0 not found`;
- the client **does** join and spectate. Verified from the server side (`status` lists
  `[Xash3D]StreamCam`, `STEAM_ID_LAN`) and from the picture (scoreboard and spectator overlay).

Two server settings are mandatory for a non-Steam client, and both are easy to get wrong:

- `-insecure` on the HLDS command line. Without it the server connects to Steam, reports
  `... secure ...` in `version` and answers every join with `STEAM validation rejected`.
  With it: `VAC secure mode disabled`, `version ... insecure`.
- `sv_lan 1` **in server.cfg**, not on the command line: the value is read when the server object
  is created (before `+map`), while `server.cfg` is executed afterwards, so `+sv_lan` is always
  overwritten. `infra/entrypoint.sh` patches the file at start-up like it does with
  `rcon_password`.

Joining: solved with a config file, no GUI automation.

- `+connect <addr>`, `-connect <addr>` and a `connect` line in `config.cfg` are silently ignored:
  Xash3D queues `+`-commands and the auto-executed config during `Host_Init`, which is **before**
  `CL_Init`, so the command runs while the network stack does not exist yet and nothing happens.
  That is why typing the same command into the console (after init) always worked.
- `wait` is a real Cbuf command: it splits the command buffer and resumes the remainder on a later
  frame. A chain of waits therefore defers `connect` until the client is up.
  `stream-entrypoint.sh` generates `cstrike/userconfig.cfg` with 400 × `wait`, then
  `connect <addr>`, 200 × `wait`, `jointeam 6`, 60 × `wait`, `spec_mode 6`.
- `userconfig.cfg` and not `config.cfg`: the engine rewrites `config.cfg` on exit, so anything kept
  there disappears after the first shutdown; `userconfig.cfg` is executed at start-up and left
  alone.
- Verified: the client appears in the server's `status` as `[Xash3D]StreamCam  STEAM_ID_LAN` and
  the captured frame is the game (mean luma 41.7, versus 59.7 for the main menu).

A dead end worth recording, because it cost a lot of time: driving the client through its GUI
(clicking the main-menu "Console" item with xdotool, typing `connect`, OCR to verify) does work but
is not deterministic — the menu item moves between runs, VGUI dialogs swallow input, and the
console eats the first keystroke. All of that was removed once the `wait` chain worked.

### Three traps in the capture container

1. **`connect` needs an IP, not a host name.** GoldSrc does no DNS lookup inside `connect`, so
   `connect srv:27015` fails silently while `connect 172.18.0.2:27015` works. The entrypoint
   resolves `SERVER_ADDR` with `getent` before writing the config.
2. **Secrets in the shared volume block the copy.** The server volume also holds files the
   capture user must not read: `server.cfg` is `0600` (it carries `rcon_password`) and the server
   writes `0600` logs. A plain `cp -a` of `cstrike/` therefore fails with "Permission denied".
   The copy runs through `tar --ignore-failed-read --exclude=logs --exclude=server.cfg ...`.
3. **An entrypoint stored in a volume is frozen.** `/hlds` is a named volume in compose, and a
   volume is seeded from the image only once. With `ENTRYPOINT ["/hlds/entrypoint.sh"]` the
   container kept running the script from the *first* image build, so later fixes (like
   `-insecure`) never took effect and the client was rejected with `STEAM validation rejected`.
   The entrypoint now lives in `/usr/local/bin` — outside every volume.

### The spectator bands

CS16Client paints two translucent bands over the picture: one at the top (team scores, map, round
timer) and one at the bottom (observed player's nickname). They are not a resource file and not a
cvar. `CHudSpectatorGui::Draw()` in `cl_dll/hud/spectator_gui.cpp` fills a strip of `INT_YPOS(2)` at
the top and at the bottom of the frame, and this HUD defines `YPOS(y)` as `y/10`, so every strip is
exactly 20% of the render height: 144 rows of the 960x720 capture, which matches the recorded frame
row for row. The two `FillRGBABlend` calls are unconditional.

What does exist and what was tried, in order:

- `cstrike/resource/UI/Spectator.res` and `BottomSpectator.res`, all `visible` fields to 0: no effect.
  There is not a single `resource/UI` string in `client.so` or `menu.so`, the client never opens
  those VGUI files. Dead end, verified on frames.
- Client cvars in `cstrike/userconfig.cfg`, written by the stream entrypoint: `spec_drawstatus 0`
  empties the top band, `spec_drawnames`, `spec_drawcone`, `spec_decal` remove the remaining
  spectator extras. `hud_spectator` is not a cvar here, the engine answers `Unknown command`.
- `hud_draw 0` removes the bands (they are painted by the client HUD) but takes the whole HUD with
  them: health, armour, ammo, radar, kill feed and the server's `NAME  100 HP  100 AR` hudmessage.
  Rejected, without the HUD the picture stops reading as a game.

So the encoder cuts the bands instead. The crop runs **before** the scale, and the vertical layout asks
the client for the extra height the bands will take: with the default `STREAM_BAND_PERCENT=20` each band
is 426 rows of the 720x2134 render, so the 720x1280 that survive are exactly the canvas — the game fills
the Shorts frame edge to edge and nothing is padded. The render size follows from that (`CAP_W` is the
canvas width, `CAP_H` is derived), so `STREAM_CAPTURE_*` no longer exists and a stale value in `.env`
cannot quietly bring the padded 4:3 composition back; `STREAM_BAND_PERCENT=0` is the only way to keep
the bands now. Rendering portrait also changes the view: the engine keeps the horizontal field of view
and grows the vertical one, so a tall frame shows more sky and ground than a 4:3 one. Measured cost of
the taller render: 253% CPU at 720x1280 against 266% at 720x2134, the encoder included.

The known price of a full frame: the client draws the kill feed at `YRES(96)` as well, so its first line
starts two rows below the top band and the cut shaves the tops of those glyphs (the operator's own HUD
line is pushed to `y=0.24` in `stream_cam.sma` for exactly that reason). Keeping a few rows of the band
would restore the kill feed and bring a thin dark edge back at the top; the clean frame was chosen
instead. `STREAM_BAND_PERCENT` is the only switch: `0` keeps both bands and the padding comes back.

To review the result without going live:

```powershell
./infra/compose.ps1 run --rm -e STREAM_OUTPUT=/game/check.mkv -e STREAM_RECORD_SEC=40 stream
docker run --rm -v cs16-youtube_client-data:/game -v "$PWD/out/shots:/shots" --entrypoint sh cs16-stream:local `
  -c "ffmpeg -y -ss 20 -i /game/check.mkv -frames:v 1 /shots/check.jpg"
```

### Reconnect behaviour and the frozen-picture case

The client has no scripting interface, so the watchdog reads the engine's own output. With `-dev`
the engine prints `Connecting to ... (retry #N)`, `Server connection timed out` and
`execing mainui.cfg` to stdout, which is redirected to `/tmp/xash.log`. After two strikes
(15 s apart) `watchdog.sh` kills the engine and the client loop restarts it, which rejoins through
`userconfig.cfg`. Retries 1–4 are ignored on purpose: a server that is still booting makes the
client retry a few times during a normal start.

Matching is case-insensitive, and it includes `Server issued disconnect` and
`has been idle for too long`: that is what the engine printed when it kicked the camera for being
idle, and the old capitalised `Disconnected` pattern missed it, so the client stayed in its menu
and the stream showed a static picture while `ffmpeg` happily kept encoding.

The log also has to grow. Bot chat used to be what kept it alive; `yb_radio_mode 0` in
`infra/server.cfg` silenced it, so `stream_cam` now prints its own heartbeat into the client
console (`[stcam] target=... hp=... pov=...`, every `stcam_heartbeat` = 60 s). `LOG_STALE_SEC`
(120 s) of silence still means "the client is not on the server".
"the client is not on the server" even when no disconnect line was printed at all.

A second failure looks identical from outside: the client is on the server, the log grows, but the
picture does not change (the team menu, or the camera on a dead body). Every `MOTION_SEC` the
watchdog grabs three seconds of the Xvfb display through `freezedetect`; four static samples in a
row (~1 min) restart the client, while one or two are normal between rounds.

`watchdog.sh` also writes `/game/.stream/runtime.json` every `CHECK_SEC`:
`{"ts":…,"xashAlive":true,"logAgeSec":3,"frozen":false,"restarts":0}`. The admin panel turns this
into one verdict - `live`, `frozen`, `stalled` (heartbeat older than 45 s) or `offline` - and shows
the log silence and the restart count.

Verified by stopping and starting the game server: the client dropped, the engine was restarted,
and after the server came back the log showed `[Xash3D]StreamCam ... entered the game` and
`joined team "SPECTATOR"` without any human action. The idle kick was verified by watching
`Game_idle_kick` disappear from the server log after `mp_autokick 0`.

A frame-brightness watchdog was tried first and thrown away: mean luma cannot separate the main
menu (~60) from a bright map (de_dust2 at 640x480 is ~120). `freezedetect` compares frames instead
of absolute brightness, so it works in both.

Camera director check: `amx_stcam status` prints
`stream_cam status: enabled=1 interval=25.0 mode=1 spectator=<name> target=<name> candidates=<n> dwell=6.0 hp=<n> active=<mode>`,
and the server log gets one `camera target <bot> (<reason>, score ...)` line per switch. `mode=1` is
chase locked (third person), `active` is the mode the server wrote to the client last second, and
`candidates` must be 20 on a 10 vs 10 server.

Why third person and nothing else: a director that re-picked the busiest bot every 8 s looked like
the camera teleporting around the map, and an in-eye window on every kill was worse — a spectator
has no view model of its own, so the weapon had to be faked with `WeaponList` + `CurWeapon`, and
every cut to and from first person read on screen as the camera glitching. Plugin 0.3.4 is chase
locked only: it holds one bot until it dies, stops moving or the hold time is up; `stcam_dwell` 6 s
and `stcam_idle` 5 s drop a static target before the camera sits on a frozen, hidden bot. `Health` +
`ArmorValue` + one HUD line give viewers real numbers instead of an empty health bar.

One engine detail the director depends on, found the hard way: the PVS is built from the spectator's
own `origin`, so a camera entity parked at the map origin stops receiving updates for a bot that
walks away — the picture freezes with the bot gone. A once-a-second copy of the target's origin fixed
the freeze but left a shorter blink: the bot crossed a portal between ticks and its model vanished
until the next one. `TaskFollow()` now re-applies the whole observer state (mode, target, origin)
ten times a second, and `ApplyCamera()` does it once more so a freshly picked target is anchored in
the same tick. `SyncCameraOrigin()` lifts the PVS anchor from the player's feet (which sits exactly
on the floor brush and can be a solid leaf) to eye level, then body centre. The heartbeat prints
`resets=<mode>/<target> feet=<0|1>`: non-zero resets mean the engine dropped those fields between
ticks, `feet=1` means the direct origin was in solid and the lift was needed.

### Gate

`infra/verify-stream.ps1 -SmokeTest` checks the image statically (binaries, resolved libraries,
x11grab support, no setuid files, payload inventory) and then runs a real game server next to the
capture container for up to 7 minutes. It fails unless the server logs
`StreamCam ... entered the game` **and** the recording contains frames and is not black. The join
is judged by the server, not by the picture, because brightness is not a reliable discriminator.




## Donation handling rules

- amount < 50 RUB or currency != RUB -> rejected, logged, nothing happens;
- amount buys the most expensive activity it can afford; leftover is not banked;
- one activity per round used to be the rule; now every activity applies at once, and only a
  cooldown-blocked donation waits (in the control API queue, not in the plugin);
- per-donor cooldown 60 s, map change at most once per 10 minutes.

## Security rules

- the donor nickname is untrusted input: whitelist `[A-Za-z0-9 _.-]`, 16 chars, translit,
  never interpolate it into an RCON command line without validation (newline = command
  injection);
- keys and tokens only in `.env` / vault, never in git, logs or test fixtures;
- the game image is built from pinned official releases (ReHLDS, ReGameDLL_CS, Metamod-R,
  AMX Mod X 1.10.0.5487, YaPB) with SHA256 checks, then scanned (trivy, ClamAV) and
  verified against a whitelist of expected binaries; no community `hlds` images.

## Before a stream

- `npm test` green, `amx_de codes` matches the catalogue;
- one test donation of 50 RUB -> bot nickname changes, row appears in the DB;
- RCON password rotated if the server was exposed, `.env` not world readable.
## Local testing: watch the stream, drive the panel

Everything below runs on one machine, without a stream key, without going live and without spending
a donation.

### 1. The stream in a browser

The capture container pushes RTMP exactly like it does to YouTube; only the target changes.

```powershell
./infra/compose.ps1 --profile local-view up -d mediamtx hlds
./infra/compose.ps1 run --rm -e STREAM_OUTPUT=rtmp://mediamtx:1935/live/test stream
./infra/compose.ps1 logs -f mediamtx      # expect: is publishing to path 'live/test'
```

Use `compose.ps1` (or `docker compose --env-file .env -f infra/docker-compose.yml ...`): the compose
file lives in `infra/`, so compose looks for the environment file there and refuses to start with
`RCON_PASSWORD is missing a value` otherwise.

Then open `http://localhost:8889/live/test?muted=false` (WebRTC) or `http://localhost:8888/live/test`
(HLS). If WebRTC shows nothing, the UDP port 8189 is blocked — HLS is the fallback.

`STREAM_OUTPUT` resolves the container by scheme: `rtmp(s)://` → FLV, `tcp://`, `udp://`, `srt://` →
MPEG-TS (TCP also gets `-listen 1`, so a player connects to us), anything else → a Matroska file. A
file target still needs `STREAM_RECORD_SEC` to stop by itself.

### 2. One page: the stream and the panel

```powershell
./infra/compose.ps1 up -d hlds control-api
./infra/compose.ps1 run -d --name cs16-panel-stream -e STREAM_OUTPUT=rtmp://mediamtx:1935/live/test stream
# open http://127.0.0.1:8085 (or ADMIN_PORT) and paste ADMIN_TOKEN
```

The page holds everything: the picture (HLS through hls.js, with sound) on top, then the activity
cards with a **Run** button, the live `active` state from the plugin, the debug donation
form, the history of what the panel sent, the donations, and the encoder layout. No second URL.

Two things that made the player hang forever, both fixed and worth knowing:

- `docker compose run` does not apply `restart:` — a push started that way stays down after a Docker
  or machine restart. For a preview that survives, put `STREAM_OUTPUT=rtmp://mediamtx:1935/live/test`
  in `.env` and use `./infra/compose.ps1 --profile local-view up -d mediamtx stream`.
- The software OpenGL renderer (llvmpipe) used every core it could see: measured **625% CPU for the
  client alone**, which starved the encoder until HLS segments arrived too late and the browser
  spinner never stopped. `LP_NUM_THREADS=2` brings the whole capture container to ~200% on a 12-core
  machine and keeps 30 fps at 960x720. Do not remove it on a small VPS.
- The game client draws its own "SELECT TEAM" panel over the picture and nothing closes it: the
  console commands `jointeam`/`menuselect`/`cancelselect` do nothing, and commands sent by the server
  are refused by the client (`Could not execute privileged command`, visible in `/tmp/xash.log`).
  Only a key press works, so `stream-entrypoint.sh` runs `xdotool key 6` (SPECTATE) for the first
  minute and once a minute after that. Verified on a frame: the panel is gone and the stream shows
  the followed bot's view.

- **Run** sends `amx_de <code>` with the parameters shown in the row (edit them under `params`), so a
  run needs no donation and ignores cooldowns. The plugin applies it in the same RCON call and the
  card shows the code as `active`.
- **Debug donation** injects a fake donation through the same pipeline as a real one and prints the
  verdict with the exact command.
- **Stop everything** sends `amx_de clear`.
- Every command the panel sends is stored in the `admin_actions` table (kind, code, params, exact
  RCON line, reply) and listed on the page: that is the audit trail for "who started this round".

If port 8080 is taken, set `ADMIN_PORT` (e.g. `ADMIN_PORT=8085`); the compose file publishes the
panel on loopback only. `STREAM_HLS_PORT` / `STREAM_HLS_PATH` (default 8888 and `live/test`) tell the
page where the hub is; the browser uses its own hostname, so the same page works from a phone in the
LAN as long as the port is published.

Three ffmpeg facts learned the hard way, all encoded in `infra/stream/entrypoint.sh`:

- **never pipe ffmpeg's stderr into the entrypoint** and never use `-progress <file>`: both stall the
  encoder right after the FLV header (2 frames in 10 s, `speed=0.017x`), and the hub then drops the
  idle publisher with `Broken pipe`. stderr goes to `/tmp/ffmpeg.log`, a separate `tail -F` copies it
  to the container log;
- an RTMP server drops a publisher that sends nothing for its read timeout, and our first packet can
  arrive around 11 s on a loaded CPU: the local hub runs with `MTX_READTIMEOUT=60s`;
- the encoder waits for the client's connect line (`Trying to connect with GoldSrc`) plus
  `STREAM_JOIN_SETTLE_SEC`, and it is supervised: a failed attempt is retried, never fatal.

Endpoints (all require `X-Admin-Token`, mutations require `application/json`, body limit 64 KiB):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | catalogue, active activity, last 20 donations, history, stream layout |
| POST | `/api/simulate` | `{amount, username, message?, bypassCooldown?}` — fake donation through the real pipeline |
| POST | `/api/trigger` | `{code, params?, nick?}` — `amx_de <code>` now |
| POST | `/api/activity/<code>` | `{price?, cooldownSec?, globalCooldownSec?, enabled?, params?}` |
| POST | `/api/activity/<code>/reset` | drop the override for one activity |
| POST | `/api/settings` | `{minAmount?, defaultCooldownSec?}` |
| POST | `/api/clear` | `amx_de clear` — round effect and the renamed bot |
| POST | `/api/sim-reset` | delete rows with `source = 'sim'` |

Milestone check without the browser:

```powershell
curl -s -H "x-admin-token: $env:ADMIN_TOKEN" http://127.0.0.1:8085/api/state
curl -s -H "x-admin-token: $env:ADMIN_TOKEN" -H "content-type: application/json" `
  -d '{"code":"bot_rain","params":{"extraBots":10}}' http://127.0.0.1:8085/api/trigger

```

Expected: `"status":"applied","activityCode":"meat_round"`, and in the server console
`donation_events ran meat_round` right away.

### 3. What the panel can and cannot change

- **Can, live**: prices, cooldowns, `enabled`, `params`, default cooldown; they go into
  `data/activities.override.json` and are applied in memory at once.
- **Cannot**: `minAmount` above the cheapest price (the catalogue parser refuses it — raise every
  price first), and anything that lives outside the control API: `DA_POLL_SEC`, DonationAlerts keys,
  stream resolution/bitrate, the capture camera. Those stay in `.env` and need a restart, on purpose:
  a panel that restarts the encoder needs the Docker socket, and the Docker socket is root.

### 4. Rules the panel inherits

- simulated donations consume cooldowns unless "bypass cooldown" is ticked, and are tagged `sim`;
- simulated ids are negative, so they never affect the poll cursor for real donations;
- editing a price does not affect `config/activities.json`; `npm test` still asserts the shipped
  catalogue (10 activities, unique prices, sorted order).



## Camera limits of the open-source client (verified 2026-10-26)

In first person the client draws no view model (no hands, no weapon) and no HUD text: `WeaponList`
and `CurWeapon` are accepted without producing a gun. First person is therefore no way to show the
weapon, and the director does not use it at all any more (plugin 0.3.0, chase locked only): the gun a
viewer sees comes from the third person camera, where the bot model holds it.

`cs_get_user_bpammo` on a knife (weapon id 29) raises "Invalid weapon id" and aborts the rest of the
HUD update. The HUD line carries no ammo any more, so that call is gone with it.
