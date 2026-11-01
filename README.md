# cs16-youtube

CS 1.6 dedicated server with bots, streamed to YouTube. A viewer donation is turned into
an in-game activity: knife round, zombie round, one bot with an M249 against everyone,
map change, and so on. Everything is driven by donations, nobody plays by hand.

Status: stage 3 works end to end on a live server — the control API polls donations (mock or
DonationAlerts), maps them to activities, enforces cooldowns, sends RCON commands and stores
the verdict. Verified on ReHLDS + Metamod-R + AMX Mod X: a 50 RUB donation reached the plugin
in game (`donation_events ran bot_nick`).

## Layout

```
config/activities.json   what a donation buys (prices, durations, cooldowns, params)
src/activities.ts        catalogue schema: loads, validates, fails fast on a bad config
src/mapping.ts           donation amount -> activity, deterministic, no viewer input
src/cooldowns.ts         per donor and per activity rate limits, based on stored facts
src/command.ts           builds the RCON line, sanitizes donor nicknames (injection guard)
src/rcon.ts              minimal RCON client (GoldSrc: `challenge rcon` over UDP) with timeouts
src/donationalerts.ts    OAuth2 (code + refresh) and the donations list endpoint
src/db.ts                SQLite: donation history, dedup by id, polling cursor
src/poller.ts            one polling pass: dedup, map, cooldown, apply, store
src/game-poller.ts       RCON poller for the panel: team race + the bot on camera (1 Hz)
src/ui/state.ts          the panel model: score, tops, target, donations, queue, theme
src/ui/panel.ts          the panel as text lines: the score bar, tops, target, donation, menu
src/ui/loop.ts           rewrites those files only when the state changes (the encoder draws them)
src/main.ts              daemon: env, wiring, graceful shutdown, POLL_ONCE mode
scripts/fake-donation.ts appends a fake donation for the mock source
scripts/oauth-login.ts   one-off OAuth helper, writes data/da-token.json
scripts/ui-preview.ts    local preview of the panel, no Docker and no game server
scripts/map-walk.ts      walks the map rotation, one activity per map (the smoke test)
plugins/donation_events/ Pawn plugin: effect registry, one public handler per activity
plugins/team_war/        Pawn plugin: T vs CT frag race, published as cvars for the panel
plugins/bot_antistuck/   Pawn plugin: shoves a bot that grinds into a wall back onto the picture
infra/Dockerfile         game image: HLDS + ReHLDS + ReGameDLL + Metamod-R + AMXX + YaPB
infra/build-hlds.sh      assembles the server, verifies every SHA256, compiles the plugin
infra/update-checksums.ps1 resolves official release assets and writes infra/checksums.env
infra/verify-image.ps1   supply-chain gate: binary whitelist, no suid, trivy scan
infra/verify-graphs.ps1  are the navigation graphs in the volume still the pinned ones?
infra/docker-compose.yml hlds + control API (shared network namespace)
```

Planned: ffmpeg streaming to YouTube.

## Rules baked into the catalogue

- minimum donation is 50 RUB, and that 50 RUB is exactly one step: every full 50 RUB buys one effect
  drawn at random from the enabled catalogue (150 RUB = three steps), so no money is lost to a
  leftover; the shipped catalogue sells one effect, the HE party, 60 seconds per step;
- a repeated effect is merged, not repeated: three steps of the HE party buy 180 seconds, and the
  plugin adds the time to a party that is already running;
- foreign donations (USD, EUR, KZT, BYN, UAH) are converted into RUB before the steps are counted,
  at a conservative built-in rate (`CURRENCY_RATES` in `.env` overrides it) and floored, an unknown
  currency is still rejected;
- the buyer's name goes on the scoreboard: `[DONOR] <nick>` with a gold shell on the bot that tops the
  frag list, for as long as the effect the same command bought;
- lasting activities apply at once and end on their own clock (`seconds` in the catalogue, 60 s per
  step), because a `csdm_lite` round almost never ends;
- the server runs team play: T against CT, friendly fire off, YaPB targets the other team only
  (`yb_csdm_mode 0`, `mp_friendlyfire 0`); bots keep their teams and fight each other;
