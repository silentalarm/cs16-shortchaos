# Runbook

## Stages

1. activity catalogue (done): `config/activities.json`, `src/activities.ts`, `src/mapping.ts`;
2. DonationAlerts OAuth + poller, cooldowns, queue, RCON client, SQLite history;
3. pinned ReHLDS image + YaPB + `donation_events` Pawn plugin;
4. end-to-end: real 50 RUB donation -> activity in game -> row in DB;
5. stream: ffmpeg -> private YouTube RTMP;
6. VPS, backups, health checks (the operator path is `docs/deploy.md`, the one command is
   `bash infra/deploy.sh`).

## The team race (`plugins/team_war`)

The stream is a race between T and CT: which side puts more bots down before the map changes. The
score is counted by the plugin from `DeathMsg`, not read from the engine scoreboard, because the
engine subtracts a frag for a team kill and this server runs **team play: T against CT**
(`yb_csdm_mode 0`, `mp_friendlyfire 0`), so a team kill cannot happen at all; the plugin counts by
hand anyway because the engine score is not the race.

The numbers are published as cvars (`team_war_t`, `team_war_ct`, `team_war_top_t`,
`team_war_top_ct`) and printed on one console line for `amx_team_war status`:

```
team_war status: t=12 ct=9 top_t=Smith:7 top_ct=Neo:5
```

The block on screen is drawn **outside the game** by `src/ui` (see "The picture panel" below), which
reads that line once a second and renders `T 12 : 9 CT`, both team tops and the bot on camera into a
PNG. Nothing is drawn into the game any more: the old hudmessage flickered, because it was resent
once a second with a fade-in (`hold 1.6`, `fadein 0.1`) and this client renders a single message.

- the score survives rounds; a map change re-initialises the plugin, which is the only reset;
- `team_war_name_len` (14) trims a long nickname so the CT half stays inside the frame;
- team_war writes `score: T n : m CT` to the log once a minute: the only trace of the race in the
  server log, and what tells an empty score apart from a plugin that stopped counting;
- `stcam_hud 1` brings the in-game block back (score + `name HP AR` in one hudmessage) as a fallback
  for a server that runs without the control API. It is off by default.

```
amx_team_war status   t=12 ct=9 top_t=Smith:7 top_ct=Neo:5   (spaces in names become underscores)
amx_team_war reset    drop every counter
amx_full_status       the same line plus the camera target and the duel state, in one reply
```

`amx_full_status` exists because of RCON's cost model: GoldSrc RCON has no request id and the control
API serialises every command, so three probes a second were three round-trips - and a paid activity
queued behind each of them. The command prints the three lines the panel parses, all of them read
from the cvars the plugins publish, so `team_war` keeps no second copy of anybody's state:

```
team_war status: t=12 ct=9 top_t=Smith:7 top_ct=Neo:5
stream_cam status: target=Smith hp=87 ar=42
map_duel status: state=live winner=-
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

- the round is only a fallback: with `csdm_lite` a round almost never ends, so every lasting effect
  carries its own clock (`set_task`, `seconds=` from the catalogue) and `Round_End` /
  `plugin_end` / `amx_de clear` drop whatever is still running;
- `he_party` keeps a repeating task of its own instead of the generic clock, because it has to re-arm
  the field twice a second, not only end itself;
- several effects run at the same time; `amx_de status` reports the running codes as a `+`-joined list
  (`active=glass_cannon+meteor_shower`, five entries at most) and `queued=0` stays in the line only
  because the admin panel parses it. Everything shared - `sv_gravity`, run speed, health, the weapon
  rule, glow, the freeze, the camera, the audio bed - is held as a *claim*: the newest effect owns it,
  and an effect releases only what it still owns (`ClaimTake` / `ClaimRelease` / `EndEffectState`),
  which is what keeps one event's clock from undoing another's;
- health, weapons and armour are reset by the next spawn, so only cvars, glows and run speed need
  cleanup.

The 110, 130, 170 and 230 RUB steps are free again: the zone activities that used them were removed.

## Foreign donations are converted, not dropped

`src/mapping.ts` keeps a small table of RUB per unit (`USD 90`, `EUR 100`, `KZT 0.18`, `BYN 27`,
`UAH 2.2`) and converts before the 50 RUB steps are counted: `Math.floor(amount * rate)`, so rounding
never buys one step more. The rates sit below the market on purpose - an error then costs the donor,
not the owner - and `CURRENCY_RATES` in `.env` (`{"USD":92}`) overrides them without a deploy.
Everything else is still rejected as `unsupported_currency`: guessing a rate for an exotic currency
either gives activities away or halves what somebody paid.

## One step, one effect: how a donation is priced

There is no price ladder any more. `minAmount` is the *step*, and every full step buys one effect
drawn at random from the enabled entries:

- 50 RUB = 1 step, 149 RUB = 2 steps, 150 RUB = 3 steps; the remainder below a full step is kept by
  the stream, so the overlay always says "50 HE PARTY" and nobody wonders where 40 RUB went;
- the draw ignores `price`, so an enabled entry has to cost exactly `minAmount` (`test/activities.test.ts`
  enforces it); `price` stays in the file so the panel table sorts and so a retired entry keeps its
  old number;
- repeats of a clock effect are merged into one longer command (`planActivities` in `src/mapping.ts`):
  three steps of the HE party send `seconds=180`, not three `seconds=60` lines that would each
  restart the same minute. The plugin then *adds* the time (`EffectHeParty`), so a second donation
  during a party extends it;
- `enabled: false` means off sale but not gone: `/api/trigger` can still fire it by hand, and flipping
  the flag back is all it takes to put it in the draw. The Pawn plugin keeps all 18 handlers.

The donation row keeps the original amount and currency; the applied log line carries `chargedRub`
next to them, so a conversion can be explained afterwards.

## The 2025-10 event set: 50 RUB, 15 seconds, one in the frame

`docs/events.md` is the record of the deal; this section is the part that touches the code.

- **Five events, one price, one length.** `glass_cannon`, `meteor_shower`, `red_light`, `lightsaber_duel`
  and `one_bullet` are all `price: 50`, `seconds: 15`, and
  every one of them passes the same clock in `params.seconds`. `he_party` is retired to
  `enabled: false`, as are the other legacy handlers - the panel can still fire them by hand.
- **One event in the frame.** Each new handler opens with `BeginEvent()`, which calls
  `ResetEventState()`, `StopAllEffectTimers()` and `CleanupActive()`. `ResetEventState()` is also
  called from `CleanupActive()`, so Round_End, `amx_de clear`, `plugin_end` and every effect clock end
  the same way. Nothing in the set can leak a cvar or leave a bot frozen.
- **The event is chosen by chat.** Every event costs the same, so `resolveDonation` reads the donation
  message as a hint (`EVENT_KEYWORDS` in `src/mapping.ts`) and falls back to the roll. The words are
  listed in `docs/events.md`; a word that names a retired event is ignored, not rejected, because the
  money is already paid.
- **Tests pin a fixture, not the catalogue.** `test/fixture.ts` (`onSaleCatalogue()`) is the
  single-effect catalogue that the poller/queue/mapping tests assert exact RCON lines against; the
  shipped catalogue is covered by `test/activities.test.ts` and `test/plugin-contract.test.ts`.
- **The camera lock exists now:** `amx_stcam lock <nick|#userid> [seconds]` holds the director on one
  bot (20 s by default, 600 s at most) and `amx_stcam unlock` gives the camera back. The lock ends by
  itself when its clock runs out, when the bot dies, when it disconnects and on round start; the status
  line reports `locked=<name|none> lock_left=<sec>`, and the panel reaches it through
  `POST /api/camera` (`{ "target": "Mr Smith", "seconds": 45 }`, `{ "release": true }`). What is still
  missing is the `boss_finale` accumulation bar.

## The respawn mode: csdm_lite, no CSDM

There is **no CSDM in the image any more**. Its plugins need the `csdm_amxx` C++ module (HLSDK
headers plus a 32-bit toolchain, see "Why full CSDM is not used" below), so they were only ever
compiled and never loaded; its spawn presets existed for the random-spawn experiment, which is gone.
The whole stage was removed together with them: no `CSDM_*` pin, no `build-csdm.sh`, no
`infra/csdm.cfg`, nothing synced into `configs/csdm/`.

What replaced it lives in `plugins/csdm_lite` and is configured by its own cvars:
`csdm_lite_delay` (0.5 s respawn), `csdm_lite_weapons` (the random primary), `csdm_lite_health`
(100), `csdm_lite_protect` (one second of godmode).

`server.cfg` changed with it: `mp_roundtime 9` (the engine clamps this cvar at 9 minutes, and no
round ever ends on the clock any more), `mp_freezetime 1`, `mp_timelimit 0` and `yb_chat 1` with
`yb_chat_percent 3` - a silent bot-only server reads as dead.

## The end of a map: plugins/map_duel

A map lives `map_duel_minutes` (10) and ends with a duel. The engine is out of the rotation on
purpose: `mp_timelimit 0`, so its own timer cannot change the map in the middle of the fight.

```
T-45 s   every bot except one per team is killed, csdm_lite_enabled 0, chaos_enabled 0
         both finalists: 100 hp, no armour, knife + the same random primary, put 96 units apart
T+0      the first finalist to die loses; at map_duel_limit (60 s) more hp wins, then frags
T+5 s    changelevel to the next map in map_duel_maps
```

- the finalists are the two bots the panel calls TOP T and TOP CT - one per team, counted with
  team_war's rule (a team kill counts for the killer's team, the engine score does not);
- one finalist per team is what keeps the round alive: a team is never wiped, so the engine cannot
  end the round under the fight and respawn the field;
- `csdm_lite_enabled 0` stops the half-second respawns, `chaos_enabled 0` stops a chaos effect from
  handing a finalist a new gun mid-fight; both are switched back by the next map (`map_duel_touched`
  remembers that the plugin was the one that muted them);
- a Ham_Spawn hook kills anything the engine revives during the duel and re-arms a finalist it
  respawns;
- the winner is published as the cvar `map_duel_winner` and polled by the control API once a second:
  the panel prints `WINNER: <name>` in its notice line. Nothing is drawn by the game.

```
amx_map_duel status   map_duel status: state=<idle|live|done> winner=<name|->
```

Cvars: `map_duel_enabled` (1), `map_duel_minutes` (10), `map_duel_prepare` (45),
`map_duel_limit` (60), `map_duel_weapons` (`ak47,m4a1,awp,xm1014,p90,mp5navy`), `map_duel_maps`
(`aim_map,aim_headshot,aim_map_2010,aim_aztecplace,aim_dust2011,aim_aspect,fy_iceworld,fy_pool_day`, wraps around).

The rotation is fight-yard maps only, and deliberately **small** ones. A vertical 9:16 feed has a
second or two to stop a thumb, and on de_dust2 the bots spend five of them running to each other with
an empty field in frame; on a compact arena the fight is already on screen when the frame changes.

`fy_simpsons` left the pool on 2026-10-31: its house has rooms narrower than two bot radii, so a bot
that lost its route there ended up pushing a door frame on camera more often than on any other map. The
three wads it needed (`fy_simpsons.wad`, `0soup0_simpsons.wad`, `cl_Simpsons.wad` - the first two are
byte-identical, one archive shipped both) belonged to that map only and are gone with it. The entrypoint
only ever copies files *into* a volume, so a volume created before the removal still has them; nothing asks
for them any more, but the space can be reclaimed by hand:

```bash
docker run --rm -v cs16-youtube_server-data:/hlds --entrypoint sh cs16-hlds:local \
  -c 'rm -f /hlds/cstrike/maps/fy_simpsons.* /hlds/cstrike/fy_simpsons.wad /hlds/cstrike/0soup0_simpsons.wad /hlds/cstrike/cl_Simpsons.wad'
```

None of the six ship with HLDS. They are fetched from GameBanana by `./infra/fetch-maps.ps1`
(`infra/maps/maps.json` names a mod id and a SHA256 pin; the script verifies GameBanana's MD5, its AV
verdict and the pin, so a re-uploaded file fails instead of landing in the game) and copied into the
server by `infra/entrypoint.sh` at start - the image build never downloads a map. The fetcher
lower-cases the map files: one pack ships `fy_Dustworld.bsp`, and on Linux the engine looks for exactly
the name the rotation asks for.

The resources travel with the map, and their placement is not obvious: a `.bsp` goes to
`cstrike/maps/`, a `.wad` to `cstrike/` (HLDS looks for wads there) and a `.wav` to `cstrike/sound/`.
`fy_iceworld` ships `de_vegas.wad`; with only the `.bsp` copied the server dies with
`FATAL ERROR: TEX_InitFromWad: couldn't open de_vegas.wad`, `hlds_run` restarts it on the default map
and the whole thing looks like "the map change was ignored". The capture container syncs missing files
from the server volume on every start (`--skip-old-files`), otherwise CS16Client could not join a map
that was added after its volume was created.

Adding a map means editing `map_duel_maps` in `plugins/map_duel/map_duel.sma`, the `MAPCYCLE` default in
`infra/docker-compose.yml` and the same fallback in `infra/entrypoint.sh` - `test/map-duel-contract.test.ts`
fails if the three disagree, if a listed map has no `.bsp` or no pinned graph, if a fetched map has no
pin, or if the wad is routed to the wrong directory. `infra/maps/README.md` has the short version.

A finalist that picks a bomb site as his goal and runs off is pulled back next to his opponent every
three seconds while the fight runs (`TaskKeepTogether`, only when the two are more than 400 units
apart): the duel is what the last minute of the map exists for.

## How the bots behave in the picture

Every knob here answers a complaint from the stream, and none of them is the engine default. The values
are written by `infra/entrypoint.sh` into `addons/yapb/conf/yapb.cfg` on every start: that file is
re-executed by YaPB on every map change and silently reverts anything set in `server.cfg` (verified -
`yb_radio_mode` went back to 2 in the middle of a stream while `yb_quota` stayed put).