- a dead bot leaves a weapon box behind and CS 1.6 has no "never drop" switch, so `csdm_lite` sweeps
  the litter every five seconds (`csdm_lite_clean_weapons`, `csdm_lite_clean_sec`) - map-placed weapons
  are left alone;
  spawn on the map's own points and respawn half a second after dying, random spawns across the map
  were tried and deleted - bots freeze on points that are not on the YaPB graph, numbers in
  `docs/runbook.md`;
- the stream is a race between T and CT (`plugins/team_war`): every frag counts for the killer's
  team, a team kill included, and the HUD keeps `T n : m CT` with both team tops until the map
  changes;
- `bounty`, `hot_potato` and `boss_raid` follow `DeathMsg` and end on their clock (or when the
  target dies); a boss is re-armed on every spawn so `csdm_lite` cannot undo the raid;
- `map_change` changes the map at once and is rate limited to once per 10 minutes; the rotation
  (`map_duel_maps`) is six fight-yard maps - `fy_iceworld`, `fy_pool_day`, `fy_snow`, `fy_buzzkill`,
  `fy_aztec`, `fy_dustworld` - because a vertical feed cannot wait five seconds for the
  bots to meet. None of them ship with HLDS: they are fetched by `infra/fetch-maps.ps1` from
  GameBanana and pinned by SHA256 in `infra/maps/maps.json` (nothing is downloaded during a build);
- `announce` must be printable ASCII: GoldSrc chat cannot render cyrillic;
- a nickname is moderated: links, ad roots and banned roots are replaced with `Anonim_Bot`, and the
  buyer also appears on the scoreboard as `[DONOR] <nick>` for 30 s unless the activity renames a bot
  itself;
- codes are stable: the Pawn plugin registers effect handlers by code.

## Commands

```powershell
npm test                                  # node:test, no runtime dependencies
npm run typecheck                         # tsc for src/, test/ and scripts/

npm run fake-donation -- --amount 120 --user Vasya   # mock donation (DA_MOCK=1)
$env:POLL_ONCE='1'; npm start              # one pass, then exit
npm start                                  # daemon, polls every DA_POLL_SEC
npm run oauth-login                        # once per account, writes data/da-token.json

# smoke test: every map of the rotation with one activity on it (needs the stack up)
docker exec cs16-youtube-control-api-1 node scripts/map-walk.ts
docker exec cs16-youtube-control-api-1 node scripts/map-walk.ts --maps fy_iceworld,fy_snow --code raptors
```

Dry run: leave `RCON_PASSWORD` empty and commands are logged instead of sent, so the whole
pipeline can be exercised before the game server exists.

## Building the game image

The image is assembled only from official releases, each pinned by SHA256; there is no
`FROM someone/hlds` anywhere. Docker Desktop / Docker Engine with BuildKit is required.

```powershell
./infra/update-checksums.ps1                     # resolve assets, write infra/checksums.env
./infra/build-image.ps1                          # expands that file into --build-arg
./infra/verify-image.ps1                         # binary whitelist, suid, trivy HIGH/CRITICAL
docker compose -f infra/docker-compose.yml up -d hlds
docker logs -f cs16-youtube-hlds-1               # wait for "donation_events loaded"
```

Then point the control API at it (`RCON_PASSWORD` in `.env`, `npm start`) and check the
contract: the API logs `plugin.contract_ok` when `amx_de codes` matches the catalogue.

## Streaming

`src/stream.ts` builds and supervises the ffmpeg pipeline; `scripts/stream.ts` is the CLI.
The stream key lives only in `.env` and is masked in every log line.

```powershell
npm run stream -- --print          # show the exact ffmpeg command, key masked
npm run stream -- --duration 20    # run for 20 s, then stop (exit code 1 if no frames)
npm run stream                     # push until Ctrl+C, restarts ffmpeg with backoff
```

`STREAM_SOURCE` picks what to capture: `desktop` (Windows `gdigrab`, with
`STREAM_OFFSET_X/Y` to grab the game window region), `x11` (Linux `Xvfb` screen, `STREAM_DISPLAY`)
or `test` (synthetic pattern, no display needed). Setting `STREAM_OUTPUT` records to a local
`.flv` instead of going live, which is how the pipeline is verified without a stream key.