| Symptom on stream | Knob | Value |
| --- | --- | --- |
| a bot stabbing an enemy instead of shooting it | `yb_stab_close_enemies` | 0 - a knife fight reads as a broken bot, **except** while a knife-only event runs: the plugin flips it to 1 for as long as half the field has no gun, see "The HE party" |
| a bot running the map with a rifle in hand, no enemy near | `yb_random_knife_attacks` | 1 (`BOT_KNIFE_ATTACKS`) - a rushing bot carries the knife the way a human rotates |
| a bot pushing into the back of a teammate | `team_semiclip_radius` (see below) | 36 units - just above the player hull |
| a bot standing still in a corner for the whole map | `yb_camping_allowed`, `yb_camping_time_min/max`, `yb_walking_allowed` | 1, 4.0 / 12.0, 0 - holding an angle is human, a third of a fight is not |
| a bot creeping at shift speed | `yb_walking_allowed` | 0 |
| a bot shooting at a remembered enemy through a wall | `yb_shoots_thru_walls` | 0 |
| a bot that reacts like a machine | `yb_difficulty` | 2 - Normal, 0.4-0.6 s reaction (`BOT_DIFFICULTY`) |
| a bot staring at a teammate without shooting | `yb_csdm_mode` | 2 (free for all targeting) |
| a bot out of bullets doing nothing | `csdm_lite_ammo`, `csdm_lite_ammo_reserve` | 1, 200 |
| a bot grinding into a wall | `bot_antistuck` (see below) | nudge after 1.5 s of no movement with a wall in front |


`mp_infinite_ammo` stays 0: that engine mode fills the magazine and removes the reload entirely. The
endless part is the **reserve**: `csdm_lite` tops it up once a second for every alive bot, so a
magazine still empties and is still reloaded, and the bot never falls back to the knife because it
counted its bullets. Knife, grenades and the bomb are skipped - they have no reserve magazine, and
topping them up would hand a bot 200 grenades.

Deploying any of it: `infra/build-image.ps1` then `infra/compose.ps1 up -d --force-recreate hlds`.
A plain `docker restart` keeps the old image and the old config.

### Why the bots walked into walls (measured 2026-10-31)

Read from the live container's log, not guessed - every map load said:

```
Unable to open Pathmatrix file for writing (filename: '/hlds/cstrike/addons/yapb/data/train/fy_iceworld.pmx')
Unable to open Vistable file for writing (filename: '/hlds/cstrike/addons/yapb/data/train/fy_iceworld.vis')
```

`ls -ld addons/yapb/data/{train,pwf,logs,graph}` answered `drwxr--r--` with `0644`: the YaPB archive
ships those as **directories** with the mode of a file, and a directory without the execute bit cannot be
written into. The bot therefore rebuilt its path matrix every round and never persisted which connections
are actually clear - a bot that mis-guesses a link walks into the wall it points at. Both the image
(`infra/Dockerfile`) and the entrypoint (`chmod 755`, idempotent) fix the mode, because a named volume
keeps the mode of its first seed forever.

Check after a start:

```bash
docker exec cs16-youtube-hlds-1 ls -ld /hlds/cstrike/addons/yapb/data/train   # drwxr-xr-x
docker exec cs16-youtube-hlds-1 ls /hlds/cstrike/addons/yapb/data/train        # <map>.pmx after a map load
docker logs cs16-youtube-hlds-1 2>&1 | grep -c Pathmatrix                      # 0
```

### `team_semiclip`: teammates do not block each other

`plugins/team_semiclip/team_semiclip.sma` runs one pass every 0.025 s: every alive player is restored to
`SOLID_SLIDEBOX`, then any two alive players of the same team closer than `team_semiclip_radius` (36) units
are both set to `SOLID_NOT` for the next pass. Enemies stay solid - a bot passing through an enemy would make
a firefight unreadable. The restore comes first in the pass, before every early return, so nothing can stay
transparent after a death, a team change, a map end or `team_semiclip_enabled 0`.

Why: twenty bots in a room the size of a bus, and the engine keeps teammates solid. A bot whose doorway is
occupied pushes into the back of the bot standing there and stays for the round - on a 9:16 stream that is
the "bots just sit there" complaint. YaPB is told the same thing from its own side,
`yb_has_team_semiclip 1` in `infra/entrypoint.sh`, otherwise it still refuses to path through the body.

```bash
amx_semiclip            # team_semiclip: enabled=1 radius=36 transparent=4
```

The cost is known: while two teammates overlap, hitscan passes through them. `mp_friendlyfire` is 0 in
`infra/server.cfg`, so nothing is lost today - with friendly fire on, a team kill at that distance would stop
being possible. The radius sits just above the 32-unit player hull, so the window is the moment the two
actually touch.

### `bot_antistuck`: the bot that still grinds a wall

`plugins/bot_antistuck/bot_antistuck.sma` is the safety net, not the fix. Every 0.5 s (a constant: the
scan period is what the time bookkeeping uses, a cvar there would only desync the two) it looks at each
alive bot that is on the ground, has not moved `bot_antistuck_units` (24) units in `bot_antistuck_secs`
(1.5 s) and has a **wall** within `bot_antistuck_wall` (48) units in front of its view (a trace; floors and
ceilings are ignored). Such a bot gets a shove away from the wall plus a jump, at most once per
`bot_antistuck_cooldown` (3 s), and the horizontal part is re-applied every 0.05 s for 0.3 s: a bot's own
usercmd replaces the velocity on the next tick, so a single write was a bot hopping in place against the
wall rather than leaving it. The first 20 shoves of a plugin load are logged - `antistuck: shoved <name> at
<x> <y> <z> after <n> s` - so the net can be watched from `docker logs` without RCON.

That front trace has one blind spot, from the stream: a bot backed into a corner or standing on a ledge has
its wall **behind** it, so the trace sees an open room and the bot stood there 8.4 s and 10.4 s before it
happened to turn (both in the 2026-11-01 log). The trace is deliberately strict because a camper also stands
still, and camping is bounded by `yb_camping_time_max` (12 s), so past `bot_antistuck_patience` (14 s)
nobody is holding an angle any more: four traces are cast instead of one and the bot is shoved towards the
most open direction, logged with a `(no wall in view)` suffix. **Keep the patience above
`yb_camping_time_max`**, or campers are shoved out of their angle; `test/bot-antistuck-contract.test.ts`
fails if the two ever cross.

```bash
amx_antistuck          # bot_antistuck: nudged=N respawned=M armed=1
```

A teleport is **not** used: `set_user_origin` is already rejected in this project (`docs/runbook.md`,
"the respawn meat grinder") - the engine leaves the bot's navigation graph pointing where it was and the bot
freezes for the rest of the round. With `bot_antistuck_respawn 1` the fallback after
`bot_antistuck_stuck_secs` (10 s) of no progress is `user_kill` with the silent flag, so the existing
`csdm_lite` grinder brings the bot back on a spawn point that is on the graph. Default is 0: a false
positive costs a visible death on camera, and the mode is only worth it if the counters prove it is needed.

**Reading the net.** It logs its first `NUDGE_LOG_LIMIT` (20) shoves per plugin load, so the log witnesses the
phenomenon but is not a rate: 20 lines means "at least 20 since the last restart". What was measured on
2026-11-01 with the dense graphs and `yb_camping_time_*` 4-12 s, 20 bots on `fy_snow`/`fy_iceworld`: six
logged shoves inside ten minutes, most of them after 1.4 s of no progress (the net's own detection time) and
two after 8.4 s and 10.4 s, when the bot had turned away from the wall the trace looks for. That is a viewer
saying "one bot is being weird", not "the bots are broken" - so the net stays on `bot_antistuck_respawn 0`.
A shove every few seconds would instead point at the **graph** for that map, not at the shove.

```bash
# what the net did since the last restart (capped at 20 lines per load, see above)
docker run --rm -v cs16-youtube_server-data:/hlds:ro --entrypoint sh cs16-stream:local -c "grep -h 'antistuck: shoved' /hlds/cstrike/addons/amxmodx/logs/*.log | tail -20"
# the exact counters, from RCON - the number the log cannot cap
amx_antistuck          # bot_antistuck: nudged=N respawned=M armed=1
# and the values the running server actually uses, not what the repository says
docker run --rm -v cs16-youtube_server-data:/hlds:ro --entrypoint sh cs16-stream:local -c "grep -E '^yb_(camping|walking|random_knife|graph_analyze_distance)' /hlds/cstrike/addons/yapb/conf/yapb.cfg"
```

### Navigation graphs: the bot reads a `.graph`, never a `.nav`

YaPB 4.4 logs `Loaded Bots Graph data v2` from `addons/yapb/data/graph/<map>.graph`; the `.nav` files next
to the maps are Quake leftovers that nothing reads (an earlier version of `infra/maps/README.md` claimed
otherwise). The archive ships a graph for the stock maps only, so each fight-yard map is analyzed on the
server itself. Six of those results are pinned in `infra/maps/graph/`, and `infra/entrypoint.sh` copies one
in **only when the volume has no graph of that name** (`yapb graphs: N file(s) added`): a graph the bot built
on the running server was analyzed with the current `yb_graph_analyze_*` values, so overwriting it on every
start is exactly how the tuning below never took effect. The repository copy is the baseline for a fresh
volume.

```bash
# force a re-analysis: a .graph that exists in the volume is never analyzed again
docker run --rm -v cs16-youtube_server-data:/hlds --entrypoint sh cs16-hlds:local \
  -c 'rm -f /hlds/cstrike/addons/yapb/data/graph/fy_aztec.graph'
# load the map, wait for "Completed map analysis", then pin the result
docker cp cs16-youtube-hlds-1:/hlds/cstrike/addons/yapb/data/graph/fy_aztec.graph infra/maps/graph/
```

Before blaming a map, check that the graph in the volume is the pinned one: `entrypoint.sh` never overwrites
a graph that exists, so a volume seeded before a denser analysis keeps the sparse build (that is how
`fy_buzzkill` stayed at 61 nodes while the repository had 1711). `infra/verify-graphs.ps1` compares each
pinned file with the volume by content and prints `STALE` for a mismatch - one `cmp` per map, no server and
no RCON needed:

```powershell
./infra/verify-graphs.ps1        # same fy_aztec.graph (49 KB) ... all 6 pinned graph(s) match the volume
```

The same analysis runs off-stream, which is how the numbers below were produced: a throwaway container with
`-e MAP=<map>` and its own directory for `/hlds/cstrike/addons/yapb/data`, two minutes on a spare core and no
interruption of the picture. Not with a **Windows bind mount** for that directory: YaPB writes the graph and
then fails to `_stat` it, so the log says `Unable to load Graph` although the file is complete. A named
volume, or the live server, reads it back fine.

How dense a graph is can be read without parsing it: the fourth uint32 of the header is the node count.

| map | archive-style analysis (64, optimized) | `yb_graph_analyze_distance 48`, not optimized |
|---|---|---|
| `fy_buzzkill` | 61 nodes, 3.2 KB | 1711 nodes, 78 KB |
| `fy_pool_day` | 187 nodes, 11.9 KB | 443 nodes, 23 KB |
| `fy_iceworld` | 215 nodes, 12.8 KB | 594 nodes, 28 KB |
| `fy_snow` | 203 nodes, 14.6 KB | 1076 nodes, 48 KB |
| `fy_aztec` | 336 nodes, 21.4 KB | 1118 nodes, 50 KB |
| `fy_dustworld` | 447 nodes, 25.4 KB | 925 nodes, 45 KB |

`fy_buzzkill` is the one that mattered: 61 nodes on a map that is all crates is a bot with nowhere to route
to, so it pushes into the wall in front of it and jumps there. The other five were 3-5x under-noded too.

`yb_graph_analyze_distance` is 48 instead of the archive's 64 (**not** 40: YaPB clamps the cvar to
42..128 and answers `Bogus value for cvar 'yb_graph_analyze_distance'` for anything outside, keeping 64) and
`yb_graph_analyze_optimize_nodes_on_finish` is 0: on a tight fight-yard map 64 units leaves too few links
in a doorway, and the optimizer deletes nodes a corridor needs.

Six graphs, one per map, are pinned in `infra/maps/graph/` (copied out of a live server on 2026-10-31).
They were analyzed with the archive's 64, and a pinned file wins over the volume, so they keep 64 until
somebody regenerates them - the point of pinning is that a fresh volume does not start with a bot
analyzing a map instead of playing it. To pick up the denser setting for one map: delete both copies, load
the map, copy the result back (`yapb graphs: N file(s) synced` then confirms the copy on the next start).

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

### Team play: T against CT, friendly fire off

The stream is a team deathmatch now: a bot only shoots the other team. Two cvars do it, and one thing
must not be done:

| Piece | Where | Why |
|---|---|---|
| `yb_csdm_mode 0` | `infra/server.cfg` | 0 = team play: a bot picks a target by team. 2 was the FFA mode, where a bot also shot teammates |
| `mp_friendlyfire 0` | `infra/server.cfg` | with team play a stray shot would only feed the other side's scoreboard; `mp_tkpunish 0` stays because it is the engine default for a rule that can no longer trigger |
| **not** `yb_join_team "ct"` | `infra/server.cfg` | pinning everybody to one team empties the other side; the engine then keeps most bots dead and idle. Measured: 0-1 kills per 40 s with one team against 90 per 40 s with two |

Verified live: bots fill both teams, the kill feed is `<CT> killed <TERRORIST>` and the reverse, and
`plugins/team_war` keeps counting frags per side (a team kill cannot happen now, the rule it was built
for is simply never triggered).

Consequence worth knowing: on a team kill CS subtracts a frag, so the scoreboard runs negative and
`FindLeaderBot()` (used by `bounty` and `curse_leader`) means "the least punished", not "the best".
`curse_leader` stopped printing the frag count for this reason.

### Why full CSDM is not used

CSDM 2.x is a Pawn layer *plus* a C++ AMXX module (`csdm_amxx`), and its plugins refuse to start
without it:

```
[AMXX] Plugin "csdm_main.amxx" failed to load: Module/Library "csdm" required for plugin.
```

Building that module needs HLSDK headers and a 32-bit toolchain. CSDM was compiled from source for a
while - five modules that were never loaded, plus its spawn presets, which only existed for the
random spawns that were dropped later. That whole stage is gone: no `CSDM_*` pin, no
`infra/build-csdm.sh`, no `infra/csdm.cfg`, nothing synced into `configs/csdm`. `csdm_lite` does the
respawn work and owns its own cvars.

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

A second trigger is an **escaped double quote inside a `log_amx`/`Announce` format string**:
`log_amx("said \"%s\"", name)` aborts the same way. Use single quotes in the format
(`Announce("%s says: '%s'", ...)`) or log the value unquoted. Found while adding `quotes_pack`
(stage 8); the trap is also noted in the `donation_events` header.