The output is 720p30 H.264 (CBR at `STREAM_BITRATE_KBPS`, keyframe every
`STREAM_KEYFRAME_SEC`) plus a silent AAC track, because YouTube flags video-only streams.

### Vertical canvas for the Shorts feed

`STREAM_ORIENTATION` picks the layout. `vertical` (the default) makes the client itself render 9:16:
it draws at the canvas width (`STREAM_WIDTH`), and the render *height* is derived from the canvas and
the band height — 2134 rows for the default 720x1280 canvas, because each of the two spectator bands
CS16Client paints over the frame is 20% of its height and 2134 = 1280 / (1 - 2 x 0.20). ffmpeg cuts the
bands off before scaling and pads nothing, so the game fills the Shorts frame edge to edge. `horizontal`
is the old 16:9 passthrough with a 4:3 render and padding.

Without a stream key the picture can still be reviewed: `STREAM_OUTPUT=/game/rec.mkv` records
instead of going live, `STREAM_WARMUP_SEC` waits for the spectator client to join, and
`STREAM_RECORD_SEC` stops the recording and exits the container.

The camera is driven by the game server, not by the client: `plugins/stream_cam` picks the living
bot that moved the most in the last second and keeps it on screen in third person (`stcam_dwell`,
`stcam_interval`) — no hopping between bots. First person is a pilot feature behind `STREAM_POV`: after
the bot on camera gets a kill the capture client is cut into its eyes for 2.5 s (`stcam_pov`,
`stcam_pov_sec`), off by default and switchable per host. The server also re-sends `jointeam 6`,
which is the only way to close the client-side "choose a team" panel — while it is up the stream
shows a frozen menu. `STREAM_SPEC_MODE=1` is `OBS_CHASE_LOCKED`; `spec_mode 6` is `OBS_MAP_CHASE`,
the map overview, which shows no gameplay at all. `STREAM_SPEC_SWITCH_SEC` re-enables the old
client-side `spec_next` cycling (0 = off, the server is the director); two directors fight each
other, so leave it at 0 with the plugin.

The stream camera is also the reason `mp_autokick 0` is set in `infra/server.cfg`: the client never
presses a key, and the engine used to remove it after two minutes ("has been idle for too long"),
which left the stream showing the menu the client fell back to.

`infra/stream/watchdog.sh` covers both failure modes and writes `runtime.json` next to
`status.json`: the heartbeat age proves the capture side is alive, and a `freezedetect` sample every
`MOTION_SEC` proves the picture moves. The panel shows the verdict as one word — `live`, `frozen`
(on the server, nothing moving: menu or a dead camera target), `stalled` (no heartbeat) or
`offline` (no telemetry at all). A static picture restarts the client only after
`FROZEN_STRIKES` samples in a row, because the pause between rounds is legitimately static.

Sound needs three pieces, because a container has no sound card: PulseAudio runs with a null sink,
`/etc/asound.conf` routes ALSA into it (the bundled SDL2 in the Xash3D release has no PulseAudio
backend, only ALSA), and ffmpeg records `cs.monitor`. The client volume is lowered to
`STREAM_GAME_VOLUME` (0.6 by default) — GoldSrc mixes at full scale and the capture measured peaks
at +8 dB, i.e. clipped — and the encoder adds a limiter as a safety net.

### Autonomous capture (no human, no Steam account)

`infra/stream` is a second image that renders the match itself: Xash3D-FWGS (open-source
GoldSrc engine, GPLv3) runs the CS 1.6 client inside a virtual X display, Mesa llvmpipe
rasterises on the CPU and ffmpeg pushes the result to YouTube. Nothing needs a logged-in
Steam client, a GPU or a window manager.

llvmpipe is told to use two threads (`LP_NUM_THREADS=2`): left alone it took **625% of a 12-core
machine for the client alone**, which starved the encoder until the HLS player in the panel never
started. With the cap the whole capture container costs ~200% and still holds 30 fps.

The CS "SELECT TEAM" panel is drawn over the game and stays there for the whole stream unless a
*key* closes it: `jointeam`, `menuselect` and `cancelselect` are ignored, and any command that
arrives from the server is rejected by the client itself (`Could not execute privileged command`).
So the entrypoint presses the real key through X11 (`xdotool`, 6 = SPECTATE) for the first minute
after the client starts and once a minute afterwards. `plugins/stream_cam` assigns the spectator team
through the cstrike module, which keeps the server side consistent while the panel is being closed.