To check a plugin without deploying it, build the compiler stage on its own and read what it produced.
`build-plugin.sh` deletes `amxxpc` when it is done, so the runtime image has no compiler at all:

```powershell
$b = @('buildx','build','-f','infra/Dockerfile','--target','build','--load','-t','cs16-de-compile')
foreach ($line in Get-Content infra/checksums.env) { if ($line -match '^\s*([A-Za-z0-9_]+)=(.*)$') { $b += '--build-arg'; $b += "$($matches[1])=$($matches[2])" } }
docker @b .
docker run --rm --entrypoint bash cs16-de-compile -c 'ls -l /hlds/cstrike/addons/amxmodx/plugins'
```

The layers are cached after the first run, so this is seconds, and a compile error fails the build instead of
leaving a stale `.amxx` behind. The `.amxx` itself is compressed, so grepping it for a function name proves
nothing: compare its mtime with the `.sma` (`ls -l --time-style=full-iso` inside the image) instead.

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

## The picture panel (the UI, drawn outside the game)

Everything a viewer reads on screen is drawn by the encoder itself, from small text files the control
API writes. Nothing is drawn by the game client: that is what made the old HUD flicker (a
`hudmessage` replaced and re-faded once a second) and sit half-invisible on a bright map.

```
amx_full_status ────┐
                    └─▶ game-poller (RCON, 1 Hz) ─┐
donations + rotation (SQLite, per poll) ──────────┴─▶ ui-state ─▶ ui/panel.ts ─▶ 11 text files
                                                                                    │
                          ffmpeg: x11grab ─crop/scale─▶ drawtext×11 ─▶ x264 ─▶ RTMP ◀─┘
```

- `src/game-poller.ts` - one console command a second (`amx_full_status`); a failed poll keeps the
  last numbers and only sets `stale`, so the panel says `NO SIGNAL` instead of showing stale numbers
  as fresh. A server without the command (image not rebuilt yet) is detected on the first tick and
  the three old probes are used instead, so a code deploy does not blank the panel;
- `src/ui/state.ts` - the model (`score`, `target`, the donation line, the rotation line, queue size,
  theme); the donation and countdown lines come from `buildOverlay()`, so the panel and the text
  fallback cannot disagree;
- `src/ui/panel.ts` - the panel itself: which file holds which line, the limits, and the score bar.
  `THEMES` in `src/ui/state.ts` maps activity codes to accent colours - a new visual variant is one
  line there plus a branch here;
- `src/ui/loop.ts` - compares a signature of the state and rewrites the files through a temporary
  name, only when the state changes (5 Hz ceiling). An idle server costs nothing;
- **the encoder draws every line itself**: `infra/stream/entrypoint.sh` builds one `drawtext` filter
  per file with `reload=1`, which ffmpeg honours per frame. No rasteriser, no extra input, nothing to
  synchronise.

### The score is a bar with the counts on it

`drawbox` cannot take its length from a file, so the race is two runs of `U+2588 FULL BLOCK`: the
terrorist run anchored at the left margin, the counter-terrorist run at the right one. Both together
always add up to the same 20 blocks, so **the outer edges never move - only the point where the runs
meet does**, which is what keeps the bar from crawling. Measured in the capture image at fontsize 40:
a block is 0.77 em (30.7 px), so 20 of them span 614 px, which fits 720 px with 52 px margins.
`U+2591 LIGHT SHADE` came out 5 px narrower over twenty characters, hence one glyph only.

The two frag counts are their own `drawtext` layers (`score-t.txt`, `score-ct.txt`) drawn on top of
the blocks at the fixed outer ends, the way a health bar carries its number - **never inside the bar
files**: a digit advances 0.64 em against a block's 0.77 em, so a number in `bar-t.txt` would shorten
the run and move the meeting point. Each number grows inward (left margin + 12 px, right margin -
12 px), so a third digit moves the text, not the bar. The row is measured, not guessed: at
`UI_TOP=36` the blocks cover y 36..83 (centre 59.5) and a 28 px digit line starting at y=42 covers
42..61 (centre 51.5), so the digits sit at `UI_TOP + 14` and share the centre of the bar. At 0 frags
a side has no blocks at all and the number stands on the picture; the black outline keeps it
readable.

Colours are the game's own: red `0xDD3333` for the terrorists (the health cross), blue `0x3366DD`
for the counter-terrorists (the armour shield). The counts are white with a black border, so they
read on both colours.

Verified on a rendered frame (same filter graph as the encoder, two states):

```
t=11 ct=9  -> red 52..387   blue 391..667
t=4  ct=16 -> red 52..171   blue 175..666
```

Left edge and right edge are identical; the meeting point moved by 216 px.

Knobs: `UI_RENDER` (1), `UI_INTERVAL_MS` (200), `STREAM_UI_TEXT` (1), `STREAM_UI_DIR`
(`/overlay/ui`), `STREAM_UI_SIZE_BAR` (40), `STREAM_UI_SIZE_SCORE` (28),
`STREAM_UI_SIZE_TOP`/`_TARGET`/`_LAST`/`_NEXT` (30/36/26/24), `STREAM_UI_MARGIN` (52),
`STREAM_UI_TOP` (36), `STREAM_UI_BOTTOM` (186),
`STREAM_UI_COLOR_T`/`_CT`/`_TEXT`/`_MUTED`/`_NEXT` (`0xDD3333`, `0x3366DD`, `white`, `0xB9C2CF`,
`0xE0A856`). The whole look is `.env`: no template to edit, no image to rebuild.

The panel lives in a subdirectory of the overlay volume because the capture container is
unprivileged: `writeUiFrame` creates `overlay/ui` and opens it up (`0777`). Without the control API
the files never appear, the lines stay empty, and the encoder falls back to the old single-block
`drawtext` donation line (the panel and the fallback are never both on - a donation would print
twice).

Editing the look without Docker:

```powershell
npm run ui-preview      # http://127.0.0.1:4399 - the files laid out at the encoder's geometry
$env:UI_PREVIEW_ACTIVITY='bounty'; npm run ui-preview   # another theme
$env:UI_PREVIEW_T='4'; npm run ui-preview               # the bar leans to CT
```

Limits on purpose: text only (no icons, no rounded panels), one write per state change, and a fixed
20-block bar - a wider vocabulary needs a renderer, and the renderer froze on a live stream.

## The free rotation (one event every three minutes)

`config/auto-events.json` + `src/auto-events.ts` + `AutoRotation` in `src/main.ts`:

- `intervalSec` (180) is the clock. A one second timer in the control API fires the slot that came
  due as the same `amx_de <code> ...` line a donation would send: no donation, no cooldown, no money;
- `free` is a **ranked** rotation (slot 0 first, then 1, ... and back to 0). The cursor lives in
  SQLite (`events.slot`, `events.next_at`), so a restart neither resets the clock nor re-fires the
  event that just ran, and a host that slept through several slots fires **one** effect, not a burst;
- a paid effect keeps the screen: when a donation reached the game less than `quietAfterPaidSec`
  (60 s) ago the slot is skipped (`events.deferred`) and the cadence stays - the free event does not
  overwrite what somebody just bought;
- the picture announces it: `ДАЛЬШЕ 2:31 · HE PARTY` in `next.txt`, rewritten once a second;
- ranked free list - short, self-explanatory, safe to repeat: `he_party` (60 s), `meteor_shower`
  (15 s), `one_bullet` (15 s), `red_light` (15 s), `jumpers` (30 s), `glass_cannon` (15 s),
  `lightsaber_duel` (30 s), `bazooka_drop` (30 s);
- paid only, never in the rotation: the hero modes with the camera locked (`nemesis`, `survivor`,
  `juggernaut`, `sniper`, `outbreak`, `chaos_plague`) and the class waves (`raptors`, `brutes`,
  `runners`, `regenerators`). These are what a viewer buys - giving them away removes the reason to
  donate;
- `chaos` is the subset a chaos burst may fire: only effects that read as chaos, all of them from the
  free list - `he_party`, `meteor_shower`, `jumpers`, `bazooka_drop`, `one_bullet`. An empty list
  keeps `amx_chaos force` (the plugin's own dice, `docs/runbook.md` "chaos_core");
- validation fails at startup, not on stream: a code the catalogue does not have, a chaos code
  outside the free list, or a free effect longer than its own slot stops the process;
- `enabled: false` switches the clock off and the bottom line goes back to `NEXT: <cheapest>`.

## The donation overlay (fallback, no panel)

`src/overlay.ts` writes three lines that the encoder draws over the picture with ffmpeg `drawtext`:

```
DONATE IN CHAT -> CHANGE THE GAME
Vasya 130 RUB
ДАЛЬШЕ 2:31 · HE PARTY
```

- the control API rewrites `overlay.txt` + `overlay.json` on every poll tick (`OVERLAY_DIR`, inside
  compose the host directory `data/overlay` mounted at `/app/overlay` and at `/overlay`);
- the last donation is the nickname and the amount only: the viewer message moved the centred line,
  and what the money bought is in the log and in the rotation line;
- the last line is the countdown to the next free event (`auto-events.ts`). Without
  `config/auto-events.json` it falls back to `NEXT: <two cheapest activities>`;
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

A **nickname** is moderated before it reaches the scoreboard: after transliteration and cleaning,
`sanitizeNick` replaces a name that carries a link (`http`, `www`, `t.me`, `.ru/.com/.net/.org/.io/.me`),
an ad root or a banned root with `Anonim_Bot`. The phrase is deliberately not filtered - it is the
product the viewer bought and the plugin prints it once, while a nickname sticks to the scoreboard for
the whole map. Any activity that carries a nickname and does not rename a bot itself also puts the
buyer on the bot leading the scoreboard as `[DONOR] <nick>` for 30 s (`AssignDonorNameToTopBot`, new
nick or round end restores the original name).

## Every lasting effect has a clock

The HE party was the first activity that did not end with the round, because with `csdm_lite` a round
almost never ends. The same is now true of every effect that changes a cvar, a run speed, health or a
render state: `moon_gravity`, `bot_rain`, `terminators`, `meat_round`, `zombie_round`,
`terminator_one`, `bounty`, `hot_potato` and `boss_raid` each call `StartEffectTimer(code, seconds)`
when they apply.

- the length is `params.seconds` from the RCON line (the plugin defaults to 45 s, `boss_raid` and
  `bot_rain` to 90 s), and the catalogue's `seconds` field is what the panel shows;
- the task id is `TASK_EFFECT_BASE + registry index`, so starting the same effect twice
  (`remove_task` first) extends it instead of stacking two timers on the same state;
- the timer ends the effect with the same reset `Round_End` used to do: cvars back to their saved
  values, glows cleared, run speed back to `sv_maxspeed`, donor tag restored;
- `Round_End`, `plugin_end` and `amx_de clear` call `StopAllEffectTimers()` as well, so a map change
  or a manual stop cannot leave a clock behind that fires into an empty state;
- `client_disconnected` drops everything keyed by that player id: a reused slot never inherits a
  bounty, a potato, a boss bar, the donor tag or a renamed bot.

## The HE party: a repeating clock

`he_party` takes every weapon away - guns and the knife - and leaves 20 bots with an HE grenade and
nothing else for 60 seconds (`amx_de he_party seconds=60`). It keeps its own repeating task instead of
the generic one, because it has to re-arm the field twice a second, not only end itself. The kit lock
(`KitWeapon`) hands the grenade back for the whole event: a knife in a bot's hand is what a viewer
reads as a broken knife round instead of a grenade party.

```
every 0.5 s, for the declared length:
  bot has a gun or a knife          -> strip everything
  bot has no HE in hand             -> give one back
  every 3rd pass                    -> the party's own blast (TE_EXPLOSION, 20 damage, 260 units)
```

- the re-arm repeats on purpose: it hands a thrown grenade straight back, and it undoes the rifle
  `csdm_lite` gives a bot that died during the party (that respawn is what a one-shot arm would miss);
- the whole weapon list is checked, not the weapon in hand - a rifle left in the backpack comes out
  the moment the bot sees somebody;
- **the knife rule is flipped while the field is disarmed.** `yb_stab_close_enemies` is 0 in
  `yapb.cfg` (a bot that stabs while holding a rifle reads as broken), and with every gun stripped it
  also stops the knife from ever swinging: measured on the live server, `he_party` produced **0 kills
  in 60 s**. One second `TaskMeleeWatch` counts the alive bots that hold no gun at all and sets the
  cvar to 1 while at least half of them are like that, back to 0 when they are armed again (the same
  minute then had 5 knife kills). It is derived from the field rather than remembered per event, so
  every knife-only code inherits it, and a map change - which re-executes `yapb.cfg` and resets the
  cvar - is repaired within a second;
- **the party throws its own grenades, and hands them out endlessly.** A thrown grenade leaves the
  weapon entity in the bot's inventory with no rounds in it, so `user_has_weapon` keeps answering yes
  and a bot that is "given a grenade once" throws exactly one per party (measured on the stream).
  `DisarmField` therefore tops the reserve up on every pass (`cs_set_user_bpammo`, two rounds), which
  is what makes it endless;
- **a flashbang next to the HE.** One throwable is not enough for YaPB to keep throwing: the same
  25 second party produced 29 HE throws with the grenade alone and 342 throws with a flashbang added,
  so the field gets both (`CSW_FLASHBANG` is in `HasGun`'s skip list - it is a throwable, not a gun,
  and stripping it every pass would be pure churn). The end of the party logs the count:
  `he_party: over, 342 grenades thrown by the bots`;
- **with the knife gone the bots do throw.** With a knife in the first slot YaPB kept choosing it and
  never touched the grenade; a bot holding a grenade and nothing else throws it at the first enemy in
  sight. That is why the field is grenades only, not "knives and grenades";
- the event's own blast (`HePartyBlast`) stays as the floor of the show: a `TE_EXPLOSION` with the
  stock grenade sound and 20 damage in 260 units at a random bot every 1.5 s, so a quiet second still
  has an explosion in it;
- nothing is restored at the end: bots keep the knife until they die, and the next spawn arms them
  again. A map change also ends it, because the plugin is re-initialised and the task is dropped.

## The round fights: bounty, hot potato, boss raid

Three activities follow the kill feed. They apply at once and end on their own clock (60 s for
`bounty` and `hot_potato`, 90 s for `boss_raid`), or earlier when the target dies, with the cvars
they touched; `Round_End` still drops them if a round happens to end first.

| Code | Price | Command | What happens |
|---|---|---|---|
| `bounty` | 105 | `amx_de bounty health=150 reward=weapon_deagle nick=vasya` | the bot with the most frags gets 150 HP and a gold glow; the bot that kills it gets the reward weapon and chat names the killer |
| `hot_potato` | 125 | `amx_de hot_potato health=25 nick=kolya` | a random bot becomes the potato: knife only, 25 HP, orange glow; the bot that kills the holder inherits it |
| `boss_raid` | 185 | `amx_de boss_raid bosses=2 bossHealth=1500 bossWeapon=weapon_m249 gruntWeapon=weapon_deagle nick=petya` | N bots become bosses (1500 HP, M249, 100 armour, red glow), everyone else gets a deagle and 50 armour; each boss kill is announced |

One `DeathMsg` handler serves all three, and `ClearFightState()` drops their state on the effect
clock, `amx_de clear` and plugin end. Only the glow has to be removed by hand: health, weapons and
armour are reset by the next spawn.

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
- the wait is bounded (`maxWaitMs`, 15 min) and the queue is capped (256 entries, oldest evicted) -
  the cap is a guard against a runaway queue, not a normal path: at 32 a burst of small donations
  evicted the first ones, and an evicted row is money taken for an effect nobody saw;
- the reserve is refilled once a second (`TaskTopUpAmmo`), and dropped weapons are swept every five
  seconds (`TaskCleanWeapons`, `csdm_lite_clean_weapons` 1 / `csdm_lite_clean_sec` 5.0): 20 bots dying
  every couple of seconds leave a `weaponbox` behind each time and CS 1.6 has no "never drop" switch.
  The sweep removes `weaponbox` entities only - `armoury_entity` weapons placed by the map stay;
- statuses: `queued` -> `applied`, `expired` (`queue_expired` / `queue_evicted`) or `failed`
  (`activity_disabled`, RCON error); the old `cooldown` value still appears in rows written before
  the queue existed, and is what the admin panel (no queue injected) keeps producing on purpose;
- the queue is in memory, but a restart does not lose it: `restoreQueue()` at startup reads every
  `queued` row back (`ORDER BY received_at ASC`), rebuilds the RCON line with the same builder and
  puts it in the queue with the original `received_at`. An entry that waited out `maxWaitMs` while
  the container was down is marked `expired` instead of firing hours late, and a row whose activity
  left the catalogue becomes `failed` / `activity_disabled`.

Log events: `donation.queued`, `donation.dequeued`, `donation.queue_expired`, `donation.queue_failed`,
`queue.evicted`, `queue.drained`, `donation.restored`, `donation.restore_failed`, `queue.restored`.

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

## Changing what a step buys

1. put the effect on sale in `config/activities.json`: `enabled: true` and `price` equal to
   `minAmount` (50), or take another one off sale with `enabled: false`;
2. `npm test` - the catalogue test pins the deal: the only entry on sale costs exactly one step,
   the file stays sorted by price, and every entry keeps a valid duration;
3. restart the control API. The Pawn plugin does not care about prices.

## Adding an activity

> The planned catalogue (50 codes in nine systems, with models, sounds and the stage order) is in
> [`docs/activities/`](activities/README.md). The four steps below are the mechanical part; the system
> description and the assets belong to that directory.

1. `config/activities.json`: unique `code`, `price`, `duration`, `rounds: 1` (round effects) or
   `seconds: 60` (clock effects) or both `null`, `params` for the effect arguments;
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
18 activities`. Then from the host:

```powershell
node -e "import('./src/rcon.ts').then(async m => console.log(await m.execOnce({host:'127.0.0.1',port:27015,password:process.env.RCON_PASSWORD},'amx_de codes')))"
```

Acceptance for stage 3: `amx_de codes` lists the 18 codes, `amx_de knives_only` makes the bots
drop their weapons immediately, `amx_de map_change maps=de_dust` changes the map.

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
  returned all 18 codes.
- **RCON has no request id, so commands are serialized.** `RconClient.exec()` chains every exchange
  onto a promise queue (`#enqueue`): the challenge, the send and the collector of one command finish
  before the next one starts. Without it, `Promise.all` from `src/game-poller.ts` (score, camera,
  duel) plus a donation put three collectors on the same socket and answers landed in the wrong
  promise. A rejected command does not poison the queue: the next one still runs.
- Metamod-R still needs ReHLDS: with the stock engine it reports `Couldn't get DLL API from !`,
  so `WITH_REGAMEDLL=1` stays off until ReGameDLL is verified separately.
- ReHLDS build order matters: HLDS -> ReHLDS engine set -> legacy libraries (skipping
  `engine_i486.so`). Copying the legacy set *before* ReHLDS brings back its bundled
  `proxy.so` and the engine dies with `Unable to initialize Steam`. Related: the engine
  dlopen()s `$HLDS/.steam/sdk32/steamclient.so` before Steam init, so the build also copies
  the legacy `libsteam_api.so` there — without it the first boot fails and `hlds_run`
  silently restarts once.
- Verified on the rebuilt image: `plugin.contract_ok` (18 activities), a 100 RUB mock
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

### Frame rate and canvas: what the box actually sustains

The client is launched with `+fps_max "$FPS"`, so `STREAM_FPS` is the ceiling for the whole pipeline,
not just the encoder: a 30 fps cap makes the game itself render 30 fps and no encoder setting brings
the motion back. The renderer is llvmpipe (software OpenGL) in the same container as x264, so frame
rate, canvas size and encoder preset all compete for the same cores. Measured on `e2-custom-4-8192`
(4 vCPU, `STREAM_ENCODE_THREADS=2`, preset `veryfast`), reading `speed=`/`dup=` from
`/tmp/ffmpeg.log` and `%CPU` from `docker stats`:

| canvas @ fps | result |
| --- | --- |
| 720x1280 @ 30 | fps 28, `drop` keeps growing - the client cannot hold 30 at that canvas |
| 720x1280 @ 45 | fps 36, `speed` 0.96 - the encoder starves the renderer |
| 640x1138 @ 45 | fps 45, `dup` 0, `speed` 1.01, xash3d + ffmpeg ~310 % of 400 % |
| 640x1138 @ 50 | fps 50, `dup` 0, ~330 % - almost no headroom left for the game side |

Three knobs move this balance. `STREAM_BAND_PERCENT=0` takes the two spectator bands out of the
render (720x2134 -> 720x1280, ~16 % of the client CPU) but puts the translucent bands back onto the
picture, because the client has no switch for their background - that is why the default stays 20.
`STREAM_PRESET` (`veryfast` by default, `superfast`/`ultrafast` cheaper) trades compression for
renderer headroom, and is the first thing to try before paying for a bigger machine. Only more cores
buy both the full canvas and 45-60 fps.

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
`stream_cam status: enabled=1 interval=25.0 mode=1 spectator=<name> target=<name> candidates=<n> dwell=6.0 hp=<n> active=<mode> ar=<n> pov=<0|1> pov_active=<0|1>`,
and the server log gets one `camera target <bot> (<reason>, score ...)` line per switch. `mode=1` is
chase locked (third person), `active` is the mode the server wrote to the client last second,
`candidates` must be 20 on a 10 vs 10 server, `pov` is the first person switch and `pov_active` says
whether the in-eye window is open right now.

Why the default is third person: a director that re-picked the busiest bot every 8 s looked like the
camera teleporting around the map, and the old *server-side* in-eye window was worse - a spectator has
no view model of its own, so the weapon had to be faked with `WeaponList` + `CurWeapon`, and every cut
to and from first person read on screen as the camera glitching. `stcam_dwell` 6 s and `stcam_idle`
5 s drop a static target before the camera sits on a frozen, hidden bot; `Health` + `ArmorValue` + one
HUD line give viewers real numbers instead of an empty health bar.

First person is a **pilot feature**, off by default:

```powershell
# switch it on for a test run, off again the same way
$env:STREAM_POV = 1; ./infra/compose.ps1 up -d --no-deps --force-recreate hlds
```

`STREAM_POV=1` reaches `server.cfg` as `stcam_pov 1` (`infra/entrypoint.sh`), and the plugin then
flips the client's observer mode to `OBS_IN_EYE` (4) for `stcam_pov_sec` (2.5 s) after the bot on
camera gets a kill, and back to the configured chase mode afterwards or whenever the target changes.
The field the engine reads is `pev_iuser1` on the spectator entity, which `ApplyCamera()` rewrites ten
times a second - a client-side `spec_mode 4` request loses that race and looks like nothing happened
(that was the first attempt, verified live: `active=` stayed 1). Watch `active=4` in
`amx_stcam status` to know the server really is in first person; the client's own picture still has the
limitation below (no view model in first person).

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

- amount < 50 RUB (after conversion) -> rejected, logged, nothing happens;
- every full 50 RUB is one step, and one step buys one effect drawn at random from the enabled
  catalogue; the remainder below a full step is not refunded and does not buy anything - which is why
  the minimum *is* the step;
- a repeated clock effect from the same donation is merged into one longer command, and the plugin
  adds the time to an effect that is already running;
- the buyer's bot wears `[DONOR] <nick>` with a gold shell for as long as the effect lasts;
- one activity per round used to be the rule; now every step applies at once, and only a
  cooldown-blocked donation waits (in the control API queue, not in the plugin);
- the shipped HE party has no cooldown, so a paid step is visible within one RCON round-trip; when an
  effect is put back on sale with `cooldownSec`, the per-donor 60 s and per-activity windows apply
  again.

## Security rules

- the donor nickname is untrusted input: whitelist `[A-Za-z0-9 _.-]`, 16 chars, translit,
  never interpolate it into an RCON command line without validation (newline = command
  injection);
- keys and tokens only in `.env` / vault, never in git, logs or test fixtures;
- the game image is built from pinned official releases (ReHLDS, ReGameDLL_CS, Metamod-R,
  AMX Mod X 1.10.0.5487, YaPB) with SHA256 checks, then scanned (trivy, ClamAV) and
  verified against a whitelist of expected binaries; no community `hlds` images.

## Running it on your own machine

Two modes, because the capture client is what costs:

| Mode | Command | CPU | RAM |
| --- | --- | --- | --- |
| development (server + panel, no capture) | `./infra/compose.ps1 dev` | ~0.05 core | ~190 MB |
| live (adds the client and the encoder) | `./infra/compose.ps1 up -d` | ~2.2 cores | ~1.1 GB |

Measured on a 12-thread desktop: `xash3d` holds ~1.6 cores on its own, `ffmpeg` 0.4-0.7, Xvfb and
PulseAudio 0.2 together, the game server 0.05. The client is expensive because it renders through
llvmpipe (software OpenGL) at 720x2134 and no encoder setting changes that: dropping to 540x960@24
with `-preset ultrafast` took the encoder from 0.7 to 0.4 core and the client from 1.6 to 1.55.

Two things that were **waste** rather than cost, fixed and measured on the same host (whole container
357% → 244% CPU, `ffmpeg` 70% → 50%, `voice.sh` 28.6% → 0%):

- `voice.sh` spun at 30% of a core forever: a played request keeps its file (the overlay volume is not
  writable for the container's uid) and only the marker in `/tmp/voice-seen` says so, but the loop
  counted **any** leftover file as work and therefore never slept. "Work" is now "an unmarked request
  was handled".
- `x11grab` pulled the whole 720x2134 canvas while the encoder kept only the middle 720x1282 rows and
  threw 40% of the pixels away in a `crop` immediately after the grab. The grab window is now
  `720x1282+0,426` and the crop filter is gone; the rows are identical (`YAVG` matches to 0.001, and
  the neighbouring band reads 104 against 137, which is how the offset was checked).

So for development, leave the client off: `dev` stops it and keeps `hlds` + `control-api` (the panel,
the RCON effects, the donation flow all work; only the picture is missing). Start the stream only
when you actually broadcast, and stop it again afterwards.

If the machine has to stay responsive while streaming, pin the work instead of shrinking it:
`STREAM_CPUSET=0-3` and `HLDS_CPUSET=4-5` in `.env` leave the rest of the cores to the desktop.


- `./infra/compose.ps1 ps` — three services `running`, `hlds` and `stream` `healthy`. A stream that
  "lags on load" is usually a stream that is not there at all: check this before touching bitrate.
- the containers carry `restart: unless-stopped`, which brings them back after a Docker restart but
  **not** after a manual `stop`/`down`, and not while the Docker engine itself is not running. If the
  host or Docker Desktop restarts, wait for the engine, then `./infra/compose.ps1 up -d`.
- `docker exec cs16-youtube-stream-1 tail -c 400 /tmp/ffmpeg.log` with
  `STREAM_FFMPEG_LOGLEVEL=info` shows `fps=`, `speed=`, `dup=` and `drop=`: `speed` under 1.0 means
  the encoder cannot keep up, a `drop` counter that keeps growing means the network or the ingest is
  behind, and a `dup` that keeps growing means the game client renders slower than the capture rate.
- `STREAM_BITRATE_KBPS` in `.env` overrides the compose default; 3000 is the floor for 720x1280@30
  with fast movement, 2000 makes a Counter-Strike frame fall apart in a firefight.

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

The token is accepted from the `X-Admin-Token` header only: a `?token=` in the URL would end up in
browser history and in every proxy access log, and the panel never needed it. `/api/trigger` and
`/api/simulate` are rate limited with a token bucket (burst of 10, one token back every 6 s, so 10
per minute sustained); over the limit the answer is `429` with a `retry-after` header. Reads are not
throttled, because the page polls `/api/state` every two seconds.

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
  catalogue (one entry on sale at exactly `minAmount`, sorted order, valid durations).



## Camera limits of the open-source client (verified 2026-10-26)

In first person the client draws no view model (no hands, no weapon) and no HUD text: `WeaponList`
and `CurWeapon` are accepted without producing a gun. First person is therefore no way to show the
weapon, and the gun a viewer sees comes from the third person camera, where the bot model holds it.
That is why the chase camera is the default. The pilot in-eye window (`stcam_pov`, see the camera
section) is a cut to an empty-handed but genuinely first-person view - it has to be judged on the
stream, which is why it is a switch and not a default.

`cs_get_user_bpammo` on a knife (weapon id 29) raises "Invalid weapon id" and aborts the rest of the
HUD update. The HUD line carries no ammo any more, so that call is gone with it.