```powershell
./infra/update-checksums.ps1 -Only XASH3D,CS16CLIENT   # pin the two capture assets (keeps the rest)
./infra/build-stream.ps1                               # builds cs16-stream:local
./infra/verify-stream.ps1 -SmokeTest                   # static checks + a real server, confirms the join
docker compose -f infra/docker-compose.yml up -d       # hlds + control-api + stream
```

Two upstream facts shape this image:

- the engine must be the **i386** build, because HLDS content ships 32-bit `cl_dlls/client.so`
  and `dlls/mp.so` and the amd64 engine only loads `*_amd64.so` twins that do not exist there;
- Valve's own `client.so` needs a Steam session, so the client library is **CS16Client**
  (FWGS, open source). Its current build needs glibc 2.38+, which is why the capture image is
  based on `debian:trixie-slim` while the game server stays on bookworm.

The client joins on its own: `stream-entrypoint.sh` writes `cstrike/userconfig.cfg` with a chain of
`wait` commands around `connect`. `+connect` on the command line does not work — Xash3D runs those
commands during `Host_Init`, before the network client exists, and silently drops them. See
`docs/runbook.md` for the full explanation.

## Watching and driving it locally

Two things make local testing possible without going live and without touching the channel.

### The stream on your desktop

`STREAM_OUTPUT` accepts a URL, not only a path, and the container format follows the scheme:
`rtmp://` gives FLV, which is exactly the code path YouTube uses. Compose has an optional
`mediamtx` service (`--profile local-view`) that receives that push and serves it to a browser:

```powershell
./infra/compose.ps1 --profile local-view up -d mediamtx hlds
./infra/compose.ps1 run --rm -e STREAM_OUTPUT=rtmp://mediamtx:1935/live/test stream
```

`compose.ps1` is a thin wrapper that passes the repository-root environment file explicitly:
compose would otherwise look for it next to `infra/docker-compose.yml` and fail with
`required variable RCON_PASSWORD is missing a value`.

Then open `http://localhost:8889/live/test?muted=false` (WebRTC, about a second of latency) or
`http://localhost:8888/live/test` (HLS, a few seconds, no UDP ports involved). Only loopback ports
are published, and the profile is never part of a normal `up`.

### The operator panel (one page: picture + controls)

`src/admin` serves a single page on `127.0.0.1:${ADMIN_PORT}` (8080 by default, 8085 in the sample
env because 8080 is often taken). Everything lives there: the live picture through HLS/hls.js (with
sound), the activity list with a **Run** button, the `active` state reported by the plugin,
the debug donation form, the log of commands the panel sent, and the donations table.

- **Run** sends `amx_de <code>` with the parameters shown in the row (editable under `params`): no
  donation needed, cooldowns ignored. The plugin applies it in the same RCON call.
- **Debug donation** runs the exact donation pipeline: minimum amount, amount→activity mapping,
  cooldowns, nickname sanitising, RCON, and it prints the verdict with the command that was sent.
  Simulated rows have negative ids (they can never collide with a DonationAlerts id or move the poll
  cursor) and `source = 'sim'`, so they can be deleted with one button.
- **Stop everything** sends `amx_de clear`.
- **Edit** changes price, cooldown, `enabled` and `params` per activity; the value goes to
  `data/activities.override.json`, is re-validated by the same parser as the catalogue and applied in
  memory at once. `config/activities.json` in git stays the default and "Reset" drops the override.
- Every command is written to `admin_actions` (kind, code, params, exact RCON line, reply), so a
  strange round can be explained afterwards.

The panel needs `ADMIN_TOKEN` in `.env`; without it the server does not start. It binds loopback and
expects the token in `X-Admin-Token`, because it can send RCON commands. On a VPS reach it through
`ssh -L 8085:127.0.0.1:8085`.


1. append an entry to `config/activities.json` (unique `code`, price >= 50, new price
   keeps mapping unambiguous);
2. add the Pawn handler and register it under the same `code`;
3. run `npm test` and rebuild the image.

No changes in the control API or the dashboard are required.
